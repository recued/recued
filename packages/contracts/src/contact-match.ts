/** D-138 Phase 1 — predicate-based contact match + canonicalization
 *  helpers. Pure deterministic logic; no IO, no LLM. Same inputs →
 *  same output is a load-bearing property — the substrate is the
 *  permissive surface, the user is the authoritative resolver, and
 *  cross-run repeatability lets the housekeeping scan stay
 *  idempotent.
 *
 *  Spec: `docs/d-138-spec.md` § A.3, § Contract Tightening. */

import {
  CONTACT_MATCH_FIELDS,
  CONTACT_MATCH_MIN_FIELDS,
  NICKNAME_ALIASES,
  type ContactMatchField,
  type ContactRecord,
  type MailingAddress,
  type NicknameAliasSet,
} from './contact.js';

// ────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────

/** Result of a `(ContactRecord, ContactRecord)` predicate evaluation.
 *  `matches: true` iff `matched_fields.length >= CONTACT_MATCH_MIN_FIELDS`. */
export interface ContactMatchResult {
  matches: boolean;
  matched_fields: ContactMatchField[];
}

/** Evaluate the deterministic merge-candidate predicate over two
 *  canonical contact records.
 *
 *  Match shapes (closed list — see `CONTACT_MATCH_FIELDS`):
 *    - `name`            — per-token rule. Tokenize on whitespace;
 *      every token-pair on the shorter-tokenized side must pass:
 *      (a) exact, (b) `NICKNAME_ALIASES` alias-resolved exact, OR
 *      (c) Levenshtein ≤ 2 on the raw lowercased token. The match
 *      counts only when every shorter-side token finds a partner.
 *    - `company`         — exact case-insensitive on `company_norm`
 *      (suffix-stripped + whitespace-collapsed via `deriveCompanyNorm`).
 *    - `phone`           — E.164 exact (NULL on either side
 *      disqualifies).
 *    - `mailing_address` — `address1` + `city` + `zip` + `country`
 *      all match after per-field canonicalization. `address2` is
 *      ignored (apt/suite changes within same building); `state` is
 *      ignored when `zip + country` match because zip provides
 *      geographic uniqueness. NULL on either side disqualifies.
 *
 *  No weights, no calibrated threshold. Since user reviews every
 *  candidate (heuristic matches NEVER auto-link), false positives
 *  cost a click and false negatives surface on the next write or
 *  housekeeping cycle. The substrate doesn't make precision/recall
 *  tradeoffs — the user is the resolver. */
export const evaluateContactMatch = (a: ContactRecord, b: ContactRecord): ContactMatchResult => {
  const matched: ContactMatchField[] = [];

  if (matchesNameField(a.name, b.name)) matched.push('name');
  if (matchesCompanyField(a.company_norm, b.company_norm)) matched.push('company');
  if (matchesPhoneField(a.phone, b.phone)) matched.push('phone');
  if (matchesAddressField(a.mailing_address, b.mailing_address)) matched.push('mailing_address');

  return {
    matches: matched.length >= CONTACT_MATCH_MIN_FIELDS,
    matched_fields: matched,
  };
};

/** Canonicalize a freeform phone string into E.164 (e.g.
 *  `'(415) 555-1234'` + `'US'` → `'+14155551234'`). Returns null on
 *  unparseable input.
 *
 *  Country code precedence at the call site (this helper consumes the
 *  resolved value):
 *    1. Caller-supplied explicit `defaultCountryCode` arg
 *    2. User-settings field (`prefs.contact.default_country_code`,
 *       initial seed `'US'` → `'+1'`) — caller passes through
 *    3. `emailHint` — TLD heuristic (`.uk` → `'+44'`, `.de` → `'+49'`,
 *       …) — best-effort; supply `emailHint` to opt in
 *    4. `null` (unparseable; phone field stays unpopulated)
 *
 *  Strips every non-`+`/non-digit character from the input. Inputs
 *  that already start with `+` are accepted verbatim (after digit
 *  filtering). Inputs with a leading country-code-style digit chain
 *  but no `+` follow the country-code precedence above. */
export const canonicalizePhone = (
  input: string | null | undefined,
  defaultCountryCode?: string,
  emailHint?: string,
): string | null => {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) return null;
  if (startsWithPlus) {
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  }
  // Local-format input — try the country-code precedence chain.
  const cc = resolvePhoneCountryCode(defaultCountryCode, emailHint);
  if (!cc) return null;
  // US + Canada special-case: both +1 with 10-digit national; if the
  // raw input already includes a leading `1`, strip before prefixing.
  if (cc === '+1') {
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    return null;
  }
  // Generic — trust the caller's country code, prepend without
  // checking national-number-plan length (different countries vary).
  // Reject implausible lengths so garbage input doesn't propagate.
  if (digits.length < 6 || digits.length > 15) return null;
  return `${cc}${digits}`;
};

