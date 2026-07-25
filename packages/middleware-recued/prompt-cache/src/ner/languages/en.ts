/** D-164 P4d — English language rules.
 *
 *  The reference language implementation. Covers the locale-specific
 *  half of the NER substrate; the language-agnostic patterns (email /
 *  ISO date / 24-hour time) live in `../extract.ts`. English contributes:
 *
 *    - **`entity.name`** — multi-word capitalised proper-noun runs
 *      (`Alice Bond`, `Mary Jane Watson`). The rule deliberately
 *      requires *two or more* capitalised tokens — single-word names
 *      (`Bob`) are too easily confused with sentence-initial verbs
 *      (`Find`) or imperative captions, so they fall outside the
 *      100%-certainty bar per design § 3 Invariant 5.
 *
 *  Three drop / trim rules ride on the regex to keep false-positive rate
 *  low (design § 3 Invariant 7):
 *    1. **Name-atom fragment drop** — runs adjacent to a `-` / `'` /
 *       `’` are partial captures of a hyphen / apostrophe name we don't
 *       fully understand (`Jean-Luc Picard` → would emit `Luc Picard`;
 *       `O'Brien Smith` → `Brien Smith`). Drop so the cache never
 *       half-names someone. *Carve-out:* a trailing **possessive clitic**
 *       (`Ben Carter's …`) is grammar, not a name atom — the run is a
 *       complete name, so it is kept (see `isNameAtomFragment`).
 *    2. **Command-head drop** — runs whose first token is in
 *       `DROP_HEADS` (`Find Alice Bond`, `Email Alice Smith`,
 *       `Status: Email Alice Smith`). The whole run drops — the imperative
 *       contract is "a command head means this isn't a bare name."
 *    3. **Trailing-title trim** — a run ending in an abbreviated title +
 *       `.` (`Does Dr.`, `Is Prof.`) fused the *next* name's title into
 *       itself; the trailing token is trimmed (and the run dropped if that
 *       leaves a single word). Also strips a genealogical suffix
 *       (`Martin Luther King Jr.` → `Martin Luther King`). See
 *       `TITLE_ABBREV`.
 *
 *  Why no sentence-initial drop (changed from the original P4d rule):
 *  the first capitalised word after `.` / `!` / `?` / text-start used to
 *  be dropped wholesale as "too ambiguous." That blunt rule discarded
 *  three high-frequency *real* chat patterns — a prompt that opens with a
 *  name (`Maya Chen hasn't replied`), a name behind an abbreviated title
 *  whose period read as a sentence boundary (`Dr. Aris Thorne`), and the
 *  first name after any clause break. It is replaced by the content-based
 *  `DROP_HEADS` filter, which is position-independent: a run drops on what
 *  its head *is*, not where it sits. The residual risk — a leading
 *  non-name run (`Quarterly Review …`, `Is Bob Around`) emitted as a name
 *  — is *backstopped downstream*: the gate fires only when the extracted
 *  name also resolves against the warehouse (design § 3, two-way 100%);
 *  an unresolved name passes through to the LLM. A dropped real name, by
 *  contrast, is an unrecoverable cache miss. So `DROP_HEADS` is kept
 *  tight (imperative heads only — no interrogatives / auxiliaries / and no
 *  name-ambiguous tokens like `Will` / `May` / `Mark`): we would rather
 *  pass an over-extracted name through the data-presence check than drop a
 *  real one at the source.
 *
 *  No locale-specific date / time forms for English yet: the bench-
 *  validated corpus uses ISO + 24-hour shapes uniformly, and adding
 *  `MM/DD` slash dates here would conflict with the same shape in other
 *  locales (`DD/MM`).
 *
 *  See: D-164
 *  § 1 ner/languages / § 3 Invariant 4 (slot grammar) / § 3
 *  Invariant 5 (binary certainty) / § 3 Invariant 7 (safe small
 *  gains). */

