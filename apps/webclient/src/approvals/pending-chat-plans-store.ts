/** Bootstrap-scoped pending Chat-plan recovery store.
 *
 * Subscriptions are registered before the first all-session snapshot. Every
 * proposal / resolution / message-link mutation that arrives while a snapshot
 * is in flight is both applied live and replayed over that snapshot before it
 * can replace the map. The same generation guard runs on reconnect, so a slow
 * pre-reconnect response cannot resurrect a resolved plan or erase a proposal
 * that arrived from another paired client.
 */

import type {
  ChatPlanRecord,
  ServerEvent,
  ToolTier,
} from '@recued/contracts';

import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { serializeChatPlanAddress } from '../shell/route.js';

export interface PendingChatPlan {
  plan_id: string;
  session_id: string;
  turn_id: string;
  /** The uncertain consumed action this fresh approval follows. */
  retry_of_plan_id?: string;
  /** Assistant message containing the in-context card, once linked. */
  message_id?: string;
  tool: string;
  tier: ToolTier;
  args: unknown;
  args_hash?: string;
  /** False when the exact encrypted reviewed payload cannot be recovered.
   * Such a row remains visible and rejectable, but never approvable. */
  payload_available: boolean;
  /** Server proposal timestamp. Older producers fall back to local arrival
   * time until the next authoritative snapshot. */
  proposed_at: number;
}

/** Ephemeral handoff after a pending plan leaves the inbox. This is deliberately
 * not durable approval history (Runs / Chat own that); it only keeps the latest
 * live decision legible long enough for the owner to continue or dismiss it. */
export interface PendingChatPlanResolution {
  plan_id: string;
  session_id: string;
  turn_id: string;
  /** Exact originating message when the pending snapshot had linked it. */
  message_id?: string;
  tool: string;
  outcome: 'approved' | 'cancelled' | 'no_longer_pending';
  resolved_at: number;
}

export type PendingChatPlansLoadPhase = 'loading' | 'ready' | 'error';

export interface PendingChatPlansStoreState {
  readonly phase: PendingChatPlansLoadPhase;
  readonly error: unknown | null;
}

export type PendingChatPlansListCaller = () => Promise<{
  plans: ReadonlyArray<ChatPlanRecord>;
}>;

export interface PendingChatPlansStore {
  /** Pending plans in proposal order (consumers re-sort for display). */
  list(): ReadonlyArray<PendingChatPlan>;
  /** Latest live/local resolution receipt. Ephemeral and explicitly
   * dismissible; never reconstructed as durable history on cold load. */
  latestResolution(): PendingChatPlanResolution | null;
  state(): PendingChatPlansStoreState;
  /** Start an authoritative reconciliation. Failures are captured in
   * `state()` and leave last-known/live rows intact. */
  refresh(): Promise<void>;
  /** The latest startup/reconnect reconciliation known when called. */
  whenLoaded(): Promise<void>;
  /** Apply a successful local resolve immediately, before a potentially missed
   * broadcast or slower authoritative refresh catches up. */
  recordResolution(
    plan: PendingChatPlan,
    decision: 'approve' | 'reject',
  ): void;
  /** Dismiss the latest receipt iff it still names this plan. */
  dismissResolution(plan_id: string): void;
  /** Register a change listener; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  /** Drop snapshot, reconnect, bus, and listener state. Idempotent. */
  dispose(): void;
}

export interface CreatePendingChatPlansStoreOptions {
  /** Bus subscription seam. Registered before the first snapshot starts. */
  subscribe: BroadcastSubscriber['on'];
  /** All-session authoritative pending-plan snapshot. Optional for narrow
   * embeddings; production provides it. */
  listPending?: PendingChatPlansListCaller;
  /** Reconcile again after every transition into `connected`. */
  reconnect?: WebclientReconnectSubscriber;
  /** Clock fallback for an older proposal frame without `created_at`. */
  now?: () => number;
}

type ProposedEvent = Extract<
  ServerEvent,
  { kind: 'chat.plan_proposed' }
>;
type ResolvedEvent = Extract<
  ServerEvent,
  { kind: 'chat.plan_resolved' }
>;
type MessageCompleteEvent = Extract<
  ServerEvent,
  { kind: 'chat.message_complete' }
>;

