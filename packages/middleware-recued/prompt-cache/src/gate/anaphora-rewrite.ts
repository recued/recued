/** D-164 P9 / P11 — two-text anaphora rewrite.
 *
 *  Resolves an anaphoric follow-up into the equivalent DIRECT prompt so
 *  the EXISTING family matchers — whose whitelists were hardened against
 *  direct prompts — can adjudicate it unchanged. This is the "two-text
 *  matcher" the gate's referent deferral was waiting for: the REFERENT
 *  text (the prior assistant turn) supplies the entity, the CURRENT
 *  prompt supplies the attribute / intent — but rather than teach every
 *  family a second, anaphor-shaped grammar, the rewrite substitutes the
 *  entity INTO the prompt and lets the one existing grammar per family
 *  do all the intent work. Every family (contact-attribute, has-email,
 *  calendar next-meeting, mail from-count) gains the anaphora path
 *  through this one reviewed seam.
 *
 *  Two binders, dispatched on the detector's signal kind:
 *    - **pronoun** (P9) — "what about her phone?" binds the pronoun to
 *      the referent's unique certainty-gated NAME (`rewritePronounPrompt`).
 *    - **ordinal / demonstrative** (P11) — "what is the second one's
 *      email?" indexes the referent's LIST SHAPE — line-shaped
 *      (`./referent-list.ts`) or inline comma enumeration
 *      (`./referent-inline-list.ts`, P11c) — and binds the phrase to
 *      the selected item's unique name (`rewriteListItemPrompt`).
 *      List-item resolution is a different closed mechanism on the
 *      same substrate — a name substitution can't model it (P9
 *      deferred these wholesale).
 *
 *  Why substitution is sound here (design § 3 Invariant 5 / 7): a wrong
 *  short-circuit answer is worse than a pass-through, so every step is a
 *  closed rule that DEFERS on anything unmodeled. Shared across binders:
 *    - the prompt must carry NO `entity.name` of its own (a pure
 *      anaphoric follow-up names nobody; a prompt-side name is either a
 *      second referenced person or a pronoun-homograph NAME — "His
 *      Excellence", "He Wei" — that substitution would corrupt);
 *    - the prompt must carry EXACTLY ONE reference overall (a second
 *      reference is a second, unmodeled binding — "does she have his
 *      number?", "the second one and their email");
 *    - after substitution, `detectAnaphora` over the rewritten text must
 *      find NOTHING (a residual anaphor means the prompt still carries an
 *      unresolved reference — including a substituted name that is itself
 *      a pronoun homograph, e.g. the surname-leading "He Wei").
 *  The rewritten text then re-enters the NORMAL pipeline — certainty-gated
 *  NER, the family whitelist, the warehouse probe — so every existing
 *  rejection rule applies to it verbatim. A substitution that synthesizes
 *  an unanticipated shape simply fails those gates (pass-through), never
 *  fires them; for a WRONG fire the user's prompt must already be exactly
 *  an anchored family question with the anaphor in the name position —
 *  i.e. a genuine follow-up about one entity the prior turn presented.
 *
 *  The residual risk is the BINDING itself. Pronouns: a third-person
 *  pronoun is bound to the referent's unique name without gender
 *  agreement (names carry no deterministic gender; an LLM binds the same
 *  way against the same history). List items: the authored list order is
 *  what the user counts — the sequence + uniform-indent rules in
 *  `parseReferentList` keep the parsed order equal to the visible order.
 *  Two mitigations for both: the referent is the MOST RECENT assistant
 *  turn (maximum salience), and every family body LEADS with the resolved
 *  display name ("Pat Lee's phone number is …"), so a mis-bound answer is
 *  self-identifying, never silent.
 *
 *  Pure module: text in, text-or-null out. No ctx, no IO. */

import {
  detectAnaphora,
  NUMERAL_ORDINAL_DIGITS_SOURCE,
  NUMERAL_ORDINAL_SUFFIX_ALTERNATIVES,
  type AnaphoraSignal,
} from '../intention/anaphora.js';
import { extract } from '../ner/index.js';

import { parseInlineNameList } from './referent-inline-list.js';
import { parseReferentList } from './referent-list.js';

/** The two texts + the detected signal the gate hands the rewrite. */
export interface AnaphoraRewriteInput {
  /** The user's CURRENT prompt — carries the attribute / intent. */
  readonly promptText: string;
  /** The prior assistant turn — carries the entity the anaphor binds to. */
  readonly referentText: string;
  /** The anaphora signal `attach` detected on the prompt. */
  readonly signal: AnaphoraSignal;
}

/** Every pronoun-ish token that counts as a REFERENCE for the exactly-one
 *  rule — the detector's pronoun list plus `its` (never a trigger, but a
 *  second reference when it rides along: "her email and its domain"). */