import type { LanguageRules, RawSlot } from '../extract.js';

/** Match a run of 2+ capitalised words separated by single spaces.
 *  `(?:[A-Z][a-z]+)` is the per-word atom: a single uppercase letter
 *  followed by one-or-more lowercase letters (excludes single-letter
 *  initials, acronyms, and all-caps tokens — those have too many
 *  false-positive scenarios). The boundary `\b` anchors keep the
 *  match from biting into adjacent lowercase text. */
const PROPER_NOUN_RUN_RE = /\b(?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)+\b/g;

/** Heads that mark a capitalised run as a command / imperative rather
 *  than a name; the whole run drops (the locked P4d contract:
 *  `Find Mary Jane Watson` → no slot, not `Mary Jane Watson`).
 *
 *  Membership discipline — include a token ONLY when it is overwhelmingly
 *  an imperative in head position AND is not itself a common given name:
 *    - imperatives / actions: yes (`Find`, `Email`, `Schedule`, …);
 *    - interrogatives / auxiliaries (`How`, `Is`, `What`, `Has`): NO — a
 *      leading `Is Bob Jones` / `What Acme Corp` would fuse the head into
 *      the run and drop a real name with it; we let those pass through to
 *      the warehouse check instead (design § 3 two-way 100%);
 *    - name-ambiguous words (`Will`, `May`, `Mark`, `Grace`, `June`): NO —
 *      never silently drop a real name.
 *  A non-name that slips through is caught by the data-presence half of
 *  the gate; a dropped name is unrecoverable. Tilt toward recall. */
const DROP_HEADS: ReadonlySet<string> = new Set([
  // original P4d command-verb heads
  'Find', 'Email', 'Show', 'Send', 'Get', 'Fetch', 'Compare', 'Status',
  'Re', 'Cc', 'Bcc', 'Forward', 'Reply', 'Open', 'Add', 'Update', 'Delete',
  'List', 'Search',
  // additional unambiguous imperative heads common at a chat-prompt start
  'Tell', 'Pull', 'Draft', 'Write', 'Summarize', 'Summarise', 'Generate',
  'Schedule', 'Remind', 'Cancel', 'Confirm', 'Prepare', 'Review', 'Check',
  'Remove', 'Archive', 'Export', 'Import', 'Sort', 'Filter',
]);

/** Abbreviated honorific / suffix titles. A run that *ends* in one of
 *  these immediately followed by `.` has fused the head of the following
 *  name into itself (`Does Dr. Aris Thorne` → the regex sees `Does Dr` +
 *  `Aris Thorne`); the title belongs to the next name, so the trailing
 *  token is trimmed. As a bonus this also strips a genealogical suffix
 *  (`Martin Luther King Jr.` → `Martin Luther King`). Only triggers on a
 *  trailing-and-dotted match, so a real name token is never affected. */
const TITLE_ABBREV: ReadonlySet<string> = new Set([
  'Dr', 'Mr', 'Mrs', 'Ms', 'Mx', 'Prof', 'Capt', 'Lt', 'Sgt', 'Col', 'Gen',
  'Maj', 'Sr', 'Jr', 'Rev', 'Fr', 'Gov', 'Sen', 'Rep', 'Det',
]);

/** Punctuation that, adjacent to a run, marks it as a fragment of a
 *  longer hyphen / apostrophe name atom. */
const NAME_ATOM_PUNCT: ReadonlySet<string> = new Set(['-', "'", '’']);
const APOSTROPHE: ReadonlySet<string> = new Set(["'", '’']);

