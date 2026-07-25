/** D-164 P11c — inline comma-list referent parsing.
 *
 *  Parses a referent whose list is a PROSE ENUMERATION rather than
 *  line-shaped markdown: "You met with 3 people last week: Pat Lee,
 *  Bob Stone, and Ann Chu." List answers come in both shapes; the
 *  line parser (`./referent-list.ts`) covers one, this covers the
 *  other, and the binder consults them in that order.
 *
 *  LANGUAGE-BEARING MODULE (English): the conjunction token (`and`)
 *  and the separator shapes are English grammar. Per the multilingual
 *  boundary discipline (design doc § Multilingual pack architecture)
 *  this lives in the gate/binder layer and folds into `languages/en/`
 *  at pack #2 — it is deliberately NOT in `referent-list.ts`, whose
 *  structural (marker / indent / blank) rules stay word-free.
 *
 *  The closed shape (defer on anything else — the P11 bar holds: a
 *  mis-parsed list is a WRONG-PERSON answer downstream):
 *
 *    <lead> NAME (, NAME)* (, and | and) NAME <terminator-or-end>
 *
 *  enforced as rules over the certainty-gated NER name spans:
 *    - **No line-list jurisdiction.** Any list-marker line anywhere in
 *      the referent → null (`containsListMarkerLine`): line-shaped
 *      referents belong to the line parser, and its REFUSALS (mixed
 *      shapes, bare markers, broken numbering) must not be resurrected
 *      here as a prose parse the user never saw as one list.
 *    - **All names chain.** EVERY `entity.name` the referent extracts
 *      must sit in ONE chain whose between-name gaps are EXACTLY a
 *      separator: interior gaps `", "`; the FINAL gap `", and "` or
 *      `" and "` (Oxford or not — the conjunction is REQUIRED, which
 *      is what distinguishes a deliberate enumeration from incidental
 *      comma-adjacent names, and makes N ≥ 2 structural). One rule
 *      closes three hazards at once: an appositive between names
 *      ("Pat Lee, the CEO of Acme, and Bob Stone" — gap unparseable),
 *      a SECOND enumeration or stray name elsewhere in the turn (the
 *      cross-sentence gap unparseable), and "A and B and C" chains
 *      (interior gap not a comma) all defer.
 *    - **Left edge — the lead must be provably item-free.** The chain
 *      rule only accounts for names NER can CERTIFY; an item it cannot
 *      ("J. Smith", "pat lee", "your manager") hiding in the lead
 *      shifts every ordinal the user counts (codex R1 HIGH: "…: J.
 *      Smith; Bob Stone, and Ann Chu" — the visible second is Bob, the
 *      parsed second is Ann). Separator-edge heuristics can't close
 *      this (any delimiter joins: `;` `&` `—` `or`), so the lead must
 *      be one of three CONTAINMENT shapes: (a) empty/whitespace (the
 *      bare list); (b) anything ending in a COLON immediately before
 *      the first name — the colon scopes the enumeration ("You met
 *      with 3 people last week: …"), an invisible item between the
 *      colon and the first gated name re-breaks the shape, and
 *      counting items out of the pre-colon FRAME itself is unnatural
 *      (accepted); (c) an ALLOWLISTED single-line verb-phrase lead.
 *      Codex R2 killed the denylist predecessor — separator characters
 *      are an open class (`;` `&` `—` `/` `+` `·` quotes parens …), so
 *      item-freedom must be proven by what the lead IS, not what it
 *      lacks. Shape (c) admits only: lowercase letter/apostrophe
 *      words, including intra-word hyphens; the pronoun-I family
 *      ("Today I met …"); a CAPITALIZED
 *      token only at position 0 and only from the closed
 *      sentence-starter lexicon ("You"/"We"/"Today"/"They"/…) —
 *      because shape alone cannot tell a sentence-initial verb phrase
 *      ("You met ") from a leading SINGLE-TOKEN NAME the NER can't
 *      certify ("Alice vs ", "Alice and " — both must defer, and do,
 *      since "Alice" is no starter); and NO joining word anywhere
 *      (`and` `or` `with` `vs` `plus` … — "you met pat lee and Bob
 *      Stone, and Ann Chu" would otherwise admit with the lowercase
 *      lead item dropped). Everything else — a second capitalized
 *      token ("J. Smith"), digits, punctuation outside intra-word
 *      hyphens, a newline —
 *      defers. "You met Pat Lee and Bob Stone." parses; "You met J.
 *      Smith. You also met Pat…", "Last week in London, you met…",
 *      and every delimiter join defer. Losses ("You met with A and
 *      B." — `with` banned; digits; diacritics) are accepted: the
 *      colon form carries rich intros.
 *    - **Right edge — nothing may follow.** After the last name: one
 *      optional sentence terminator, then whitespace to END OF TEXT.
 *      A trailing fragment can hide an item NER can't certify (codex
 *      R1 HIGH: "…and Ann Chu. Alice too." — the user's LAST is
 *      Alice, the parsed last is Ann), and no lexical heuristic
 *      separates "Alice too." from "Want details?" (both
 *      sentence-initial capitals). Possessive / modifier tails
 *      ("and Ann Chu's manager", "and Ann Chu last week") defer a
 *      fortiori. Deferring harmless closers ("…Ann Chu. Want
 *      details?") is the accepted price of airtightness — the LLM
 *      path answers those.
 *
 *    - **No name spans a line break.** The NER's capitalized-run rule
 *      crosses `\s+` — including newlines — so "Alice\nPat Lee, Bob
 *      Stone, and Ann Chu" extracts "Alice\nPat Lee" as ONE name and
 *      every ordinal shifts off what the user saw as two lines (codex
 *      R2 HIGH). Any name whose raw span carries `\r` or `\n` defers
 *      the whole parse. Newlines INSIDE separators stay legal (a
 *      wrapped sentence — "Pat Lee,\nBob Stone, and Ann Chu" — keeps
 *      the visible order), and a colon-anchored lead may end with a
 *      newline ("Here they are:\nPat Lee and Bob Stone" — the list on
 *      its own unmarked line, still colon-scoped).
 *
 *  Items are returned as the names' RAW in-text spans (byte-true to
 *  what the user saw); the binder's per-item NER re-derives the clean
 *  value downstream, identically to line-parsed items.
 *
 *  Pure module: text in, items-or-null out. No ctx, no IO. */

