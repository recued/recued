/** D-269 — what happens the moment the quiet-hours window ends.
 *
 *  ⛔⛔ EXTRACTED FROM `start-post-listener-runtime.ts` BECAUSE AN AUDIT MUTATION
 *  PASSED. No-opping the whole callback body — the held-ask re-delivery AND the
 *  card — left 150 tests green. It was an inline closure inside the boot path,
 *  so nothing could reach it without booting a server, and so nothing did.
 *
 *  🔑 The extraction is the fix, not a tidy-up: **a behaviour only reachable by
 *  booting the process is a behaviour nobody tests**, and this one carries step
 *  5's entire promise — that an approval held overnight is delivered when the
 *  window lifts.
 *
 *  Spec: internal design notes D-269 steps 4–5 + REV 20. */

import { renderQuietHoursDigest, type QuietHoursDigest } from '@recued/contracts';

export interface QuietHoursReleaseDeps {
  /** D-158's boot sweep, reused verbatim. ⛔ An approval held by quiet hours is
   *  durably `open` with its `fanout_channels` and is indistinguishable from one
   *  whose channel was briefly unreachable — TR-10, the case this already
   *  handles. **Quiet hours on an approval is TR-10 with a clock**, which is why
   *  step 5 needed no queue of its own. */
  recoverPendingAsks: () => Promise<unknown>;
  /** ⚠ `notify`, not `ask`: the digest was recomputed from anchor rows a moment
   *  ago, so there is nothing to make durable. */
  notify: (message: { title: string; text: string }) => Promise<unknown>;
  /** The zone the card's times are rendered in. */
  timeZone?: string;
}

/** ⚠ RE-DELIVERY FIRST, CARD SECOND, and the order is a promise to the reader:
 *  an owner who reads the digest and opens their prompts finds them already
 *  there. Reversed, the card can arrive pointing at prompts that have not been
 *  re-sent yet.
 *
 *  ⛔ BOTH ARE BEST-EFFORT AND INDEPENDENT. A re-delivery failure must not cost
 *  the card, and a card that cannot be delivered must not take the housekeeping
 *  cycle with it — the same contract as every other `notify`. */
export const buildQuietHoursReleaseHandler = (
  deps: QuietHoursReleaseDeps,
): ((digest: QuietHoursDigest) => void) => (digest) => {
  void deps.recoverPendingAsks().catch(() => { /* best-effort */ });
  void deps.notify({
    title: 'While you were away',
    text: deps.timeZone === undefined
      ? renderQuietHoursDigest(digest)
      : renderQuietHoursDigest(digest, deps.timeZone),
  }).catch(() => { /* best-effort */ });
};
