/** 2026-11-20 (the owner: "go ahead") — whether a failed recipe run's actions are all accounted for, so the answer
 *  needs no "did not confirm completion" notice (`presentAnswer`, `chat-turn-executor.ts`, from `9fbd4deb4`).
 *
 *  The notice is for an action whose outcome is unknown: it may have taken effect or not. A browser batch keeps its
 *  own record of that (`batch_progress`, `bridges/dom-adapter.ts`). For each action step it counts the times the
 *  action was attempted and acknowledged. It calls the batch unconfirmed when a code says delivery was uncertain, the
 *  page was not the one asked for, or an attempted action went unacknowledged, and then it reports the page state
 *  as `unknown`. Outside those cases the outcome is known:
 *  - nothing was attempted: a refusal before any action (the binding mismatch "No batch steps ran"; a target that is
 *    not an editable field; no control by that name), whatever the page's last state;
 *  - every attempted action was acknowledged, and what failed was a check: a wait whose condition did not show;
 *  - the failed step was sent once and the page answered that its target was not there (`DOM_SELECTOR_NOT_FOUND`,
 *    "The page changed since it was inspected"): the Bridge found nothing to act on;
 *  - 2026-11-20, later: the failed step was a click sent once that the Bridge did not carry out because something
 *    covered its element (`click_obstruction`, `executed: false`: "Something else on the page covers it … so it was
 *    not clicked"). A P run on `a5c8a9dcf` failed on the notice alone after one, its note saved correctly
 *    (`…-P-plain-wait-a5c8a9dcf`, r3).
 *  - 2026-11-20, later still (the owner: "go ahead, fix the DOM_WRITE_FAILED notice too"): the failed step was text sent
 *    once to an element that takes none. The page refused it, and the host's fresh, whole read of the same document
 *    shows a control that only clicks (`control_correction`: a link, a button), which the Bridge's write has nothing to
 *    type into. A P run on `2c22c26b9` saved its note correctly and failed on the notice alone after typing into a link
 *    (`…-P-brief-windows-2c22c26b9`, D64-r3).
 *  - 2026-11-21 (the owner: "c yes"): the failed step was text sent once to a field behind the dialog open on the page.
 *    The page refused it, and the host's fresh, whole read after the refusal shows the target outside the open dialog
 *    (`control_blocked`); the Bridge types into nothing there. Two P runs on `e1258fbca` (T64-r3 and r4).
 *  - 2026-11-21: one of these with the page gone since it was read, which leaves the page's state unknown but not the
 *    step's: it found nothing to act on. Two P runs (A128-r2 and r4).
 *  A later read then shows the state. The host counts an action as attempted when it sends it and acknowledged when
 *  the page confirms it, so a refusal and a lost answer have the same counts; the code tells them apart, and only
 *  for one attempt (a second could follow a first whose answer was lost).
 *
 *  Measured on browser task P (2026-11-20). Six runs failed on the notice alone, each with a correct answer behind
 *  it, and every one was raised by one of those kinds (`recued-bridge-vs-browser-use/results/analysis/`):
 *  - three on the release candidate `8913dedde` (`2026-11-20-P-release-candidate-8913dedde`);
 *  - one with the navigation rules (`…-P-navigation-rules-pj86u2m8`);
 *  - two on `6eb71cdae`, after the first cut of this rule left the last two kinds out
 *    (`…-P-release-candidate-6eb71cdae`).
 *
 *  ⚠ A run with no such record keeps the notice. That covers a dispatch failure, a tool that is not a browser batch,
 *  a step error without `batch_progress`, and anything unreadable. Unknown is the default. */

/** The codes the batch itself calls unconfirmed, whatever its counts say. */
const UNCERTAIN_DELIVERY: ReadonlySet<string> = new Set(['ACTION_DELIVERY_UNCERTAIN', 'DOM_PAGE_NOT_MATCHING']);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Text the page refused for an element that takes none: refused (`post_action.action_status`), with the correction
 *  the host attaches only when a fresh, whole read of the same document shows the element as a control that clicks
 *  (`fillTargetCorrection`, `bridges/dom-adapter.ts`). A text an editor did not take is refused too, but carries no
 *  correction: the field was typed into, so it stays unknown. */
