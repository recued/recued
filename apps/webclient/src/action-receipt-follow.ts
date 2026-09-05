/** Route-independent owner follow-through for approved gated operations.
 *
 * The `execution/action_changed` broadcast is only an invalidation. This
 * follower reads the durable receipt, waits until its stable approval group is
 * terminal, then presents one aggregate outcome. It never raises a second
 * notification or treats a peer handoff as a spinner. */

import type {
  GatedActionApprovalGroup,
  GatedActionGetResponse,
  GatedActionListRequest,
  GatedActionListResponse,
} from '@recued/contracts';
import type { BroadcastSubscriber } from './realtime/subscriber.js';

const TERMINAL_ACTION_STATUSES: NonNullable<GatedActionListRequest['status']> = [
  'succeeded',
  'partial',
  'failed',
  'dispatched',
  'denied',
  'cancelled',
  'in_doubt',
];

export const ACTION_RECEIPT_DELIVERY_STORAGE_KEY =
  'recued.action-receipt-delivery.v4';
const DEFAULT_RECONCILE_LIMIT = 200;
const DEFAULT_MAX_DELIVERED_KEYS = 256;
const DEFAULT_MAX_REQUESTED_REVISIONS = 512;
const DEFAULT_RETRY_INITIAL_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
export const ACTION_RECEIPT_RECONCILE_POLL_INTERVAL_MS = 5_000;
const MAX_RECONCILE_PAGES = 10_000;

/** Deliberately matches the small, synchronous part of browser `Storage` so a
 * caller may inject localStorage, a namespaced adapter, or a deterministic
 * test double without coupling this route-independent follower to bootstrap's
 * profile store. Only opaque receipt/group identities and counts are stored. */
export interface ActionReceiptDeliveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ActionReceiptFollowOptions {
  subscribe: BroadcastSubscriber['on'];
  getAction: (args: { action_ref: string }) => Promise<GatedActionGetResponse>;
  /** Durable cold-start/reconnect reconciliation. Optional for older embeds;
   * without it the follower remains live-invalidation-only. */
  listActions?: (args: GatedActionListRequest) => Promise<GatedActionListResponse>;
  /** Persists already-presented aggregate outcomes across page recreation. */
  deliveryStorage?: ActionReceiptDeliveryStorage;
  deliveryStorageKey?: string;
  reconcileLimit?: number;
  maxDeliveredKeys?: number;
  maxRequestedRevisions?: number;
  /** Failed durable reads retry while the socket remains connected; otherwise
   * a one-off rpc failure after an invalidation would stay invisible until a
   * later reconnect. Tests may inject a deterministic timer. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  setRetryTimer?: (
    handler: () => void,
    delayMs: number,
  ) => { cancel: () => void };
  /** A connected owner periodically re-reads the durable change clock because
   * standalone CLI/MCP processes share SQLite but not the daemon's in-process
   * event bus. This is a one-shot timer that is re-armed after each complete
   * scan, so a slow read can never overlap itself. */
  pollIntervalMs?: number;
  setPollTimer?: (
    handler: () => void,
    delayMs: number,
  ) => { cancel: () => void };
  present: (toast: { title: string; text: string }) => void;
  onError?: (error: unknown) => void;
}

export interface ActionReceiptFollow {
  /** Enable/disable periodic durable reconciliation with the live connection.
   * Enabling takes effect after the caller's immediate subscribe-then-reconcile
   * pass; disabling cancels the outstanding one-shot poll. */
  setConnected(connected: boolean): void;
  /** Clear connection-local invalidation revisions before a fresh subscription.
   * Archive restore can reuse action refs with lower revisions; durable
   * reconciliation remains the source of truth across the disconnect. */
  prepareReconnect(): void;
  /** Reconcile terminal receipts missed while offline. Safe to call on every
   * connected transition; concurrent calls collapse onto one list request. */
  reconcile(): Promise<void>;
  dispose(): void;
}

