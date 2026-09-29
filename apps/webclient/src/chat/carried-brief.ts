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

/** Nothing is carried — and so nothing is SHOWN. ⛔ This used to render a
 *  heading ("Nothing carried yet") over the caveat, and the caveat's "This is
 *  what Chat is carrying forward…" then pointed at nothing, so it read as a
 *  caption for the conversation below it. The caveat qualifies ROWS; with no
 *  rows there is nothing to qualify, and nothing to disclose. */
export interface CarriedBriefEmptyModel {
  kind: 'empty';
}

export interface CarriedBriefLoadingModel {
  kind: 'loading';
}

export type CarriedBriefRenderModel =
  | CarriedBriefModel
  | CarriedBriefEmptyModel
  | CarriedBriefLoadingModel;

/** Named as Settings names it ("Keep a running note"), so the two surfaces
 *  describe one thing in one word. */
const HEADING = "Chat's running note";
const CAVEAT =
  "This is Chat's running note for this chat, in its own words. It is not a "
  + 'record of what you said. It can be missing things, or wrong. Your messages '
  + 'themselves are not changed.';

const asStrings = (v: unknown): readonly string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];

/** (brief snapshot) → rows. `undefined` means the read has not landed;
 *  `null` means the server has no carry for this conversation.
 *
 *  The three states stay apart in the model, and two of them look alike on
 *  screen: neither `loading` nor `empty` renders anything. That is safe now
 *  because neither CLAIMS anything — the old empty panel said "Nothing carried
 *  yet", which was also shown with the running note switched off, where "yet"
 *  promised a carry that would never come. */
export const buildCarriedBriefModel = (
  brief: unknown | null | undefined,
): CarriedBriefRenderModel => {
  if (brief === undefined) return { kind: 'loading' };
  const record = brief !== null && typeof brief === 'object'
    ? (brief as Record<string, unknown>)
    : null;
  if (record === null) return { kind: 'empty' };
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
  if (rows.length === 0) return { kind: 'empty' };
  return {
    kind: 'carrying',
    heading: HEADING,
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
