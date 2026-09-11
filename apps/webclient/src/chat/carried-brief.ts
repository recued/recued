/** Route-side disclosure of what the assistant is CARRYING about this
 *  conversation — a pure projection, like `activity.ts` beside it.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE BRIEF STEERED EVERY TURN AND NOBODY COULD SEE IT.
 *  Only the fold TRAIL reached the transparency stream (`decisions: [...]`) —
 *  that folds happened, never what they kept. `memory.write` entries already
 *  meet this bar ("transparently attributed to the AI and visible + reversible
 *  in the Memory view"), and the brief holds strictly more influential content:
 *  it is in the packet of every subsequent turn, whereas a saved memory is only
 *  read when something searches for it.
 *
 *  🔑 IT IS SHOWABLE ONLY BECAUSE IT IS DURABLE. While the carry lived in a
 *  module-level Map that died with the process, there was nothing to render.
 *
 *  ⛔⛔ AND THE FRAMING IS PART OF THE PROJECTION, NOT THE RENDERER'S PROBLEM.
 *  The brief is an INTERPRETATION, not a record — measured over 386 constraint
 *  entries, 10% are exact substrings of a user message, 66% near-copies, 25%
 *  genuinely reworded — and it asserts values at 98.4% accuracy, so roughly 1
 *  in 60 carried values is wrong and is then propagated faithfully into every
 *  later turn. A surface that showed these as facts would lend a wrong value
 *  the credibility of being displayed. `heading` and `caveat` ship WITH the
 *  rows so a caller cannot render the content without the qualification. */

/** One line of the carry, already labelled for display. */
export interface CarriedBriefRow {
  /** Which brief field this came from — the caller styles by this, and the
   *  fields differ in kind, not just in name. */
  field: 'intent' | 'constraints' | 'findings' | 'pending';
  text: string;
  /** True for content that originated with the OWNER rather than with a tool.
   *  ⚠ The distinction is the brief's own central one — "a tool result can be
   *  re-derived; nothing can re-derive what the user said" — and it is what
   *  makes a wrong row worth correcting rather than shrugging at. */
  from_owner: boolean;
}

export interface CarriedBriefModel {
  kind: 'carrying';
  heading: string;
  /** ⚠ Never omit this in a render. See the class comment. */
  caveat: string;
  rows: readonly CarriedBriefRow[];
}

export interface CarriedBriefEmptyModel {
  kind: 'empty';
  heading: string;
  caveat: string;
  rows: readonly [];
}

export interface CarriedBriefLoadingModel {
  kind: 'loading';
}

export type CarriedBriefRenderModel =
  | CarriedBriefModel
  | CarriedBriefEmptyModel
  | CarriedBriefLoadingModel;

const CAVEAT =
  'This is what the assistant is carrying forward, in its own words — not a '
  + 'record of what you said. It can be incomplete or wrong; your messages '
  + 'themselves are unaffected.';

const asStrings = (v: unknown): readonly string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];

/** (brief snapshot) → rows. `undefined` means the read has not landed;
 *  `null` means the server has no carry for this conversation.
 *
 *  ⛔ THE THREE STATES ARE KEPT APART DELIBERATELY. "Nothing carried yet" and
 *  "we have not asked" look identical on screen and mean opposite things —
 *  the same distinction the AI/Models usage panel keeps for the same reason. */
export const buildCarriedBriefModel = (
  brief: unknown | null | undefined,
): CarriedBriefRenderModel => {
  if (brief === undefined) return { kind: 'loading' };
  const record = brief !== null && typeof brief === 'object'
    ? (brief as Record<string, unknown>)
    : null;
  if (record === null) {
    return { kind: 'empty', heading: 'Nothing carried yet', caveat: CAVEAT, rows: [] };
  }
  const rows: CarriedBriefRow[] = [];
  const intent = typeof record['intent'] === 'string' ? record['intent'].trim() : '';
  // ⚠ `intent` is the model's read of what you are working on and it DRIFTS by
  //   design (measured: 23% of turns), so it is shown as the current framing
  //   rather than as a goal you set.
  if (intent.length > 0) rows.push({ field: 'intent', text: intent, from_owner: false });
  // ⛔ Owner-originated first. `constraints` is the field the brief protects and
  //   the one a reader can actually check against their own memory; findings
  //   are re-derivable and matter less if wrong.
  for (const t of asStrings(record['constraints'])) {
    rows.push({ field: 'constraints', text: t, from_owner: true });
  }
  for (const t of asStrings(record['pending'])) {
    rows.push({ field: 'pending', text: t, from_owner: false });
  }
  for (const t of asStrings(record['findings'])) {
    rows.push({ field: 'findings', text: t, from_owner: false });
  }
  if (rows.length === 0) {
    return { kind: 'empty', heading: 'Nothing carried yet', caveat: CAVEAT, rows: [] };
  }
  return {
    kind: 'carrying',
    heading: 'What the assistant is carrying',
    caveat: CAVEAT,
    rows,
  };
};

/** Owner-facing labels. Exhaustive over the union, so a new brief field cannot
 *  reach the screen as a raw slug. */
export const CARRIED_BRIEF_FIELD_LABELS: Readonly<
  Record<CarriedBriefRow['field'], string>
> = {
  intent: 'Working on',
  constraints: 'From you',
  pending: 'Still to do',
  findings: 'Found',
};
