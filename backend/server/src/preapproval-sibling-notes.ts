/** D-261 § 9.1 — advisory "another automation runs this too" review note.
 *
 *  ## What this is for
 *
 *  Every preapproval identity keys on the TARGET (`schedule_id` /
 *  `recipe_id` / `trigger_id`), never on what the target does. Two schedules
 *  of one recipe with the same config and the same due instant are two
 *  independent identities — an approval on one never authorises the other,
 *  which is correct and is not changed here.
 *
 *  What duplicates DO break is an inference. `advancePreapprovalOccurrence`
 *  says it lets "preparation/decision detect intervening execution"; what it
 *  detects is intervening execution OF THAT TARGET, because
 *  `schedule-store.ts` advances the sequence scoped to `(kind, schedule_id)`.
 *  So a duplicate can fire the same action between prepare and decide, and
 *  the owner is shown a review that is silent about it.
 *
 *  ⛔ NOT FIXABLE BY AN EFFECT KEY. `(recipe_id, effective_config, due_at)` —
 *  or `dispatch_hash` plus the instant — collides for genuine duplicates BY
 *  CONSTRUCTION. That is what makes it a usable detector and an unusable key:
 *  promoting it to a dedup key would silently break an owner who wants two
 *  runs, and the substrate cannot tell "duplicated by mistake" from
 *  "duplicated on purpose" because the two are identical in every recorded
 *  field. Only the owner knows. So this informs; it does not rule.
 *
 *  ## Why it is safe to be wrong
 *
 *  `preapprovalReviewDigest` commits to `{proposal_id, future_execution_ref,
 *  revision, snapshot_hash, selected_member_ids}` — WHAT WILL RUN, not what
 *  the owner was told. `interaction_notes` is outside that digest, so a
 *  sibling appearing or vanishing after review neither invalidates the digest
 *  nor forces re-approval. ⚠ The corollary is that the note CAN go stale, and
 *  that is accepted rather than solved — it is computed at review (the call
 *  that renders what the owner sees) to narrow the window, not to close it.
 *
 *  Spec: D-261 § 9.1. */

import type Database from 'better-sqlite3';

/** What the sweep can compare, and what it deliberately cannot.
 *
 *  ⛔ THIS IS A PROXY, NOT AN EFFECT COMPARISON, and the difference is
 *  load-bearing. A true comparison would resolve each sibling's effective
 *  config (dish → group → install → defaults) and compare `dispatch_hash` —
 *  which means running the prepare machinery per sibling, from a layer that
 *  has neither the dish store nor the recipe sources in scope.
 *
 *  Instead the sweep matches on `(recipe_id, dish_id, next_run_at)`. Config
 *  is derived FROM the dish, so same recipe + same dish + same instant does
 *  imply the same action. The cost is UNDER-DETECTION: two DIFFERENT dishes
 *  carrying identical overlays are the same action and will not be reported.
 *
 *  ⚠ Under-detection is the correct direction for an advisory note. A missed
 *  warning leaves the owner exactly where they are today; a false warning
 *  ("another automation runs this") about two dishes that merely look alike
 *  would be the substrate asserting something it did not verify. If this ever
 *  needs to be exact, the fix is to resolve `dispatch_hash` per sibling at a
 *  layer that can — not to loosen the match here. */
export interface SiblingNoteInput {
  recipe_id: string;
  /** The proposal's own target — excluded from its own sweep. `null` for a
   *  target with no schedule row, in which case nothing is excluded. */
  target_schedule_id: string | null;
  /** The reviewed target's bound dish, or `null` for a dishless run. */
  dish_id: string | null;
  /** The reviewed due instant. `null` ⇒ no clock target (a trigger fires on
   *  an event), so no time claim can be made and the sweep is skipped. */
  due_at: number | null;
}

interface ScheduleRow { schedule_id: string; data: string }
interface ScheduleData {
  enabled?: unknown;
  next_run_at?: unknown;
  dish_id?: unknown;
}

/** Count sibling automations that resolve to the same action at the same
 *  instant. Zero ⇒ no note.
 *
 *  Reads `schedules` directly: `schedules_recipe_idx ON schedules(recipe_id)`
 *  covers the lookup, and the row set is schedules-per-recipe (normally 0–2),
 *  so no new index is needed. */
export const countSiblingAutomations = (
  db: Database.Database,
  input: SiblingNoteInput,
): number => {

  // ⚠ SHORT-CIRCUIT, NOT THE ENFORCEMENT. A null `due_at` is already excluded
  // by the instant comparison below (a number never equals null), so removing
  // this line changes no result — measured: the suite stayed green under that
  // mutation. It earns its place by skipping the query entirely for trigger
  // targets, which have no due instant and can never match. Do not read it as
  // the thing that stops a trigger making a time claim; that is the
  // comparison.
  if (input.due_at === null) return 0;
  const rows = db
    .prepare('SELECT schedule_id, data FROM schedules WHERE recipe_id = ?')
    .all(input.recipe_id) as ScheduleRow[];

  let count = 0;
  for (const row of rows) {

    if (row.schedule_id === input.target_schedule_id) continue;
    let data: ScheduleData;
    try { data = JSON.parse(row.data) as ScheduleData; } catch { continue; }
    // A disabled sibling will not fire ordinarily, so it is not a duplicate
    // run to warn about. ⚠ A sibling PARKED by its own preapproval is also
    // stored disabled and WILL dispatch — it is skipped here on purpose:
    // its own review carries the mirror note, and warning from both sides
    // would double-count one pair.

    if (data.enabled !== true) continue;
    if (typeof data.next_run_at !== 'number' || data.next_run_at !== input.due_at) continue;
    const siblingDish = typeof data.dish_id === 'string' ? data.dish_id : null;

    if (siblingDish !== input.dish_id) continue;
    count += 1;
  }
  return count;
};

/** The note itself, or `null` when there is nothing to say.
 *
 *  Wording states an OBSERVATION, never a prediction — "is also set to run",
 *  not "this will run twice". The sweep is a point-in-time reading the review
 *  digest does not stand behind, and the copy must not promise more. */
export const siblingAutomationNote = (
  db: Database.Database,
  input: SiblingNoteInput,
): string | null => {
  const count = countSiblingAutomations(db, input);
  if (count === 0) return null;
  return count === 1
    ? '1 other automation is also set to run this action at this time.'
    : `${count} other automations are also set to run this action at this time.`;
};
