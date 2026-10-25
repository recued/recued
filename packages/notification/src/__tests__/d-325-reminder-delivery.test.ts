import { createInMemoryCollection } from '@recued/storage';
import { PREAPPROVAL_NOTIFICATION_HANDLER } from '@recued/contracts';
import type { InteractiveTransport, OutboundMessage, OutboundPrompt, Transport, TransportSendResult } from '@recued/transport';
import { createTelegramTransport } from '@recued/transport';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore,
  createRemoteChannel, createUiChannel, createEmailChannel, emailReplyText, receivesOnly,
  type AskDeliveryDestination, type AskDeliveryEnvelope, type AskDeliveryInput, type AskDeliveryRecord,
  type AskDeliveryStore, type Channel, type NotificationSettings, type PendingAsk,
  type OutboundEmail,
  type NotificationBlock,
} from '../index.js';

const owner: AskDeliveryDestination = { id: 'owner-telegram', channel: 'telegram', connection_name: 'private',
  connection_enrolled_at: 100, recipient: 'private-chat', expected_sender: 'owner' };
const emailDestination: AskDeliveryDestination = { id: 'owner-email', channel: 'email', connection_name: 'personal-email',
  connection_enrolled_at: 200, recipient: 'owner@example.com', expected_sender: 'owner@example.com', sender_source: 'alerts' };
const options = [{ id: 'done', label: 'Done' }, { id: 'later', label: 'Later' },
  { id: 'not_needed', label: 'Not needed' }, { id: 'stop', label: 'Stop reminding' }];
const input = (group_id = 'day-one', destinations: AskDeliveryDestination[] = [owner, { id: 'ui', channel: 'ui' }]): AskDeliveryInput => ({
  group_id, destinations, asks: ['Passport', 'Driving licence'].map((title, index) => ({
    ask_id: `ask-${group_id}-${index + 1}`, message: { title, text: `${title} renewal is due.` }, options,
    handler: { kind: 'reminder.occurrence', payload: { occurrence: `${group_id}-${index + 1}` } },
  })),
});

const fixture = () => {
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const deliveryStore = createAskDeliveryStore(createInMemoryCollection<AskDeliveryRecord>());
  let time = 1_000_000;
  let sequence = 0;
  let unlocked = true;
  const handled = vi.fn();
  const boot = (channel: Channel, store: AskDeliveryStore = deliveryStore, ui?: Channel) => {
    const block = createNotificationBlock({ askStore, deliveryStore: store,
      settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
      channels: [ui ?? createUiChannel({ busSink: () => {} }), channel], now: () => time,
      mintAskId: () => `ask-attempt-${++sequence}`, isVaultUnlocked: () => unlocked });
    block.registerAskHandler('reminder.occurrence', handled);
    return block;
  };
  return { askStore, deliveryStore, boot, handled, advance: (ms: number) => { time += ms; },
    seal: () => { unlocked = false; }, unlock: () => { unlocked = true; } };
};

const remoteFixture = () => {
  let credentialAvailable = true;
  let enrollment = 100;
  const sends: OutboundPrompt[] = [];
  const edits: Array<OutboundPrompt & { vendor_message_id: string }> = [];
  const closes: string[] = [];
  let nextResult: TransportSendResult | undefined;
  let editOk = true;
  const transport: InteractiveTransport = {
    vendor: 'telegram', send: vi.fn(async (): Promise<TransportSendResult> => ({ ok: true })), parseInbound: () => null,
    parseConversationId: () => null,
    async sendPrompt(prompt) {
      sends.push(structuredClone(prompt));
      return nextResult ?? { ok: true, vendor_message_id: `message-${sends.length}` };
    },
    async updatePrompt(prompt) { edits.push(structuredClone(prompt)); return editOk ? { ok: true } : { ok: false,
      error: { kind: 'network', detail: 'offline' } }; },
    async closePrompt(prompt) { closes.push(prompt.vendor_message_id); return editOk ? { ok: true } : { ok: false,
      error: { kind: 'network', detail: 'offline' } }; },
    parseInboundChoice: payload => payload as ReturnType<InteractiveTransport['parseInboundChoice']>,
    parseCallbackConversationId: payload => (payload as { recipient?: string }).recipient ?? null,
  };
  const channel = () => createRemoteChannel({ transport, resolveCredential: async destination => credentialAvailable ? {
    token: 'fixture-token', recipient: 'private-chat', expected_sender: 'owner',
    connection_name: destination?.connection_name ?? 'private', connection_enrolled_at: enrollment,
  } : null });
  return { channel, sends, edits, closes,
    unavailable: () => { credentialAvailable = false; },
    reenroll: () => { enrollment += 1; },
    failEdits: () => { editOk = false; }, restoreEdits: () => { editOk = true; },
    unknown: () => { nextResult = { ok: false, error: { kind: 'network', detail: 'ack lost' } }; },
    accepted: () => { nextResult = undefined; },
  };
};

