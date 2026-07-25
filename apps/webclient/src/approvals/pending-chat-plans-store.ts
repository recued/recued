/** R20 (Option A) — webclient-local aggregator of pending chat write-plans.
 *
 *  Chat plan-approvals (D-137) are proposed inside a live chat turn and held in
 *  the server's PROCESS-LOCAL plan store — no durable table, no list rpc; the
 *  only signal is the `chat.plan_proposed` broadcast. So `#approvals` (and the
 *  bell popover) can only aggregate plans seen LIVE this session: there is no
 *  reload/restart durability, which matches the substrate's deliberate design
 *  ("a server restart fairly drops every pending plan; Mary re-asks" — and
 *  D-157's no-held-promise doctrine that chat is the lone exception to). If
 *  durable chat-plan recovery is ever wanted, the right path is to route plans
 *  through the D-157 checkpoint machinery, not a bespoke table — out of scope.
 *
 *  This store subscribes to the per-pair bus, accumulates proposed plans, and
 *  drops them on `chat.plan_resolved` (which also fires when a plan is resolved
 *  from `#approvals` itself — the resolve rpc clears the server plan + fans the
 *  frame). The chat route keeps its OWN in-context plan cards; this is a second,
 *  surface-independent consumer of the same broadcasts. Lives at bootstrap
 *  scope so it survives route navigation and feeds both surfaces.
 */

import type { ToolTier } from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';

/** A pending chat write-plan, projected from the `chat.plan_proposed` frame. */
export interface PendingChatPlan {
  plan_id: string;
  session_id: string;
  turn_id: string;
  tool: string;
  tier: ToolTier;
  args: unknown;
  /** Client arrival stamp (epoch ms). The bus frame carries no timestamp, so
   *  the store stamps proposal arrival — the unified `#approvals` list sorts
   *  newest-first across gates / asks / plans on this same axis. */
  proposed_at: number;
}

export interface PendingChatPlansStore {
  /** Pending plans in proposal order (the consumer re-sorts for display). */
  list(): ReadonlyArray<PendingChatPlan>;
  /** Register a change listener; returns an unsubscribe fn. Fires on every
   *  add (proposed) / drop (resolved). */
  subscribe(listener: () => void): () => void;
  /** Drop all bus subscriptions + listeners + held plans. Idempotent. */
  dispose(): void;
}

export interface CreatePendingChatPlansStoreOptions {
  /** Broadcast subscription seam (`subscriber.on`). The store names
   *  `chat.plan_proposed` + `chat.plan_resolved`; both are in
   *  `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` so the server fans them (D-169 TR-10). */
  subscribe: BroadcastSubscriber['on'];
  /** Clock seam (default `Date.now`) for the proposal arrival stamp. */
  now?: () => number;
}

export const createPendingChatPlansStore = (
  opts: CreatePendingChatPlansStoreOptions,
): PendingChatPlansStore => {
  const now = opts.now ?? Date.now;
  // Keyed by plan_id, insertion-ordered. A re-proposal of an edited plan
  // arrives under a NEW plan_id (the original is left cancelled for audit), so
  // a key collision only happens on a duplicate frame — last-writer-wins is
  // safe either way.
  const plans = new Map<string, PendingChatPlan>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One broken consumer must not stop the others.
      }
    }
  };

  const unsubscribers: Array<() => void> = [
    opts.subscribe('chat.plan_proposed', (event) => {
      if (disposed) return;
      plans.set(event.plan_id, {
        plan_id: event.plan_id,
        session_id: event.session_id,
        turn_id: event.turn_id,
        tool: event.tool,
        tier: event.tier,
        args: event.args,
        proposed_at: now(),
      });
      notify();
    }),
    opts.subscribe('chat.plan_resolved', (event) => {
      if (disposed) return;
      // The resolved frame carries the full plan; drop by its id.
      if (plans.delete(event.plan.plan_id)) notify();
    }),
  ];

  return {
    list: () => [...plans.values()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
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
    },
  };
};