type PendingPlanMutation =
  | { readonly kind: 'proposed'; readonly plan: PendingChatPlan }
  | { readonly kind: 'resolved'; readonly planId: string }
  | {
      readonly kind: 'message_linked';
      readonly sessionId: string;
      readonly turnId: string;
      readonly messageId: string;
    };
type ProposedPlanMutation = Extract<
  PendingPlanMutation,
  { readonly kind: 'proposed' }
>;

interface PendingPlanSnapshotLoad {
  readonly generation: number;
  readonly mutations: PendingPlanMutation[];
}

/** Plan ids are unique, so a recently resolved id must never re-enter the
 * pending map from a delayed proposal frame or stale snapshot. Bound the
 * in-memory tombstones so a long-running tab cannot grow without limit. */
const RESOLVED_PLAN_TOMBSTONE_LIMIT = 256;

const planFromRecord = (record: ChatPlanRecord): PendingChatPlan | null => {
  const plan = record.plan;
  if (plan.status !== 'proposed') return null;
  return {
    plan_id: plan.plan_id,
    session_id: plan.session_id,
    turn_id: plan.turn_id,
    ...(plan.retry_of_plan_id !== undefined
      ? { retry_of_plan_id: plan.retry_of_plan_id }
      : {}),
    ...(record.message_id !== undefined
      ? { message_id: record.message_id }
      : {}),
    tool: plan.tool,
    tier: plan.tier,
    args: plan.args,
    args_hash: plan.args_hash,
    payload_available: record.payload_available,
    proposed_at: plan.created_at,
  };
};

/** Link a global approval row to its exact in-context Chat card. The durable
 * message id remains an explicit fallback if that card cannot be recovered. */
export const pendingChatPlanHref = (
  plan: Pick<
    PendingChatPlan | PendingChatPlanResolution,
    'plan_id' | 'session_id' | 'message_id'
  >,
): string => serializeChatPlanAddress({
  sessionId: plan.session_id,
  planId: plan.plan_id,
  ...(plan.message_id !== undefined
    ? { messageId: plan.message_id }
    : {}),
});

/** One copy source for the full Approvals route and compact attention popover,
 * so neither surface can imply that approval itself executed the action. */
export const pendingChatPlanResolutionCopy = (
  resolution: PendingChatPlanResolution,
): {
  title: string;
  detail: string;
  linkLabel: string;
} => {
  if (resolution.outcome === 'approved') {
    return {
      title: `Approved ${resolution.tool}`,
      detail:
        'You said yes to exactly these details. Nothing has run yet. Carry on in Chat when you are ready.',
      linkLabel: 'Carry on in Chat',
    };
  }
  if (resolution.outcome === 'cancelled') {
    return {
      title: `Rejected ${resolution.tool}`,
      detail:
        'This will not run. Go back to Chat if you want to change it.',
      linkLabel: 'Return to Chat',
    };
  }
  return {
    title: `Approval updated: ${resolution.tool}`,
    detail:
      'This is not waiting for you any more. Open Chat to see where it got to.',
    linkLabel: 'Open Chat',
  };
};

const proposedMutation = (
  event: ProposedEvent,
  arrivedAt: number,
): ProposedPlanMutation => ({
  kind: 'proposed',
  plan: {
    plan_id: event.plan_id,
    session_id: event.session_id,
    turn_id: event.turn_id,
    ...(event.retry_of_plan_id !== undefined
      ? { retry_of_plan_id: event.retry_of_plan_id }
      : {}),
    tool: event.tool,
    tier: event.tier,
    args: event.args,
    ...(event.args_hash !== undefined
      ? { args_hash: event.args_hash }
      : {}),
    payload_available: true,
    proposed_at: event.created_at ?? arrivedAt,
  },
});

const messageLinkMutation = (
  event: MessageCompleteEvent,
): PendingPlanMutation | null => {
  if (
    event.final === null
    || typeof event.final !== 'object'
    || typeof (event.final as { id?: unknown }).id !== 'string'
  ) return null;
  return {
    kind: 'message_linked',
    sessionId: event.session_id,
    turnId: event.turn_id,
    messageId: (event.final as { id: string }).id,
  };
};

