/** D-119 Phase 10 — server-side approval rpc handlers.
 *
 *  Three rpc methods:
 *    `approval.list`        → snapshot of every pending approval
 *    `approval.resolve`     → first-write-wins; subsequent resolves
 *                             return `accepted: false` + winner info
 *    `approval.subscribe`   → returns the snapshot + the current
 *                             subscription seq counter; the server
 *                             pushes `approval_changed` events to
 *                             subscribed clients on every list change
 *
 *  The store is in-memory (Map<approval_id, …>) by design — approvals
 *  are short-lived (5-min default timeout per `ApprovalPendingRecord`)
 *  and lose meaning after a server restart. Recipes that need to
 *  recover from server restart fall back to the engine's existing
 *  per-run prompt.
 *
 *  First-write-wins resolution: the first `approval.resolve` for a
 *  given `approval_id` records the winner; subsequent attempts get a
 *  `winner_instance` echo so the losing client can show "Decided on
 *  Work Laptop just now" and re-fetch.
 *
 *  Push channel: subscribers are tracked per-WS-client. On every
 *  list change the handler bumps the seq counter and calls each
 *  subscriber's `pushEvent` callback (wired by `ws-server.ts` through
 *  the same channel that delivers `instance_revoked`). */

import {
  RpcError,
  type HandlerSlice,
  type ServerApprovalResolveResult,
  type ServerApprovalSubscriptionEvent,
  type ServerPendingApproval,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';

interface PendingEntry extends ServerPendingApproval {
  /** First resolution to land. Subsequent resolves see this and
   *  return `accepted: false`. */
  resolution?: {
    decision: 'approve' | 'reject' | 'cancel';
    winner_instance: string;
    resolved_at: number;
    note?: string;
  };
}

export interface ApprovalStore {
  /** Snapshot of every still-pending approval. Server enumerates
   *  this for `approval.list`. */
  list(): ServerPendingApproval[];
  /** Add a pending approval to the store. Called by the engine /
   *  watcher dispatcher when an approval is generated. Bumps the
   *  subscription seq + pushes to subscribers. */
  add(record: ServerPendingApproval): void;
  /** First-write-wins resolve. Returns the result envelope so the
   *  rpc caller can echo to the user. */
  resolve(
    approval_id: string,
    decision: 'approve' | 'reject' | 'cancel',
    by_instance: string,
    note?: string,
  ): ServerApprovalResolveResult;
  /** Drop a pending entry without recording a resolution (e.g. on
   *  timeout or cascade cancellation). Bumps seq + pushes. */
  remove(approval_id: string): void;
  /** Register a subscriber. Returns an unsubscribe function the
   *  caller (ws-server) calls on disconnect. */
  subscribe(
    client_instance: string,
    pushEvent: (ev: ServerApprovalSubscriptionEvent) => void,
  ): () => void;
  /** Current seq counter — exposed so `approval.subscribe` can echo
   *  it to the client for gap detection. */
  seq(): number;
}

/** Optional observer callbacks invoked alongside the existing
 *  `approval_changed` broadcast. Each fires for the matching
 *  store transition (add → pending; resolve / remove → resolved).
 *  D-121 Phase 6 wires these to the realtime broadcast bus so
 *  webapp / extension viewers see per-id approval events without
 *  needing the legacy `seq + pending_count` aggregate. */
export interface ApprovalStoreObserver {
  onPending?: (approval_id: string) => void;
  onResolved?: (approval_id: string) => void;
}

export const createApprovalStore = (
  now: () => number = Date.now,
  observer: ApprovalStoreObserver = {},
): ApprovalStore => {
  const pending = new Map<string, PendingEntry>();
  let seqCounter = 0;
  const subscribers = new Map<string, (ev: ServerApprovalSubscriptionEvent) => void>();

  const broadcastChange = (): void => {
    seqCounter++;
    const ev: ServerApprovalSubscriptionEvent = {
      seq: seqCounter,
      pending_count: pending.size,
    };
    for (const push of subscribers.values()) {
      try { push(ev); }
      catch { /* non-fatal — subscriber callback is opaque */ }
    }
  };

  return {
    list() {
      const out: ServerPendingApproval[] = [];
      for (const e of pending.values()) {
        if (e.resolution) continue;
        // Strip the `resolution` field — not part of the wire shape.
        const { resolution: _r, ...rest } = e;
        void _r;
        out.push(rest);
      }
      return out;
    },

    add(record) {
      // Skip if already present — idempotent on duplicate adds.
      if (pending.has(record.approval_id)) return;
      pending.set(record.approval_id, { ...record });
      broadcastChange();
      // D-121 Phase 6 — surface the per-id event to the realtime bus
      // (webapp / extension live indicators). Errors swallowed so a
      // bad observer never breaks the legacy approval_changed path.
      try { observer.onPending?.(record.approval_id); }
      catch { /* swallow */ }
    },

    resolve(approval_id, decision, by_instance, note) {
      const entry = pending.get(approval_id);
      if (!entry) {
        throw new RpcError(
          'not_found',
          `Approval '${approval_id}' is not pending — already resolved or expired`,
          404,
        );
      }
      // First-write-wins: if there's already a resolution, return
      // it instead of overwriting.
      if (entry.resolution) {
        return {
          approval_id,
          accepted: false,
          winner_instance: entry.resolution.winner_instance,
          winner_decision: entry.resolution.decision,
        };
      }
      entry.resolution = {
        decision,
        winner_instance: by_instance,
        resolved_at: now(),
        ...(note !== undefined ? { note } : {}),
      };
      // Drop from pending list — broadcast the new count.
      pending.delete(approval_id);
      broadcastChange();
      try { observer.onResolved?.(approval_id); }
      catch { /* swallow */ }
      return { approval_id, accepted: true };
    },

    remove(approval_id) {
      if (!pending.has(approval_id)) return;
      pending.delete(approval_id);
      broadcastChange();
      try { observer.onResolved?.(approval_id); }
      catch { /* swallow */ }
    },

    subscribe(client_instance, pushEvent) {
      subscribers.set(client_instance, pushEvent);
      return () => {
        subscribers.delete(client_instance);
      };
    },

    seq() {
      return seqCounter;
    },
  };
};

export interface ApprovalHandlerDeps {
  /** Backing store. Composed once at server boot in bin.ts. */
  store: ApprovalStore;
  /** Push-to-client transport. ws-server passes a callback that
   *  serializes the event onto the client's existing pair-WS push
   *  channel using the same `type` field convention as
   *  `instance_revoked`. The handler captures this via the
   *  `subscribe` method's `pushEvent` argument. */
  pushToClient: (
    client: WsClient,
    payload: { type: 'approval_changed'; event: ServerApprovalSubscriptionEvent },
  ) => void;
}

export type ApprovalMethods =
  | 'approval.list'
  | 'approval.resolve'
  | 'approval.subscribe';

export const makeApprovalHandlers = (
  deps: ApprovalHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ApprovalMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['approval.list', 'approval.resolve', 'approval.subscribe'],
    handlers: {
      'approval.list': async () => ({ approvals: deps.store.list() }),

      'approval.resolve': async (args, client) => {
        if (typeof args.approval_id !== 'string' || !args.approval_id) {
          throw new RpcError('bad_request', 'approval_id is required', 400);
        }
        if (
          args.decision !== 'approve'
          && args.decision !== 'reject'
          && args.decision !== 'cancel'
        ) {
          throw new RpcError('bad_request', 'decision must be approve / reject / cancel', 400);
        }
        const by_instance = client.instance_id ?? 'unknown';
        const note = typeof args.note === 'string' ? args.note : undefined;
        return deps.store.resolve(args.approval_id, args.decision, by_instance, note);
      },

      'approval.subscribe': async (_args, client) => {
        const instance = client.instance_id ?? `anon-${Math.random().toString(36).slice(2)}`;
        // The push callback closes over the client + the deps
        // transport. ws-server wires `pushToClient` to its `send`
        // helper, so subscribers see events as they're broadcast.
        deps.store.subscribe(instance, (ev) => {
          deps.pushToClient(client, { type: 'approval_changed', event: ev });
        });
        return {
          approvals: deps.store.list(),
          seq: deps.store.seq(),
        };
      },
    },
  };
};