const titleFor = (group: GatedActionApprovalGroup): string => {
  const plural = group.action_refs.length > 1 || group.items > 1;
  switch (group.status) {
    case 'succeeded': return plural ? 'Approved actions completed' : 'Approved action completed';
    case 'partial': return 'Approved actions partially completed';
    case 'failed': return plural ? 'Approved actions failed' : 'Approved action failed';
    case 'dispatched': return plural ? 'Approved actions dispatched' : 'Approved action dispatched';
    case 'denied': return plural ? 'Actions denied' : 'Action denied';
    case 'cancelled': return plural ? 'Actions cancelled' : 'Action cancelled';
    case 'in_doubt': return plural ? 'Action outcomes need review' : 'Action outcome needs review';
    // A non-terminal group is never presented.
    case 'awaiting_approval': return 'Waiting for approval';
    case 'dispatching': return 'Approved action dispatching';
  }
};

const presentationKey = (group: GatedActionApprovalGroup): string =>
  [
    group.approval_ref,
    group.status,
    group.items,
    group.succeeded,
    group.failed,
    group.dispatched,
    group.denied,
    group.cancelled,
    group.in_doubt,
  ].join(':');

const rememberNewestGroup = (
  target: Map<string, GatedActionApprovalGroup>,
  group: GatedActionApprovalGroup,
): void => {
  const prior = target.get(group.approval_ref);
  if (
    prior === undefined
    || group.change_seq > prior.change_seq
    || (group.change_seq === prior.change_seq
      && presentationKey(group).localeCompare(presentationKey(prior)) > 0)
  ) target.set(group.approval_ref, group);
};

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) || value < 1
    ? fallback
    : Math.floor(value);

interface ActionReceiptDeliveryState {
  change_epoch?: string;
  since_change_seq?: number;
  /** Every processed outcome exactly at the inclusive change watermark. This set is
   * deliberately not LRU-trimmed: a later action can acquire the same
   * sequence value with any opaque approval ref, so a lexicographic frontier
   * would be capable of skipping it forever. */
  delivered: string[];
  /** Bounded duplicate guard for live outcomes newer than the last complete
   * durable scan and for harmless late metadata revisions. */
  recent: string[];
  /** Live outcomes not yet covered by a complete durable scan. Kept separately
   * from the bounded recent guard so a large live burst cannot evict an early
   * key before the coalesced scan advances the durable frontier. */
  pending: string[];
}

const readDeliveryState = (
  storage: ActionReceiptDeliveryStorage | undefined,
  key: string,
  max: number,
  reportError: (error: unknown) => void,
): ActionReceiptDeliveryState => {
  if (storage === undefined) return { delivered: [], recent: [], pending: [] };
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { delivered: [], recent: [], pending: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null
      || typeof parsed !== 'object'
      || !Array.isArray((parsed as { delivered?: unknown }).delivered)
    ) return { delivered: [], recent: [], pending: [] };
    const version = (parsed as { version?: unknown }).version;
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
      return { delivered: [], recent: [], pending: [] };
    }
    const delivered = (parsed as { delivered: unknown[] }).delivered
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (version !== 4) {
      const legacyRecent = (version === 2 || version === 3)
        && Array.isArray((parsed as { recent?: unknown }).recent)
        ? (parsed as { recent: unknown[] }).recent.filter(
            (entry): entry is string => typeof entry === 'string' && entry.length > 0,
          )
        : [];
      return {
        delivered: [],
        recent: [...new Set([...delivered, ...legacyRecent])].slice(-max),
        pending: [],
      };
    }
    const rawEpoch = (parsed as { change_epoch?: unknown }).change_epoch;
    const rawSince = (parsed as { since_change_seq?: unknown }).since_change_seq;
    const changeEpoch = typeof rawEpoch === 'string' && rawEpoch.length > 0
      ? rawEpoch
      : undefined;
    const sinceChangeSeq = typeof rawSince === 'number'
      && Number.isInteger(rawSince)
      && rawSince >= 0
      ? rawSince
      : undefined;
    const rawRecent = (parsed as { recent?: unknown }).recent;
    const recent = Array.isArray(rawRecent)
      ? rawRecent.filter((entry): entry is string =>
          typeof entry === 'string' && entry.length > 0)
      : [];
    const rawPending = (parsed as { pending?: unknown }).pending;
    const pending = Array.isArray(rawPending)
      ? rawPending.filter((entry): entry is string =>
          typeof entry === 'string' && entry.length > 0)
      : [];
    return {
      ...(changeEpoch !== undefined && sinceChangeSeq !== undefined
        ? { change_epoch: changeEpoch, since_change_seq: sinceChangeSeq }
        : {}),
      delivered: changeEpoch !== undefined && sinceChangeSeq !== undefined
        ? [...new Set(delivered)]
        : [],
      recent: [...new Set(recent)].slice(-max),
      pending: changeEpoch !== undefined && sinceChangeSeq !== undefined
        ? [...new Set(pending)]
        : [],
    };
  } catch (error) {
    reportError(error);
    return { delivered: [], recent: [], pending: [] };
  }
};

