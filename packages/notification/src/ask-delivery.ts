import type { AskStore, NewPendingAsk } from './ask-store.js';
import type { Channel } from './channels/channel.js';
import { createAskSerializer, isAskId } from './correlation.js';
import { isProtectedAskKind } from './protected-asks.js';
import { normalizeEmailAnswerToken } from './ask-text-answer.js';
import type { InboundReply, PendingAsk } from './types.js';
import type {
  AskDeliveryAttempt, AskDeliveryEnvelope, AskDeliveryGroup, AskDeliveryInput,
  AskDeliveryOutcome, AskDeliveryReceipt, AskDeliveryStore, UnmatchedAskReply,
  AskDeliveryDestination, AskReplyOrigin,
} from './ask-delivery-store.js';

/** A day of refusals, with the backoff below: the owner keeps the in-app copy. */
const MAX_REFUSED_ATTEMPTS = 30;
/** About a day of failed edits, backing off from a minute to an hour. */
const MAX_WITHDRAWAL_FAILURES = 20;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface AskDeliveryControllerDeps {
  store: AskDeliveryStore;
  asks: AskStore;
  channels: readonly Channel[];
  now: () => number;
  mint: () => string;
  canDeliver?: () => boolean;
  /** Quiet hours hold new messages, while reconciliation and withdrawing
   * already-shown buttons remain available to an active owner. */
  canSend?: () => boolean;
  authorizeOrigin?: (destination: AskDeliveryDestination, origin: AskReplyOrigin, reply: InboundReply) => boolean | Promise<boolean>;
  /** D-325 P31 — an item that is no longer the household's (its asset was made
   * private after the reminder was planned). Household copies treat it as closed:
   * not sent again, withdrawn where shown, not answerable from there. The owner's
   * copies keep it. */
  householdWithheld?: (ask: NewPendingAsk) => boolean | Promise<boolean>;
}

/** The durable part of the existing ask layer. No occurrence, rule, schedule or
 * lifecycle decisions live here. Sends serialize per envelope; answers continue
 * to serialize per ask in NotificationBlock. */