const PRONOUN_TOKEN_RE = /\b(he|she|it|its|they|them|him|her|his|their)\b/gi;

/** Prepositions that license the OBJECT reading of `her` / `him` / `them`
 *  ("meeting with her", "emails from him", "an email for them"). The
 *  closed list matches the family grammars' own prepositions; an object
 *  pronoun after an unmodeled verb ("call her") defers. */
const OBJECT_PREPOSITION_RE = /\b(?:with|from|for|to|of|about)\s+$/i;

/** A word (letter / digit) follows after whitespace — the possessive-
 *  determiner position ("her PHONE", "their EMAIL address"). */
const FOLLOWED_BY_WORD_RE = /^\s+[a-z0-9]/i;

/** The prompt-side name rule, shared by both binders: a pure anaphoric
 *  follow-up names nobody. A prompt-side `entity.name` means either a
 *  second referenced person ("what about her phone, and Bob Stone's?")
 *  or an anaphor-HOMOGRAPH name the substitution would corrupt — "what
 *  is His Excellence's email?" / "He Wei's phone?" carry a name whose
 *  leading token doubles as a pronoun trigger, and substituting that
 *  token rewrites the name itself. Both defer (codex fold: the
 *  homograph wrong-fire). */
const promptCarriesName = (promptText: string): boolean => {
  const extraction = extract(promptText);
  return (
    extraction !== null
    && extraction.slots.some((s) => s.kind === 'entity.name')
  );
};

/** Trim + collapse interior whitespace on an extracted name; `null`
 *  when nothing survives. */
const cleanName = (raw: string): string | null => {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length === 0 ? null : name;
};

// ── The pronoun binder (P9) ────────────────────────────────────────

/** Rewrite a pronoun follow-up into the equivalent direct prompt, or
 *  `null` to defer. See the file header for the shared rules; the
 *  closed substitution table is:
 *
 *  | token            | position required            | substitution |
 *  |------------------|-------------------------------|--------------|
 *  | `his` / `their`  | followed by a word            | `<Name>'s`   |
 *  | `her`            | followed by a word            | `<Name>'s`   |
 *  | `her`            | after an object preposition   | `<Name>`     |
 *  | `him` / `them`   | after an object preposition   | `<Name>`     |
 *  | `he` / `she` / `they` | anywhere (subject form)  | `<Name>`     |
 *  | `it` / `its`     | never — thing-reference       | defer        |
 *
 *  `her` is the one ambiguous form (possessive determiner OR object):
 *  a following word decides possessive ("her phone"), a preceding
 *  preposition decides object ("with her?"); both absent → defer. The
 *  subject forms substitute position-free because a misplaced subject
 *  substitution cannot form a family shape the prompt didn't already
 *  have — the family grammars anchor BOTH ends of the whole prompt. */
const rewritePronounPrompt = (input: AnaphoraRewriteInput): string | null => {
  const { promptText, referentText } = input;
  if (promptCarriesName(promptText)) return null;

  // The entity: exactly one certainty-gated name in the referent.
  const referent = extract(referentText);
  if (referent === null) return null;
  const names = referent.slots.filter((s) => s.kind === 'entity.name');
  if (names.length !== 1) return null;
  const name = cleanName(names[0]!.value);
  if (name === null) return null;

  // The reference: exactly one pronoun-ish token in the prompt.
  const occurrences = [...promptText.matchAll(PRONOUN_TOKEN_RE)];
  if (occurrences.length !== 1) return null;
  const occurrence = occurrences[0]!;
  const token = occurrence[1]!.toLowerCase();
  const start = occurrence.index;
  const before = promptText.slice(0, start);
  const after = promptText.slice(start + occurrence[0].length);

  // The closed substitution table (see the doc above).
  const possessive = FOLLOWED_BY_WORD_RE.test(after);
  const object = OBJECT_PREPOSITION_RE.test(before);
  let replacement: string | null;
  switch (token) {
    case 'his':
    case 'their':
      replacement = possessive ? `${name}'s` : null;
      break;
    case 'her':
      replacement = possessive ? `${name}'s` : object ? name : null;
      break;
    case 'him':
    case 'them':
      replacement = object ? name : null;
      break;
    case 'he':
    case 'she':
    case 'they':
      replacement = name;
      break;
    default: // it / its — thing-reference, never a contact binding
      replacement = null;
  }
  if (replacement === null) return null;

  const rewritten = before + replacement + after;
  // No residual reference may survive the substitution.
  if (detectAnaphora(rewritten) !== null) return null;
  return rewritten;
};

// ── The list-item binder (P11) ─────────────────────────────────────