const cursorKey = (cursor: { change_seq: number; action_ref: string }): string =>
  `${cursor.change_seq}:${cursor.action_ref}`;

const isStrictlyEarlierCursor = (
  candidate: { change_seq: number; action_ref: string },
  previous: { change_seq: number; action_ref: string },
): boolean => candidate.change_seq < previous.change_seq
  || (candidate.change_seq === previous.change_seq
    && candidate.action_ref.localeCompare(previous.action_ref) < 0);

export const followActionReceipts = (
  options: ActionReceiptFollowOptions,
): ActionReceiptFollow => {
  let disposed = false;
  let reconcileInFlight: Promise<void> | null = null;
  const storageKey = options.deliveryStorageKey ?? ACTION_RECEIPT_DELIVERY_STORAGE_KEY;
  const reconcileLimit = positiveInteger(options.reconcileLimit, DEFAULT_RECONCILE_LIMIT);
  const maxDeliveredKeys = positiveInteger(
    options.maxDeliveredKeys,
    DEFAULT_MAX_DELIVERED_KEYS,
  );
  const maxRequestedRevisions = positiveInteger(
    options.maxRequestedRevisions,
    DEFAULT_MAX_REQUESTED_REVISIONS,
  );
  const retryInitialMs = positiveInteger(options.retryInitialMs, DEFAULT_RETRY_INITIAL_MS);
  const retryMaxMs = Math.max(
    retryInitialMs,
    positiveInteger(options.retryMaxMs, DEFAULT_RETRY_MAX_MS),
  );
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs,
    ACTION_RECEIPT_RECONCILE_POLL_INTERVAL_MS,
  );
  const setRetryTimer = options.setRetryTimer ?? ((handler, delayMs) => {
    const id = globalThis.setTimeout(handler, delayMs);
    return { cancel: () => globalThis.clearTimeout(id) };
  });
  const setPollTimer = options.setPollTimer ?? ((handler, delayMs) => {
    const id = globalThis.setTimeout(handler, delayMs);
    return { cancel: () => globalThis.clearTimeout(id) };
  });
  const reportError = (error: unknown): void => {
    if (disposed) return;
    try { options.onError?.(error); } catch { /* telemetry must not re-enter */ }
  };
  const requestedRevision = new Map<string, number>();
  const stored = readDeliveryState(
    options.deliveryStorage,
    storageKey,
    maxDeliveredKeys,
    reportError,
  );
  let deliveryChangeEpoch = stored.change_epoch;
  let deliverySinceChangeSeq = stored.since_change_seq;
  const deliveredAtSince = new Set(stored.delivered);
  const recentDelivered = new Set(stored.recent);
  const pendingLiveDelivered = new Set(stored.pending);
  const sessionPresented = new Set<string>();
  // Live terminal reads can win the subscribe-before-reconcile race. Do not
  // render them while the durable lineage is unknown: queue the newest group
  // and fold it into the first stable-epoch scan. A browser crash in this
  // window therefore cannot show an outcome and then forget which epoch owned
  // its duplicate-suppression key.
  const pendingLiveGroups = new Map<string, GatedActionApprovalGroup>();
  let epochUncertain = false;
  let connectionGeneration = 0;
  let liveTerminalGeneration = 0;
  let reconcileAgain = false;
  let retryDelayMs = retryInitialMs;
  let retryTimer: { cancel: () => void } | null = null;
  let pollingConnected = false;
  let pollTimer: { cancel: () => void } | null = null;

  const cancelRetry = (): void => {
    retryTimer?.cancel();
    retryTimer = null;
    retryDelayMs = retryInitialMs;
  };

  const cancelPoll = (): void => {
    pollTimer?.cancel();
    pollTimer = null;
  };

  const schedulePoll = (): void => {
    if (
      disposed
      || !pollingConnected
      || options.listActions === undefined
      || pollTimer !== null
      || reconcileInFlight !== null
    ) return;
    pollTimer = setPollTimer(() => {
      pollTimer = null;
      void reconcile();
    }, pollIntervalMs);
  };

  const scheduleRetry = (): void => {
    if (
      disposed
      || !pollingConnected
      || options.listActions === undefined
      || retryTimer !== null
    ) return;
    const delayMs = retryDelayMs;
    const generation = connectionGeneration;
    retryDelayMs = Math.min(retryMaxMs, retryDelayMs * 2);
    retryTimer = setRetryTimer(() => {
      retryTimer = null;
      if (
        disposed
        || !pollingConnected
        || generation !== connectionGeneration
      ) return;
      void reconcile();
    }, delayMs);
  };

  const persistDelivered = (): void => {
    if (options.deliveryStorage === undefined) return;
    try {
      options.deliveryStorage.setItem(storageKey, JSON.stringify({
        version: 4,
        ...(deliveryChangeEpoch !== undefined && deliverySinceChangeSeq !== undefined
          ? {
              change_epoch: deliveryChangeEpoch,
              since_change_seq: deliverySinceChangeSeq,
            }
          : {}),
        delivered: [...deliveredAtSince],
        recent: [...recentDelivered],
        pending: [...pendingLiveDelivered],
      }));
    } catch (error) {
      reportError(error);
    }
  };

  const rememberBounded = (set: Set<string>, key: string, max: number): void => {
    set.delete(key);
    set.add(key);
    while (set.size > max) {
      const oldest = set.values().next().value as string | undefined;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  };

  const rememberDelivered = (key: string): void => {
    rememberBounded(recentDelivered, key, maxDeliveredKeys);
    persistDelivered();
  };

  const presentGroup = (
    group: GatedActionApprovalGroup,
    source: 'live' | 'reconcile',
  ): boolean => {
    if (disposed || !group.terminal) return false;
    const key = presentationKey(group);
    if (
      deliveredAtSince.has(key)
      || recentDelivered.has(key)
      || sessionPresented.has(key)
      || pendingLiveDelivered.has(key)
    ) return true;
    // Presentation and the in-memory delivery mark occur without an await, so
    // a live invalidation racing a reconnect list cannot double-present. Mark
    // only after `present` returns: a renderer failure remains retryable.
    options.present({
      title: titleFor(group),
      text: group.status_message,
    });
    rememberBounded(sessionPresented, key, maxDeliveredKeys);
    if (source === 'live') pendingLiveDelivered.add(key);
    rememberDelivered(key);
    return true;
  };

  const baselineHasPassed = (
    group: GatedActionApprovalGroup,
    key: string,
    baseline: { since_change_seq?: number; delivered: ReadonlySet<string> },
  ): boolean => {
    if (baseline.since_change_seq === undefined) return false;
    if (group.change_seq < baseline.since_change_seq) return true;
    if (group.change_seq > baseline.since_change_seq) return false;
    return baseline.delivered.has(key);
  };

  const advanceDeliveryFrontier = (
    group: GatedActionApprovalGroup,
    key: string,
  ): void => {
    if (deliverySinceChangeSeq === undefined || group.change_seq > deliverySinceChangeSeq) {
      deliverySinceChangeSeq = group.change_seq;
      deliveredAtSince.clear();
      deliveredAtSince.add(key);
    } else if (group.change_seq === deliverySinceChangeSeq) {
      deliveredAtSince.add(key);
    }
    persistDelivered();
  };

  const rememberRequestedRevision = (actionRef: string, revision: number): void => {
    requestedRevision.delete(actionRef);
    requestedRevision.set(actionRef, revision);
    while (requestedRevision.size > maxRequestedRevisions) {
      const oldest = requestedRevision.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      requestedRevision.delete(oldest);
    }
  };

  const reconcileAfterLiveTerminal = (): void => {
    if (disposed || options.listActions === undefined) return;
    cancelPoll();
    if (reconcileInFlight !== null) {
      // The current page set may predate this terminal mutation. One coalesced
      // follow-up scan advances the durable frontier past every live key, so
      // bounded recent/session guards can be safely evicted later.
      reconcileAgain = true;
      return;
    }
    void reconcile();
  };

  const unsubscribe = options.subscribe('execution', (event) => {
    if (
      disposed
      || event.op !== 'action_changed'
      || typeof event.action_ref !== 'string'
      || event.action_ref.length === 0
      || typeof event.action_revision !== 'number'
      || !Number.isInteger(event.action_revision)
    ) return;
    const actionRef = event.action_ref;
    const actionRevision = event.action_revision;
    const generation = connectionGeneration;
    const prior = requestedRevision.get(actionRef) ?? 0;
    if (actionRevision <= prior) return;
    rememberRequestedRevision(actionRef, actionRevision);

    void options.getAction({ action_ref: actionRef }).then((response) => {
      if (disposed || generation !== connectionGeneration) return;
      if (!response.group.terminal) return;
      liveTerminalGeneration += 1;
      if (epochUncertain && options.listActions !== undefined) {
        rememberNewestGroup(pendingLiveGroups, response.group);
      } else {
        presentGroup(response.group, 'live');
      }
      reconcileAfterLiveTerminal();
    }).catch((error) => {
      if (disposed || generation !== connectionGeneration) return;
      // The event is an invalidation, not the source of truth. Let an
      // at-least-once replay of this exact revision retry a failed durable
      // read instead of treating the failed request as if it had observed it.
      if (requestedRevision.get(actionRef) === actionRevision) {
        requestedRevision.delete(actionRef);
      }
      reportError(error);
      scheduleRetry();
    });
  });

  const reconcileOnce = async (): Promise<void> => {
    const liveGenerationAtStart = liveTerminalGeneration;
    const baseline = {
      ...(deliveryChangeEpoch !== undefined && deliverySinceChangeSeq !== undefined
        ? {
            change_epoch: deliveryChangeEpoch,
            since_change_seq: deliverySinceChangeSeq,
          }
        : {}),
      delivered: new Set(deliveredAtSince),
    };
    const groupsByApproval = new Map<string, GatedActionApprovalGroup>();
    let before: GatedActionListRequest['before'];
    let previousCursor: GatedActionListRequest['before'];
    const seenCursors = new Set<string>();
    let responseClock: { epoch: string; floor: number } | undefined;
    for (let page = 0; page < MAX_RECONCILE_PAGES; page += 1) {
      const response = await options.listActions!({
        status: [...TERMINAL_ACTION_STATUSES],
        limit: reconcileLimit,
        ...(baseline.change_epoch !== undefined
          && baseline.since_change_seq !== undefined
          ? {
              since_change_epoch: baseline.change_epoch,
              since_change_seq: baseline.since_change_seq,
            }
          : {}),
        ...(before !== undefined ? { before } : {}),
      });
      if (!Array.isArray(response.groups)
        || !Array.isArray(response.receipts)
        || typeof response.change_epoch !== 'string'
        || response.change_epoch.length === 0
        || !Number.isInteger(response.change_floor)
        || response.change_floor < 0) {
        throw new Error('execution.action.list returned an invalid page');
      }
      if (responseClock === undefined) {
        responseClock = {
          epoch: response.change_epoch,
          floor: response.change_floor,
        };
      } else if (response.change_epoch !== responseClock.epoch
        || response.change_floor !== responseClock.floor) {
        throw new Error('execution.action.list changed epoch while paging');
      }
      for (const group of response.groups) {
        if (!group.terminal) continue;
        rememberNewestGroup(groupsByApproval, group);
      }
      const next = response.next_cursor;
      if (next === undefined) break;
      if (
        typeof next.change_seq !== 'number'
        || !Number.isInteger(next.change_seq)
        || next.change_seq < 1
        || typeof next.action_ref !== 'string'
        || next.action_ref.length === 0
        || (previousCursor !== undefined
          && !isStrictlyEarlierCursor(next, previousCursor))
        || seenCursors.has(cursorKey(next))
      ) {
        throw new Error('execution.action.list returned a non-progressing cursor');
      }
      previousCursor = next;
      seenCursors.add(cursorKey(next));
      before = next;
      if (page === MAX_RECONCILE_PAGES - 1) {
        throw new Error('execution.action.list exceeded the reconciliation page limit');
      }
    }
    if (disposed) return;
    if (responseClock === undefined) {
      throw new Error('execution.action.list returned no clock');
    }
    const baselineForClock = baseline.change_epoch === responseClock.epoch
      ? baseline
      : {
          change_epoch: responseClock.epoch,
          since_change_seq: responseClock.floor,
          delivered: new Set<string>(),
        };
    if (deliveryChangeEpoch !== responseClock.epoch) {
      deliveryChangeEpoch = responseClock.epoch;
      deliverySinceChangeSeq = responseClock.floor;
      deliveredAtSince.clear();
      recentDelivered.clear();
      sessionPresented.clear();
      pendingLiveDelivered.clear();
    } else if (deliverySinceChangeSeq === undefined) {
      deliverySinceChangeSeq = responseClock.floor;
    }
    epochUncertain = false;
    persistDelivered();
    // Fold terminal reads that arrived after subscription but before the
    // lineage read into this stable snapshot. A queued group can be newer than
    // the page that carried its approval ref, so the same change-seq ordering
    // chooses the durable winner.
    for (const group of pendingLiveGroups.values()) {
      rememberNewestGroup(groupsByApproval, group);
    }
    // The RPC returns newest-first; present oldest-first so an offline burst
    // reads chronologically and the newest outcome remains at the top of the
    // shared toast stack.
    const groups = [...groupsByApproval.values()].sort((a, b) =>
      a.change_seq - b.change_seq || a.approval_ref.localeCompare(b.approval_ref));
    for (const group of groups) {
      const key = presentationKey(group);
      if (baselineHasPassed(group, key, baselineForClock)) continue;
      if (!presentGroup(group, 'reconcile')) continue;
      // Only a completed, fully-paged snapshot advances the durable scan
      // frontier. Live invalidations never leap over older offline outcomes.
      advanceDeliveryFrontier(group, key);
    }
    pendingLiveGroups.clear();
    if (liveTerminalGeneration === liveGenerationAtStart) {
      pendingLiveDelivered.clear();
      persistDelivered();
    }
    retryDelayMs = retryInitialMs;
  };

  function reconcile(): Promise<void> {
    if (disposed || options.listActions === undefined) return Promise.resolve();
    if (reconcileInFlight !== null) return reconcileInFlight;
    cancelPoll();
    let completed = false;
    const pending = (async (): Promise<void> => {
      do {
        reconcileAgain = false;
        await reconcileOnce();
      } while (!disposed && reconcileAgain);
      completed = true;
    })().catch((error) => {
      reconcileAgain = false;
      reportError(error);
      scheduleRetry();
    }).finally(() => {
      if (reconcileInFlight === pending) reconcileInFlight = null;
      if (disposed) return;
      if (completed && reconcileAgain) {
        reconcileAgain = false;
        void reconcile();
        return;
      }
      if (completed) schedulePoll();
    });
    reconcileInFlight = pending;
    return pending;
  }

  return {
    setConnected(connected) {
      if (disposed) return;
      pollingConnected = connected;
      if (!connected) {
        connectionGeneration += 1;
        requestedRevision.clear();
        pendingLiveGroups.clear();
        cancelPoll();
        cancelRetry();
      }
    },
    prepareReconnect() {
      if (disposed) return;
      pollingConnected = false;
      cancelPoll();
      connectionGeneration += 1;
      requestedRevision.clear();
      epochUncertain = true;
      pendingLiveGroups.clear();
    },
    reconcile,
    dispose() {
      if (disposed) return;
      disposed = true;
      requestedRevision.clear();
      deliveredAtSince.clear();
      recentDelivered.clear();
      sessionPresented.clear();
      pendingLiveGroups.clear();
      cancelRetry();
      cancelPoll();
      try { unsubscribe(); } catch { /* subscriber owns teardown */ }
    },
  };
};