/** Country-code precedence helper. Exported for test coverage. */
export const resolvePhoneCountryCode = (
  defaultCountryCode?: string,
  emailHint?: string,
): string | null => {
  if (defaultCountryCode) {
    const explicit = normalizeCountryCode(defaultCountryCode);
    if (explicit) return explicit;
  }
  if (emailHint) {
    const fromTld = countryCodeFromEmailTld(emailHint);
    if (fromTld) return fromTld;
  }
  return null;
};

/** Map a 2-letter country code or `'+NN'` form to E.164 prefix.
 *  Returns null on unrecognized input. The mapping is intentionally
 *  small — only the high-traffic countries Recued users sit in
 *  initially. Additions are one-line registry edits. */
const normalizeCountryCode = (cc: string): string | null => {
  const trimmed = cc.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    return /^\+\d{1,4}$/.test(trimmed) ? trimmed : null;
  }
  const upper = trimmed.toUpperCase();
  return COUNTRY_TO_E164_PREFIX[upper] ?? null;
};

const countryCodeFromEmailTld = (email: string): string | null => {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const dot = email.lastIndexOf('.');
  if (dot < 0 || dot < at) return null;
  const tld = email.slice(dot + 1).toLowerCase();
  return TLD_TO_E164_PREFIX[tld] ?? null;
};

const COUNTRY_TO_E164_PREFIX: Record<string, string> = {
  US: '+1',
  CA: '+1',
  GB: '+44',
  UK: '+44',
  DE: '+49',
  FR: '+33',
  ES: '+34',
  IT: '+39',
  NL: '+31',
  BE: '+32',
  CH: '+41',
  AT: '+43',
  IE: '+353',
  AU: '+61',
  NZ: '+64',
  IN: '+91',
  JP: '+81',
  KR: '+82',
  CN: '+86',
  HK: '+852',
  SG: '+65',
  BR: '+55',
  MX: '+52',
};

const TLD_TO_E164_PREFIX: Record<string, string> = {
  uk: '+44',
  de: '+49',
  fr: '+33',
  es: '+34',
  it: '+39',
  nl: '+31',
  be: '+32',
  ch: '+41',
  at: '+43',
  ie: '+353',
  au: '+61',
  nz: '+64',
  in: '+91',
  jp: '+81',
  kr: '+82',
  cn: '+86',
  br: '+55',
  mx: '+52',
};

/** Permissive input shape — accepts vendor field names + their
 *  cross-region aliases (`province` for `state`, `postal_code` for
 *  `zip`). Returns null when any required field (`address1`, `city`,
 *  `zip`, `country`) is missing after normalization. */
export interface MailingAddressInput {
  address1?: string;
  address2?: string;
  city?: string;
  /** State, province, or 2-letter code. */
  state?: string;
  /** Alias for `state` — non-US callers may carry province. */
  province?: string;
  zip?: string;
  /** Alias for `zip` — Salesforce uses `MailingPostalCode`. */
  postal_code?: string;
  country?: string;
}

/** Per-field normalization that produces the structured `MailingAddress`
 *  the predicate compares. Required fields: `address1`, `city`, `zip`,
 *  `country`. Returns null on any missing required field — partial
 *  addresses don't persist. `address2` is preserved when present but
 *  ignored by the predicate. */
export const canonicalizeMailingAddress = (input: MailingAddressInput): MailingAddress | null => {
  const address1 = canonicalizeAddressLine(input.address1);
  const city = collapseLower(input.city);
  const stateRaw = input.state ?? input.province;
  const state = canonicalizeStateField(stateRaw);
  const zip = canonicalizeZip(input.zip ?? input.postal_code);
  const country = canonicalizeCountry(input.country);
  if (!address1 || !city || !zip || !country) return null;
  if (state === null) return null;
  const out: MailingAddress = { address1, city, state, zip, country };
  const address2 = input.address2 ? collapseLower(input.address2) : '';
  if (address2) out.address2 = address2;
  return out;
};

