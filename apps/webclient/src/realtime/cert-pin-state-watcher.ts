/** D-148 § A.6.5 — cert-pin state watcher (NEXT-#2 advance, slice 113).
 *
 *  The consumer-side complement to slice 87's cert-pin handler. The
 *  handler writes `cert_pin_state` to `WebclientLocalStore` after
 *  every signature-verified `cert.rotation_notice` /
 *  `cert.rotation_reverted` broadcast; this watcher mirrors that
 *  state in memory + exposes the `getState()` / `subscribe()` shape
 *  the Settings → Server cert-pin status panel needs to surface the
 *  7d overlap window.
 *
 *  ── Two surfaces ───────────────────────────────────────────────────
 *    - `createCertPinStateWatcher(opts)` — factory. Returns a
 *      `CertPinStateWatcher` with `getState()` / `subscribe()` /
 *      `notify()` / `refresh()` / `dispose()`.
 *    - `CertPinStateWatcher` — the handle.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — `notify()` is the cert-pin handler's hook, not a broadcast
 *  subscription. The cert-pin handler already serializes broadcasts
 *  through its enqueue chain + verifies signatures before persisting;
 *  re-subscribing here would force the watcher to repeat both layers
 *  (verification + serialization) just to derive the same state. The
 *  handler's new `onStateChanged` option (slice 113) emits the
 *  post-persist state directly; the watcher's `notify()` is wired as
 *  that callback in the bootstrap composition. The watcher itself
 *  holds NO subscriber reference + does no signature work — it is a
 *  pure state mirror + observer registry.
 *
 *  DD#2 — Cold-boot `refresh()` reads from `localStore`. On page
 *  reload, the handler has not yet observed any broadcast — but the
 *  pin state from the prior session is durable in `localStore`. The
 *  bootstrap calls `refresh()` once at composition time so the
 *  Settings panel can surface a pending rotation that was staged
 *  before the reload. The promise is awaited by the bootstrap so the
 *  cold-boot snapshot is visible by the time the route mounts.
 *
 *  DD#3 — `now` is NOT used by the watcher itself — the consumer
 *  panel applies the `current_valid_until > now` gate at render time.
 *  Keeping the watcher time-agnostic means an idle paired client
 *  doesn't need a wake-up timer to "expire" a stale state; the next
 *  render naturally hides the surface when the clock crosses
 *  `current_valid_until`. The `now` seam on the panel mount drives
 *  the deterministic time-formatting helper instead.
 *
 *  DD#4 — Listener isolation. Subscribers receive the latest snapshot
 *  on every transition (including a `refresh()` that produces a
 *  fresh-but-equal state — the renderer's `lastHtml` guard absorbs
 *  the redundant tick). One broken subscriber MUST NOT take down the
 *  notify loop; the iteration snapshots the listener set + swallows
 *  per-listener throws (same discipline as
 *  `realtime/pair-required.ts`).
 *
 *  DD#5 — Reference-fresh snapshots. `getState()` returns the stored
 *  reference directly (the cert-pin handler builds a fresh object on
 *  every transition + the contract type is read-only), so an
 *  observer can compare references for "is this a new state?"
 *  without cloning. This matches the `PairRequiredHandler.getState()`
 *  contract — the handler emits fresh objects on every transition,
 *  so referential equality is sufficient for change detection.
 *
 *  DD#6 — Generation counter guards `refresh()` against the cold-boot
 *  race (Codex slice-113 P2 fold). The bootstrap fires `refresh()`
 *  fire-and-forget before the WS handshake; on a slow IndexedDB
 *  read, a signed `cert.rotation_notice` can land + call `notify()`
 *  BEFORE the cold-boot read resolves. Without a guard the
 *  refresh's `state = read` would clobber the newer notify state +
 *  regress the Settings panel until the next broadcast. The
 *  counter increments on every `notify()` write; `refresh()`
 *  snapshots the counter pre-await + bails on resolve if it has
 *  changed (a more-recent notify has already advanced the state).
 *
 *  Spec: docs/d-148-spec.md § A.6.5. */

import type { WebclientCertPinState } from '@recued/contracts';

import type { WebclientLocalStore } from '../storage/local-store.js';

export interface CertPinStateWatcher {
  /** Snapshot the current pin state. `null` when no pin is held or
   *  the watcher has not yet refreshed from `localStore`. The
   *  returned reference is stable until the next `notify()` /
   *  `refresh()` transition. */
  getState(): WebclientCertPinState | null;
  /** Observe state changes. The listener fires synchronously after
   *  every `notify()` (post-persist callback from the cert-pin
   *  handler) and `refresh()` resolution. Returns an unsubscribe fn. */
  subscribe(listener: (state: WebclientCertPinState | null) => void): () => void;
  /** Wired as the cert-pin handler's `onStateChanged` hook. Updates
   *  the in-memory snapshot + fans out to subscribers. Idempotent on
   *  reference-equal input — only fires subscribers when the state
   *  reference actually changes. */
  notify(state: WebclientCertPinState | null): void;
  /** Re-read the persisted snapshot from `localStore`. The bootstrap
   *  awaits this once at composition time so the cold-boot pin state
   *  is visible by the time the panel mounts. Resolves to the
   *  refreshed state (or `null` if the store has no pin row). */
  refresh(): Promise<WebclientCertPinState | null>;
  /** Drop all subscribers. Idempotent. */
  dispose(): void;
}

export interface CreateCertPinStateWatcherOptions {
  /** The shared webclient local store. Read on `refresh()` only;
   *  writes flow through the cert-pin handler. */
  localStore: WebclientLocalStore;
  /** Best-effort failure sink for `refresh()` read errors. Defaults
   *  to no-op — a read failure leaves the prior state intact so the
   *  panel keeps surfacing whatever was last observed. */
  onRefreshError?: (err: Error) => void;
}

export const createCertPinStateWatcher = (
  opts: CreateCertPinStateWatcherOptions,
): CertPinStateWatcher => {
  const { localStore } = opts;
  let state: WebclientCertPinState | null = null;
  let disposed = false;
  // DD#6 — incremented on every `notify()` write that actually
  // changes state. `refresh()` snapshots this pre-await + bails on
  // resolve if it has advanced, so a slow cold-boot read can't
  // clobber a newer notify-driven state.
  let generation = 0;
  const listeners = new Set<(state: WebclientCertPinState | null) => void>();

  const fanOut = (): void => {
    const snapshot = state;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* DD#4 — one broken renderer must not take down the loop */
      }
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: (next) => {
      if (disposed) return;
      if (next === state) return;
      state = next;
      generation++;
      fanOut();
    },
    refresh: async () => {
      if (disposed) return state;
      const startGeneration = generation;
      let read: WebclientCertPinState | null;
      try {
        read = await localStore.get('cert_pin_state');
      } catch (err) {
        if (opts.onRefreshError) {
          try {
            opts.onRefreshError(err as Error);
          } catch {
            /* failure-report sink must never re-enter */
          }
        }
        return state;
      }
      if (disposed) return state;
      // DD#6 — bail if a notify landed during the await. The notify
      // path already wrote the more-recent state; clobbering it
      // with this stale cold-boot read would regress the panel
      // (Codex slice-113 P2 fold).
      if (generation !== startGeneration) return state;
      if (read === state) return state;
      state = read;
      fanOut();
      return state;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
};