/** The closed list-reference phrase grammar — the binder's countable +
 *  bindable unit. The numeral branch composes from the DETECTOR's
 *  exported token sources (`../intention/anaphora.ts`) — the P11
 *  watch-out's "detector + union + table TOGETHER" requirement is
 *  structural, not conventional: the two grammars cannot drift apart on
 *  what a numeral ordinal is. The detector's numeral arm is NARROW
 *  (`one` head required) because numeral ordinals are the canonical
 *  date / noun-modifier form — a bare arm reroutes today-FIRING direct
 *  prompts ("btw the 2nd thing: what is Pat Lee's email?"; "before the
 *  25th") into deferral. Corpus-measured (14,154 texts): `one`-headed
 *  numerals reroute ZERO; bare numerals reroute 20, all noun modifiers.
 *
 *  Phrase shapes (each must be the prompt's ONLY reference):
 *    - `the <first..tenth|last> one` — the `one` head noun is REQUIRED:
 *      a bare ordinal's head noun names the item kind ("the second
 *      MEETING") and the binder cannot verify the list holds that kind,
 *      while interrogative heads ("the first name") aren't item
 *      references at all. Only the semantically-empty `one` is closed.
 *    - `the <1st..999th> one` — the numeral twin (`the 2nd one`), same
 *      required `one` head. Digits + suffix capture separately so the
 *      selector can require ENGLISH SUFFIX AGREEMENT (`the 2th one` is
 *      a typo whose intent we must not guess — defer). The 3-digit
 *      bound mirrors `parseReferentList`'s numbered-marker bound.
 *    - `the former` / `the latter` (optional `one`) — idiomatically
 *      drop the head noun; two-item lists only. WITHOUT `one`, the next
 *      token must not be a word: adjectival former / latter qualify a
 *      following NOUN ("the former EMAIL" asks about an old address,
 *      "the latter CASE" picks a scenario) and substituting there
 *      corrupts the prompt (codex fold: "what is the former email?" →
 *      "what is Pat Lee email?"). A possessive clitic, punctuation, or
 *      end-of-text marks the bare item reference ("the former's email",
 *      "who is the latter?").
 *    - `this one` / `that one` — unambiguous only against a ONE-item
 *      list (chat carries no pointer; with N ≥ 2 the deixis is
 *      unresolvable). `these` / `those` never bind — plural. */
// composes to: /\bthe\s+(first|…|last)\s+one\b|\bthe\s+([1-9]\d{0,2})(st|nd|rd|th)\s+one\b(?!-)|\bthe\s+(former|latter)\b(?:\s+one\b|(?!\s+[a-z0-9]))|\b(this|that)\s+one\b/gi
// The numeral branch's `(?!-)` mirrors the detector arm (compound nouns
// — "the 1st one-on-one" — are not item references); the word branches
// keep their P11-reviewed shape, where the BROAD word detector already
// routes those prompts and the residual check holds.
const LIST_REFERENCE_RE = new RegExp(
  String.raw`\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+one\b`
    + String.raw`|\bthe\s+(${NUMERAL_ORDINAL_DIGITS_SOURCE})(${NUMERAL_ORDINAL_SUFFIX_ALTERNATIVES})\s+one\b(?!-)`
    + String.raw`|\bthe\s+(former|latter)\b(?:\s+one\b|(?!\s+[a-z0-9]))`
    + String.raw`|\b(this|that)\s+one\b`,
  'gi',
);

const ORDINAL_WORD_INDEX: ReadonlyMap<string, number> = new Map([
  ['first', 1],
  ['second', 2],
  ['third', 3],
  ['fourth', 4],
  ['fifth', 5],
  ['sixth', 6],
  ['seventh', 7],
  ['eighth', 8],
  ['ninth', 9],
  ['tenth', 10],
]);

/** The correct English ordinal suffix for `n` — `st`/`nd`/`rd` on 1/2/3
 *  finals EXCEPT the teens (11th / 12th / 13th, and 111th / 212th / …),
 *  else `th`. */
const correctOrdinalSuffix = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  const mod10 = n % 10;
  return mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
};

/** Resolve a `LIST_REFERENCE_RE` match to a 1-based item index against
 *  a list of `length` items, or `null` to defer. The selector table:
 *
 *  | phrase                  | requires                    | selects    |
 *  |-------------------------|-----------------------------|------------|
 *  | `the first..tenth one`  | index ≤ N                   | that index |
 *  | `the last one`          | N ≥ 1                       | N          |
 *  | `the 1st..999th one`    | correct suffix AND index ≤ N| that index |
 *  | `the 2th one` etc.      | never — a suffix-number mismatch is a typo
 *  |                         | whose intended index we must not guess — defer |
 *  | `the former`            | N = 2 exactly               | 1          |
 *  | `the latter`            | N = 2 exactly               | 2          |
 *  | `this one` / `that one` | N = 1 exactly               | 1          |
 *  | `the previous`          | never — ambiguous (previous item? previous
 *  |                         | turn?); not in the phrase grammar — defer |
 *  | `these` / `those`       | never — plural; not in the grammar — defer | */
