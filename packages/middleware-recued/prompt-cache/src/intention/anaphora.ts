/** D-164 P4c — anaphora detection.
 *
 *  Deterministic, closed-list detection of current-session anaphora in
 *  the user's latest message. Three kinds (design § 2):
 *    - **pronoun** — third-person singular / plural (`he` / `she` /
 *      `it` / `they` / `them` / `him` / `her`) plus the possessive
 *      determiners `his` / `their` (P9 — the two-text rewrite resolves
 *      "and HIS phone?" / "what about THEIR email?"; bare `her` already
 *      covers the feminine determiner). `its` is deliberately absent:
 *      an `its`-anaphor refers to a THING (usually the attribute value
 *      just rendered), never a contact, and the rewrite would bind it
 *      to a person.
 *    - **demonstrative** — `this one` / `that one` / `these` / `those`
 *    - **ordinal** — `the first` / `the second` / ... / `the last` /
 *      `the previous` (WORD ordinals, broad — no head-noun requirement),
 *      plus the NUMERAL form `the 1st one` / `the 2nd one` / ...
 *      (NARROW — the `one` head is required AT THE DETECTOR). The
 *      asymmetry is measured, not stylistic: numeral ordinals are the
 *      canonical English date / noun-modifier form ("before the 25th",
 *      "the 70th birthday party", "the 18th century exhibit"), so a
 *      broad numeral arm reroutes genuinely-direct prompts off the
 *      direct path into anaphora deferral — 20 such texts in the
 *      14,154-text use-case corpus, every one a noun modifier, zero of
 *      them list references. The `one`-headed numeral phrase rerouted
 *      ZERO corpus texts. Word ordinals keep their grandfathered
 *      breadth (already triggers since P4c — narrowing them would
 *      change the residual-check semantics the P11 binder relies on).
 *
 *  English only — multilingual variants land alongside P4d's NER
 *  `languages/` substrate. The router is "barely more than a context-
 *  attachment helper" (design § 2); over-broad matching (`this` /
 *  `that` / `the one` alone) is intentionally OUT of scope at P4c —
 *  bare demonstratives fire too often on non-anaphoric text. The
 *  closed-list shape lets us tighten / loosen by registry edit later
 *  without spec churn.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md § 2.
 */

/** What kind of anaphor matched. */
export type AnaphoraKind = 'pronoun' | 'demonstrative' | 'ordinal';

/** One anaphora hit — the trigger string + where it sits in the text. */
export interface AnaphoraSignal {
  readonly kind: AnaphoraKind;
  readonly trigger: string;
  readonly position: number;
}

/** The numeral-ordinal TOKEN pieces, exported so the list binder's
 *  counting grammar (`gate/anaphora-rewrite.ts` `LIST_REFERENCE_RE`)
 *  composes its numeral branch from the SAME source — the detector and
 *  the counter cannot drift apart on what a numeral ordinal is. Digits
 *  are `1`–`999` with no leading zero (mirrors the list parser's
 *  3-digit marker bound; `the 0th one` is unmodeled and never routes);
 *  the suffix alternatives pair loosely here — `the 2th one` still
 *  ROUTES (and then defers at the binder's strict suffix-agreement
 *  rule) rather than silently staying direct. */
export const NUMERAL_ORDINAL_DIGITS_SOURCE = String.raw`[1-9]\d{0,2}`;
export const NUMERAL_ORDINAL_SUFFIX_ALTERNATIVES = 'st|nd|rd|th';

/** Word-boundary-anchored patterns for each kind. The case-insensitive
 *  flag is on each pattern; the `\b` anchors keep `it` from matching
 *  inside `submit` / `email`, `they` from matching inside `theyll`,
 *  etc. (Contractions like `they'll` still tokenize as `they` + `'ll`
 *  under `\b` — accepted as a useful match.) */
const PATTERNS: ReadonlyArray<{ kind: AnaphoraKind; regex: RegExp }> = [
  {
    kind: 'pronoun',
    regex: /\b(he|she|it|they|them|him|her|his|their)\b/i,
  },
  {
    kind: 'demonstrative',
    regex: /\b(this|that)\s+one\b|\b(these|those)\b/i,
  },
  {
    kind: 'ordinal',
    // composes to: /\bthe\s+(first|…|former)\b|\bthe\s+[1-9]\d{0,2}(?:st|nd|rd|th)\s+one\b(?!-)/i
    // The `(?!-)` keeps compound nouns out: "the 1st one-on-one" is a
    // MEETING, not an empty `one` head — without it the phrase routes
    // and a name-carrying direct prompt around it loses its direct-path
    // fire (codex R1). `one's` stays in — that IS the binding shape.
    regex: new RegExp(
      String.raw`\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|previous|latter|former)\b`
        + String.raw`|\bthe\s+${NUMERAL_ORDINAL_DIGITS_SOURCE}(?:${NUMERAL_ORDINAL_SUFFIX_ALTERNATIVES})\s+one\b(?!-)`,
      'i',
    ),
  },
];

/** Detect the earliest anaphora hit in `text`, if any. Returns `null`
 *  when none of the closed-list patterns match.
 *
 *  Earliest hit wins so a sentence like "the second one — they said
 *  it" still reports the leading ordinal rather than masking it with a
 *  pronoun two clauses later. The downstream gate / NER walks back
 *  from the trigger's position to identify the referent. */
export const detectAnaphora = (text: string): AnaphoraSignal | null => {
  let best: AnaphoraSignal | null = null;
  for (const { kind, regex } of PATTERNS) {
    const match = regex.exec(text);
    if (match === null) continue;
    const candidate: AnaphoraSignal = {
      kind,
      trigger: match[0].toLowerCase(),
      position: match.index,
    };
    if (best === null || candidate.position < best.position) {
      best = candidate;
    }
  }
  return best;
};
