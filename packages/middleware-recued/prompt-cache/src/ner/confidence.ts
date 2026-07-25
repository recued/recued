/** D-164 P4d — binary certainty gate.
 *
 *  Filters raw extraction spans down to "100%-certain" slot values. The
 *  binary rule (design § 3 Invariant 5) is "clean typed value or pass
 *  through" — there's no probability score to threshold. Uncertain
 *  spans (e.g., a `5/24` slash-date that could be a fraction, or a
 *  single capitalised word that could be sentence-initial) are
 *  silently dropped here so they never reach the template-match step.
 *
 *  Per-kind certainty rules:
 *    - **entity.email** — pattern already validated by the regex in
 *      `extract.ts`; the gate adds the lower-case canonical form.
 *      Practically every regex match passes.
 *    - **date** — `YYYY-MM-DD` only; the gate round-trips through a
 *      UTC `Date` so non-existent calendar dates (Feb 29 of a non-leap
 *      year, Apr 31, etc.) drop. Years restricted to
 *      `YEAR_FLOOR .. YEAR_CEILING` so `0000-01-01` and far-future
 *      stamps pass through rather than count as "clean typed value."
 *    - **time** — `HH:MM[:SS]`; regex already constrains the digit
 *      ranges (`[0-2]\d:[0-5]\d`) and rejects fractional-seconds
 *      prefixes via lookahead. The gate adds a `HH <= 23` check
 *      because `[0-2]\d` admits `24..29`. Out-of-range → drop.
 *    - **entity.name** — gate has no extra rule; the language module
 *      is responsible for emitting only certain name spans (a sentence-
 *      initial `Find` is the language module's problem, not the
 *      certainty gate's).
 *
 *  Why drop instead of "any uncertainty → null whole extraction":
 *  the certainty gate is local to each span. A prompt like
 *  `email Bob at bob@x.com about 2026-13-99` carries a clean email,
 *  an uncertain name (covered by the language module's own rules), and
 *  a malformed date. Returning only the clean email is the safe
 *  behavior — the language module is the gate for the name; the
 *  date drops silently; the email survives. The caller in `index.ts`
 *  decides whether an empty filtered set should become `null`.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 3 Invariant 5 (binary certainty), § 3 Invariant 7 (safe small
 *  gains). */

import type { RawSlot, SlotKind } from './extract.js';

/** A certainty-gated slot — guaranteed clean per the per-kind rules.
 *  `value` is the canonical form (email lower-cased; date / time
 *  passed through unchanged once range-validated; name verbatim).
 *  `raw` retains the original span for audit / debugging. */
export interface SlotValue {
  readonly kind: SlotKind;
  readonly value: string;
  readonly raw: string;
  readonly position: number;
}

/** Supported year window for the `date` certainty check. Years outside
 *  the window pass-through to the LLM — `0000-01-01` is almost always
 *  noise (mis-typed placeholder), and stamps centuries into the future
 *  are equally suspicious. The window is intentionally wide enough to
 *  cover any realistic user-typed past / future date. */
const YEAR_FLOOR = 1900;
const YEAR_CEILING = 2100;

/** Reject malformed ISO-8601 calendar dates by round-tripping through
 *  a UTC `Date`. The pattern in `extract.ts` already asserts shape;
 *  this is the semantic check. Round-trip mismatch (`2023-02-29` rolls
 *  to `2023-03-01`) reveals the date never existed. */
const isCertainDate = (raw: string): boolean => {
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < YEAR_FLOOR || year > YEAR_CEILING) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const stamp = new Date(Date.UTC(year, month - 1, day));
  return (
    stamp.getUTCFullYear() === year
    && stamp.getUTCMonth() === month - 1
    && stamp.getUTCDate() === day
  );
};

/** Reject `24:00`-or-later 24-hour times. The pattern's `[0-2]\d`
 *  prefix admits `24..29`; the rest of the digits are already in
 *  range by the regex's character classes. */
const isCertainTime = (raw: string): boolean => {
  const hour = Number(raw.slice(0, 2));
  return hour <= 23;
};

/** Canonicalise an email — lower-case the whole address. Domains are
 *  case-insensitive per RFC 5321; local-parts are technically
 *  case-sensitive but every practical SMTP server treats them as
 *  case-insensitive. Lower-casing matches the warehouse's storage
 *  convention (see `canonical-shapes.md` contact-by-email keying). */
const canonicaliseEmail = (raw: string): string => raw.toLowerCase();

/** Promote a single `RawSlot` to a `SlotValue` if it clears the
 *  per-kind certainty rule; return `null` otherwise. Pure function. */
export const gateOne = (slot: RawSlot): SlotValue | null => {
  switch (slot.kind) {
    case 'entity.email':
      return {
        kind: 'entity.email',
        value: canonicaliseEmail(slot.raw),
        raw: slot.raw,
        position: slot.position,
      };
    case 'date':
      if (!isCertainDate(slot.raw)) return null;
      return {
        kind: 'date',
        value: slot.raw,
        raw: slot.raw,
        position: slot.position,
      };
    case 'time':
      if (!isCertainTime(slot.raw)) return null;
      return {
        kind: 'time',
        value: slot.raw,
        raw: slot.raw,
        position: slot.position,
      };
    case 'entity.name':
      return {
        kind: 'entity.name',
        value: slot.raw,
        raw: slot.raw,
        position: slot.position,
      };
  }
};

/** Gate a whole extraction. Returns the subset of `raws` that clears
 *  the per-kind rules in input order. An empty result is meaningful:
 *  the caller in `index.ts` translates it to a `null` `ExtractionResult`
 *  (the pass-through signal). */
export const gateExtraction = (
  raws: ReadonlyArray<RawSlot>,
): ReadonlyArray<SlotValue> => {
  const out: SlotValue[] = [];
  for (const raw of raws) {
    const gated = gateOne(raw);
    if (gated !== null) out.push(gated);
  }
  return out;
};
