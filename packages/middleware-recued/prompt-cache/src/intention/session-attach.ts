/** D-164 P4c — session referent candidate selection.
 *
 *  Given the active conversation history, identify the most recent
 *  assistant turn as the *referent candidate* — the text the anaphor
 *  most plausibly points back to. No entity resolution here: this slice
 *  only narrows the search space for downstream NER (P4d). The actual
 *  "who is `they`?" question is the NER pass's job; the router just
 *  hands NER the right span to look at.
 *
 *  Why most-recent assistant: the user's prior turns are usually a
 *  question or a request; the assistant's reply is where named
 *  entities, ordered lists, and resolved IDs typically appear. Falling
 *  back to the most-recent user turn or yielding `null` is the
 *  alternative — P4c picks "most-recent assistant turn only" as the
 *  safest minimum. A user-only history (no assistant reply yet) yields
 *  `null` and the gate degrades gracefully.
 *
 *  See: D-164 § 2.
 */

import type { SessionEntry } from '@recued/chat';

/** The candidate the router hands downstream. `entry` is the raw
 *  `SessionEntry` so NER can scan its text + timestamp without
 *  re-resolving from history. */
export interface ReferentCandidate {
  readonly entry: SessionEntry;
}

/** Walk `history` from the tail backward; return the first assistant
 *  entry. `null` when the history is empty or has no assistant entry
 *  yet (the first-turn case — anaphora is detected but there's nothing
 *  to attach it to). */
export const findReferentCandidate = (
  history: readonly SessionEntry[],
): ReferentCandidate | null => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry !== undefined && entry.role === 'assistant') {
      return { entry };
    }
  }
  return null;
};
