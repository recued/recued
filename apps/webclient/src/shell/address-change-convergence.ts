/** D-148 — may this tab reload itself onto a just-saved server address?
 *
 *  ⛔ A PURE FUNCTION BECAUSE THE POLICY WAS OTHERWISE UNTESTABLE. It lived
 *  inline in `webclient-bootstrap.ts`, and every panel test injects its own
 *  convergence callback — so deleting the dirty-work guard entirely reddened
 *  NOTHING. The rule that protects a running chat turn from being discarded
 *  had no test, in a file with twenty-five of them.
 *
 *  ⚠ A RELOAD IS A DISCARD. It takes an in-flight chat turn, an unsaved recipe
 *  and a running execution with it. The address is ALREADY SAVED by the time
 *  this is asked, so deferring costs the user one click and losing their work
 *  costs them the work — the asymmetry decides every unclear case.
 */

import type { ServerSwitchWorkState } from './server-switcher.js';

export type AddressChangeConvergence = 'reloading' | 'deferred';

export const decideAddressChangeConvergence = (args: {
  /** What the tab is in the middle of, from the same authority the server
   *  switcher consults. */
  readonly workState: ServerSwitchWorkState;
  /** False when the host has no reload seam at all — a real configuration
   *  (an embedded host, a test harness), not an error. */
  readonly canReload: boolean;
  /** Whether the tab's `beforeunload` guard would object.
   *
   *  ⛔ A SEPARATE INPUT BECAUSE IT IS A SEPARATE LIST, AND THE TWO DISAGREED.
   *  `approvalAttentionPopover.hasInFlightWork()` and
   *  `drawerCreateOverlay.hasInFlightWork()` block an unload and are NOT part
   *  of the switch work snapshot — so a `clean` tab could still raise the
   *  native "Leave site?" dialog. A user who cancelled it would be left on the
   *  old address with nothing said, which is the state this reload exists to
   *  prevent. Reload only when NOTHING would object. */
  readonly unloadWouldLoseWork: boolean;
}): AddressChangeConvergence => {
  if (!args.canReload) return 'deferred';
  if (args.unloadWouldLoseWork) return 'deferred';
  // ⛔ EXHAUSTIVE BY EQUALITY TO 'clean', NOT BY LISTING THE DIRTY STATES. A
  // new member of `ServerSwitchWorkState` — and there are already six — must
  // default to KEEPING the user's work, not to discarding it because nobody
  // remembered to add it to a denylist.
  return args.workState === 'clean' ? 'reloading' : 'deferred';
};