const typingRefusedByControl = (error: Record<string, unknown>): boolean => {
  if (error.code !== 'DOM_WRITE_FAILED') return false;
  const details = record(error.details);
  const correction = record(details?.control_correction);
  const supported = correction?.supported_actions;
  return record(details?.post_action)?.action_status === 'refused' && correction?.requested_action === 'type'
    && Array.isArray(supported) && !supported.includes('type');
};

/** 2026-11-21 (the owner: "c yes") — text the page refused for a field behind the dialog open on it: refused, with the
 *  host's record that a fresh, whole read after the refusal shows the target outside the open dialog
 *  (`control_blocked`, `fillTargetBlocked`). The Bridge's write types into nothing outside an open dialog. On browser
 *  task P two runs saved and checked their note and failed on the notice alone after one
 *  (`recued-bridge-vs-browser-use/results/analysis/2026-11-21-P-calibration-F-ec66850f1`, T64-r3 and r4). */
const typingRefusedForDialog = (error: Record<string, unknown>): boolean => {
  if (error.code !== 'DOM_WRITE_FAILED') return false;
  const details = record(error.details);
  const blocked = record(details?.control_blocked);
  return record(details?.post_action)?.action_status === 'refused' && blocked?.requested_action === 'type'
    && blocked.blocked_by === 'dialog';
};

/** The failed step's own answer says it was not carried out: its target was not there, a click its element was
 *  covered for was not made, or text was refused by an element that takes none or one behind an open dialog. */
const notCarriedOut = (error: Record<string, unknown>): boolean => error.code === 'DOM_SELECTOR_NOT_FOUND'
  || record(record(error.details)?.click_obstruction)?.executed === false
  || typingRefusedByControl(error) || typingRefusedForDialog(error);

/** One step's error: known only when its batch says what ran, and every attempted action was acknowledged. */
const knownStepError = (error: Record<string, unknown>): boolean => {
  if (typeof error.code === 'string' && UNCERTAIN_DELIVERY.has(error.code)) return false;
  const progress = record(record(error.details)?.batch_progress);
  if (progress === undefined || !Array.isArray(progress.effects)) return false;
  // Nothing attempted: what the page showed last cannot make an action's outcome unknown.
  if (progress.effects.length === 0) return true;
  // 2026-11-21 — nor does a page the failed step itself found gone ("The page has reloaded, gone to another address or
  //   closed since it was read"), which leaves the page's state unknown: that step did nothing, and the effects below
  //   still have to account for every other action. On P two runs failed on the notice alone after one
  //   (`…-P-brief-windows-2c22c26b9`, A128-r2 and r4).
  if (progress.page_state === 'unknown' && !notCarriedOut(error)) return false;
  return progress.effects.every((entry) => {
    const effect = record(entry);
    if (effect === undefined || typeof effect.attempted !== 'number' || effect.attempted < 1) return false;
    if (effect.acknowledged === effect.attempted) return true;
    // The failed step, sent once, was not carried out: nothing to act on, covered and not clicked, or nothing to type
    // into. Nothing done.
    return notCarriedOut(error) && effect.step === progress.failed_step && effect.attempted === 1 && effect.acknowledged === 0;
  });
};

/** Whether a failed run's result (`ChatDispatchResult.result` beside `run_failed`) accounts for every action it
 *  attempted: each step error carries its batch record, and none leaves an action's outcome unknown. */
export const failedRunEffectsKnown = (result: unknown): boolean => {
  const steps = record(result)?.steps;
  if (!Array.isArray(steps)) return false;
  const errors = steps.map((step) => record(record(step)?.error)).filter((error) => error !== undefined);
  return errors.length > 0 && errors.every(knownStepError);
};