const ABBREVIATION_MAP: Record<string, string> = {
  st: 'street',
  street: 'street',
  ave: 'avenue',
  avenue: 'avenue',
  blvd: 'boulevard',
  boulevard: 'boulevard',
  rd: 'road',
  road: 'road',
  dr: 'drive',
  drive: 'drive',
  ln: 'lane',
  lane: 'lane',
  ct: 'court',
  court: 'court',
  hwy: 'highway',
  highway: 'highway',
  pkwy: 'parkway',
  parkway: 'parkway',
  pl: 'place',
  place: 'place',
  ter: 'terrace',
  terrace: 'terrace',
  trl: 'trail',
  trail: 'trail',
  ste: 'suite',
  suite: 'suite',
  apt: 'apt',
  apartment: 'apt',
  fl: 'floor',
  floor: 'floor',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
};

const canonicalizeAddressLine = (raw: string | undefined): string => {
  if (!raw) return '';
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens
    .map((tok) => {
      // Strip trailing single-char punctuation (`.` / `,`) before
      // looking up the abbreviation map. Keeps `123 Main St.` and
      // `123 Main St` collapsing onto the same canonical form.
      const stripped = tok.replace(/[.,]+$/g, '');
      return ABBREVIATION_MAP[stripped] ?? stripped;
    })
    .filter(Boolean)
    .join(' ');
};

const collapseLower = (raw: string | undefined): string => {
  if (!raw) return '';
  return raw.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
};

const canonicalizeStateField = (raw: string | undefined): string => {
  if (raw === undefined || raw === null) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 2-letter US state codes preserved verbatim (uppercased). Anything
  // longer collapses to lowercase.
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return collapseLower(trimmed);
};

const canonicalizeZip = (raw: string | undefined): string => {
  if (!raw) return '';
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
};

const canonicalizeCountry = (raw: string | undefined): string => {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  // Map a small set of common full-name forms to ISO-2.
  const lower = trimmed.toLowerCase();
  return COUNTRY_NAME_TO_ISO2[lower] ?? '';
};

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'canada': 'CA',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'germany': 'DE',
  'france': 'FR',
  'spain': 'ES',
  'italy': 'IT',
  'netherlands': 'NL',
  'belgium': 'BE',
  'switzerland': 'CH',
  'austria': 'AT',
  'ireland': 'IE',
  'australia': 'AU',
  'new zealand': 'NZ',
  'india': 'IN',
  'japan': 'JP',
  'south korea': 'KR',
  'china': 'CN',
  'hong kong': 'HK',
  'singapore': 'SG',
  'brazil': 'BR',
  'mexico': 'MX',
};

// ────────────────────────────────────────────────────────────────
// Blocking-key derivation
// ────────────────────────────────────────────────────────────────

/** Lowercased + whitespace-collapsed first-token + last-token. The
 *  first token is alias-resolved through `NICKNAME_ALIASES` so
 *  `'Bob Smith'` and `'Robert Smith'` produce the same key. NULL when
 *  the name has fewer than two whitespace-separated tokens (single-
 *  token names — e.g. a vendor record with only `firstname` — can't
 *  participate in name-key blocking). */
export const deriveNameKey = (name: string | null | undefined): string | null => {
  if (typeof name !== 'string') return null;
  const tokens = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const first = aliasCanonicalize(tokens[0]!);
  const last = tokens[tokens.length - 1]!;
  return `${first} ${last}`;
};

/** `${zip}|${country}` after canonicalization. NULL when the address
 *  is null. */
export const deriveAddressZipCountryKey = (address: MailingAddress | null | undefined): string | null => {
  if (!address) return null;
  return `${address.zip}|${address.country}`;
};

/** Lowercased + trimmed + whitespace-collapsed + suffix-stripped
 *  (`'Inc.'` / `'LLC'` / `'Co.'` / `'Ltd.'` / `'Corp.'` / etc.). NULL
 *  when company is null. */
export const deriveCompanyNorm = (company: string | null | undefined): string | null => {
  if (typeof company !== 'string') return null;
  const normalized = company
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => tok.replace(/[.,]+$/g, ''))
    .filter((tok) => !COMPANY_SUFFIX_STOPWORDS.has(tok))
    .join(' ');
  return normalized || null;
};

const COMPANY_SUFFIX_STOPWORDS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'llc',
  'l.l.c',
  'co',
  'company',
  'corp',
  'corporation',
  'ltd',
  'limited',
  'plc',
  'gmbh',
  'sa',
  's.a',
  'ag',
  'kg',
  'bv',
  'b.v',
  'oy',
  'ab',
  'as',
  'sl',
  'sas',
  'srl',
  'sarl',
]);

// ────────────────────────────────────────────────────────────────
// Per-field predicate helpers
// ────────────────────────────────────────────────────────────────