import { extract } from '../ner/index.js';

import { containsListMarkerLine } from './referent-list.js';

/** Interior separator — exactly one comma then whitespace. */
const INTERIOR_GAP_RE = /^,\s+$/;

/** Final separator — the REQUIRED conjunction, Oxford comma optional. */
const FINAL_GAP_RE = /^(?:,)?\s+and\s+$/;

/** Lead shape (b): anything ending in a colon immediately before the
 *  first name. */
const COLON_ANCHORED_LEAD_RE = /:\s*$/;

/** Lead shape (c) vocabulary. A capitalized token can be EITHER a
 *  sentence starter or a name the NER couldn't certify — only this
 *  closed lexicon (position 0 only) is admitted as the former. */
const SENTENCE_STARTERS: ReadonlySet<string> = new Set([
  'you', "you're", "you've", "you'd", "you'll",
  'we', "we're", "we've", "we'd", "we'll",
  'i', 'it', "it's", 'they', "they're", "they've", "they'd", "they'll",
  'this', 'that', "that's", 'these', 'those',
  'today', 'yesterday', 'here', "here's", 'there', "there's",
]);

/** Joining words that can splice an UNCERTIFIED item onto the chain
 *  from inside an otherwise-lowercase lead ("you met pat lee and …").
 *  Banned at any position. */
const BANNED_JOINERS: ReadonlySet<string> = new Set([
  'and', 'or', 'nor', 'plus', 'with', 'vs', 'versus',
  'alongside', 'together', 'including', 'besides', 'except',
]);

const LOWERCASE_WORD_RE = /^[a-z][a-z'’]*(?:-[a-z][a-z'’]*)*$/;
const I_FAMILY_RE = /^I(?:['’][a-z]+)?$/;
const CAPITALIZED_WORD_RE = /^[A-Z][a-z'’]*$/;

/** Lead shape (c): a single-line verb-phrase lead made ONLY of safe
 *  tokens (see the header). Must end with whitespace before the first
 *  name. */
const isSafeVerbPhraseLead = (lead: string): boolean => {
  if (/[\r\n]/.test(lead)) return false;
  if (!/[ \t]$/.test(lead)) return false;
  const tokens = lead.trim().split(/[ \t]+/);
  if (tokens.length === 0 || tokens[0]!.length === 0) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (BANNED_JOINERS.has(token.toLowerCase())) return false;
    if (LOWERCASE_WORD_RE.test(token)) continue;
    if (I_FAMILY_RE.test(token)) continue;
    if (
      i === 0
      && CAPITALIZED_WORD_RE.test(token)
      && SENTENCE_STARTERS.has(token.toLowerCase())
    ) {
      continue;
    }
    return false;
  }
  return true;
};

/** A raw name span crossing a line break is a NER glue artifact, not
 *  a name the user saw as one item. */
const NAME_SPANS_LINE_BREAK_RE = /[\r\n]/;

/** Tail: ONE optional sentence terminator, then whitespace to end of
 *  text — nothing else may follow the enumeration. */
const TAIL_RE = /^[.!?…]?\s*$/;

/** Parse `text` as ONE inline comma enumeration of certainty-gated
 *  names, or `null` to defer. The returned array index `i` IS the
 *  item's ordinal position `i + 1` — the same contract as
 *  `parseReferentList`. */
export const parseInlineNameList = (
  text: string,
): readonly string[] | null => {
  if (containsListMarkerLine(text)) return null;

  const extraction = extract(text);
  if (extraction === null) return null;
  const names = extraction.slots
    .filter((s) => s.kind === 'entity.name')
    .slice()
    .sort((a, b) => a.position - b.position);
  if (names.length < 2) return null;
  if (names.some((n) => NAME_SPANS_LINE_BREAK_RE.test(n.raw))) return null;

  const lead = text.slice(0, names[0]!.position);
  const leadSafe =
    lead.trim().length === 0
    || COLON_ANCHORED_LEAD_RE.test(lead)
    || isSafeVerbPhraseLead(lead);
  if (!leadSafe) return null;

  for (let i = 0; i < names.length - 1; i += 1) {
    const gapStart = names[i]!.position + names[i]!.raw.length;
    const gapEnd = names[i + 1]!.position;
    if (gapEnd <= gapStart) return null; // overlapping spans — unmodeled
    const gap = text.slice(gapStart, gapEnd);
    const rule = i === names.length - 2 ? FINAL_GAP_RE : INTERIOR_GAP_RE;
    if (!rule.test(gap)) return null;
  }

  const last = names[names.length - 1]!;
  const tail = text.slice(last.position + last.raw.length);
  if (!TAIL_RE.test(tail)) return null;

  return names.map((n) => n.raw);
};