const applyMutation = (
  target: Map<string, PendingChatPlan>,
  mutation: PendingPlanMutation,
): boolean => {
  if (mutation.kind === 'resolved') {
    return target.delete(mutation.planId);
  }
  if (mutation.kind === 'proposed') {
    const existing = target.get(mutation.plan.plan_id);
    target.set(mutation.plan.plan_id, {
      ...mutation.plan,
      // A replayed proposal predates the completed-message linkage carried by
      // an authoritative snapshot. Never erase the stronger durable address.
      ...(existing?.message_id !== undefined
        ? { message_id: existing.message_id }
        : {}),
    });
    return true;
  }
  let changed = false;
  for (const [planId, plan] of target) {
    if (
      plan.session_id !== mutation.sessionId
      || plan.turn_id !== mutation.turnId
      || plan.message_id === mutation.messageId
    ) continue;
    target.set(planId, { ...plan, message_id: mutation.messageId });
    changed = true;
  }
  return changed;
};

export const createPendingChatPlansStore = (
  opts: CreatePendingChatPlansStoreOptions,
): PendingChatPlansStore => {
  const now = opts.now ?? Date.now;
  let plans = new Map<string, PendingChatPlan>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let phase: PendingChatPlansLoadPhase =
    opts.listPending === undefined ? 'ready' : 'loading';
  let lastError: unknown | null = null;
  let latestResolution: PendingChatPlanResolution | null = null;
  const resolvedPlanIds = new Set<string>();
  let loadGeneration = 0;
  let activeLoad: PendingPlanSnapshotLoad | null = null;
  let pendingLoad: Promise<void> = Promise.resolve();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One broken consumer must not stop the others.
      }
    }
  };

  const setLatestResolution = (
    resolution: PendingChatPlanResolution,
  ): boolean => {
    // A local optimistic receipt can retain a stronger exact-message address
    // than the subsequent broadcast, whose canonical plan has no message_id.
    const next =
      latestResolution?.plan_id === resolution.plan_id
      && latestResolution.message_id !== undefined
      && resolution.message_id === undefined
        ? { ...resolution, message_id: latestResolution.message_id }
        : resolution;
    if (
      latestResolution?.plan_id === next.plan_id
      && latestResolution.outcome === next.outcome
      && latestResolution.message_id === next.message_id
      && latestResolution.resolved_at === next.resolved_at
    ) return false;
    latestResolution = next;
    return true;
  };

  const rememberResolvedPlan = (planId: string): void => {
    // Delete + add refreshes insertion order for a duplicate terminal event.
    resolvedPlanIds.delete(planId);
    resolvedPlanIds.add(planId);
    while (resolvedPlanIds.size > RESOLVED_PLAN_TOMBSTONE_LIMIT) {
      const oldest = resolvedPlanIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      resolvedPlanIds.delete(oldest);
    }
  };

  const recordResolvedPlan = (
    plan: Pick<
      PendingChatPlan,
      'plan_id' | 'session_id' | 'turn_id' | 'message_id' | 'tool'
    >,
    outcome: PendingChatPlanResolution['outcome'],
    resolvedAt: number,
  ): void => {
    if (disposed) return;
    rememberResolvedPlan(plan.plan_id);
    const mutation: PendingPlanMutation = {
      kind: 'resolved',
      planId: plan.plan_id,
    };
    activeLoad?.mutations.push(mutation);
    const removed = applyMutation(plans, mutation);
    const receiptChanged = setLatestResolution({
      plan_id: plan.plan_id,
      session_id: plan.session_id,
      turn_id: plan.turn_id,
      ...(plan.message_id !== undefined
        ? { message_id: plan.message_id }
        : {}),
      tool: plan.tool,
      outcome,
      resolved_at: resolvedAt,
    });
    if (removed || receiptChanged) notify();
  };

  const applyLiveMutation = (mutation: PendingPlanMutation): void => {
    if (disposed) return;
    activeLoad?.mutations.push(mutation);
    if (applyMutation(plans, mutation)) notify();
  };

  const unsubscribers: Array<() => void> = [
    opts.subscribe('chat.plan_proposed', (event) => {
      const mutation = proposedMutation(event, now());
      if (resolvedPlanIds.has(mutation.plan.plan_id)) return;
      applyLiveMutation(mutation);
    }),
    opts.subscribe('chat.plan_resolved', (event) => {
      const resolved = event as ResolvedEvent;
      if (
        resolved.plan.status !== 'approved'
        && resolved.plan.status !== 'cancelled'
      ) return;
      const pending = plans.get(resolved.plan.plan_id);
      recordResolvedPlan(
        {
          plan_id: resolved.plan.plan_id,
          session_id: resolved.plan.session_id,
          turn_id: resolved.plan.turn_id,
          ...(pending?.message_id !== undefined
            ? { message_id: pending.message_id }
            : {}),
          tool: resolved.plan.tool,
        },
        resolved.plan.status,
        resolved.plan.resolved_at ?? now(),
      );
    }),
    opts.subscribe('chat.message_complete', (event) => {
      const mutation = messageLinkMutation(event);
      if (
        mutation === null
        || mutation.kind !== 'message_linked'
        || disposed
      ) return;
      activeLoad?.mutations.push(mutation);
      const plansChanged = applyMutation(plans, mutation);
      const receipt = latestResolution;
      const receiptChanged =
        receipt !== null
        && receipt.session_id === mutation.sessionId
        && receipt.turn_id === mutation.turnId
        && receipt.message_id !== mutation.messageId
          ? setLatestResolution({
              ...receipt,
              message_id: mutation.messageId,
            })
          : false;
      if (plansChanged || receiptChanged) notify();
    }),
  ];

  const refresh = (): Promise<void> => {
    if (opts.listPending === undefined || disposed) return Promise.resolve();
    const generation = ++loadGeneration;
    const load: PendingPlanSnapshotLoad = { generation, mutations: [] };
    activeLoad = load;
    phase = 'loading';
    lastError = null;
    notify();
    pendingLoad = (async () => {
      try {
        const snapshot = await opts.listPending!();
        if (
          disposed
          || activeLoad?.generation !== generation
        ) return;
        const next = new Map<string, PendingChatPlan>();
        for (const record of snapshot.plans) {
          const plan = planFromRecord(record);
          if (
            plan !== null
            && !resolvedPlanIds.has(plan.plan_id)
          ) next.set(plan.plan_id, plan);
        }
        for (const mutation of load.mutations) {
          applyMutation(next, mutation);
        }
        // If a disconnect hid the terminal broadcast, the authoritative
        // pending snapshot can still tell us that a previously visible row is
        // no longer awaiting a decision. Keep the copy neutral: only the
        // terminal event / successful local RPC can distinguish approve from
        // reject.
        const disappeared = [...plans.values()]
          .filter((plan) => !next.has(plan.plan_id))
          .sort((a, b) => b.proposed_at - a.proposed_at);
        // The snapshot is authoritative for every row it removed, even though
        // the handoff intentionally surfaces only the newest receipt.
        for (const plan of disappeared) rememberResolvedPlan(plan.plan_id);
        const latestDisappeared = disappeared[0];
        if (
          latestDisappeared !== undefined
          && latestResolution?.plan_id !== latestDisappeared.plan_id
        ) {
          setLatestResolution({
            plan_id: latestDisappeared.plan_id,
            session_id: latestDisappeared.session_id,
            turn_id: latestDisappeared.turn_id,
            ...(latestDisappeared.message_id !== undefined
              ? { message_id: latestDisappeared.message_id }
              : {}),
            tool: latestDisappeared.tool,
            outcome: 'no_longer_pending',
            resolved_at: now(),
          });
        }
        plans = next;
        activeLoad = null;
        phase = 'ready';
        lastError = null;
        notify();
      } catch (error) {
        if (
          disposed
          || activeLoad?.generation !== generation
        ) return;
        activeLoad = null;
        phase = 'error';
        lastError = error;
        // Live mutations already applied to `plans` stay visible.
        notify();
      }
    })();
    return pendingLoad;
  };

  if (opts.reconnect !== undefined && opts.listPending !== undefined) {
    unsubscribers.push(
      opts.reconnect(() => {
        if (!disposed) void refresh();
      }),
    );
  }
  if (opts.listPending !== undefined) void refresh();

  return {
    list: () => [...plans.values()],
    latestResolution: () => latestResolution,
    state: () => ({ phase, error: lastError }),
    refresh,
    whenLoaded: () => pendingLoad,
    recordResolution: (plan, decision) => {
      recordResolvedPlan(
        plan,
        decision === 'approve' ? 'approved' : 'cancelled',
        now(),
      );
    },
    dismissResolution: (plan_id) => {
      if (disposed || latestResolution?.plan_id !== plan_id) return;
      latestResolution = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      loadGeneration += 1;
      activeLoad = null;
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // Best-effort teardown.
        }
      }
      unsubscribers.length = 0;
      listeners.clear();
      plans.clear();
      resolvedPlanIds.clear();
      latestResolution = null;
    },
  };
};
