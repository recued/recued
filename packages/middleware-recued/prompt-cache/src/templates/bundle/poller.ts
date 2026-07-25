/** D-164 P4g-3 — bundle refresh poller.
 *
 *  `startBundlePoller({ fetcher, store, intervalMs, ... })` drives a
 *  cron-style refresh loop: every `intervalMs`, fetch the latest
 *  manifest from the upstream `BundleFetcher`, persist it into the
 *  `BundleStore`, and fire the optional `onUpdate` / `onError` hooks
 *  for caller observability. The first tick runs immediately so
 *  callers can `await firstTick` to know whether the boot-time fetch
 *  succeeded; subsequent ticks fire on the scheduler interval.
 *
 *  Concurrent-tick guard. If a tick is still in flight when the
 *  scheduler fires, the next tick is skipped (not queued). This
 *  protects against an upstream that's slower than the interval —
 *  without the guard, slow ticks would pile up promises until the
 *  process ran out of memory.
 *
 *  Stop semantics. The returned `stop()` clears the scheduler
 *  handle and flips an `isStopped` flag. An in-flight tick still
 *  completes (we don't abort the fetch), but its `onUpdate`/
 *  `onError` callbacks are suppressed and the store is NOT written
 *  to — `stop()` is the caller saying "I no longer care about this
 *  manifest"; persisting a post-stop fetch would surface as a
 *  surprise update on the next boot.
 *
 *  Scheduler injection. `setInterval` / `clearInterval` are
 *  injectable as `scheduler` so tests can drive the loop with
 *  `vi.useFakeTimers` or a synthetic handle without monkey-patching
 *  the globals. Defaults to `globalThis.setInterval` /
 *  `globalThis.clearInterval`.
 *
 *  Error semantics. Every fetch / persist error feeds `onError`
 *  (best-effort — a throwing handler is wrapped in its own
 *  try/catch so the poller never tears down on a buggy logger).
 *  The poller does NOT throw out of `tick`; failures are observable
 *  but never propagate.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/bundle. */

import type { BundleFetcher, BundleManifest } from './fetch.js';
import type { BundleStore } from './store.js';

/** Subset of `globalThis.setInterval` / `clearInterval` the poller
 *  needs. Returning `unknown` keeps the handle type loose — tests
 *  using synthetic schedulers can return any sentinel. */
export interface PollerScheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Default scheduler — wraps the global timer functions. The wrapper
 *  is needed because `setInterval` returns a `Timeout` object in
 *  Node (not a number) but the `PollerScheduler.setInterval` return
 *  type is `unknown` either way. */
export const defaultScheduler: PollerScheduler = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]),
};

export interface StartBundlePollerOptions {
  /** Upstream source. The poller calls `fetchManifest()` per tick. */
  readonly fetcher: BundleFetcher;
  /** Persistence target. `put` is called with the fresh manifest. */
  readonly store: BundleStore;
  /** Interval between subsequent ticks in milliseconds. The first
   *  tick fires immediately on `startBundlePoller`. */
  readonly intervalMs: number;
  /** Fired after a successful `fetch → put` cycle, with the fresh
   *  manifest. Optional. */
  readonly onUpdate?: (manifest: BundleManifest) => void;
  /** Fired on any tick failure (fetch reject, persist reject). The
   *  poller continues running; failures don't abort the loop.
   *  Optional. */
  readonly onError?: (err: unknown) => void;
  /** Defaults to `defaultScheduler`. Tests inject a synthetic
   *  scheduler for deterministic timing. */
  readonly scheduler?: PollerScheduler;
}

export interface BundlePollerHandle {
  /** Halt the poller. Idempotent — subsequent calls are no-ops.
   *  An in-flight tick completes but its result is discarded. */
  stop(): void;
  /** Resolves when the initial (boot-time) tick completes. Useful
   *  for callers that want to know whether the first fetch succeeded
   *  before proceeding (e.g., to build the pool from the freshly
   *  populated store rather than the cold one). Never rejects —
   *  errors flow through `onError`. */
  readonly firstTick: Promise<void>;
}

/** Start the poller. Returns a `BundlePollerHandle` synchronously;
 *  the first tick is queued + observable via `firstTick`. */
export const startBundlePoller = (
  options: StartBundlePollerOptions,
): BundlePollerHandle => {
  const {
    fetcher,
    store,
    intervalMs,
    onUpdate,
    onError,
    scheduler = defaultScheduler,
  } = options;

  let inFlight = false;
  let stopped = false;

  const safeInvoke = (fn: (() => void) | undefined): void => {
    if (fn === undefined) return;
    try {
      fn();
    } catch {
      // Hook failures must not tear down the poller; the gate's
      // pass-through is the runtime safety net for the wider system.
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    let manifest: BundleManifest | undefined;
    try {
      manifest = await fetcher.fetchManifest();
    } catch (err) {
      if (!stopped) safeInvoke(() => onError?.(err));
      inFlight = false;
      return;
    }
    if (stopped) {
      inFlight = false;
      return;
    }
    try {
      await store.put(manifest);
    } catch (err) {
      if (!stopped) safeInvoke(() => onError?.(err));
      inFlight = false;
      return;
    }
    if (!stopped) safeInvoke(() => onUpdate?.(manifest));
    inFlight = false;
  };

  const firstTick = tick();
  const handle = scheduler.setInterval(() => {
    // Fire-and-forget; tick swallows its own failures.
    void tick();
  }, intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      scheduler.clearInterval(handle);
    },
    firstTick,
  };
};