export const createAskDeliveryController = (deps: AskDeliveryControllerDeps) => {
  const serial = createAskSerializer();
  const creation = createAskSerializer();
  const channels = new Map(deps.channels.map(channel => [channel.name, channel]));
  // Repairs a failed receipt write in-process without repeating accepted I/O.
  const knownOutcomes = new Map<string, AskDeliveryOutcome>();
  let restored: Promise<void> | undefined;

  const envelope = (group: AskDeliveryGroup, attempt: AskDeliveryAttempt): AskDeliveryEnvelope => ({
    group_id: group.group_id, attempt_id: attempt.id,
    destination: group.destinations.find(item => item.id === attempt.destination_id)!,
    asks: group.asks, repeat: attempt.repeat,
    ...(attempt.closed_ask_ids ? { closed_ask_ids: attempt.closed_ask_ids } : {}),
  });
  const receipt = (group: AskDeliveryGroup, attempt: AskDeliveryAttempt): AskDeliveryReceipt => ({
    ...envelope(group, attempt),
    ...(attempt.result?.outcome === 'delivered' && attempt.result.provider_message_id !== undefined
      ? { provider_message_id: attempt.result.provider_message_id } : {}),
    ...(attempt.result?.outcome === 'delivered' && attempt.result.presentation
      ? { presentation: attempt.result.presentation } : {}),
  });
  const closedIds = async (group: AskDeliveryGroup): Promise<string[]> => {
    const rows = await Promise.all(group.asks.map(ask => deps.asks.get(ask.ask_id)));
    return group.asks.filter((_ask, index) => rows[index]?.status !== 'open').map(ask => ask.ask_id);
  };
  /** Closed for this destination: a household copy also closes withheld items. */
  const closedFor = async (group: AskDeliveryGroup, destination: AskDeliveryDestination | undefined, closed: string[]): Promise<string[]> => {
    if (destination?.audience !== 'household' || !deps.householdWithheld) return closed;
    const withheld: string[] = [];
    for (const ask of group.asks) if (!closed.includes(ask.ask_id) && await deps.householdWithheld(ask)) withheld.push(ask.ask_id);
    return withheld.length ? [...closed, ...withheld] : closed;
  };

  const initializeAsks = async (group: AskDeliveryGroup) => {
    if (group.asks_initialized) return;
    for (const ask of group.asks) {
      const stored = await deps.asks.get(ask.ask_id);
      if (!stored) await deps.asks.create(ask);
      else {
        const { status: _status, answer: _answer, answered_via: _via, ...seed } = stored;
        if (canonical(seed) !== canonical(ask)) throw new Error('Reminder ask id is already in use');
      }
    }
    group.asks_initialized = true;
    await deps.store.put(group);
  };

  const restore = (): Promise<void> => {
    if (!restored) {
      restored = (async () => {
        for (const group of await deps.store.groups()) {
          await serial.run(group.group_id, async () => {
            const current = await deps.store.get(group.group_id);
            if (!current) return;
            await initializeAsks(current);
            const closed = await closedIds(current);
            for (const attempt of current.attempts) {
              if (attempt.result?.outcome !== 'delivered') continue;
              const destination = envelope(current, attempt).destination;
              await channels.get(destination.channel)
                ?.restoreAskDelivery?.(receipt(current, attempt), await closedFor(current, destination, closed));
            }
          });
        }
      })().catch(error => { restored = undefined; throw error; });
    }
    return restored;
  };

  /** Re-derive jobs from terminal questions too: a crash between recording an
   * answer/cancel and queueing its job must not strand buttons forever. */
  const withdrawGroup = async (group: AskDeliveryGroup) => {
    const closed = await closedIds(group);
    let changed = false;
    if (closed.length === group.asks.length && group.closed_at === undefined) {
      group.closed_at = deps.now(); changed = true;
    }
    for (const attempt of group.attempts) {
      if (attempt.result?.outcome !== 'delivered') continue;
      for (const ask_id of await closedFor(group, envelope(group, attempt).destination, closed)) {
        if (group.withdrawals.some(job => job.attempt_id === attempt.id && job.ask_id === ask_id)) continue;
        group.withdrawals.push({ attempt_id: attempt.id, ask_id,
          item: group.asks.findIndex(ask => ask.ask_id === ask_id) + 1, requested_at: deps.now() });
        changed = true;
      }
    }
    // No provider edit can precede this durable write.
    if (changed) await deps.store.put(group);
    if (deps.canDeliver?.() === false) return;
    for (const job of group.withdrawals) {
      if (deps.canDeliver?.() === false) return;
      if (job.acknowledged_at !== undefined || (job.retry_at !== undefined && job.retry_at > deps.now())) continue;
      const attempt = group.attempts.find(item => item.id === job.attempt_id);
      if (!attempt || attempt.result?.outcome !== 'delivered') continue;
      const destination = envelope(group, attempt).destination;
      const channel = channels.get(destination.channel);
      let acknowledged = false;
      try {
        if (channel?.withdrawAskDelivery) acknowledged = await channel.withdrawAskDelivery(receipt(group, attempt), await closedFor(group, destination, closed));
        else if (channel?.name === 'ui') {
          await channel.closeAsk(job.ask_id);
          acknowledged = true;
        }
      } catch { /* The durable job, including handled asks, is retried. */ }
      if (acknowledged) {
        job.acknowledged_at = deps.now();
        await deps.store.put(group);
      } else {
        job.failures = (job.failures ?? 0) + 1;
        if (job.failures >= MAX_WITHDRAWAL_FAILURES) { job.acknowledged_at = deps.now(); job.abandoned = true; }
        else job.retry_at = deps.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(job.failures - 1, 6));
        await deps.store.put(group);
      }
    }
  };

  const storeOutcome = async (group: AskDeliveryGroup, attempt: AskDeliveryAttempt, result: AskDeliveryOutcome) => {
    knownOutcomes.set(attempt.id, result);
    const changed = canonical(attempt.result) !== canonical(result);
    attempt.result = result;
    if (changed) await deps.store.put(group);
    knownOutcomes.delete(attempt.id);
    if (result.outcome === 'delivered') {
      await channels.get(envelope(group, attempt).destination.channel)
        ?.restoreAskDelivery?.(receipt(group, attempt), await closedIds(group));
    }
  };

  const deliverGroup = async (group: AskDeliveryGroup) => {
    await initializeAsks(group);
    if (group.released === false) return;
    if (deps.canDeliver?.() === false) return;
    if (group.not_before > deps.now()) return;
    for (const destination of group.destinations) {
      if (deps.canDeliver?.() === false) return;
      const channel = channels.get(destination.channel);
      if (!channel) continue;
      // Resolve every uncertain send first. A receipt discovered later still
      // needs withdrawal, even when the marked repeat was already delivered.
      for (const attempt of group.attempts.filter(item => item.destination_id === destination.id)) {
        const known = knownOutcomes.get(attempt.id);
        if (known) { await storeOutcome(group, attempt, known); continue; }
        if (attempt.result?.outcome === 'delivered' || attempt.result?.outcome === 'not_delivered') continue;
        let result: AskDeliveryOutcome = attempt.result ?? { outcome: 'unknown' };
        if (channel.reconcileAskDelivery) {
          try { result = await channel.reconcileAskDelivery(envelope(group, attempt)); }
          catch { /* Reconciliation failure is not proof of non-delivery. */ }
        }
        if (result.outcome === 'unknown' && !result.error && attempt.result?.outcome === 'unknown' && attempt.result.error) {
          result = { ...result, error: attempt.result.error };
        }
        await storeOutcome(group, attempt, result);
      }
      const attempts = group.attempts.filter(item => item.destination_id === destination.id);
      const closed = await closedFor(group, destination, await closedIds(group));
      if (closed.length === group.asks.length) continue;
      if (attempts.some(item => item.result?.outcome === 'delivered')) continue;
      const uncertain = attempts.filter(item => !item.result || item.result.outcome === 'unknown');
      // At most one potentially accepted repeat. A definite refusal can retry;
      // an uncertain repeat cannot produce a third copy.
      if (uncertain.some(item => item.repeat)) continue;
      const latest = attempts.at(-1);
      if (latest?.result?.outcome === 'not_delivered') {
        // A destination that can never take this envelope, or has refused it for a
        // day, is not tried again; the owner keeps the in-app copy.
        if (latest.result.permanent
          || attempts.filter(item => item.result?.outcome === 'not_delivered').length >= MAX_REFUSED_ATTEMPTS) continue;
        const delay = Math.min(3_600_000, 15_000 * 2 ** Math.min(attempts.length - 1, 8));
        if (deps.now() < latest.started_at + delay) continue;
      }
      if (deps.canSend?.() === false) continue;
      const attempt: AskDeliveryAttempt = { id: deps.mint(), destination_id: destination.id,
        started_at: deps.now(), repeat: uncertain.length > 0, closed_ask_ids: closed };
      group.attempts.push(attempt);
      // No send can precede its durable attempt.
      await deps.store.put(group);
      let result: AskDeliveryOutcome;
      try {
        if (deps.canDeliver?.() === false || deps.canSend?.() === false) result = { outcome: 'not_delivered', error: 'Delivery is held by the current owner policy' };
        else if (channel.deliverAskDelivery) result = await channel.deliverAskDelivery(envelope(group, attempt));
        else if (channel.name === 'ui') {
          for (const ask of group.asks) {
            if (!closed.includes(ask.ask_id)) await channel.deliverAsk(ask.ask_id,
              { ...ask.message, ...(ask.ui_link_url ? { link_url: ask.ui_link_url } : {}) }, ask.options, { reminder: true });
          }
          result = { outcome: 'delivered' };
        } else result = { outcome: 'not_delivered', error: 'This channel has no durable reminder adapter', permanent: true };
      } catch { result = { outcome: 'unknown', error: 'The send did not return an acknowledgement' }; }
      await storeOutcome(group, attempt, result);
    }
    await withdrawGroup(group);
  };

  const create = async (request: AskDeliveryInput, deliver = true): Promise<{ ask_ids: string[] }> => {
    const input = structuredClone(request);
    if (!input.group_id || input.group_id.length > 200 || input.asks.length < 1 || input.asks.length > 20
      || input.destinations.length < 1 || input.destinations.length > 20
      || new Set(input.asks.map(ask => ask.ask_id)).size !== input.asks.length
      || new Set(input.destinations.map(destination => destination.id)).size !== input.destinations.length
      || input.asks.some(ask => typeof ask.ask_id !== 'string' || !ask.ask_id
        // An emailed reply carries its ask back only in the subject tag.
        || input.destinations.some(destination => destination.channel === 'email') && !isAskId(ask.ask_id)
        || typeof ask.handler.kind !== 'string' || !ask.handler.kind
        || ask.options.length < 1 || ask.options.length > 8
        || isProtectedAskKind(ask.handler.kind)
        || new Set(ask.options.map(option => option.id)).size !== ask.options.length)
      || input.destinations.some(destination => !destination.id || !channels.has(destination.channel)
        || (destination.channel !== 'ui' && (!destination.connection_name || !destination.recipient
          || !Number.isFinite(destination.connection_enrolled_at)))
        || (destination.audience === 'household' && (destination.channel !== 'telegram' || !destination.expected_sender
          || !Array.isArray(destination.allowed_senders) || destination.allowed_senders.length < 1 || destination.allowed_senders.length > 32
          || !destination.allowed_senders.includes(destination.expected_sender)
          || destination.allowed_senders.some(sender => typeof sender !== 'string' || !sender.trim() || sender.length > 200)
          || new Set(destination.allowed_senders).size !== destination.allowed_senders.length))
        || (destination.audience !== 'household' && destination.allowed_senders !== undefined))
      || (input.not_before !== undefined && !Number.isFinite(input.not_before))
      || new TextEncoder().encode(JSON.stringify(input)).length > 256 * 1024) {
      throw new Error('Invalid reminder delivery envelope');
    }
    await restore();
    return creation.run('reserve', () => serial.run(input.group_id, async () => {
      let group = await deps.store.get(input.group_id);
      const created_at = group?.created_at ?? deps.now();
      const asks: NewPendingAsk[] = input.asks.map(ask => ({ ask_id: ask.ask_id, message: ask.message,
        ...(ask.ui_link_url ? { ui_link_url: ask.ui_link_url } : {}),
        options: [...ask.options], handler_kind: ask.handler.kind, handler_payload: ask.handler.payload,
        delivery_group_id: input.group_id, created_at,
        fanout_channels: [...new Set(input.destinations.map(destination => destination.channel))] }));
      const seed = { asks, destinations: [...input.destinations], not_before: input.not_before ?? created_at };
      if (group) {
        if (canonical(seed) !== canonical({ asks: group.asks, destinations: group.destinations, not_before: group.not_before })) {
          throw new Error('Reminder envelope id is already in use');
        }
      } else {
        // Reserve every ask id before persisting the envelope, to reject reuse
        // of a legacy or different managed decision without partial delivery.
        for (const ask of asks) if (await deps.asks.get(ask.ask_id)) throw new Error('Reminder ask id is already in use');
        group = { kind: 'group', group_id: input.group_id, ...seed, created_at,
          asks_initialized: false, released: deliver, attempts: [], withdrawals: [] };
        await deps.store.put(group);
      }
      await initializeAsks(group);
      if (deliver) {
        if (group.released === false) { group.released = true; await deps.store.put(group); }
        await deliverGroup(group);
      }
      return { ask_ids: group.asks.map(ask => ask.ask_id) };
    }));
  };

  const release = async (group_id: string): Promise<void> => {
    await restore();
    await serial.run(group_id, async () => {
      const group = await deps.store.get(group_id);
      if (!group) throw new Error('Unknown reminder envelope');
      if (group.released === false) { group.released = true; await deps.store.put(group); }
      await deliverGroup(group);
    });
  };

  const withdraw = async (ask: PendingAsk) => {
    if (!ask.delivery_group_id) return;
    await restore();
    await serial.run(ask.delivery_group_id, async () => {
      const group = await deps.store.get(ask.delivery_group_id!);
      if (group) await withdrawGroup(group);
    });
  };

  const accepts = async (ask: PendingAsk, reply: InboundReply): Promise<boolean> => {
    await restore();
    if (!ask.delivery_group_id) return true;
    if (reply.landing_capability === true) return true;
    // Pair-authenticated UI is the owner's direct action on the same question.
    if (reply.via === 'ui') return true;
    const origin = reply.origin;
    if (!origin) return false;
    return serial.run(ask.delivery_group_id, async () => {
      const group = await deps.store.get(ask.delivery_group_id!);
      if (!group) return false;
      const destination = group.destinations.find(item => item.channel === reply.via
        && item.connection_name === origin.connection_name
        && item.connection_enrolled_at === origin.connection_enrolled_at
        && item.recipient === origin.recipient && !!item.expected_sender
        && (item.audience === 'household' ? item.allowed_senders?.includes(origin.sender) === true : item.expected_sender === origin.sender));
      if (!destination || !group.attempts.some(attempt => attempt.destination_id === destination.id)) return false;
      const item = group.asks.find(entry => entry.ask_id === ask.ask_id);
      if (destination.audience === 'household' && item && await deps.householdWithheld?.(item)) return false;
      if (deps.authorizeOrigin && !await deps.authorizeOrigin(destination, origin, reply)) return false;
      // A press is also a receipt for a copy whose acknowledgement was lost.
      // Keep it separately; never overwrite the known repeat's message id.
      if (origin.provider_message_id && !group.attempts.some(attempt => attempt.destination_id === destination.id
        && attempt.result?.outcome === 'delivered' && attempt.result.provider_message_id === origin.provider_message_id)) {
        group.attempts.push({ id: deps.mint(), destination_id: destination.id,
          started_at: deps.now(), repeat: false,
          result: { outcome: 'delivered', provider_message_id: origin.provider_message_id } });
        await deps.store.put(group);
      }
      // Even a late press on a terminal question clears that copy's buttons.
      if (ask.status !== 'open') await withdrawGroup(group);
      return true;
    });
  };

  const recover = async () => {
    await restore();
    for (const row of await deps.store.groups()) {
      await serial.run(row.group_id, async () => {
        const group = await deps.store.get(row.group_id);
        if (!group) return;
        // Terminal questions are not skipped: they own durable edit jobs.
        await withdrawGroup(group);
        await deliverGroup(group);
      });
    }
  };

  const preserveForPrune = async (before: number): Promise<string[]> => {
    await restore();
    const preserve: string[] = [];
    for (const row of await deps.store.groups()) {
      await serial.run(row.group_id, async () => {
        const group = await deps.store.get(row.group_id);
        if (!group) return;
        const members = await Promise.all(group.asks.map(ask => deps.asks.get(ask.ask_id)));
        const live = members.some(ask => ask?.status === 'open' || ask?.status === 'answered');
        if (!live && group.closed_at !== undefined && group.closed_at < before
          && group.withdrawals.every(job => job.acknowledged_at !== undefined)) await deps.store.delete(group.group_id);
        else preserve.push(...group.asks.map(ask => ask.ask_id));
      });
    }
    return preserve;
  };

  const unmatched = async (group_id: string, via: InboundReply['via'], text: string, reason: UnmatchedAskReply['reason']) => {
    await deps.store.putUnmatched({ kind: 'unmatched_reply', id: deps.mint(), group_id,
      via, text: text.slice(0, 2000), reason, created_at: deps.now() });
  };

  /** Email's subject names the envelope. A bundle must name an item too.
   * This returns a candidate only; submitAnswer still checks its origin. */
  const parseTextReply = async (group_id: string, text: string, via: InboundReply['via']): Promise<{ ask_id: string; option: string } | null> => {
    const group = await deps.store.get(group_id);
    if (!group) return null;
    let index = 0;
    let answer = text.trim();
    if (group.asks.length > 1) {
      const match = /^(\d+)\s+(.+)$/.exec(answer);
      if (!match) { await unmatched(group_id, via, text, 'item_required'); return null; }
      index = Number(match[1]) - 1;
      answer = match[2]!.trim();
      if (!Number.isSafeInteger(index) || index < 0 || index >= group.asks.length) {
        await unmatched(group_id, via, text, 'unknown_item'); return null;
      }
    }
    const ask = group.asks[index]!;
    const normalized = normalizeEmailAnswerToken(answer);
    const matches = ask.options.filter(option => normalizeEmailAnswerToken(option.id) === normalized
      || normalizeEmailAnswerToken(option.label) === normalized);
    const option = matches.length === 1 ? matches[0] : undefined;
    if (!option) { await unmatched(group_id, via, text, 'unknown_option'); return null; }
    return { ask_id: ask.ask_id, option: option.id };
  };

  return { create, release, restore, recover, withdraw, accepts, parseTextReply, preserveForPrune,
    recordUnmatched: unmatched, unmatched: () => deps.store.unmatched() };
};