describe('D-325 durable reminder asks', () => {
  it('does not send a later destination a question already answered on the first surface', async () => {
    const f = fixture(); const r = remoteFixture();
    let saved!: () => void;
    const recorded = new Promise<void>(resolve => { saved = resolve; });
    const record = f.askStore.recordAnswer.bind(f.askStore);
    vi.spyOn(f.askStore, 'recordAnswer').mockImplementation(async (...args) => { await record(...args); saved(); });
    let block!: NotificationBlock;
    let winning!: Promise<unknown>;
    const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
      deliverNotify: async () => {}, closeAsk: async () => {},
      async deliverAsk(ask_id) {
        winning = block.submitAnswer({ ask_id, option: 'done', via: 'ui' });
        // Wait only for the durable answer, not its close broadcast, which
        // correctly waits for this envelope's current delivery to settle.
        await recorded;
      } };
    block = f.boot(r.channel(), f.deliveryStore, ui);
    const original = input('fast-answer', [{ id: 'ui', channel: 'ui' }, owner]);
    await block.askBundle({ ...original, asks: [original.asks[0]!] });
    await winning;
    expect(r.sends).toHaveLength(0);
    expect(f.handled).toHaveBeenCalledTimes(1);
  });
  it('does not recover an unreleased replacement, and rechecks closed questions when its flow releases it', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    await f.boot(r.channel()).prepareAskBundle(plan);
    const restarted = f.boot(r.channel());
    await restarted.recoverPendingAsks();
    expect(r.sends).toHaveLength(0);
    await restarted.cancelAsk(plan.asks[0]!.ask_id);
    await restarted.releaseAskBundle(plan.group_id);
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.options.map(option => option.correlation_id)).toEqual(Array(4).fill(plan.asks[1]!.ask_id));
    await restarted.recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
  });
  it('holds reminder I/O while sealed without consuming its unknown-delivery repeat', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    f.seal();
    const block = f.boot(r.channel());
    await block.askBundle(plan);
    await block.recoverPendingAsks();
    expect(r.sends).toHaveLength(0);
    expect((await f.deliveryStore.get(plan.group_id))!.attempts).toHaveLength(0);
    f.unlock();
    await block.recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.text).not.toMatch(/^Repeat/);
  });
  it('answers one bundle item, rejects the household origin, and restores both provider ids before a post-restart answer', async () => {
    const f = fixture(); const r = remoteFixture(); const remote = r.channel(); const block = f.boot(remote);
    const plan = input();
    await block.askBundle(plan);
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.options.map(option => option.correlation_id)).toEqual([
      ...Array(4).fill(plan.asks[0]!.ask_id), ...Array(4).fill(plan.asks[1]!.ask_id),
    ]);
    const press = (recipient: string, from = 'owner') => remote.parseInboundReply({
      correlation_id: plan.asks[0]!.ask_id, option_id: 'done', from,
      recipient, vendor_message_id: 'message-1',
    }, { name: 'private', enrolled_at: 100 })!;
    await block.submitAnswer(press('household-group'));
    await block.submitAnswer(press('private-chat', 'someone-else'));
    expect(f.handled).not.toHaveBeenCalled();
    await block.submitAnswer(press('private-chat'));
    expect(f.handled).toHaveBeenCalledTimes(1);
    expect((await block.getAsk(plan.asks[1]!.ask_id))?.status).toBe('open');
    expect(r.edits.at(-1)!.options.map(option => option.correlation_id)).toEqual(Array(4).fill(plan.asks[1]!.ask_id));

    const restarted = f.boot(r.channel());
    // No explicit recovery call: answer admission itself restores delivery ids.
    await restarted.submitAnswer({ ask_id: plan.asks[1]!.ask_id, option: 'done', via: 'ui' });
    expect(r.closes).toContain('message-1');
    await restarted.recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
    expect(f.handled).toHaveBeenCalledTimes(2);
    expect((await f.deliveryStore.get(plan.group_id))!.withdrawals.every(job => job.acknowledged_at !== undefined)).toBe(true);
  });

  it('says a valid reply came after its reminder closed, only to where the reminder went, and keeps an emailed one', async () => {
    const f = fixture(); const r = remoteFixture(); const block = f.boot(r.channel());
    const plan = input('late-day');
    await block.askBundle(plan);
    const reply = (ask: number, sender = 'owner', option = 'done') => ({ ask_id: plan.asks[ask]!.ask_id, option, via: 'telegram' as const,
      origin: { connection_name: 'private', connection_enrolled_at: 100, recipient: 'private-chat', sender } });
    expect(await block.submitAnswer(reply(0))).toBe('answered');
    // The same press again, after the first one closed it.
    expect(await block.submitAnswer(reply(0))).toBe('closed');
    // Closed elsewhere (Today, the asset's page, evidence), then pressed.
    await block.cancelAsk(plan.asks[1]!.ask_id);
    expect(await block.submitAnswer(reply(1))).toBe('closed');
    // Someone the reminder never went to, or an option it never offered, learns nothing.
    expect(await block.submitAnswer(reply(1, 'someone-else'))).toBe('ignored');
    expect(await block.submitAnswer(reply(1, 'owner', 'bogus'))).toBe('ignored');
    expect(f.handled).toHaveBeenCalledTimes(1);

    // Email cannot say so in place: the reply joins the unmatched ones, under the reminder's title.
    await block.recordLateAskReply(plan.asks[1]!.ask_id, 'email', ' done ');
    expect((await block.listUnmatchedAskReplies()).map(({ reason, text, via, group_id }) => ({ reason, text, via, group_id })))
      .toEqual([{ reason: 'already_closed', text: 'Driving licence: done', via: 'email', group_id: plan.group_id }]);
  });

  it('answers a typed reply only where the reminder was shown as text, and never in the household group', () => {
    // ⛔ A button delivery prints no "1 = Done" hint, so text that merely looks like
    // an option — the owner's "1" to an assistant's question, a member's "Done!" in
    // the family group — must stay ordinary conversation.
    const transport: InteractiveTransport = {
      vendor: 'telegram', send: async () => ({ ok: true }),
      parseInbound: payload => payload as { text: string; from: string },
      parseConversationId: payload => (payload as { recipient: string }).recipient,
      sendPrompt: async () => ({ ok: true, vendor_message_id: 'message-1' }),
      updatePrompt: async () => ({ ok: true }), closePrompt: async () => ({ ok: true }),
      parseInboundChoice: () => null, parseCallbackConversationId: () => null,
    };
    const family: AskDeliveryDestination = { id: 'family-telegram', channel: 'telegram', connection_name: 'private',
      connection_enrolled_at: 100, recipient: 'family-chat', audience: 'household' };
    const remote = createRemoteChannel({ transport, resolveCredential: async () => null });
    const show = (destination: AskDeliveryDestination, presentation: 'buttons' | 'text', group: string) => remote.restoreAskDelivery!({
      group_id: group, attempt_id: `${group}-attempt`, destination, repeat: false, provider_message_id: 'message-1', presentation,
      asks: [{ ask_id: `${group}-ask`, message: { text: 'Boiler service is due.' }, options, handler_kind: 'reminder.occurrence',
        handler_payload: {}, fanout_channels: ['telegram'], created_at: 1 }],
    }, []);
    const typed = (recipient: string, from: string, text: string) =>
      remote.parseInboundReply({ recipient, from, text }, { name: 'private', enrolled_at: 100 });
    show(owner, 'buttons', 'private-buttons'); show(family, 'buttons', 'family-buttons');
    expect(typed('private-chat', 'owner', '1')).toBeNull();
    expect(typed('private-chat', 'owner', 'Done')).toBeNull();
    expect(typed('family-chat', 'member', 'Done!')).toBeNull();
    show(owner, 'text', 'private-text');
    expect(typed('private-chat', 'owner', '1')).toMatchObject({ ask_id: 'private-text-ask', option: 'done' });
  });

  it('never redelivers a dismissed but delivered open ask on repeated restarts', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    await f.boot(r.channel()).askBundle(plan);
    for (let i = 0; i < 3; i++) await f.boot(r.channel()).recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
    expect((await f.askStore.get(plan.asks[0]!.ask_id))!.status).toBe('open');
  });

  it('retains the email subject anchor while another bundle item is open, then prunes after closure and acknowledged withdrawals', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    const block = f.boot(r.channel());
    await block.askBundle(plan);
    await block.submitAnswer({ ask_id: plan.asks[0]!.ask_id, option: 'done', via: 'ui' });
    f.advance(8 * 86_400_000);
    await block.pruneHandledAsks(2_000_000);
    expect((await block.getAsk(plan.asks[0]!.ask_id))?.status).toBe('handled');
    expect((await block.getAsk(plan.asks[1]!.ask_id))?.status).toBe('open');
    await block.submitAnswer({ ask_id: plan.asks[1]!.ask_id, option: 'done', via: 'ui' });
    // A months-old question still gets the terminal receipt's retention window.
    await block.pruneHandledAsks(2_000_000);
    expect(await block.getAsk(plan.asks[0]!.ask_id)).not.toBeNull();
    f.advance(8 * 86_400_000);
    await block.pruneHandledAsks(8 * 86_400_000 + 2_000_000);
    expect(await block.getAsk(plan.asks[0]!.ask_id)).toBeNull();
    expect(await f.deliveryStore.get(plan.group_id)).toBeNull();
  });

  it('records a send before I/O and sends at most one marked repeat after lost acknowledgements', async () => {
    const f = fixture(); const sent: AskDeliveryEnvelope[] = [];
    const channel: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false,
      deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {},
      async deliverAskDelivery(envelope) {
        const stored = await f.deliveryStore.get(envelope.group_id);
        expect(stored!.attempts.at(-1)?.result).toBeUndefined();
        expect(stored!.attempts.at(-1)?.id).toBe(envelope.attempt_id);
        sent.push(envelope);
        return { outcome: 'unknown' };
      } };
    const plan = input();
    await f.boot(channel).askBundle(plan);
    await f.boot(channel).recoverPendingAsks();
    const writes = vi.spyOn(f.deliveryStore, 'put');
    await f.boot(channel).recoverPendingAsks();
    expect(writes).not.toHaveBeenCalled();
    expect(sent.map(item => item.repeat)).toEqual([false, true]);
    expect(sent[1]!.asks.map(ask => ask.ask_id)).toEqual(sent[0]!.asks.map(ask => ask.ask_id));
    expect((await f.deliveryStore.get(plan.group_id))!.attempts).toHaveLength(3); // Includes the UI receipt.
  });

  it('keeps retrying while the connection cannot open, and delivers once when it can', async () => {
    const f = fixture();
    const free = createNetServer();
    await new Promise<void>(done => free.listen(0, '127.0.0.1', () => done()));
    let port = (free.address() as AddressInfo).port;
    await new Promise<void>(done => free.close(() => done()));
    const received: string[] = [];
    const telegram = createHttpServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.on('end', () => { received.push(body); response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } })); });
    });
    const transport = createTelegramTransport({ timeoutMs: 5_000,
      fetchImpl: (_input, init) => fetch(`http://127.0.0.1:${port}/`, init) });
    const channel = () => createRemoteChannel({ transport, resolveCredential: async destination => ({
      token: 'fixture-token', recipient: 'private-chat', expected_sender: 'owner',
      connection_name: destination?.connection_name ?? 'private', connection_enrolled_at: 100 }) });
    const plan = input();
    const ownerAttempts = async () => (await f.deliveryStore.get(plan.group_id))!.attempts
      .filter(attempt => attempt.destination_id === owner.id);
    try {
      await f.boot(channel()).askBundle(plan);
      for (let tick = 0; tick < 3; tick += 1) {
        f.advance(3_600_000);
        await f.boot(channel()).recoverPendingAsks();
      }
      await new Promise<void>(done => telegram.listen(0, '127.0.0.1', () => done()));
      port = (telegram.address() as AddressInfo).port;
      f.advance(3_600_000);
      await f.boot(channel()).recoverPendingAsks();
      expect((await ownerAttempts()).map(attempt => attempt.result?.outcome))
        .toEqual(['not_delivered', 'not_delivered', 'not_delivered', 'not_delivered', 'delivered']);
      expect((await ownerAttempts()).some(attempt => attempt.repeat)).toBe(false);
      expect(received).toHaveLength(1);
    } finally { await new Promise<void>(done => telegram.close(() => done())); }
  });

  it('recovers a crash after acceptance but before receipt persistence with one repeat under the same ask', async () => {
    const f = fixture(); const r = remoteFixture();
    let failReceipt = true;
    const failing: AskDeliveryStore = { ...f.deliveryStore, async put(group) {
      if (failReceipt && group.attempts.some(attempt => attempt.result?.outcome === 'delivered')) {
        throw new Error('fixture process lost its receipt write');
      }
      await f.deliveryStore.put(group);
    } };
    const plan = input();
    await expect(f.boot(r.channel(), failing).askBundle(plan)).rejects.toThrow('lost its receipt write');
    expect((await f.deliveryStore.get(plan.group_id))!.attempts[0]!.result).toBeUndefined();
    failReceipt = false;
    const restarted = f.boot(r.channel());
    await restarted.recoverPendingAsks();
    await restarted.recoverPendingAsks();
    expect(r.sends).toHaveLength(2);
    expect(r.sends[1]!.text).toMatch(/^Repeat/);
    expect(r.sends[1]!.options).toEqual(r.sends[0]!.options);
    // Pressing the lost original discovers its id; answering clears both copies.
    await restarted.submitAnswer({ ask_id: plan.asks[0]!.ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'private', connection_enrolled_at: 100, recipient: 'private-chat', sender: 'owner',
      provider_message_id: 'message-1',
    } });
    expect(new Set(r.edits.map(edit => edit.vendor_message_id))).toEqual(new Set(['message-1', 'message-2']));
  });

  it('repairs a failed receipt write in the same process without repeating accepted I/O', async () => {
    const f = fixture(); const r = remoteFixture(); let fails = 1;
    const failing: AskDeliveryStore = { ...f.deliveryStore, async put(group) {
      if (group.attempts[0]?.result?.outcome === 'delivered' && fails-- > 0) throw new Error('temporary disk failure');
      await f.deliveryStore.put(group);
    } };
    const block = f.boot(r.channel(), failing);
    await expect(block.askBundle(input())).rejects.toThrow('disk failure');
    await block.recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
  });

  it('uses an authoritative receipt reconciliation without producing a repeat', async () => {
    const f = fixture(); const r = remoteFixture(); r.unknown();
    const channel = r.channel();
    await f.boot(channel).askBundle(input());
    channel.reconcileAskDelivery = vi.fn(async () => ({ outcome: 'delivered' as const, provider_message_id: 'accepted-before-crash' }));
    await f.boot(channel).recoverPendingAsks();
    expect(channel.reconcileAskDelivery).toHaveBeenCalledTimes(1);
    expect(r.sends).toHaveLength(1);
  });

  it('reconstructs withdrawal jobs from handled asks, and retries edits until acknowledged', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    await f.boot(r.channel()).askBundle(plan);
    // The terminal write survived; the process died before queuing withdrawals.
    await f.askStore.cancel(plan.asks[0]!.ask_id);
    r.failEdits();
    await f.boot(r.channel()).recoverPendingAsks();
    const pending = (await f.deliveryStore.get(plan.group_id))!.withdrawals.find(job => job.item === 1 && job.attempt_id !== 'none')!;
    expect(pending.acknowledged_at).toBeUndefined();
    r.restoreEdits();
    f.advance(60_000); // A failed edit waits a minute before its retry.
    await f.boot(r.channel()).recoverPendingAsks();
    expect(r.edits.at(-1)!.vendor_message_id).toBe('message-1');
    expect(r.edits.at(-1)!.options).toHaveLength(4);
    expect((await f.deliveryStore.get(plan.group_id))!.withdrawals.every(job => job.acknowledged_at !== undefined)).toBe(true);
    expect(r.sends).toHaveLength(1);
  });

  it('stops retrying a destination that can never take the envelope, or has refused it for a day', async () => {
    const gone = fixture(); const r = remoteFixture(); r.unavailable();
    const ownerAttempts = async (f: ReturnType<typeof fixture>) => (await f.deliveryStore.get('day-one'))!.attempts.filter(attempt => attempt.destination_id === owner.id);
    const goneBlock = gone.boot(r.channel()); await goneBlock.askBundle(input());
    for (let hour = 0; hour < 5; hour += 1) { gone.advance(3_600_000); await goneBlock.recoverReminderAsks(); }
    expect(await ownerAttempts(gone)).toEqual([expect.objectContaining({ result: expect.objectContaining({ permanent: true }) })]);

    const refused = fixture();
    const channel: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false,
      deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {},
      deliverAskDelivery: async () => ({ outcome: 'not_delivered', error: 'Forbidden: bot is not a member of the group' }) };
    const block = refused.boot(channel); await block.askBundle(input());
    for (let step = 0; step < 2 * 24 * 6; step += 1) { refused.advance(600_000); await block.recoverReminderAsks(); }
    expect(await ownerAttempts(refused)).toHaveLength(30);
  });

  it('backs off a withdrawal that keeps failing and abandons it, so its group can be pruned', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    const block = f.boot(r.channel()); await block.askBundle(plan);
    // The message was deleted in the chat: every edit of it fails from now on.
    r.failEdits(); const calls = () => r.edits.length + r.closes.length; const before = calls();
    await block.submitAnswer({ ask_id: plan.asks[0]!.ask_id, option: 'done', via: 'ui' });
    await block.submitAnswer({ ask_id: plan.asks[1]!.ask_id, option: 'done', via: 'ui' });
    for (let minute = 0; minute < 60; minute += 1) { f.advance(60_000); await block.recoverReminderAsks(); }
    // Backing off, not hammering: after an hour each job has failed only a few times.
    const early = (await f.deliveryStore.get(plan.group_id))!.withdrawals.filter(job => job.failures !== undefined);
    expect(early.length).toBeGreaterThan(0);
    expect(early.every(job => job.failures! <= 8 && job.abandoned === undefined)).toBe(true);
    for (let minute = 60; minute < 3 * 24 * 60; minute += 1) { f.advance(60_000); await block.recoverReminderAsks(); }
    const attempts = calls() - before;
    const jobs = (await f.deliveryStore.get(plan.group_id))!.withdrawals.filter(job => job.attempt_id !== 'none');
    const remote = jobs.filter(job => job.failures !== undefined);
    expect(remote.length).toBeGreaterThan(0);
    // Each failing job edits at most 20 times over three days, not 4,320.
    expect(attempts).toBeGreaterThan(remote.length * 5); expect(attempts).toBeLessThanOrEqual(remote.length * 20);
    expect(remote.every(job => job.abandoned === true)).toBe(true);
    expect(jobs.every(job => job.acknowledged_at !== undefined)).toBe(true); // Nothing keeps the group alive.
  });

  it('keeps each bundled item’s reason and gives the bundle one link, to Today', async () => {
    const plan = (id: string, count: number, text: (index: number) => string): AskDeliveryInput => {
      const base = input(id);
      return { ...base, asks: Array.from({ length: count }, (_, index) => ({ ...base.asks[0]!, ask_id: `ask-${id}-${index}`,
        message: { title: `Family car ${index}`, text: text(index), link_url: `https://home.example/#yours/asset/car-${index}` } })) };
    };
    const f = fixture(); const r = remoteFixture();
    await f.boot(r.channel()).askBundle(plan('why', 2, index => `Book legal check · Family car ${index}. legal check on: 2026-11-30. Due 2026-11-30.`));
    const text = r.sends[0]!.text;
    expect(text).toContain('Family car 0. legal check on: 2026-11-30. Due 2026-11-30.');
    expect(text).toContain('Family car 1. legal check on: 2026-11-30. Due 2026-11-30.');
    expect(text.match(/https:\/\//gu)).toEqual(['https://']);
    expect(text).toContain('https://home.example/#today');
    const many = fixture(); const crowded = remoteFixture();
    await many.boot(crowded.channel()).askBundle(plan('many', 20, index => `Item ${index}: ${'a reason that runs on '.repeat(12)}Due 2026-11-30.`));
    expect(crowded.sends[0]!.text.length).toBeLessThan(4000);
  });

  it('holds delivery through quiet hours and omits an item already answered during the hold', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = { ...input(), not_before: 2_000_000 };
    const block = f.boot(r.channel());
    await block.askBundle(plan);
    expect(r.sends).toHaveLength(0);
    await block.submitAnswer({ ask_id: plan.asks[0]!.ask_id, option: 'done', via: 'ui' });
    f.advance(1_000_000);
    await block.recoverPendingAsks();
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.options.map(option => option.correlation_id)).toEqual(Array(4).fill(plan.asks[1]!.ask_id));
    expect(r.sends[0]!.text).toContain('1. Closed');
  });

  it('fails closed when the named connection disappears or is recreated under its old name', async () => {
    for (const change of ['delete', 'reenroll'] as const) {
      const f = fixture(); const r = remoteFixture();
      if (change === 'delete') r.unavailable(); else r.reenroll();
      await f.boot(r.channel()).askBundle(input());
      f.advance(60_000);
      await f.boot(r.channel()).recoverPendingAsks();
      expect(r.sends).toHaveLength(0);
      expect((await f.deliveryStore.get('day-one'))!.attempts.filter(attempt => attempt.destination_id === owner.id)
        .every(attempt => attempt.result?.outcome === 'not_delivered')).toBe(true);
    }
  });

  it('requires an email bundle item, preserves unmatched replies, and leaves its other item open', async () => {
    const f = fixture(); const sent: string[] = [];
    const channel = createEmailChannel({ sendEmail: async () => { throw new Error('must use named delivery'); },
      sendEmailDelivery: async (email, destination) => {
        expect(destination).toEqual(emailDestination); sent.push(email.body_text);
        return { outcome: 'delivered', provider_message_id: 'email-message-id' };
      } });
    const block = f.boot(channel); const plan = input('email-day', [emailDestination]);
    await block.askBundle(plan);
    expect(sent[0]).toContain('2. Driving licence');
    expect(await block.parseAskBundleReply(plan.group_id, 'Done', 'email')).toBeNull();
    expect(await block.parseAskBundleReply(plan.group_id, '3 done', 'email')).toBeNull();
    const reply = await block.parseAskBundleReply(plan.group_id, emailReplyText('2 Done.\n\nOn Friday someone wrote:\n> original'), 'email');
    expect(reply?.ask_id).toBe(plan.asks[1]!.ask_id);
    await block.submitAnswer({ ...reply!, via: 'email', origin: { connection_name: 'personal-email',
      connection_enrolled_at: 200, recipient: 'owner@example.com', sender: 'owner@example.com' } });
    expect((await block.getAsk(plan.asks[1]!.ask_id))!.status).toBe('handled');
    expect((await block.getAsk(plan.asks[0]!.ask_id))!.status).toBe('open');
    expect((await block.listUnmatchedAskReplies()).map(item => item.reason)).toEqual(['item_required', 'unknown_item']);
    await f.boot(channel).recoverPendingAsks();
    expect(sent).toHaveLength(1);
  });

  it('marks a repeat in both email bodies and keeps UI-only fragments out of the remote message', async () => {
    const f = fixture(); const sent: OutboundEmail[] = [];
    const channel = createEmailChannel({ sendEmail: async () => {}, answerLink: id => `https://public.example/ask/${id}`,
      sendEmailDelivery: async email => { sent.push(email); return { outcome: 'unknown' }; } });
    const original = input('email-repeat', [emailDestination]);
    const first = { ...original.asks[0]!, message: { ...original.asks[0]!.message, link_url: '#today' }, ui_link_url: '#today' };
    const block = f.boot(channel);
    await block.askBundle({ ...original, asks: [first] });
    await block.recoverPendingAsks();
    await block.recoverPendingAsks();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toMatch(/^Repeat:/);
    expect(sent[1]!.body_text).toContain('Repeat —');
    expect(sent[1]!.body_html).toContain('Repeat —');
    expect(sent.every(email => !email.body_text.includes('#today'))).toBe(true);
  });

  it('does not pass protected approvals through the reminder delivery API', async () => {
    const f = fixture(); const r = remoteFixture(); const plan = input();
    plan.asks[0]!.handler.kind = PREAPPROVAL_NOTIFICATION_HANDLER;
    await expect(f.boot(r.channel()).askBundle(plan)).rejects.toThrow('Invalid reminder');
    expect(r.sends).toHaveLength(0);
  });
});

