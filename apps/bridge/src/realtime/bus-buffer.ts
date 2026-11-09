/** D-169 P2 Slice 1 — service-worker bus buffer.
 *
 *  A small, bounded, in-memory accumulator the SW feeds from the
 *  broadcast-bus subscriber (`subscriber.ts`). It maps the live
 *  `ServerEvent` stream into the three side-panel list-section shapes
 *  (N.5 #2/#3/#4) and hands a serialisable snapshot to the side-panel
 *  `fetch-frames` poll responder.
 *
 *  Architecture (N.4 / I-7 — no retention substrate):
 *   - The SW buffer is the SINGLE accumulator; the side-panel store is a
 *     pure render-through cache re-applied wholesale on each poll tick.
 *     The SW↔side-panel hop is a `chrome.runtime.sendMessage` round-trip,
 *     which structurally CLONES the snapshot — so the store never holds a
 *     reference to (and `freezeState` never freezes) the buffer's live
 *     arrays.
 *   - Live-only: the buffer holds nothing across SW restart. Bus events
 *     fired while the SW was down are NOT replayed; the historical slice
 *     (recent executions / notifications / pending asks via rpc) is a
 *     follow-on slice (Slice 2). On a pair transition the SW reboots, so
 *     the buffer starts empty for the new pair.
 *
 *  Bus events carry a monotonic `cursor` but no wall-clock timestamp, so
 *  the buffer stamps receipt time via the injected `now` clock. For a
 *  live stream "when the bridge saw it" ≈ "when it fired" (sub-second);
 *  the historical rpc slice (Slice 2) carries authoritative server
 *  timestamps. */

import type { ServerEvent } from '@recued/contracts';
import type { SidePanelStoreState } from '../side-panel/store/local-store.js';

/** The three list-section row shapes, derived from the store so the
 *  buffer + the store + the wire snapshot stay in lockstep. */
export type BridgeBusRecipeResult = SidePanelStoreState['recipe_results']['items'][number];
export type BridgeBusNotification = SidePanelStoreState['notifications']['items'][number];
export type BridgeBusApproval = SidePanelStoreState['approvals']['items'][number];

/** Serialisable snapshot returned to the side panel each poll tick.
 *  Plain arrays (newest-first) — survives the `sendMessage` clone. */
export interface BridgeBusBufferSnapshot {
  recipe_results: ReadonlyArray<BridgeBusRecipeResult>;
  notifications: ReadonlyArray<BridgeBusNotification>;
  approvals: ReadonlyArray<BridgeBusApproval>;
}

export interface BridgeBusBuffer {
  /** Fold one bus event into the buffer. Unhandled kinds are a no-op
   *  (the subscriber may surface kinds a future slice consumes). */
  apply(event: ServerEvent): void;
  /** D-169 P2 Slice 2 — REPLACE all three sections with the rpc-fetched
   *  historical slice (`execution.recent` / `notification.recent` /
   *  `notification.pending_asks`). Called from the SW's `onConnected` hook
   *  on every (re)connect: the rpc slice is the AUTHORITATIVE "what
   *  happened recently" view (spec § A.5 / DL-6), so it wholesale-replaces
   *  rather than merges. Live bus events that arrive AFTER the seed
   *  prepend on top via `apply`; a reconnect re-seed discards the prior
   *  connection's live-accumulated rows and restores the fresh
   *  authoritative base (which itself includes anything still recent in
   *  the durable stores) — this self-heals any transient duplicate from
   *  the tiny seed-vs-subscribe race without a per-row dedup key. Each
   *  section is capped like the live path.
   *
   *  KNOWN LIMITATION (Codex P2 fold, deferred): executions + asks carry a
   *  durable wire id (`run_id` / `ask_id`) shared by the live frame + the
   *  rpc row, so a cross-source collision dedups cleanly. Notifications do
   *  NOT — the live `notification.notify` frame has only a monotonic
   *  cursor (synth id `notify:<cursor>`), while the rpc row carries the
   *  durable `notification_fired` activity id. So a notify that fires in
   *  the tiny window between the seed's `notification.recent` snapshot and
   *  the subscription can be REPLACED out of the live view by the seed and
   *  is briefly absent until the next mount/reconnect fetch — but it is
   *  durably persisted server-side and reappears then (never lost). The
   *  clean fix (a durable id + timestamp on the `notification.notify` bus
   *  event so live + rpc rows share a key) is a contracts change deferred
   *  to a follow-on. */
  seed(snapshot: BridgeBusBufferSnapshot): void;
  /** Current newest-first snapshot of all three sections. */
  snapshot(): BridgeBusBufferSnapshot;
  /** Drop everything — used on un-pair / teardown. */
  reset(): void;
}

