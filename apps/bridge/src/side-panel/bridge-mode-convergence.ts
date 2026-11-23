/** D-169 P2 Slice 4 (live-mode propagation) — convergence loop for a
 *  `bridge-mode-invalidated` push.
 *
 *  The service worker pushes this signal to the side panel when the server
 *  fans out a `notification.bridge_mode_changed` event (and on every
 *  reconnect). The signal is intentionally value-less: it only says this
 *  bridge's mode *changed*, not what it changed to. The panel must re-read
 *  its OWN mode from the server (`notifications.my_bridge_mode`) — it never
 *  trusts mode flags carried on the wire.
 *
 *  Why fail-closed rather than keep-last-known: the answer path
 *  (`notification.submitAnswer`) is keyed only on the ask and is NOT
 *  re-checked against the submitting bridge's current mode. So a stale
 *  approval-ON gate would let this bridge keep answering an outstanding ask
 *  after the user turned approval OFF. A re-fetch we cannot complete must
 *  therefore not leave the prior (possibly approval-ON) mode in place: we
 *  retry with a short backoff, and if every attempt fails to learn the
 *  post-change mode we drop the gate to read-only. Recovery from a
 *  fail-closed comes from the next reconnect push / panel re-open re-fetch.
 *  (Codex adversarial-review HIGH fold — the inline one-shot re-fetch this
 *  replaced widened the stale window from ≤30s, the old status-tick poll,
 *  to unbounded on a stable connection.) */
export interface BridgeModeConvergenceOptions {
  /** A newer invalidation or pairing change retires this sequence, including
   *  an already-pending refresh or backoff. Omitted by standalone callers. */
  isCurrent?: () => boolean;
  /** Re-read + apply the authoritative mode for this bridge. Resolves
   *  `true` iff it applied a definitive mode — an unpaired panel has none
   *  to apply, so it too resolves `true` (nothing to converge). Resolves
   *  `false` on any failure to learn the mode (transport error / ok:false /
   *  no reply). */
  refresh: () => Promise<boolean>;
  /** Drop the gate to read-only (both-off). Invoked at most once, the
   *  instant the FIRST re-fetch fails — before any backoff — so no stale
   *  (possibly approval-ON) gate survives a change we were told about. */
  failClosed: () => void;
  /** Await `ms` (production: `setTimeout`). Injected so tests drive timing
   *  deterministically. */
  delay: (ms: number) => Promise<void>;
  /** Total re-fetch attempts before failing closed (must be ≥ 1). */
  attempts: number;
  /** Backoff between attempts, in milliseconds. */
  retryMs: number;
}

/** Run the convergence loop. The first `refresh()` is attempted eagerly:
 *  if it applies the authoritative mode, we're done (no flicker on the
 *  common path). If it FAILS we `failClosed()` immediately — before any
 *  backoff — because the invalidation already told us the mode changed, so
 *  leaving the prior (possibly approval-ON) gate up even for the backoff
 *  window would be fail-open. We then keep retrying (with `retryMs`
 *  backoff) up to `attempts` total, recovering to the true mode the moment
 *  a later attempt succeeds; if none do, the gate stays read-only. */
export const runBridgeModeConvergence = async (
  opts: BridgeModeConvergenceOptions,
): Promise<void> => {
  const current = opts.isCurrent ?? (() => true);
  if (!current()) return;
  if (await opts.refresh() || !current()) return;
  // First re-fetch failed — fail closed NOW, then retry to recover.
  opts.failClosed();
  for (let attempt = 1; attempt < opts.attempts; attempt += 1) {
    await opts.delay(opts.retryMs);
    if (!current()) return;
    if (await opts.refresh() || !current()) return;
  }
};