const selectListIndex = (
  match: RegExpMatchArray,
  length: number,
): number | null => {
  const ordinalWord = match[1]?.toLowerCase();
  if (ordinalWord !== undefined) {
    if (ordinalWord === 'last') return length;
    const index = ORDINAL_WORD_INDEX.get(ordinalWord)!;
    return index <= length ? index : null;
  }
  const numeralDigits = match[2];
  if (numeralDigits !== undefined) {
    const index = Number.parseInt(numeralDigits, 10);
    const suffix = match[3]!.toLowerCase();
    if (suffix !== correctOrdinalSuffix(index)) return null; // typo'd ordinal
    return index <= length ? index : null;
  }
  const formerLatter = match[4]?.toLowerCase();
  if (formerLatter !== undefined) {
    if (length !== 2) return null;
    return formerLatter === 'former' ? 1 : 2;
  }
  // this one / that one — group 5 by construction.
  return length === 1 ? 1 : null;
};

/** Rewrite an ordinal / demonstrative follow-up into the equivalent
 *  direct prompt, or `null` to defer. The closed rules, in order:
 *    1. the prompt carries NO `entity.name` of its own (shared rule);
 *    2. the prompt carries ZERO pronoun-ish tokens and EXACTLY ONE
 *       list-reference phrase (the exactly-one-reference rule — "the
 *       second one and his email" / "the first one or the last one"
 *       both carry two references);
 *    3. the referent parses as a closed-shape list — line-shaped
 *       (`parseReferentList`) first, inline comma enumeration
 *       (`parseInlineNameList`, P11c) second; the line parser owns any
 *       referent carrying list-marker lines, so its refusals never fall
 *       through to a prose re-parse;
 *    4. the phrase selects an item via the closed selector table
 *       (`selectListIndex`) — out-of-range / wrong-cardinality defers;
 *    5. the selected ITEM NER-extracts to exactly one certainty-gated
 *       `entity.name` (a multi-name item is ambiguous; a name-less item
 *       — an email-only line, a meeting title — has nothing to bind);
 *    6. the phrase span is replaced with the item's name — position-free,
 *       because the grammatical marks live OUTSIDE the phrase (the `'s`
 *       in "the second one's email", the preposition in "with the second
 *       one") and the family grammars anchor both ends of the rewritten
 *       prompt;
 *    7. no residual anaphor may survive (`detectAnaphora` over the
 *       rewritten text — catches unseen second references like a
 *       trailing "those", and homograph item names like "He Wei"). */
const rewriteListItemPrompt = (input: AnaphoraRewriteInput): string | null => {
  const { promptText, referentText } = input;
  if (promptCarriesName(promptText)) return null;

  // The reference: zero pronouns, exactly one list-reference phrase.
  if ([...promptText.matchAll(PRONOUN_TOKEN_RE)].length !== 0) return null;
  const phrases = [...promptText.matchAll(LIST_REFERENCE_RE)];
  if (phrases.length !== 1) return null;
  const phrase = phrases[0]!;

  // The entity: the phrase-selected item's unique certainty-gated name.
  // Line-shaped lists first; a referent with NO list-marker lines may
  // instead parse as one inline comma enumeration (P11c).
  const items =
    parseReferentList(referentText) ?? parseInlineNameList(referentText);
  if (items === null) return null;
  const index = selectListIndex(phrase, items.length);
  if (index === null) return null;
  const item = extract(items[index - 1]!);
  if (item === null) return null;
  const names = item.slots.filter((s) => s.kind === 'entity.name');
  if (names.length !== 1) return null;
  const name = cleanName(names[0]!.value);
  if (name === null) return null;

  const start = phrase.index;
  const rewritten =
    promptText.slice(0, start)
    + name
    + promptText.slice(start + phrase[0].length);
  // No residual reference may survive the substitution.
  if (detectAnaphora(rewritten) !== null) return null;
  return rewritten;
};

// ── The dispatcher ─────────────────────────────────────────────────

/** Rewrite an anaphoric follow-up into the equivalent direct prompt, or
 *  `null` to defer. Dispatches on the detector's signal kind: pronouns
 *  take the name-substitution binder (P9), ordinals / demonstratives
 *  take the list-item binder (P11). Every defer surfaces as the gate's
 *  `anaphora-unresolved` pass-through. */
export const rewriteAnaphoricPrompt = (
  input: AnaphoraRewriteInput,
): string | null => {
  if (input.signal.kind === 'pronoun') return rewritePronounPrompt(input);
  return rewriteListItemPrompt(input);
};