describe('an emailed reminder names its ask in the subject', () => {
  it('refuses an emailed group whose ask a reply could not name, and keeps app-only groups as they were', async () => {
    const f = fixture();
    const block = f.boot(createEmailChannel({ sendEmail: async () => {},
      sendEmailDelivery: async () => ({ outcome: 'delivered', provider_message_id: 'email-message-id' }) }));
    // D-325 once minted bare UUIDs: `extractAskId` never read one back.
    const bare = (group_id: string, destinations: AskDeliveryDestination[]) => ({ ...input(group_id, destinations),
      asks: input(group_id).asks.map((ask, index) => ({ ...ask, ask_id: `0e5b2c7a-91d4-4f3e-8a6b-00000000000${index}` })) });
    await expect(block.askBundle(bare('emailed', [emailDestination]))).rejects.toThrow('Invalid reminder delivery envelope');
    // A saved app-only payload is resent as it was stored.
    await expect(block.askBundle(bare('app-only', [{ id: 'ui', channel: 'ui' }]))).resolves.toEqual({ ask_ids: expect.any(Array) });
  });
});

describe('D-325 §15.7 (2026-10-24) — a reminder is a notification, never an approval', () => {
  // As the app enrols them: a Telegram connection names no principal (only Teams resolves one, D-238).
  const unnamed: AskDeliveryDestination = { id: 'owner-telegram', channel: 'telegram', connection_name: 'private',
    connection_enrolled_at: 100, recipient: 'private-chat' };
  const family: AskDeliveryDestination = { id: 'household-telegram', channel: 'telegram', connection_name: 'family',
    connection_enrolled_at: 300, recipient: '-100200300', audience: 'household' };
  const plan = (group_id: string, destinations: AskDeliveryDestination[]): AskDeliveryInput => ({ group_id, destinations,
    asks: [{ ask_id: `ask-${group_id}`, options, handler: { kind: 'reminder.occurrence', payload: {} },
      message: { title: 'Boiler service', text: 'The boiler service is due on 12 Nov.', link_url: 'https://recued.example/#yours/occurrences' } }] });
  /** Each connection's credential as it is stored: neither names a principal, except
   *  that the family group's may carry one by hand, which must not matter. */
  const telegram = (familyPrincipal?: string) => {
    const posts: OutboundMessage[] = []; const prompts: OutboundPrompt[] = []; const edits: string[] = [];
    const transport: InteractiveTransport = {
      vendor: 'telegram', send: async message => { posts.push(structuredClone(message)); return { ok: true, vendor_message_id: `post-${posts.length}` }; },
      parseInbound: () => null, parseConversationId: () => null,
      sendPrompt: async prompt => { prompts.push(structuredClone(prompt)); return { ok: true, vendor_message_id: `prompt-${prompts.length}` }; },
      updatePrompt: async prompt => { edits.push(prompt.vendor_message_id); return { ok: true }; },
      closePrompt: async prompt => { edits.push(prompt.vendor_message_id); return { ok: true }; },
      parseInboundChoice: payload => payload as ReturnType<InteractiveTransport['parseInboundChoice']>,
      parseCallbackConversationId: payload => (payload as { recipient?: string }).recipient ?? null,
    };
    const channel = () => createRemoteChannel({ transport, resolveCredential: async destination => destination?.connection_name === 'family'
      ? { token: 'family-token', recipient: '-100200300', connection_name: 'family', connection_enrolled_at: 300,
        ...(familyPrincipal ? { expected_sender: familyPrincipal } : {}) }
      : { token: 'owner-token', recipient: 'private-chat', connection_name: 'private', connection_enrolled_at: 100 } });
    return { channel, posts, prompts, edits };
  };
  const press = (remote: Channel & { parseInboundReply: (payload: unknown, connection?: { name: string; enrolled_at: number }) => unknown },
    ask_id: string, recipient: string, from: string, connection: { name: string; enrolled_at: number }) =>
    remote.parseInboundReply({ correlation_id: ask_id, option_id: 'done', from, recipient, vendor_message_id: 'prompt-1' }, connection) as Parameters<NotificationBlock['submitAnswer']>[0];

  it('answers the owner from their own chat with no principal named, as the owner, and nobody from the household group', async () => {
    const f = fixture(); const t = telegram('family-admin'); const remote = t.channel(); const block = f.boot(remote);
    const bundle = plan('no-principal', [unnamed, family, { id: 'ui', channel: 'ui' }]);
    await block.askBundle(bundle);
    // The owner gets buttons; the household gets the reminder as a message, without its owner-only link.
    expect(t.prompts.map(prompt => [prompt.recipient, prompt.options.map(option => option.id)])).toEqual([['private-chat', ['done', 'later', 'not_needed', 'stop']]]);
    expect(t.posts.map(post => post.recipient)).toEqual(['-100200300']);
    expect(t.posts[0]!.text).toContain('The boiler service is due on 12 Nov.');
    expect(t.posts[0]!.text).not.toContain('https://');
    const ask_id = bundle.asks[0]!.ask_id;
    // ⛔ Nobody in the family group answers: not a member, not even the owner.
    for (const from of ['member', 'family-admin']) {
      expect(await block.submitAnswer(press(remote, ask_id, '-100200300', from, { name: 'family', enrolled_at: 300 }))).toBe('ignored');
    }
    // A chat other than the owner's own is not the owner's.
    expect(await block.submitAnswer(press(remote, ask_id, 'someone-elses-chat', 'owner-account', { name: 'private', enrolled_at: 100 }))).toBe('ignored');
    expect(f.handled).not.toHaveBeenCalled();
    expect(await block.submitAnswer(press(remote, ask_id, 'private-chat', 'owner-account', { name: 'private', enrolled_at: 100 }))).toBe('answered');
    expect(f.handled).toHaveBeenCalledTimes(1);
    expect((await f.askStore.get(ask_id))?.owner_answer).toBe(true);
    // The owner's buttons close; the household's message has none, so nothing is edited there.
    expect(t.edits).toEqual(['prompt-1']);
    expect((await f.deliveryStore.get(bundle.group_id))!.withdrawals.every(job => job.acknowledged_at !== undefined)).toBe(true);
  });

  it('refuses a press on a household copy stored with the member list it once had', async () => {
    const f = fixture(); const t = telegram(); const remote = t.channel(); const block = f.boot(remote);
    // Sent before 2026-10-24: the group's copy named an answerer and its members.
    const legacy = { ...family, expected_sender: 'owner-account', allowed_senders: ['owner-account', 'member'] } as AskDeliveryDestination;
    const bundle = plan('legacy', [legacy, { id: 'ui', channel: 'ui' }]);
    await block.askBundle(bundle);
    expect(t.posts).toHaveLength(1);
    for (const from of ['member', 'owner-account']) {
      expect(await block.submitAnswer(press(remote, bundle.asks[0]!.ask_id, '-100200300', from, { name: 'family', enrolled_at: 300 }))).toBe('ignored');
    }
    expect(f.handled).not.toHaveBeenCalled();
  });

  it('posts to a conversation others may be in without buttons and takes no answer from it, unless only the owner is there', async () => {
    // With no principal, Recued cannot tell the owner from others in a Slack channel, on
    // Discord, or on Teams. Only a private conversation answers without one.
    const shapes: Array<[AskDeliveryDestination, boolean]> = [
      [unnamed, false], [family, true], [{ id: 'a', channel: 'telegram', recipient: '-1001' }, true],
      [{ id: 'b', channel: 'whatsapp', recipient: '447700900000' }, false], [{ id: 'c', channel: 'slack', recipient: 'D0123' }, false],
      [{ id: 'd', channel: 'slack', recipient: 'C0123' }, true], [{ id: 'e', channel: 'discord', recipient: '1234' }, true],
      [{ id: 'f', channel: 'teams', recipient: '19:chat' }, true], [{ id: 'g', channel: 'teams', recipient: '19:chat', expected_sender: 'owner-object-id' }, false],
      [{ id: 'h', channel: 'ui' }, false], [emailDestination, false],
    ];
    expect(shapes.map(([destination]) => receivesOnly(destination))).toEqual(shapes.map(([, only]) => only));
    for (const [recipient, shared] of [['C0123', true], ['D0123', false]] as const) {
      const posts: OutboundMessage[] = []; const prompts: OutboundPrompt[] = [];
      const transport: InteractiveTransport = { vendor: 'slack', parseInbound: () => null, parseConversationId: () => null,
        send: async message => { posts.push(structuredClone(message)); return { ok: true, vendor_message_id: `post-${posts.length}` }; },
        sendPrompt: async prompt => { prompts.push(structuredClone(prompt)); return { ok: true, vendor_message_id: `prompt-${prompts.length}` }; },
        updatePrompt: async () => ({ ok: true }), closePrompt: async () => ({ ok: true }),
        parseInboundChoice: payload => payload as ReturnType<InteractiveTransport['parseInboundChoice']>,
        parseCallbackConversationId: payload => (payload as { recipient?: string }).recipient ?? null };
      const remote = createRemoteChannel({ transport, resolveCredential: async () => ({ token: 'slack-token', recipient,
        connection_name: 'work', connection_enrolled_at: 100 }) });
      const f = fixture(); const block = f.boot(remote);
      const bundle = plan(`slack-${recipient}`, [{ id: 'owner-slack', channel: 'slack', connection_name: 'work', connection_enrolled_at: 100, recipient },
        { id: 'ui', channel: 'ui' }]);
      await block.askBundle(bundle);
      // In a channel the reminder is a message, still with its link to Recued; a direct message keeps its buttons.
      expect([posts.length, prompts.length], recipient).toEqual(shared ? [1, 0] : [0, 1]);
      if (shared) expect(posts[0]!.text).toContain('https://recued.example/#yours/occurrences');
      // ⛔ A press from the channel, as on a post an older build made there with buttons, answers nothing.
      expect(await block.submitAnswer(press(remote, bundle.asks[0]!.ask_id, recipient, 'U-owner', { name: 'work', enrolled_at: 100 })), recipient)
        .toBe(shared ? 'ignored' : 'answered');
    }
  });

  it('⛔ leaves a classic ask on a chat with no principal unanswerable by typing, while a reminder shown as text there answers', async () => {
    // D-238 holds for approvals: with no known approver, nobody may answer by typing.
    const posts: OutboundMessage[] = [];
    const transport: Transport = { vendor: 'telegram', send: async message => { posts.push(message); return { ok: true }; },
      parseInbound: payload => payload as { text: string; from: string },
      parseConversationId: payload => (payload as { recipient: string }).recipient };
    // A channel with no buttons, as D-238's Teams is: answered by typing or by link.
    const remote = createRemoteChannel({ transport, capability: 'landing-page', resolveCredential: async () => ({ token: 'owner-token',
      recipient: 'private-chat', connection_name: 'private', connection_enrolled_at: 100 }) });
    await remote.deliverAsk('approval-1', { title: 'Send the invoice?', text: 'Approve to send it.' }, [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }]);
    const typed = (text: string) => remote.parseInboundReply({ recipient: 'private-chat', from: 'colleague', text }, { name: 'private', enrolled_at: 100 });
    expect(typed('Approve')).toBeNull();
    remote.restoreAskDelivery!({ group_id: 'shown-as-text', attempt_id: 'shown-as-text-1', destination: unnamed, repeat: false,
      provider_message_id: '', presentation: 'text', asks: [{ ask_id: 'reminder-1', message: { text: 'Boiler service is due.' }, options,
        handler_kind: 'reminder.occurrence', handler_payload: {}, fanout_channels: ['telegram'], created_at: 1 }] }, []);
    expect(typed('Done')).toMatchObject({ ask_id: 'reminder-1', option: 'done' });
    expect(typed('Approve')).toBeNull();
  });
});