/** Reject runs that are fragments of a longer hyphen / apostrophe name
 *  atom (`Jean-Luc Picard` would otherwise emit `Luc Picard`; `O'Brien
 *  Smith` would emit `Brien Smith`).
 *
 *  - **Leading** `-` / `'` / `’` immediately before the run → fragment;
 *    we captured the tail of a longer atom. Drop.
 *  - **Leading initial** (`J. Robert Oppenheimer`) immediately before the run
 *    → fragment; without a contextual known-name candidate we understand only
 *    the suffix and must not resolve it as a different contact named `Robert
 *    Oppenheimer`.
 *  - **Trailing** `-` or a mid-atom apostrophe → fragment. Drop.
 *  - **Trailing possessive clitic** (`'`/`’` followed by `s` / `S` /
 *    whitespace / end) → NOT a fragment. `Ben Carter's renewal` is a
 *    complete name plus a grammatical clitic; keep the run. This is the
 *    one carve-out — it recovers the very common possessive phrasing in
 *    chat without re-admitting `O'Brien`-style mid-atom apostrophes. */
const isNameAtomFragment = (
  text: string,
  matchStart: number,
  matchEnd: number,
): boolean => {
  const before = matchStart > 0 ? text[matchStart - 1] : undefined;
  if (before !== undefined && NAME_ATOM_PUNCT.has(before)) return true;
  if (/(?:^|[^\p{L}\p{M}])[A-Za-z]\.\s+$/u.test(text.slice(0, matchStart))) return true;

  const after = matchEnd < text.length ? text[matchEnd] : undefined;
  if (after === undefined || !NAME_ATOM_PUNCT.has(after)) return false;

  if (APOSTROPHE.has(after)) {
    const next = matchEnd + 1 < text.length ? text[matchEnd + 1] : undefined;
    if (next === undefined || next === 's' || next === 'S' || /\s/.test(next)) {
      return false; // possessive clitic — complete name, keep it
    }
  }
  return true; // trailing hyphen or mid-atom apostrophe — fragment
};

/** Reject runs whose first word is a command / imperative head. */
const startsWithDropHead = (raw: string): boolean => {
  const firstSpace = raw.indexOf(' ');
  const head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  return DROP_HEADS.has(head);
};

/** English-only extractor. Returns multi-word proper-noun runs that:
 *  1. aren't fragments of a longer hyphen / apostrophe name atom
 *     (possessive clitics excepted), and
 *  2. don't begin with a known command / imperative head.
 *  Position in the sentence no longer matters — a prompt-leading name is
 *  a first-class extraction (design § 3 Invariant 7; recovery is
 *  backstopped by the gate's data-presence check). */
const extractEn = (text: string): ReadonlyArray<RawSlot> => {
  if (text.length === 0) return [];
  const slots: RawSlot[] = [];
  PROPER_NOUN_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = PROPER_NOUN_RUN_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    const rawEnd = start + match[0].length;

    // Trailing abbreviated-title trim: drop a `… Dr.` / `… Jr.`-style final
    // token (the title heads the *next* name, or is a genealogical suffix).
    let raw = match[0];
    let runEnd = rawEnd;
    const lastSpace = raw.lastIndexOf(' ');
    if (lastSpace !== -1 && text[rawEnd] === '.' && TITLE_ABBREV.has(raw.slice(lastSpace + 1))) {
      raw = raw.slice(0, lastSpace);
      runEnd = start + raw.length;
    }

    // A surviving run must still be a 2+ -word proper-noun run.
    if (raw.indexOf(' ') !== -1) {
      const fragment = isNameAtomFragment(text, start, runEnd);
      const command = startsWithDropHead(raw);
      if (!fragment && !command) {
        slots.push({
          kind: 'entity.name',
          raw,
          position: start,
        });
      }
    }
    if (match.index === PROPER_NOUN_RUN_RE.lastIndex) {
      PROPER_NOUN_RUN_RE.lastIndex += 1;
    }
    match = PROPER_NOUN_RUN_RE.exec(text);
  }
  return slots;
};

/** The exported rule bundle. `locale: 'en'` matches the canonical
 *  BCP-47 primary-tag the registry keys on. */
export const EN_RULES: LanguageRules = {
  locale: 'en',
  extract: extractEn,
};