const matchesNameField = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false;
  const tokensA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const tokensB = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  // Per-token rule: every token on the shorter-tokenized side must
  // find a partner in the longer side at the SAME position from each
  // end (firsts to firsts, lasts to lasts). Vendor name fields almost
  // always carry `firstname + lastname` — anchoring to the ends
  // prevents middle-name token mismatches from defeating Bob Smith
  // vs Robert Adam Smith.
  const shorter = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longer = tokensA.length <= tokensB.length ? tokensB : tokensA;
  if (shorter.length === 0) return false;
  // Compare first token to first token, last token to last token.
  // For 2-token names this checks both tokens; for 1-token names this
  // only checks the single token (which gets compared against both
  // ends of the longer side and counts when either passes).
  const firstS = shorter[0]!;
  const lastS = shorter[shorter.length - 1]!;
  const firstL = longer[0]!;
  const lastL = longer[longer.length - 1]!;
  if (shorter.length === 1) {
    return tokenMatches(firstS, firstL) || tokenMatches(firstS, lastL);
  }
  if (!tokenMatches(firstS, firstL)) return false;
  if (!tokenMatches(lastS, lastL)) return false;
  // For names with 3+ tokens on the shorter side, require all interior
  // tokens to match too (Levenshtein on the corresponding longer-side
  // token if both sides have the same length, or skip-best-match
  // otherwise). Conservative: only fire when every interior token
  // finds a match.
  for (let i = 1; i < shorter.length - 1; i++) {
    const interior = shorter[i]!;
    let found = false;
    for (let j = 1; j < longer.length - 1; j++) {
      if (tokenMatches(interior, longer[j]!)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
};

const tokenMatches = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (aliasesShareCluster(a, b)) return true;
  return levenshtein(a, b) <= 2;
};

/** Returns true when both tokens belong to the same `NICKNAME_ALIASES`
 *  cluster (canonical + alias union). */
const aliasesShareCluster = (a: string, b: string): boolean => {
  const sets = aliasIndex();
  const setA = sets.get(a);
  const setB = sets.get(b);
  if (!setA || !setB) return false;
  return setA === setB;
};

let cachedAliasIndex: Map<string, NicknameAliasSet> | null = null;
const aliasIndex = (): Map<string, NicknameAliasSet> => {
  if (cachedAliasIndex) return cachedAliasIndex;
  const m = new Map<string, NicknameAliasSet>();
  for (const cluster of NICKNAME_ALIASES) {
    m.set(cluster.canonical, cluster);
    for (const alias of cluster.aliases) m.set(alias, cluster);
  }
  cachedAliasIndex = m;
  return m;
};

const aliasCanonicalize = (token: string): string => {
  const cluster = aliasIndex().get(token);
  return cluster ? cluster.canonical : token;
};

const matchesCompanyField = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (!a || !b) return false;
  return a === b;
};

const matchesPhoneField = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false;
  return a === b;
};

const matchesAddressField = (
  a: MailingAddress | undefined,
  b: MailingAddress | undefined,
): boolean => {
  if (!a || !b) return false;
  if (a.address1 !== b.address1) return false;
  if (a.city !== b.city) return false;
  if (a.zip !== b.zip) return false;
  if (a.country !== b.country) return false;
  return true;
};

// ────────────────────────────────────────────────────────────────
// Levenshtein
// ────────────────────────────────────────────────────────────────

/** Two-row dynamic-programming Levenshtein. Bounded short-circuit at
 *  3 (one more than the predicate threshold of 2) so we don't compute
 *  full edit distance when the answer is "way too far." */
export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 3) return 1_000;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let minRow = curr[0]!;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
      if (curr[j]! < minRow) minRow = curr[j]!;
    }
    if (minRow > 3) return 1_000;
    [prev, curr] = [curr, prev];
  }
  return prev[lb]!;
};

// ────────────────────────────────────────────────────────────────
// Pair-key + rejection helpers
// ────────────────────────────────────────────────────────────────

/** Lexicographic pair_key — same shape as the queue's UNIQUE column.
 *  `email_a <= email_b` is enforced so `(A, B)` and `(B, A)` both
 *  collapse onto one canonical key. */
export const canonicalPairKey = (a: string, b: string): string => {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
};

/** Rejection-pair lookup helper — pure function over a Set so callers
 *  can pre-compute the set once per scan and reuse across many
 *  predicate evaluations. The Set holds `pair_key` strings. */
export const isPairRejected = (a: string, b: string, rejected: ReadonlySet<string>): boolean => {
  return rejected.has(canonicalPairKey(a, b));
};
