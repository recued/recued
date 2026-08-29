/** DETERMINISTIC DATE ARITHMETIC. ⛔⛔ **NOT WIRED TO ANYTHING, AND THAT IS A
 *  MEASURED DECISION — DO NOT EXPOSE IT AS A CHAT TOOL WITHOUT READING THIS.**
 *
 *  It was built as `compute.date`, a Tier-1 tool, on the reasoning that
 *  arithmetic was the only failure class surviving a model swap: across 29 live
 *  bench-278 runs on two models, three answers to "90 days before 2026-12-31"
 *  were wrong ("1 November", "29 September", "1 October"), each from a model
 *  that had read the contract clause correctly and then miscounted across month
 *  boundaries. A host cannot get that wrong. The tool worked, and shipping it
 *  made the task WORSE.
 *
 *  ⛔ MEASURED: bench 278, qwen, same substrate, only tool availability
 *  differing — **17/18 without it, 7/10 with it.** The model CALLED it 10/10, so
 *  adoption was never the problem. All three failures were
 *  `add_days(2026-12-31, -30)`: the tool computed 2026-12-01 flawlessly from the
 *  SUPERSEDED notice period. One run called -30, then -90, and answered empty.
 *
 *  🔑🔑 TWO REASONS IT LOST, AND THE SECOND IS THE GENERAL ONE:
 *   1. **Determinism does not make an answer right — it makes a WRONG answer
 *      stable and confident.** A calculator is only ever as good as its input,
 *      and handing the model a fast way to compute encouraged it to compute
 *      EARLY, off the first notice period it read, before the supersession was
 *      established. The failure moved from arithmetic (fixed) to premature
 *      commitment (caused).
 *   2. **DELEGATING A STEP REMOVES THE MODEL'S OWN CHECK ON IT.** Without the
 *      tool the same model wrote *"Verify: Oct 2 → 31 Oct (29 days), Nov (30) =
 *      59, Dec (31) = 90 ✓"* — it audited its own arithmetic. With the tool
 *      there is nothing to audit; the result arrives authoritative. So the trade
 *      is "occasionally wrong, sometimes self-caught" for "never wrong given the
 *      input, and never self-caught".
 *
 *  ⚠ THE RATE NEVER JUSTIFIED IT EITHER: 3 slips in 29 runs is ~10%, against a
 *  catalog entry on every turn and a round trip. The accuracy case was thin
 *  before the measurement and did not survive it.
 *
 *  ✅ WHAT WOULD JUSTIFY A DIFFERENT TOOL — a control-plane argument, not an
 *  accuracy one. An audit row reading `add_days(2026-12-31, -30)` makes the
 *  wrong ASSUMPTION explicit and checkable, where mental arithmetic buries it in
 *  prose. That is worth designing FOR deliberately; it is not a consolation for
 *  a primitive that measured worse.
 *
 *  ⚠ AND DO NOT WIDEN THE PARSER to accept localised or ambiguous forms
 *  (`31/12/2026`, `2026年12月31日`). The refusal below is load-bearing:
 *  `03/04/2026` is 3 April or 4 March by locale, and a calculator that guesses
 *  is exactly the confident-wrong-deadline machine this was meant to prevent. A
 *  refusal is visible to the caller; a guess is not.
 *
 *  Kept, tested and exported because the engine is correct and cheap, and the
 *  auditability angle may be pursued. Nothing advertises it to a model.
 *
 *  ── the original rationale, still true of the ARITHMETIC itself ──
 *  DETERMINISTIC DATE ARITHMETIC — the host computes, the model does not.
 *
 *  ⛔⛔ WHY THIS EXISTS, AND IT IS THE ONLY FAILURE CLASS THAT SURVIVED A MODEL
 *  SWAP. Bench 278 asks for the last day to give notice: 90 days before
 *  2026-12-31. Across 29 live runs and TWO different models, three answers were
 *  wrong — "1 November 2026", "29 September 2026", "1 October 2026" — every one
 *  of them from a model that had read the clause correctly, caught a
 *  supersession, and then miscounted days across month boundaries. Both models
 *  did it. Every other failure measured in that work was model-specific (a
 *  referent binding one model does not make) or substrate-specific (snippets,
 *  a collapsing AND, key order); this one is neither.
 *
 *  🔑 A HOST CANNOT GET THIS WRONG ON A COIN FLIP. `2026-12-31 minus 90 days`
 *  has one answer, so this is the rare intervention whose correctness does not
 *  need a live A/B to believe — it needs a table of cases, which is below.
 *
 *  ⚠ UTC ONLY, AND DELIBERATELY. A notice period is a count of calendar days,
 *  not an interval of elapsed time, so a DST-crossing local zone would make
 *  `+1 day` occasionally mean 23 or 25 hours and shift the answer by a day at
 *  the boundary. Callers wanting a zone convert at the edge; the arithmetic
 *  stays on a fixed grid. */

/** A calendar day on the UTC grid: `YYYY-MM-DD`, no time, no zone. */
export type CalendarDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ⛔ REJECTS AN OVERFLOWED DATE RATHER THAN ROLLING IT. `Date.UTC(2026, 1, 30)`
 *  silently yields 2 March; a caller who typed `2026-02-30` has a bug, and
 *  quietly answering about a different day is how that bug reaches a user as a
 *  confident wrong deadline. Round-tripping the parse is what catches it. */
export const parseCalendarDate = (value: string): Date | null => {
  const m = ISO_DATE.exec(value.trim());
  if (m === null) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return formatCalendarDate(date) === value.trim() ? date : null;
};

export const formatCalendarDate = (d: Date): CalendarDate =>
  `${String(d.getUTCFullYear()).padStart(4, '0')}-${
    String(d.getUTCMonth() + 1).padStart(2, '0')}-${
    String(d.getUTCDate()).padStart(2, '0')}`;

const DAY_MS = 86_400_000;

/** Days added (negative subtracts). Pure grid arithmetic — no month lengths to
 *  get wrong, which is exactly where the models slipped. */
export const addDays = (from: CalendarDate, days: number): CalendarDate | null => {
  const d = parseCalendarDate(from);
  if (d === null || !Number.isFinite(days) || !Number.isInteger(days)) return null;
  return formatCalendarDate(new Date(d.getTime() + days * DAY_MS));
};

/** ⛔ MONTHS ARE NOT 30 DAYS, and the end-of-month case is the one that bites:
 *  "three months after 30 November" has no 30 February to land on. CLAMPS to
 *  the last valid day of the target month (31 Jan + 1 month = 28 Feb), which is
 *  the convention contracts use and the one a reader expects. Documented rather
 *  than assumed, because the alternative (roll into March) is defensible too and
 *  a silent choice between them is a wrong date nobody can see. */
export const addMonths = (from: CalendarDate, months: number): CalendarDate | null => {
  const d = parseCalendarDate(from);
  if (d === null || !Number.isFinite(months) || !Number.isInteger(months)) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return formatCalendarDate(new Date(Date.UTC(y, m, Math.min(day, lastOfTarget))));
};

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export const diffDays = (a: CalendarDate, b: CalendarDate): number | null => {
  const da = parseCalendarDate(a);
  const db = parseCalendarDate(b);
  if (da === null || db === null) return null;
  return Math.round((db.getTime() - da.getTime()) / DAY_MS);
};
