/** D-164 P4d — core extraction logic.
 *
 *  Runs the language-agnostic patterns (email / ISO-8601 date /
 *  24-hour time) plus the active language module's patterns over the
 *  caller's text and returns raw candidate spans. Pure function; no
 *  state, no caller capability check. The 100% certainty gate lives in
 *  `confidence.ts` — this file's job is only to enumerate matches.
 *
 *  Why language-agnostic patterns live here, not in a language module:
 *  email shape (RFC 5322 conservative subset), ISO-8601 date
 *  (`YYYY-MM-DD`), and 24-hour `HH:MM` time tokenize identically across
 *  every locale we register. Pushing them into `languages/en.ts` would
 *  force every other locale to duplicate the same regex; centralising
 *  here keeps language modules focused on locale-specific assets
 *  (proper-noun shape, locale date formats, etc.).
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 ner / § 3 Invariant 4 (slot grammar) / § 3 Invariant 5
 *  (binary certainty). */

/** Universal slot vocabulary tied to enrichment topics (design § 3
 *  Invariant 4). Mirrors `SlotName` from `../types.ts` deliberately —
 *  the NER layer carries an internal alias so the per-language modules
 *  don't need to know the template-side type name. Templates and NER
 *  share the same closed vocabulary; mismatch → pass through. */
export type SlotKind = 'entity.name' | 'entity.email' | 'date' | 'time';

/** A raw extraction span — what the regex (or language rule) saw. The
 *  certainty gate (`confidence.ts`) is what decides whether `raw`
 *  becomes a `SlotValue`. Position is the start index of `raw` in the
 *  scanned text. */
export interface RawSlot {
  readonly kind: SlotKind;
  readonly raw: string;
  readonly position: number;
}

/** Per-language rule bundle. `extract` runs over the same text the
 *  language-agnostic extractors see; the language is expected to add
 *  ONLY locale-specific spans (proper-noun shape, am/pm time, locale
 *  date formats). Returning `[]` is the universal stub — every
 *  registered locale starts as a stub until rules land. */
export interface LanguageRules {
  readonly locale: string;
  readonly extract: (text: string) => ReadonlyArray<RawSlot>;
}

/** Conservative email syntax — standard local + domain shape with a
 *  lowercase TLD requirement. Per-piece:
 *    - **local** — alphanumeric plus `._%+-` (RFC 5321 unquoted form).
 *    - **domain labels** — alphanumeric, dash-interior, dot-separated;
 *      label can't start or end with `-`.
 *    - **TLD** — lowercase letters only, 2-24 chars.
 *
 *  Lowercase-only TLD is the load-bearing FPR knob: stops the regex
 *  from biting a sentence's next word (`bob@x.com.Then show ...`) and
 *  rules out path-suffix collisions where the trailing segment is a
 *  capitalised identifier. URL noise (`/`, `\`, `:`) drops out for
 *  free because none of them appear in the local / domain class.
 *
 *  `\b` anchors at start + end so embeds in prose extract cleanly
 *  without consuming surrounding punctuation. */
const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[a-z]{2,24}\b/g;

/** ISO-8601 calendar date `YYYY-MM-DD`. Range-checks (year window,
 *  month / day, leap-year Feb 29) live in the certainty gate
 *  (`confidence.ts`); this pattern only asserts the digit shape +
 *  separators. */
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** 24-hour time `HH:MM` (optional `:SS`). 12-hour times stay out of
 *  the language-agnostic layer because `am` / `pm` / `am.` / `a.m.`
 *  vary per locale — those forms belong in language modules.
 *
 *  The trailing `(?![.\d:])` rejects three drift modes:
 *    - **`.`** — fractional-seconds suffix (`23:59:59.123`); we don't
 *      canonicalise sub-second precision, so anything that hints at
 *      it is pass-through (design § 3 Invariant 5).
 *    - **`\d`** — runs of more digits suggest the time-shaped span
 *      was part of a larger digit string (e.g. `12:34567`); reject.
 *    - **`:`** — a third colon-segment means HH:MM:SS:??, which we
 *      don't model. The bare `\b` would otherwise backtrack the
 *      optional `:SS` off and emit `HH:MM`, silently dropping the
 *      trailing `:SS.xxx` precision. */
const TIME_24H_RE = /\b([0-2]\d):([0-5]\d)(?::([0-5]\d))?\b(?![.\d:])/g;

/** Strip a single trailing sentence-punctuation character from a raw
 *  match span. The email regex's character class accepts most ASCII
 *  glyphs in the local-part / domain (per RFC 5322 leniency); the rule
 *  here is "if the very last character is end-of-clause punctuation,
 *  drop it." Conservative — does not strip multiple chars. */
const stripTrailingPunctuation = (raw: string): string => {
  const last = raw.charCodeAt(raw.length - 1);
  // `.` `,` `;` `:` `?` `!`
  if (last === 46 || last === 44 || last === 59 || last === 58 || last === 63 || last === 33) {
    return raw.slice(0, -1);
  }
  return raw;
};

/** Push every regex match in `text` as a `RawSlot` of the given kind.
 *  Resets `lastIndex` before each scan so the module-level `RegExp`
 *  literals stay safe to reuse across calls. */
const collectMatches = (
  text: string,
  regex: RegExp,
  kind: SlotKind,
  out: RawSlot[],
): void => {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const raw = stripTrailingPunctuation(match[0]);
    out.push({
      kind,
      raw,
      position: match.index,
    });
    // Guard against zero-width matches to keep the loop terminating.
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
    match = regex.exec(text);
  }
};

/** Extract every raw candidate slot from `text` using the
 *  language-agnostic patterns + the active language's rules.
 *
 *  The returned array is in *discovery order* — language-agnostic
 *  emails first, then ISO dates, then 24-hour times, then whatever
 *  the language module emits (typically names). Stable ordering for
 *  the certainty gate; callers must not assume left-to-right position
 *  order without re-sorting. */
export const extractRawSlots = (
  text: string,
  language: LanguageRules,
): ReadonlyArray<RawSlot> => {
  if (text.length === 0) return [];
  const slots: RawSlot[] = [];
  collectMatches(text, EMAIL_RE, 'entity.email', slots);
  collectMatches(text, ISO_DATE_RE, 'date', slots);
  collectMatches(text, TIME_24H_RE, 'time', slots);
  for (const slot of language.extract(text)) {
    slots.push(slot);
  }
  return slots;
};