/** Per-section cap. Bounds RAM + matches the historical rpc slice's
 *  `limit: 50` (N.5) so the live + historical views align in size. */
export const BRIDGE_BUS_BUFFER_CAP = 50;

export interface BridgeBusBufferOptions {
  /** Receipt clock. Defaults to `Date.now`. Tests pin it. */
  now?: () => number;
  /** Per-section cap override (tests). Defaults to
   *  `BRIDGE_BUS_BUFFER_CAP`. */
  cap?: number;
}

export const createBridgeBusBuffer = (
  opts?: BridgeBusBufferOptions,
): BridgeBusBuffer => {
  const now = opts?.now ?? Date.now;
  const cap = Math.max(1, opts?.cap ?? BRIDGE_BUS_BUFFER_CAP);

  // LOG sections (append-only event streams): newest-first, capped.
  let recipeResults: BridgeBusRecipeResult[] = [];
  let notifications: BridgeBusNotification[] = [];
  // SET section: the currently-pending asks, keyed by `ask_id`. An ask
  // is unique while open (D-158 durable ask_id) — re-delivery upserts,
  // `ask_closed` removes. Modelled newest-first like the logs.
  let approvals: BridgeBusApproval[] = [];

  const prependCapped = <T>(list: ReadonlyArray<T>, item: T): T[] =>
    [item, ...list].slice(0, cap);

  return {
    apply(event) {
      switch (event.kind) {
        case 'notification.notify': {
          notifications = prependCapped(notifications, {
            // No id/timestamp on the wire — synthesise a stable id from
            // the monotonic cursor + stamp receipt time.
            id: `notify:${event.cursor}`,
            ...(event.title !== undefined ? { title: event.title } : {}),
            text: event.text,
            fired_at: now(),
          });
          return;
        }
        case 'notification.ask': {
          // D-325 reminders have their own toast/Today surfaces. They never
          // enter the extension's approval list or its badge.
          if (event.reminder === true) return;
          const row: BridgeBusApproval = {
            ask_id: event.ask_id,
            ...(event.title !== undefined ? { title: event.title } : {}),
            text: event.text,
            options: event.options.map((o) => ({ id: o.id, label: o.label })),
            created_at: now(),
            // D-234 § 234.3 / § 234.4e — the LIVE frame's copies. Missing here,
            // a card shown from the bus offers no reason field and no "read it
            // here" link until the next history re-fetch replaces it — and a
            // `'required'` ask answered in that window no-ops.
            ...(event.link_url !== undefined ? { link_url: event.link_url } : {}),
            ...(event.note_prompt !== undefined
              ? { note_prompt: event.note_prompt }
              : {}),
            ...(event.body !== undefined ? { body: event.body } : {}),
            ...(event.resource_review ? { resource_review: event.resource_review } : {}),
          };
          // Upsert by ask_id (dedup at-least-once re-delivery); newest-first.
          approvals = prependCapped(
            approvals.filter((a) => a.ask_id !== event.ask_id),
            row,
          );
          return;
        }
        case 'notification.ask_closed': {
          approvals = approvals.filter((a) => a.ask_id !== event.ask_id);
          return;
        }
        case 'execution': {
          // Only terminal transitions land a row this slice; `start` /
          // `progress` are in-flight noise the live list doesn't show.
          // `duration_ms` is unknown from a single terminal event —
          // the historical rpc (Slice 2) carries real durations.
          if (event.op === 'complete' || event.op === 'error') {
            // D-169 P2 Slice 2 Codex P2 fold — upsert by `run_id` (dedup,
            // newest-first) so a run already present from the rpc-seeded
            // historical slice isn't duplicated when its terminal live
            // event crosses the seed (the same posture as the ask path
            // dedups by `ask_id`). The live row's `duration_ms` is null;
            // a later reconnect re-seed restores the real duration.
            recipeResults = prependCapped(
              recipeResults.filter((r) => r.run_id !== event.run_id),
              {
                run_id: event.run_id,
                recipe_id: event.recipe_id,
                status: event.op === 'complete' ? 'ok' : 'error',
                started_at: now(),
                duration_ms: null,
              },
            );
          }
          return;
        }
        default:
          // Subscribed-but-unhandled / unsubscribed kind — no-op.
          return;
      }
    },
    seed(snapshot) {
      // Authoritative replace (newest-first already), capped to match the
      // live path. Copy into fresh arrays so the caller's snapshot object
      // can't alias the buffer's internal state.
      recipeResults = snapshot.recipe_results.slice(0, cap);
      notifications = snapshot.notifications.slice(0, cap);
      approvals = snapshot.approvals.slice(0, cap);
    },
    snapshot: () => ({
      recipe_results: recipeResults,
      notifications,
      approvals,
    }),
    reset() {
      recipeResults = [];
      notifications = [];
      approvals = [];
    },
  };
};
