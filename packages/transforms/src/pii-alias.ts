/**
 * D-167 — Reversible PII Alias Comfort Layer (P0 substrate).
 *
 * Pure, fixture-only redaction. No Gateway wiring, no I/O. The chat-mode
 * middleware (P1) and the `pii-protect` / `pii-restore` transforms (P4) both
 * compose this substrate; nothing else here yet.
 *
 * Hard invariant — restoration must not fail. Aliasing is allowed to miss
 * (free-text mentions of unknown PII, non-Latin addresses, ambiguous
 * nicknames — all pass through raw in comfort mode); any alias the substrate
 * EMITS must restore deterministically when the same shape returns through
 * display / approval-preview / outbound-write surfaces.
 *
 * Slice 2 (collision-proofing) — the readable Word<N> alias family carries the
 * `pii.` prefix (`pii.Person1`, `pii.Phone1.gb`, `cap_pii.Org2`). A bare
 * `Person1`/`Account5`/`Id9` a user TYPES (anonymization labels, account refs)
 * is then NOT an alias surface, so restore leaves it untouched instead of
 * mapping every `Person1` to whichever real name turn-1 aliased — killing the
 * common restore-collision. The `.invalid`-bearing email composite
 * (`m<N>@d<M>.invalid`) + bare domain (`d<N>.invalid`) are already collision-
 * proof (a shape humans never type) and keep their unprefixed form. See
 * `PII_ALIAS_PREFIX`. The residual — a user literally typing the PREFIXED
 * `pii.PersonN` — is Slice 3's pre-scan reserve/escape job.
 *
 * Spec: docs/d-167-spec.md §Alias vocabulary, §Alias ledger, §Runtime flow.
 */

import type {
  EntityFieldPrivacy,
  LedgerKind,
  PiiAliasableData,
  PiiFieldTag,
  PiiLedgerStoreSnapshot,
  RedactionAliasEntry,
  RedactionSummary,
} from '@recued/contracts';

import {
  buildAhoCorasick,
  findAhoCorasickMatches,
  normalizeForMatch,
  type AhoCorasick,
} from './aho-corasick.js';

/**
 * D-167 Slice 2 — prefix on the readable Word<N> alias family (`name` /
 * `org` / `phone` / `address` / `url` / `external_id` / `account_id` and the
 * malformed-email `email` fallback). The base alias becomes `pii.Person1`,
 * `pii.Phone1`, `pii.Account3`, … so a bare `Person1`/`Account3` a user types is
 * no longer a restorable alias surface — collision-proofing (module doc).
 *
 * The unprefixed email composite (`m<N>@d<M>.invalid`) and bare domain
 * (`d<N>.invalid`) stay as-is — already collision-proof via the reserved
 * `.invalid` TLD. Generation references this constant; the restore /
 * `stripAliasSuffix` / `kindFromBase` / `isAlreadyAliased` regexes encode the
 * SAME prefix literally as `pii\.` (kept in sync by hand — the value is a fixed
 * design decision, not a tunable).
 */
const PII_ALIAS_PREFIX = 'pii.';

/* ──────────────── Ledger ──────────────── */

/**
 * One alias ledger. Mutable; the substrate's allocators populate it as
 * fields and content text get aliased. The ledger never leaves the local
 * process — the LLM only sees alias surfaces.
 */
export interface Ledger {
  scope_id: string;
  /** Forward index: `${kind}::${real_value}` → entry. Lookup-or-allocate. */
  byKindRealValue: Map<string, RedactionAliasEntry>;
  /** Reverse index: `${kind}::${base_alias}` → entry. Restore lookups.
   *  `base_alias` is the alias with any trailing `.suffix` stripped — e.g.
   *  `pii.Phone1.gb` stores under `pii.Phone1` so the LLM can mutate the suffix
   *  without breaking restore. The `pii.` prefix IS part of the base key (it is
   *  the readable family's collision-proofing, not a strippable suffix). */
  byKindBaseAlias: Map<string, RedactionAliasEntry>;
  /** Monotonic counter per kind. First email → `m1`, second → `m2`. */
  counters: Map<LedgerKind, number>;
  /** Sibling counter per canonical alias (for casing variants). Stored
   *  separately from the kind counter so canonical IDs stay clean. */
  siblingCounters: Map<string, number>;
  /** D-167 Slice 3 — user-typed `pii.*` literal → its reserve/escape entry,
   *  keyed `${kind}::${literal_token}`. The pre-scan (`preScanReservePii`)
   *  populates it so the SAME literal a user types more than once (or across
   *  turns, in chat history) REUSES one decision. Entries also live in
   *  `byKindBaseAlias` (so restore returns the literal) but NOT in
   *  `byKindRealValue` — the content pass iterates that map, and a `pii.*`-shaped
   *  `real_value` there would let `scanContent` re-process an emitted alias. */
  preScanLiterals: Map<string, RedactionAliasEntry>;
}

/**
 * The mutable alias-indexing state a ledger carries, minus its `scope_id`. A
 * run-local `PiiLedgerStore` shares ONE of these across every ledger it mints
 * (D-167 Slice 2) so alias numbers stay unique run-wide and the same real value
 * collapses to one alias across `pii-protect` steps — the property that lets the
 * engine restore a whole run's output (`PiiLedgerStore.restoreAll`) with no
 * alias-number collisions. The chat-mode session ledger and direct callers omit
 * it, each owning a private namespace (one `createLedger` = one fresh namespace).
 */
export type AliasNamespace = Omit<Ledger, 'scope_id'>;

const createAliasNamespace = (): AliasNamespace => ({
  byKindRealValue: new Map(),
  byKindBaseAlias: new Map(),
  counters: new Map(),
  siblingCounters: new Map(),
  preScanLiterals: new Map(),
});

/**
 * Build a ledger. With `shared` omitted the ledger owns a private alias
 * namespace (chat-mode session ledger, direct callers, single-step recipe use).
 * With `shared` supplied the ledger's four indices ARE the shared maps, so every
 * ledger built from that one namespace allocates from a single run-wide counter
 * set + forward/reverse index — see `AliasNamespace`. `scope_id` stays per-ledger
 * either way (it is stamped onto entries for provenance, never used as a lookup
 * key), so a shared-namespace ledger still records which step first saw a value.
 */
export const createLedger = (scope_id: string, shared?: AliasNamespace): Ledger => {
  const ns = shared ?? createAliasNamespace();
  return {
    scope_id,
    byKindRealValue: ns.byKindRealValue,
    byKindBaseAlias: ns.byKindBaseAlias,
    counters: ns.counters,
    siblingCounters: ns.siblingCounters,
    preScanLiterals: ns.preScanLiterals,
  };
};

const kindKey = (kind: LedgerKind, value: string) => `${kind}::${value}`;

/** A value made only of digits. Such a value is ambiguous in prose — `94043` is a postcode
 *  or an invoice number or a year, and nothing in the string says which — so `scanContent`
 *  refuses to blind-replace it (see the guard there). Deliberately NOT a length rule:
 *  alphanumeric postcodes (UK `SW1A 1AA`, CA `K1A 0B1`) are distinctive and stay scannable. */
const ALL_DIGITS_RE = /^\d+$/;

/**
 * Next free per-kind counter — SKIP-aware (D-167 Slice 3). Increments past any
 * slot whose `defaultBaseAlias(kind, n)` is already registered in
 * `byKindBaseAlias` (a real alias OR a Slice-3 reservation/escape), so a fresh
 * allocation never collides with a slot the pre-scan claimed for a user-typed
 * `pii.*` literal. Pre-Slice-3 (and whenever no higher slot is pre-claimed) the
 * `while` never runs — `counter+1` is always unallocated — so this is behavior-
 * identical to the old `+1` for the existing alias path. */
const nextCounter = (ledger: Ledger, kind: LedgerKind): number => {
  let n = (ledger.counters.get(kind) ?? 0) + 1;
  while (ledger.byKindBaseAlias.has(kindKey(kind, defaultBaseAlias(kind, n)))) {
    n += 1;
  }
  ledger.counters.set(kind, n);
  return n;
};

/* ──────────────── Counters (for redaction_summary audit) ──────────────── */

export interface RedactionCounters {
  email: number;
  name: number;
  org: number;
  phone: number;
  address: number;
  url: number;
  external_id: number;
  account_id: number;
  content_text_replacements: number;
}

export const createCounters = (): RedactionCounters => ({
  email: 0,
  name: 0,
  org: 0,
  phone: 0,
  address: 0,
  url: 0,
  external_id: 0,
  account_id: 0,
  content_text_replacements: 0,
});

export const summarizeRedactions = (
  counters: RedactionCounters,
): RedactionSummary['counts'] => {
  const out: RedactionSummary['counts'] = {};
  if (counters.email) out.email = counters.email;
  if (counters.name) out.name = counters.name;
  if (counters.org) out.org = counters.org;
  if (counters.phone) out.phone = counters.phone;
  if (counters.address) out.address = counters.address;
  if (counters.url) out.url = counters.url;
  if (counters.external_id) out.external_id = counters.external_id;
  if (counters.account_id) out.account_id = counters.account_id;
  if (counters.content_text_replacements) {
    out.content_text_replacements = counters.content_text_replacements;
  }
  return out;
};

/* ──────────────── Allocation primitives ──────────────── */

interface AllocOpts {
  source_ref?: string;
  via_side_effect_of?: 'email' | 'url';
  /** Custom naming hook called with the freshly-allocated kind counter `n`.
   *  Defaults to the per-kind base alias (`pii.Person<N>`, `pii.Phone<N>`, etc.) for
   *  both `alias_value` and `base_alias`. Override when the alias needs a
   *  composed surface (phone w/ ISO suffix, address w/ city.state.country). */
  aliasBuilder?: (n: number) => { alias_value: string; base_alias: string };
}

/**
 * Lookup-or-allocate keyed on (scope_id, kind, real_value). Repeat lookups
 * for the same triple reuse the existing alias unconditionally. Used both
 * by external callers (aliasIdentifierField) and by internal side-effects
 * (domain row from email, email_local row from email).
 */
export const getOrAllocate = (
  ledger: Ledger,
  kind: LedgerKind,
  real_value: string,
  opts: AllocOpts = {},
): RedactionAliasEntry => {
  const key = kindKey(kind, real_value);
  const existing = ledger.byKindRealValue.get(key);
  if (existing) return existing;

  const n = nextCounter(ledger, kind);
  const built = opts.aliasBuilder
    ? opts.aliasBuilder(n)
    : { alias_value: defaultBaseAlias(kind, n), base_alias: defaultBaseAlias(kind, n) };
  const { alias_value, base_alias: base } = built;
  const now = Date.now();
  const entry: RedactionAliasEntry = {
    scope_id: ledger.scope_id,
    kind,
    real_value,
    alias_value,
    first_observed_at: {
      ...(opts.source_ref !== undefined ? { source_ref: opts.source_ref } : {}),
      ...(opts.via_side_effect_of !== undefined
        ? { via_side_effect_of: opts.via_side_effect_of }
        : {}),
    },
    created_at: now,
  };
  ledger.byKindRealValue.set(key, entry);
  ledger.byKindBaseAlias.set(kindKey(kind, base), entry);
  return entry;
};

const defaultBaseAlias = (kind: LedgerKind, n: number): string => {
  // Readable Word<N> family carries the `pii.` prefix (collision-proofing,
  // Slice 2). The email_local (`m<N>`) + domain (`d<N>.invalid`) halves of the
  // collision-proof email composite stay unprefixed.
  switch (kind) {
    case 'email':        return `${PII_ALIAS_PREFIX}Email${n}`;   // malformed-email fallback (D-167 restore-completeness); well-formed emails use the email_local + domain composite
    case 'name':         return `${PII_ALIAS_PREFIX}Person${n}`;
    case 'org':          return `${PII_ALIAS_PREFIX}Org${n}`;
    case 'phone':        return `${PII_ALIAS_PREFIX}Phone${n}`;
    case 'address':      return `${PII_ALIAS_PREFIX}Address${n}`;
    case 'url':          return `${PII_ALIAS_PREFIX}Url${n}`;
    case 'external_id':  return `${PII_ALIAS_PREFIX}Id${n}`;
    case 'account_id':   return `${PII_ALIAS_PREFIX}Account${n}`;
    case 'email_local':  return `m${n}`;
    case 'domain':       return `d${n}.invalid`;
  }
};

/* ──────────────── Parsers (naive, comfort-layer scope) ──────────────── */

/** Split "alice@acme.com" → { local: "alice", domain: "acme.com" } (lowercased
 *  email per spec). Returns undefined on malformed input. */
export const splitEmail = (raw: string): { local: string; domain: string } | undefined => {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at <= 0 || at === normalized.length - 1) return undefined;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!local || !domain || domain.includes('@')) return undefined;
  if (!domain.includes('.')) return undefined;
  return { local, domain };
};

/** Split "https://acme.com/portal?id=42" → { scheme, host, rest }. The rest
 *  preserves path + query exactly. Returns undefined when parsing fails. */
export const splitUrl = (raw: string): { scheme: string; host: string; rest: string } | undefined => {
  if (typeof raw !== 'string') return undefined;
  try {
    const u = new URL(raw);
    if (!u.protocol.endsWith(':')) return undefined;
    const scheme = u.protocol.slice(0, -1);
    const host = u.host.toLowerCase();
    if (!host) return undefined;
    const rest = `${u.pathname}${u.search}${u.hash}`;
    return { scheme, host, rest };
  } catch { return undefined; }
};

/**
 * Country-code → ISO-3166 alpha-2 map. v1 covers a pragmatic subset; the
 * comfort layer's fallback when a code isn't in the table is bare
 * `pii.Phone<N>` (no suffix). Spec §"Alias vocabulary" calls out country-only
 * suffix — area codes are deliberately not in scope.
 */
const COUNTRY_CODE_TO_ISO: Record<string, string> = {
  '1':  'us',   // North American Numbering Plan — defaults to 'us' per spec example
  '7':  'ru',
  '20': 'eg',
  '27': 'za',
  '30': 'gr',
  '31': 'nl',
  '32': 'be',
  '33': 'fr',
  '34': 'es',
  '36': 'hu',
  '39': 'it',
  '40': 'ro',
  '41': 'ch',
  '43': 'at',
  '44': 'gb',
  '45': 'dk',
  '46': 'se',
  '47': 'no',
  '48': 'pl',
  '49': 'de',
  '51': 'pe',
  '52': 'mx',
  '53': 'cu',
  '54': 'ar',
  '55': 'br',
  '56': 'cl',
  '57': 'co',
  '58': 've',
  '60': 'my',
  '61': 'au',
  '62': 'id',
  '63': 'ph',
  '64': 'nz',
  '65': 'sg',
  '66': 'th',
  '81': 'jp',
  '82': 'kr',
  '84': 'vn',
  '86': 'cn',
  '90': 'tr',
  '91': 'in',
  '92': 'pk',
  '93': 'af',
  '94': 'lk',
  '95': 'mm',
  '98': 'ir',
  '212': 'ma',
  '213': 'dz',
  '216': 'tn',
  '218': 'ly',
  '220': 'gm',
  '233': 'gh',
  '234': 'ng',
  '254': 'ke',
  '256': 'ug',
  '351': 'pt',
  '352': 'lu',
  '353': 'ie',
  '354': 'is',
  '358': 'fi',
  '370': 'lt',
  '371': 'lv',
  '372': 'ee',
  '380': 'ua',
  '385': 'hr',
  '420': 'cz',
  '421': 'sk',
  '852': 'hk',
  '853': 'mo',
  '855': 'kh',
  '856': 'la',
  '880': 'bd',
  '886': 'tw',
  '961': 'lb',
  '962': 'jo',
  '964': 'iq',
  '965': 'kw',
  '966': 'sa',
  '967': 'ye',
  '968': 'om',
  '971': 'ae',
  '972': 'il',
  '974': 'qa',
  '977': 'np',
  '992': 'tj',
  '994': 'az',
  '995': 'ge',
};

/** Strip formatting + split a `+CC…` E.164 string into its known country ISO
 *  and the national-significant remainder (`+1 415 555 0199` → `{ iso: 'us',
 *  national: '4155550199' }`). Country code is greedy longest-first (3-digit
 *  codes beat their 2/1-digit prefixes). Returns undefined on a non-E.164
 *  string or an unknown country code — the shared core behind
 *  `parsePhoneCountryIso` (ISO view) and `nationalPhoneDigits` (national-run
 *  view). */
const splitE164 = (raw: string): { iso: string; national: string } | undefined => {
  if (typeof raw !== 'string') return undefined;
  const digits = raw.replace(/[\s\-().]/g, '');
  if (!digits.startsWith('+')) return undefined;
  const rest = digits.slice(1);
  if (!/^\d+$/.test(rest)) return undefined;
  for (const len of [3, 2, 1]) {
    if (rest.length <= len) continue;
    const code = rest.slice(0, len);
    const iso = COUNTRY_CODE_TO_ISO[code];
    if (iso) return { iso, national: rest.slice(len) };
  }
  return undefined;
};

/** Parse "+44-20-7946-0958" → "gb". Returns undefined on non-E.164 or
 *  unknown country code. Country code is greedy-match longest-first
 *  (3-digit codes win over their 2/1-digit prefixes). */
export const parsePhoneCountryIso = (raw: string): string | undefined =>
  splitE164(raw)?.iso;

/** The national-significant digits of a known-country E.164 phone — the stored
 *  `+14155550199` minus its `1` country code → `4155550199`. Lets the egress
 *  phone-variant pass alias the NATIONAL layout a user typically types
 *  (`(415) 555-0199`) against the same ledger entry, not only the full E.164
 *  digit run. Undefined when the stored value isn't E.164 or carries a country
 *  code absent from the ISO table (that even-narrower case still passes
 *  through). */
export const nationalPhoneDigits = (raw: string): string | undefined =>
  splitE164(raw)?.national;

/** Countries that drop a leading `0` TRUNK prefix in E.164, so the national
 *  layout a user writes carries a `0` the stored number doesn't (UK `020 7946
 *  0958` ↔ `+44 20 7946 0958`). Only these get the optional-`0` national match.
 *  SAFE BY DEFAULT — a country absent here (NANP `us`, which has no trunk
 *  prefix; the abolished-trunk Nordics; trunk-`8` Russia; Italy, which keeps the
 *  `0` IN the number) gets the plain no-trunk national run only, so a stray
 *  `0<national>` can't false-alias to it. A pragmatic high-confidence subset
 *  (same posture as `COUNTRY_CODE_TO_ISO`); unlisted trunk-`0` countries are a
 *  residual, never a false positive. */
const TRUNK_ZERO_ISO: ReadonlySet<string> = new Set([
  'gb', 'fr', 'de', 'au', 'nl', 'be', 'ch', 'at', 'ie', 'nz', 'se',
]);

/** The digit-string forms a user might TYPE for a stored E.164 phone, for
 *  identifier matching (the prefetch's resolve-a-contact-by-number path), split
 *  by confidence:
 *    - `full` — the FULL E.164 digits (country code included). Unambiguous
 *      enough to match even a BARE contiguous number a user types without
 *      separators (`14155550199`).
 *    - `national` — the NATIONAL-significant digits (known country code
 *      stripped) and, for a trunk-`0` country, the national digits with the
 *      leading `0` a user writes (`+442079460958` → `2079460958`, `02079460958`).
 *      Country-code-LESS and so AMBIGUOUS with a bare invoice/account number —
 *      the caller matches these ONLY against phone-FORMATTED runs (≥ 2 separated
 *      digit groups), never a bare number.
 *  Mirrors the egress phone-variant pass's run set + its `TRUNK_ZERO_ISO` gate,
 *  so a phone the prefetch resolves by number seeds the SAME ledger surface the
 *  egress later aliases. `full` is undefined below 7 digits; `national` empty
 *  for a non-E.164 / unknown-country value. */
export const phoneMatchDigits = (
  raw: string,
): { readonly full?: string; readonly national: readonly string[] } => {
  const digits = typeof raw === 'string' ? raw.replace(/\D+/gu, '') : '';
  const full = digits.length >= 7 ? digits : undefined;
  const national: string[] = [];
  const parsed = splitE164(raw);
  if (parsed !== undefined && parsed.national.length >= 7) {
    national.push(parsed.national);
    if (TRUNK_ZERO_ISO.has(parsed.iso)) national.push(`0${parsed.national}`);
  }
  return { full, national };
};

const KNOWN_COUNTRY_TOKENS: Record<string, string> = {
  'usa': 'usa',
  'us': 'usa',
  'united states': 'usa',
  'united states of america': 'usa',
  'uk': 'gb',
  'gb': 'gb',
  'united kingdom': 'gb',
  'canada': 'ca',
  'ca': 'ca',
  'germany': 'de',
  'de': 'de',
  'france': 'fr',
  'fr': 'fr',
  'australia': 'au',
  'japan': 'jp',
  'ireland': 'ie',
  'india': 'in',
};

/**
 * Naive comma-split address parser. Handles the spec examples:
 *
 *   "1 Main St, San Francisco, CA 94102, USA"
 *     → { city: 'san-francisco', state: 'ca', country_iso: 'usa' }
 *   "Some Office, London, UK"
 *     → { city: 'london', country_iso: 'gb' }
 *
 * Returns undefined when the input can't be split into ≥ 2 commas-separated
 * parts (e.g. non-Latin scripts, freeform single-string blobs). The bare
 * `pii.Address<N>` fallback is the honest comfort-layer stance here.
 */
export const parseAddressComponents = (
  raw: string,
): { city?: string; state?: string; country_iso?: string } | undefined => {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length < 2) return undefined;

  const last = parts[parts.length - 1].toLowerCase();
  const country_iso = KNOWN_COUNTRY_TOKENS[last];
  if (!country_iso) return undefined;

  const remaining = parts.slice(0, -1);
  let state: string | undefined;
  let city: string | undefined;
  if (remaining.length >= 2) {
    const candidate = remaining[remaining.length - 1].toLowerCase();
    const stripped = candidate.replace(/\s+\d.*$/, '').trim();   // drop trailing zip
    if (/^[a-z]{2,3}$/.test(stripped)) {
      state = stripped;
      city = remaining[remaining.length - 2].toLowerCase().replace(/\s+/g, '-');
    } else {
      city = stripped.replace(/\s+/g, '-');
    }
  } else if (remaining.length === 1) {
    city = remaining[0].toLowerCase().replace(/\s+/g, '-');
  }

  const out: { city?: string; state?: string; country_iso?: string } = { country_iso };
  if (city) out.city = city;
  if (state) out.state = state;
  return out;
};

/* ──────────────── Identifier-pass aliasing ──────────────── */

/**
 * Already-alias guard — P0 of the D-167 entity-marker design
 * (`docs/d-160-n10-part-pii-pending-design.md` §N.10.2 / P0).
 *
 * `aliasIdentifierField` keys allocation on the REAL value via `getOrAllocate`,
 * with no check that the value is itself ALREADY an alias surface. The
 * entity-marker design runs an identifier pass at the per-turn gather AND keeps
 * the per-call wire seam over reinvokes; a field touched by both (or any future
 * double-pass) would otherwise have `m1@d1.invalid` / `pii.Person1` re-allocated
 * as fresh PII — an alias-of-an-alias the restore pass can never unwind. These
 * anchored full-string shapes mirror `ALIAS_TOKEN_PATTERN` so the identifier pass
 * is idempotent: aliasing an alias is a no-op.
 *
 * Only ZERO/negligible-collision surfaces are recognized. The `.invalid` shapes
 * (`m<N>@d<M>.invalid`, `d<N>.invalid`, aliased URL hosts) never collide —
 * `.invalid` is a reserved non-resolving TLD (RFC 2606) — and the readable
 * family now carries the `pii.` prefix (Slice 2), so a real
 * `pii.Person1`/`pii.Org1`/`pii.Phone1`/`pii.Address1`-shaped value is no longer
 * even a vanishingly-rare comfort miss (a user types `Person1`, never the
 * prefixed form). The `Id<N>` / `Account<N>` / `Email<N>` / `Url<N>` surfaces
 * stay DELIBERATELY excluded: they are never double-passed by the entity-marker
 * design (contact/deal alias only `email` + `name`), so excluding them is a
 * no-op for the use case. (Pre-Slice-2 they were also a false-positive-leak risk
 * — a real `external_id` `Id123` looked like its own alias; the `pii.` prefix
 * now moots that, but they remain excluded as the no-op they always were.)
 */
const FULL_ALIAS_SHAPES: readonly RegExp[] = [
  /^(?:cap\d*_)?m\d+@d\d+\.invalid$/,                                  // email composite
  /^(?:cap\d*_)?d\d+\.invalid$/,                                       // bare / sibling domain
  /^cap\d*_pii\.(?:Person|Org|Phone|Address)\d+(?:\.[a-z0-9-]+){0,3}$/, // casing sibling
  /^pii\.(?:Person|Org|Phone|Address)\d+(?:\.[a-z0-9-]+){0,3}$/,        // base alias (+ geo/iso suffix)
];

/** True when `value` is wholly an alias surface the substrate already emitted —
 *  the bare/base shapes above, or a URL whose host is an aliased domain
 *  (`scheme://d<N>.invalid/…`, which the base shapes don't cover). */
export const isAlreadyAliased = (value: string): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (FULL_ALIAS_SHAPES.some((re) => re.test(value))) return true;
  const url = splitUrl(value);
  return url !== undefined && /^(?:cap\d*_)?d\d+\.invalid$/.test(url.host);
};

/**
 * Field-level aliasing. Pick the right per-kind allocator and return the
 * LLM-facing alias surface. Updates `counters` (field-level counts feed
 * the audit redaction_summary).
 */
export const aliasIdentifierField = (
  ledger: Ledger,
  kind: Exclude<EntityFieldPrivacy, 'content'>,
  value: string,
  counters?: RedactionCounters,
  source_ref?: string,
): string => {
  if (typeof value !== 'string' || value.length === 0) return value;
  // P0 idempotence — a value already in alias form must not be re-allocated
  // (would yield an alias-of-an-alias when the entity-marker gather pass and the
  // wire seam both touch the same field). No counter bump: no NEW redaction.
  if (isAlreadyAliased(value)) return value;
  switch (kind) {
    case 'email':       counters && (counters.email += 1);
                        return aliasEmail(ledger, value, source_ref);
    case 'name':        counters && (counters.name += 1);
                        return aliasSimple(ledger, 'name', value, source_ref);
    case 'org':         counters && (counters.org += 1);
                        return aliasSimple(ledger, 'org', value, source_ref);
    case 'phone':       counters && (counters.phone += 1);
                        return aliasPhone(ledger, value, source_ref);
    case 'address':     counters && (counters.address += 1);
                        return aliasAddress(ledger, value, source_ref);
    case 'url':         counters && (counters.url += 1);
                        return aliasUrl(ledger, value, source_ref);
    case 'external_id': counters && (counters.external_id += 1);
                        return aliasSimple(ledger, 'external_id', value, source_ref);
    case 'account_id':  counters && (counters.account_id += 1);
                        return aliasSimple(ledger, 'account_id', value, source_ref);
  }
};

const aliasSimple = (
  ledger: Ledger,
  kind: LedgerKind,
  value: string,
  source_ref?: string,
): string => {
  const entry = getOrAllocate(ledger, kind, value, source_ref ? { source_ref } : {});
  return entry.alias_value;
};

/**
 * Email field aliasing — spec §"Alias vocabulary" line 167. Creates an
 * 'email_local' row keyed on the full email + a 'domain' side-effect row
 * keyed on the host. Returns the composed `m<N>@d<M>.invalid` surface.
 *
 * Reuse: same email → same composed alias. Second email at the same host
 * gets a fresh `m<N+1>` but reuses the host's `d<M>.invalid`.
 */
const aliasEmail = (
  ledger: Ledger,
  value: string,
  source_ref?: string,
): string => {
  const parts = splitEmail(value);
  if (!parts) {
    // A non-parseable email (no `@`, no host dot, …) can't decompose into the
    // `m<N>@d<M>.invalid` composite, so it aliases to the dedicated `email`
    // kind's `Email<N>` surface (D-167 restore-completeness hardening). This
    // used to borrow the bare `email_local` surface (`m<N>`), which is ambiguous
    // with a literal "m1"/"M1" token and so could never round-trip through
    // free-text restore. `Email<N>` is unambiguous and restores deterministically
    // via the bare-name restore family — honoring the hard round-trip invariant
    // for an alias the substrate emits.
    return aliasSimple(ledger, 'email', value, source_ref);
  }
  const domainEntry = getOrAllocate(ledger, 'domain', parts.domain, {
    via_side_effect_of: 'email',
  });
  const emailEntry = getOrAllocate(ledger, 'email_local', `${parts.local}@${parts.domain}`, {
    via_side_effect_of: 'email',
    ...(source_ref ? { source_ref } : {}),
  });
  return `${emailEntry.alias_value}@${domainEntry.alias_value}`;
};

/**
 * URL field aliasing — spec §"Alias vocabulary" lines 173-178. On parse
 * success: 'domain' side-effect + compose `<scheme>://d<N>.invalid<path>`.
 * On parse failure: bare `Url<N>` fallback row keyed on the full URL.
 */
const aliasUrl = (
  ledger: Ledger,
  value: string,
  source_ref?: string,
): string => {
  const parts = splitUrl(value);
  if (!parts) {
    return aliasSimple(ledger, 'url', value, source_ref);
  }
  const domainEntry = getOrAllocate(ledger, 'domain', parts.host, {
    via_side_effect_of: 'url',
  });
  return `${parts.scheme}://${domainEntry.alias_value}${parts.rest}`;
};

/**
 * Phone field aliasing — spec §"Alias vocabulary" line 156. E.164 parses
 * to country ISO; the suffix-attached `pii.Phone<N>.<iso>` is what the LLM
 * sees. Parse failures fall back to bare `pii.Phone<N>`.
 *
 * Restore uses base-alias lookup (`pii.Phone<N>`) so the LLM can drop or
 * mutate the suffix without breaking round-trip.
 */
const aliasPhone = (
  ledger: Ledger,
  value: string,
  source_ref?: string,
): string => {
  const iso = parsePhoneCountryIso(value);
  return getOrAllocate(ledger, 'phone', value, {
    ...(source_ref ? { source_ref } : {}),
    aliasBuilder: (n) => {
      const base = `${PII_ALIAS_PREFIX}Phone${n}`;
      return { alias_value: iso ? `${base}.${iso}` : base, base_alias: base };
    },
  }).alias_value;
};

/**
 * Address field aliasing — spec §"Alias vocabulary" line 157. Structured
 * input composes `pii.Address<N>.<city>[.<state>].<country_iso>`; parse failures
 * fall back to bare `pii.Address<N>`.
 */
const aliasAddress = (
  ledger: Ledger,
  value: string,
  source_ref?: string,
): string => {
  const parts = parseAddressComponents(value);
  return getOrAllocate(ledger, 'address', value, {
    ...(source_ref ? { source_ref } : {}),
    aliasBuilder: (n) => {
      const base = `${PII_ALIAS_PREFIX}Address${n}`;
      if (!parts || !parts.country_iso) {
        return { alias_value: base, base_alias: base };
      }
      const segs: string[] = [base];
      if (parts.city) segs.push(parts.city);
      if (parts.state) segs.push(parts.state);
      segs.push(parts.country_iso);
      return { alias_value: segs.join('.'), base_alias: base };
    },
  }).alias_value;
};

/** D-167 — the canonical structured-address shape (`docs/canonical-shapes.md` MailingAddress),
 *  plus the aliases vendors actually use. Read only to DERIVE composite match-forms; the
 *  record's own fields are aliased leaf-by-leaf as always, so the object never collapses. */
export interface AddressComponents {
  readonly street?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postal?: string;
  readonly country?: string;
}

const ADDRESS_KEYS: Readonly<Record<keyof AddressComponents, readonly string[]>> = Object.freeze({
  street: ['address1', 'address_1', 'street', 'street1', 'line1'],
  city: ['city', 'locality', 'town'],
  state: ['state', 'region', 'province'],
  postal: ['zip', 'postal_code', 'postcode', 'zip_code'],
  country: ['country'],
});

/** The COARSE leaves that stay VISIBLE in a structured address.
 *
 *  This is a DESIGN PREFERENCE, not a comfort compromise (owner, 2026-07-12): **we want the
 *  LLM to be location-aware.** A model that cannot see `Mountain View, CA` cannot reason
 *  about the timezone, the working hours, the currency, the jurisdiction, or whether two
 *  people are in the same place — and those are things Recued exists to do. The precise
 *  identifiers (street line, postcode) are what pinpoint a household, and those ARE aliased;
 *  the region is what makes the model useful, and it stays. The geo-suffixed alias
 *  (`pii.Address1.mountain-view.ca`) carries the same grain even where the run is replaced.
 *
 *  So: do NOT "tighten" this by aliasing city / state / country. It would not be a stricter
 *  version of the same design — it would be a different, worse product. (Open-question #9.) */
const ADDRESS_COARSE_KEYS: ReadonlySet<string> = new Set([
  ...ADDRESS_KEYS.city,
  ...ADDRESS_KEYS.state,
  ...ADDRESS_KEYS.country,
]);

/** Read the canonical address components out of a structured record. Returns undefined when
 *  the object carries none of them (not an address → the caller fails closed instead). */
export const readAddressComponents = (
  value: Record<string, unknown>,
): AddressComponents | undefined => {
  const out: Record<string, string> = {};
  for (const [slot, keys] of Object.entries(ADDRESS_KEYS)) {
    for (const key of keys) {
      const v = value[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        out[slot] = v.trim();
        break;
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : (out as AddressComponents);
};

/**
 * D-167 — the ADDRESS analogue of `phoneMatchDigits` / the email→domain decomposition: the
 * layouts a known address plausibly appears in, in RAW TEXT.
 *
 * WHY THIS EXISTS (owner's design). A postal code cannot be matched on its own: `94043` is
 * indistinguishable from an invoice number, so `scanContent` withholds any all-digit value
 * (see the guard there) and the postcode leaks in prose. But we are not limited to the bare
 * token — **the record hands us the whole address**, so we know the postcode's NEIGHBOURS.
 * A postcode is virtually always written adjacent to its city and/or state, with optional
 * commas — so we look for those COMBINATIONS instead. `Mountain View, CA 94043` matches;
 * `invoice 94043` cannot, because the bare postcode is deliberately never a form.
 *
 * Exactly the email/domain trick: aliasing `alice@acme.com` teaches the ledger the DOMAIN,
 * which then anchors a composite match (`<anything>@acme.com`). Here the city/state anchor
 * the postcode.
 *
 * The forms carry the city/state INSIDE the matched run, so replacing the run with the
 * geo-suffixed alias (`pii.Address1.mountain-view.ca`) keeps the region legible to the model
 * — which is the whole point of the geo suffix (open-question #9 keeps city-grain visible).
 * Longest-first matching in `scanContent` means the richest present layout wins.
 *
 * ─── KNOWN LIMITATION, NOT A GAP (owner, 2026-07-12) ───────────────────────────────────
 * The forms are matched LITERALLY, so an ABBREVIATION written out long-hand does not match:
 * a record holding `state: 'CA'` produces the form `Mountain View, CA 94043`, and prose that
 * says `Mountain View, California 94043` matches NOTHING — the postcode stays raw there. Same
 * class for street abbreviations (`Parkway` vs `Pkwy`, `Street` vs `St`).
 *
 * This is DELIBERATE and must not be "fixed" reflexively. Expanding abbreviations means
 * shipping and maintaining a synonym table per country, and every synonym is another chance
 * to over-match — and this file's whole history is that OVER-aliasing (corruption, false
 * identity) costs more than a miss. D-167's stance is explicit: *aliasing may MISS; the HARD
 * invariant is RESTORE*. A missed postcode is a miss. Treat it as such; do not file it as a
 * defect, and do not add a synonym table without an owner decision.
 */
export const addressMatchForms = (parts: AddressComponents): string[] => {
  const { city, state, postal } = parts;
  // Only POSTAL-bearing forms are generated. The street line needs no help — it is
  // multi-token and distinctive, so its own leaf row already matches it in prose. The
  // postcode is the one component that cannot stand alone, so these forms exist purely to
  // give it its neighbours. Nothing here is ever a lone token.
  if (!postal) return [];
  const forms = new Set<string>();
  const add = (...segments: readonly string[]): void => {
    if (segments.length < 2) return; // NEVER a bare postcode — that is the whole point
    forms.add(segments.join(', '));
    forms.add(segments.join(' '));
    // The everyday US layout: comma after the city, space before the postcode.
    if (segments.length >= 3) {
      forms.add(`${segments.slice(0, -1).join(', ')} ${segments[segments.length - 1]!}`);
    }
  };
  if (city && state) add(city, state, postal);
  if (city) add(city, postal);
  if (state) add(state, postal);
  return [...forms];
};

/** Register the composite address forms as CONTENT-SCAN targets.
 *
 *  STRUCTURE-SAFE BY CONSTRUCTION — and this is the crux of the owner's objection that
 *  collapsing `{street, city, state, zip, country}` into one `address1` would break the shape
 *  on the way back. The composite entry is **never written into a field**. The record's own
 *  leaves keep their own per-leaf aliases and restore independently, so the object stays an
 *  object. This entry exists ONLY so `scanContent` can recognise the address written out in
 *  PROSE, and it restores to the run it matched — no structure to lose, because prose has
 *  none.
 *
 *  All forms point at the SAME entry (the phone-variant mechanism: many `real_value` keys,
 *  one row), so every layout aliases identically and restore is unambiguous. */
const registerAddressComposite = (
  ledger: Ledger,
  parts: AddressComponents,
  source_ref?: string,
): void => {
  for (const form of addressMatchForms(parts)) {
    // Each layout is its OWN ledger row, keyed on the exact text it will match. It has to
    // be: `scanContent` builds its pattern from `entry.real_value`, so pointing several
    // keys at one row would match only that row's own text. Its own row also keeps RESTORE
    // EXACT — the alias returns the run that was actually replaced, never a richer address
    // than the prose contained. Unmatched rows cost nothing the model can see: they are
    // ledger-only, so it never learns an alias for a layout that did not appear.
    //
    // The alias keeps the GEO SUFFIX (`pii.Address4.mountain-view.ca`) even though the
    // matched run is being removed, so the model still gets region grain — the very thing
    // open-question #9 keeps city-grain visible for.
    getOrAllocate(ledger, 'address', form, {
      ...(source_ref ? { source_ref } : {}),
      aliasBuilder: (n) => {
        const base = `${PII_ALIAS_PREFIX}Address${n}`;
        const segs: string[] = [base];
        if (parts.city) segs.push(parts.city.toLowerCase().replace(/\s+/g, '-'));
        if (parts.state) segs.push(parts.state.toLowerCase().replace(/\s+/g, '-'));
        return { alias_value: segs.join('.'), base_alias: base };
      },
    });
  }
};

/* ──────────────── Content-pass scan ──────────────── */

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface SiblingDecision {
  alias_value: string;
  base_alias: string;
}

/** Allocate a sibling row for a casing variant. The sibling is its own
 *  ledger row (so restore returns the variant's exact casing) but reuses
 *  the canonical's identity number with a `cap_` / `capN_` prefix so the
 *  LLM can see the relationship. */
const allocSibling = (
  ledger: Ledger,
  canonical: RedactionAliasEntry,
  variant_real_value: string,
): RedactionAliasEntry => {
  const existing = ledger.byKindRealValue.get(kindKey(canonical.kind, variant_real_value));
  if (existing) return existing;

  const siblingCount = (ledger.siblingCounters.get(canonical.alias_value) ?? 0) + 1;
  ledger.siblingCounters.set(canonical.alias_value, siblingCount);
  const prefix = siblingCount === 1 ? 'cap_' : `cap${siblingCount}_`;
  // `alias_value` is the full LLM-facing surface (`cap_pii.Address1.san-francisco.ca.usa`).
  // `base_alias` must use the SUFFIX-STRIPPED canonical (`cap_pii.Address1`), because
  // restore looks up byKindBaseAlias on `stripAliasSuffix(match)` — keying on the
  // full suffixed value here would miss for suffixed aliases (phone `.iso` /
  // address `.geo`), leaving an emitted sibling un-restorable. Canonical rows
  // key on the stripped base too (see each aliasBuilder's `base_alias`), so this
  // keeps siblings symmetric with them. `stripAliasSuffix`'s domain carve-out
  // leaves `d<N>.invalid` intact, so domain siblings stay `cap_d<N>.invalid`.
  const decision: SiblingDecision = {
    alias_value: `${prefix}${canonical.alias_value}`,
    base_alias:  `${prefix}${stripAliasSuffix(canonical.alias_value)}`,
  };

  // Bypass nextCounter — siblings share the canonical's identity number.
  const now = Date.now();
  const entry: RedactionAliasEntry = {
    scope_id: ledger.scope_id,
    kind: canonical.kind,
    real_value: variant_real_value,
    alias_value: decision.alias_value,
    first_observed_at: {},
    relationship_refs: [canonical.alias_value],
    created_at: now,
  };
  ledger.byKindRealValue.set(kindKey(canonical.kind, variant_real_value), entry);
  ledger.byKindBaseAlias.set(kindKey(canonical.kind, decision.base_alias), entry);
  return entry;
};

/** True when `rest` (the text immediately AFTER a matched value) begins another
 *  token/domain label — a label char, or a `.` then a label char — so the match
 *  is a PREFIX of a longer token and must NOT be aliased (`acme.community`,
 *  `acme.com.au`, `acme.com.рф`, `acme.comя`). A `.` before a NON-label char (a
 *  sentence-final period) is NOT a continuation, so the value still aliases.
 *  Unicode-aware (`\p{…}` + the `u` flag) and applied in CODE, NOT folded into the
 *  scanContent match regexes: those stay `/gi`, because adding `u` there would
 *  also make `i` Unicode-CASE-FOLD the value literal (e.g. `K` ↔ the Kelvin sign
 *  U+212A) — an unintended over-match across every kind. */
const startsLabelContinuation = (rest: string): boolean =>
  /^\.?[\p{L}\p{N}_-]/u.test(rest);

/** Digits-only view of a phone string — strips `+`, spaces, and every
 *  separator so two layouts of the SAME number compare equal. */
const phoneDigits = (s: string): string => s.replace(/\D+/gu, '');

/** Separators allowed BETWEEN digits when matching a known phone in an
 *  arbitrary layout — space, `.`, `(`, `)`, `+`, `-`. Deliberately excludes
 *  `\s` (no newline) so a match can't span lines, and excludes digits so the
 *  per-phone pattern matches EXACTLY that phone's digit count (can't over-grab
 *  an adjacent number). */
const PHONE_INNER_SEP = '[ .()+-]*';

/**
 * Content-pass — substring-replace ledger-known real values plus one
 * anchored allocation exception (domain-anchored email completion).
 *
 * Spec §"Runtime flow" step 3:
 *   - iterate ledger entries longest-real-value-first
 *   - case-insensitive word-boundary substring match
 *   - exact equality reuses canonical alias; casing differences allocate
 *     a sibling row keyed on the variant casing
 *   - domain-anchored email completion: `[^@\s]+@<known_domain>` →
 *     allocate fresh email_local and emit `m<N>@d<N>.invalid`
 *   - NO NER, NO regex extraction without a ledger anchor, NO fresh
 *     allocation for unanchored spans
 *   - unknown spans pass through unchanged
 */
export const scanContent = (
  ledger: Ledger,
  text: string,
  counters?: RedactionCounters,
): { text: string; replacements: number } => {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, replacements: 0 };
  }

  // Snapshot ledger entries so we don't iterate over our own newly-allocated
  // siblings inside the same pass.
  const entries = Array.from(ledger.byKindRealValue.values())
    .filter(e => e.kind !== 'email_local' || /^m\d+$/.test(e.alias_value))   // skip ourselves later
    .sort((a, b) => b.real_value.length - a.real_value.length);

  let working = text;
  let replacements = 0;

  for (const entry of entries) {
    if (entry.kind === 'email_local') continue;     // email_local rows handled implicitly via their composite form below
    const real = entry.real_value;
    if (!real || real.length === 0) continue;
    // A bare ALL-DIGIT value is too ambiguous to blind-replace in prose. A US postal code
    // `94043` is indistinguishable from `invoice 94043` — and replacing both with the SAME
    // alias does not merely mangle a number, it asserts a FALSE EQUALITY: the model reads
    // `invoice pii.Address1` and `zip pii.Address1` and concludes the invoice number IS the
    // contact's postcode. A false identity is worse than a redaction. (Measured before this
    // guard: `invoice 94043 paid` → `invoice pii.Address1 paid`.)
    //
    // This is NOT "postcodes are unsafe to scan". UK (`SW1A 1AA`) and Canadian (`K1A 0B1`)
    // postcodes are ALPHANUMERIC, hence distinctive, and keep scanning correctly — any bare
    // occurrence of them really IS the postcode. The hazard is precisely the all-digit
    // formats (US / DE / FR / …), which is exactly what this predicate selects.
    //
    // `phone` is EXEMPT: it owns its digit logic (the ≥ 7-digit floor in `phoneMatchDigits`
    // plus the deliberate national / trunk-zero variant rows, which are all-digit by
    // construction). Guarding it here would silently break known-phone matching in prose —
    // the very class of regression this file exists to prevent.
    //
    // The value is still ALIASED AT ITS FIELD, so the record's postcode never egresses; only
    // the blind prose replacement is withheld, and RESTORE is unaffected (it reads
    // `byKindBaseAlias`). A postcode written out in free prose is an accepted miss — D-167:
    // "aliasing may MISS; the HARD invariant is RESTORE".
    if (entry.kind !== 'phone' && ALL_DIGITS_RE.test(real)) continue;
    // Leading boundary: the `@` in the lookbehind shields a bare 'domain' row
    // from matching inside an already-aliased email shape (`m1@acme.com`) — that
    // span is regenerated by the email composite emit below; we replace bare
    // mentions only.
    // Trailing boundary: the ASCII lookaheads reject a word char or `-` directly
    // after the value plus a `.`+ASCII-label continuation; the Unicode tail (a
    // sentence-final period `Bob.` / `acme.com.` — MATCH — vs a longer Unicode
    // label `acme.com.рф` — REJECT) is settled by `startsLabelContinuation` in
    // the callback, so this regex stays `/gi` and never case-folds the value.
    const pattern = new RegExp(
      `(?<![\\w.@-])${escapeRegExp(real)}(?![\\w-])(?!\\.[\\w-])`,
      'gi',
    );
    const replaced = working.replace(pattern, (match: string, offset: number, str: string) => {
      // A Unicode label continuation the ASCII lookaheads can't see → leave raw.
      if (startsLabelContinuation(str.slice(offset + match.length))) return match;
      replacements += 1;
      if (match === real) {
        return entry.kind === 'email_local' ? composeEmailAlias(ledger, entry) : entry.alias_value;
      }
      // Casing-only difference → sibling row keyed on the matched variant.
      const sibling = allocSibling(ledger, entry, match);
      return sibling.alias_value;
    });
    working = replaced;
  }

  // Domain-anchored email completion. After bare-domain replacement above,
  // some `<localpart>@<real_domain>` spans may remain (the bare domain was
  // shielded inside the email shape by the negative-lookbehind). Detect and
  // alias them.
  const domainEntries = Array.from(ledger.byKindRealValue.values())
    .filter(e => e.kind === 'domain');
  for (const dom of domainEntries) {
    const real_domain = dom.real_value;
    if (!real_domain) continue;
    // Trailing boundary: ASCII lookaheads reject a word char or `-` and a
    // `.`+ASCII-label continuation directly after the domain; the Unicode tail (a
    // sentence-final period `acme.com.` — COMPLETE — vs a longer Unicode label
    // `acme.com.рф`, a DIFFERENT domain — REJECT) is settled by
    // `startsLabelContinuation` in the callback. Kept `/gi` (not `/giu`) so the
    // domain literal is never Unicode-case-folded. The original single `(?![\w.-])`
    // dropped the common sentence-final-period case (raw email — a coverage miss);
    // this boundary completes it while still blocking longer / IDN domains.
    // (Local-part matching stays ASCII — EAI is out of scope.)
    const emailLikePattern = new RegExp(
      `(?<![\\w.-])([\\w][\\w.+-]*)@${escapeRegExp(real_domain)}(?![\\w-])(?!\\.[\\w-])`,
      'gi',
    );
    working = working.replace(emailLikePattern, (_full: string, local: string, offset: number, str: string) => {
      // A Unicode label continuation the ASCII lookaheads can't see → leave raw.
      if (startsLabelContinuation(str.slice(offset + _full.length))) return _full;
      const full_email = `${String(local).toLowerCase()}@${real_domain}`;
      const emailEntry = getOrAllocate(ledger, 'email_local', full_email, {
        via_side_effect_of: 'email',
      });
      replacements += 1;
      return `${emailEntry.alias_value}@${dom.alias_value}`;
    });
  }

  // Phone-variant pass — alias a KNOWN ledger phone typed in any separator
  // layout (the literal loop above only catches the stored form,
  // `+14155550199`). Each phone contributes up to two digit runs, each matched
  // EXACTLY (its digit sequence with arbitrary separators BETWEEN digits,
  // bounded by non-word on both sides — so it can't be sandwiched in an id
  // `ABC14155550199XYZ`, merge with an adjacent number `…0199 650…`, or swallow
  // a trailing one `…0199 2pm`):
  //   - the FULL E.164 run (with country code) — globally unambiguous; and
  //   - when a known country code parses off, the NATIONAL run (`+14155550199`
  //     → `4155550199`, the layout a user typically types as `(415) 555-0199`).
  //     For a country that DROPS a leading `0` trunk in E.164 (`TRUNK_ZERO_ISO`
  //     — UK `020 7946 0958`), the national pattern also tolerates that optional
  //     `0`; NANP and other no-trunk countries do NOT, so a stray `0<national>`
  //     can't false-alias to a US contact.
  // The national run is anchored but ambiguous in two ways the full run isn't,
  // so it carries extra guards:
  //   - DEDUP: a national run shared by ≥2 ledger phones — or equal to another
  //     phone's full run — is dropped (`runTally`), since aliasing it would
  //     coin-flip which contact it restores to.
  //   - NOT A LONGER NUMBER'S TAIL: the `(?<![+\d]…)` lookbehind rejects a
  //     national run preceded (through phone separators) by a `+` OR a bare
  //     digit — i.e. the tail of a DIFFERENT country/trunk-prefixed number in
  //     the text, written `+1 207 946 0958` OR plain `1-207-946-0958`, must not
  //     match a UK contact's `2079460958`. The national prefix is `[(]*` (no
  //     `+`) so `+<national>` never matches either. (Accepted over-rejection: a
  //     contact's own national run preceded by an UNRELATED bare number through
  //     only separators — `order 12 415 555 0199` — is left raw rather than risk
  //     mis-restoring a longer number; the full E.164 form still aliases.)
  // Apply LONGER runs first (sort desc) so a full-form mention is consumed whole
  // before a shorter national run could strip only its tail. An unknown country
  // code (absent from the ISO table) yields only the full run. Ledger-anchored,
  // NO NER, NO fresh allocation — an unknown phone has no entry, so it never
  // reaches this pass.
  const phoneEntries = Array.from(ledger.byKindRealValue.values()).filter(
    (e) => e.kind === 'phone',
  );
  const runTally = new Map<string, number>();
  const tallyRun = (d: string): void => { runTally.set(d, (runTally.get(d) ?? 0) + 1); };
  for (const e of phoneEntries) {
    const full = phoneDigits(e.real_value);
    if (full.length >= 7) tallyRun(full);
    const national = nationalPhoneDigits(e.real_value);
    if (national !== undefined && national.length >= 7 && national !== full) tallyRun(national);
  }
  const phoneVariants: Array<{
    digits: string; alias: string; national: boolean; trunkZero: boolean;
  }> = [];
  for (const e of phoneEntries) {
    const full = phoneDigits(e.real_value);
    if (full.length >= 7) {
      phoneVariants.push({ digits: full, alias: e.alias_value, national: false, trunkZero: false });
    }
    const parsed = splitE164(e.real_value);
    if (
      parsed !== undefined && parsed.national.length >= 7 && parsed.national !== full
      && runTally.get(parsed.national) === 1
    ) {
      phoneVariants.push({
        digits: parsed.national,
        alias: e.alias_value,
        national: true,
        trunkZero: TRUNK_ZERO_ISO.has(parsed.iso),
      });
    }
  }
  phoneVariants.sort((a, b) => b.digits.length - a.digits.length);
  for (const { digits, alias, national, trunkZero } of phoneVariants) {
    const body = digits.split('').join(PHONE_INNER_SEP);
    const pattern = national
      ? new RegExp(`(?<![+\\d][\\d ().+-]{0,18})(?<![\\w])[(]*${trunkZero ? '0?' : ''}${body}(?![\\w])`, 'g')
      : new RegExp(`(?<![\\w])[+(]*${body}(?![\\w])`, 'g');
    working = working.replace(pattern, () => {
      replacements += 1;
      return alias;
    });
  }

  if (counters) counters.content_text_replacements += replacements;
  return { text: working, replacements };
};

/* ──────────── Aho-Corasick known-value content aliasing (D-167 P4) ──────────── */

/** A name/org value the PII-Value Registry knows about, with its ledger kind.
 *  The B4 single-token commonness filter (`shouldSeedEntityValue`) is the
 *  REGISTRY's gate — it owns the prompt-cache dependency — so the seeds reaching
 *  `buildKnownValueIndex` are already B4-filtered; this layer adds no commonness
 *  logic of its own (design §4 I4). */
export interface KnownValueSeed {
  readonly value: string;
  /** `address` (2026-07-12) carries STREET LINES only — multi-token, distinctive strings the
   *  A-C can match safely. NEVER a postcode (all digits → collides with invoice numbers) and
   *  NEVER a city/state/country: those are single common tokens that would over-alias, and the
   *  owner's ruling is that they stay VISIBLE so the model is location-aware. */
  readonly kind: 'name' | 'org' | 'address';
}

/** An identifier (email/phone) the registry RESOLVED from the text against its
 *  own indexes (the design §2 IDENTIFIERS path — extract-by-regex → exact
 *  lookup, done registry-side because the indexes are backend data). Passed to
 *  `aliasKnownValuesInContent` to seed alongside the A-C name/org discovery so
 *  ONE `scanContent` pass aliases all of them. `value` is the contact's canonical
 *  STORED form (full E.164 phone / canonical email), so the phone-variant /
 *  domain-anchored passes reconstruct every typed layout. */
export interface KnownValueIdentifierSeed {
  readonly kind: 'phone' | 'email' | 'url';
  /** ⚠ For `url`, the value MUST carry a scheme (`https://acme.com`). That is what makes
   *  `aliasUrl` emit the `domain` side-effect row (`acme.com` → `d1.invalid`), which is the
   *  whole point: the domain row is what lets the content pass alias EVERY layout of that host
   *  — `https://acme.com/login` → `https://d1.invalid/login`, bare `acme.com/x` → `d1.invalid/x`
   *  — while leaving a public host (`docs.python.org`) alone. A BARE domain seeded here parses
   *  as a non-URL and falls back to a whole-value `pii.UrlN`, which destroys the scheme/path
   *  AND never reaches the shared domain ledger. Measured; do not "simplify" it. */
  readonly value: string;
}

/** A built name/org matcher: the automaton + the per-pattern-index canonical
 *  value & kind to seed when present. Deduped by case-fold (one canonical per
 *  fold — `Acme`/`ACME` collapse, the casing variant being `scanContent`'s
 *  sibling job at replace time). Build ONCE per registry rebuild; reuse across
 *  `aliasKnownValuesInContent` calls (design §3 — A-C is build-once). */
export interface KnownValueIndex {
  readonly ac: AhoCorasick;
  /** Parallel to the automaton's pattern indices. */
  readonly meta: readonly KnownValueSeed[];
}

/** Build the name/org A-C index. Dedups per `(kind, match-fold)` so `Acme`/`ACME`
 *  of the same kind collapse to one canonical pattern (first seen wins;
 *  `scanContent` restores the exact casing variant via a sibling at replace time),
 *  while a value that is BOTH a name AND an org (across two contacts) keeps BOTH —
 *  each seeds its own kind, and `scanContent`'s longest-first replace deterministically
 *  picks one, so the alias kind is never decided by walk order. The fold is the
 *  automaton's own (`normalizeForMatch`), so dedup and matching can't disagree.
 *  Empty / whitespace-only values are dropped + edge whitespace trimmed (contact
 *  values are already clean, so this only hardens). The caller has applied B4
 *  (`shouldSeedEntityValue`); this normalises + dedups only. */
export const buildKnownValueIndex = (
  seeds: readonly KnownValueSeed[],
): KnownValueIndex => {
  const byKindFold = new Map<string, KnownValueSeed>();
  for (const seed of seeds) {
    if (typeof seed.value !== 'string') continue;
    const value = seed.value.trim();
    if (value.length === 0) continue;
    const key = `${seed.kind}\u0000${normalizeForMatch(value)}`;
    if (!byKindFold.has(key)) byKindFold.set(key, { value, kind: seed.kind });
  }
  const meta = [...byKindFold.values()];
  return { ac: buildAhoCorasick(meta.map((m) => m.value)), meta };
};

/**
 * D-167 P4 — SEED the session ledger with every known name/org/email/phone the
 * registry recognises in `text`, WITHOUT replacing anything. This is the discovery
 * half of `scanContent` SCALED, split out so a caller that already runs the
 * ledger-anchored alias passes (the chat egress) can seed the FULL cross-session
 * registry into its ledger and let those passes do the replacement — closing the
 * memory-recall leak ([[pii-memory-recall-leak-confirmed]]) without a second
 * deep-walk.
 *
 *   · NAME/ORG — one O(text) A-C pass finds the values present (boundary-verified
 *     to PARITY with `scanContent`, so a substring-only hit like `son` inside
 *     `comparison` never seeds); each is `getOrAllocate`d into the SESSION ledger.
 *   · IDENTIFIERS — each registry-resolved phone/email is `aliasIdentifierField`d
 *     (builds the phone ISO-suffix / email local+domain composite rows that
 *     `scanContent`'s phone-variant + domain-anchored passes alias).
 *
 * Idempotent (a value the prefetch already seeded reuses its alias). NO `counters`
 * bump — seeding is ledger prep, not a redaction event. Seeding into the SESSION
 * ledger keeps the hard zero-failure-restore invariant: the alias the model sees
 * is the one the ledger restore reads from.
 *
 * Boundary parity (the design §7 risk): the leading `(?<![\w.@-])` (ASCII) and the
 * trailing `startsLabelContinuation` (the SAME Unicode-aware label tail
 * `scanContent`'s callback uses) are re-checked here, so a value only ever SEEDS
 * on a genuinely word-bounded occurrence; `scanContent` then re-applies the
 * identical boundaries at replace time.
 */
export const seedKnownValuesFromContent = (
  ledger: Ledger,
  text: string,
  index: KnownValueIndex,
  identifierSeeds: readonly KnownValueIdentifierSeed[] = [],
): void => {
  if (typeof text !== 'string' || text.length === 0) return;

  // NAME/ORG — seed each canonical value with ≥ 1 boundary-valid span.
  const seededPatterns = new Set<number>();
  for (const { end, patternIndex } of findAhoCorasickMatches(index.ac, text)) {
    if (seededPatterns.has(patternIndex)) continue; // already seeded (getOrAllocate is idempotent anyway)
    const start = end - (index.ac.patternLengths[patternIndex] ?? 0);
    // Leading boundary: ASCII `(?<![\w.@-])` — a word char / `.` / `@` / `-`
    // immediately before makes this a longer token's interior, not a mention.
    if (start > 0 && /[\w.@-]/.test(text.charAt(start - 1))) continue;
    // Trailing boundary: the SAME Unicode-aware tail `scanContent` applies — a
    // letter/number/`_`/`-`, or `.`+such, right after is a label continuation.
    if (startsLabelContinuation(text.slice(end))) continue;
    const seed = index.meta[patternIndex];
    if (seed === undefined) continue;
    seededPatterns.add(patternIndex);
    getOrAllocate(ledger, seed.kind, seed.value);
  }

  // IDENTIFIERS — registry-resolved phone/email rows.
  for (const seed of identifierSeeds) {
    aliasIdentifierField(ledger, seed.kind, seed.value);
  }
};

/**
 * D-167 P4 — `scanContent` SCALED to the FULL contact registry: alias EVERY known
 * name/org/email/phone present in `text`. `seedKnownValuesFromContent` discovers +
 * seeds the registry values into the SESSION ledger, then `scanContent` aliases the
 * union (session ledger + the new seeds) in ONE pass — so all of `scanContent`'s
 * battle-tested logic (longest-first overlap, casing siblings, the phone-variant +
 * domain-anchored passes) applies uniformly to both. `counters` (when supplied) is
 * bumped ONLY by the `scanContent` replacement (`content_text_replacements`), never
 * double-counting a seed.
 */
export const aliasKnownValuesInContent = (
  ledger: Ledger,
  text: string,
  index: KnownValueIndex,
  identifierSeeds: readonly KnownValueIdentifierSeed[] = [],
  counters?: RedactionCounters,
): { text: string; replacements: number } => {
  if (typeof text !== 'string' || text.length === 0) return { text, replacements: 0 };
  seedKnownValuesFromContent(ledger, text, index, identifierSeeds);
  return scanContent(ledger, text, counters);
};

/** Internal — compose `m<N>@d<M>.invalid` from an email_local row by
 *  finding the matching domain row via the email_local's real_value. */
const composeEmailAlias = (ledger: Ledger, emailLocal: RedactionAliasEntry): string => {
  const parts = splitEmail(emailLocal.real_value);
  if (!parts) return emailLocal.alias_value;
  const dom = ledger.byKindRealValue.get(kindKey('domain', parts.domain));
  if (!dom) return emailLocal.alias_value;
  return `${emailLocal.alias_value}@${dom.alias_value}`;
};

/* ──────────────── Restore ──────────────── */

const stripAliasSuffix = (alias: string): string => {
  // Strip the geo/iso suffix from a readable-family alias, keeping its `pii.`
  // prefix (the prefix's own `.` is NOT a suffix separator). For `pii.Phone1.gb`
  // → `pii.Phone1`; `pii.Address1.san-francisco.ca.usa` → `pii.Address1`;
  // `cap_pii.Org1` (no geo suffix) → returns as-is.
  //
  // EXCEPT the domain alias `d<N>.invalid` (and its casing-sibling
  // `cap<N>_d<N>.invalid`): the `.invalid` is part of the base_alias itself
  // (the byKindBaseAlias key is `d<N>.invalid` / `cap_d<N>.invalid` — see
  // `defaultBaseAlias` + `allocSibling`), NOT a strippable geo/iso suffix.
  // Stripping it to `d<N>` / `cap_d<N>` makes `kindFromBase` miss, so a
  // content-scanned bare domain, its casing sibling, or a URL's aliased host
  // (`https://d<N>.invalid/...`) survives restore unchanged — a violation of the
  // hard round-trip invariant, since the substrate DID emit that alias.
  if (/^(?:cap\d*_)?d\d+\.invalid$/.test(alias)) return alias;
  // Skip past a leading `[cap<K>_]pii.` so the search for the geo/iso suffix
  // starts AFTER the prefix dot. An unprefixed alias (`m<N>`, reached via
  // split('@')[0]) has no match → from = 0, and with no further `.` it returns
  // as-is.
  const pref = alias.match(/^(?:cap\d*_)?pii\./);
  const from = pref ? pref[0].length : 0;
  const dot = alias.indexOf('.', from);
  if (dot < 0) return alias;
  return alias.slice(0, dot);
};

const kindFromBase = (base: string): LedgerKind | undefined => {
  // Strip `cap[N]_` then the readable-family `pii.` prefix when present. The
  // unprefixed email_local (`m<N>`) / domain (`d<N>.invalid`) bases carry no
  // `pii.`, so the second strip is a no-op for them.
  const stripped = base.replace(/^cap\d*_/, '').replace(/^pii\./, '');
  if (/^Person\d+$/.test(stripped))   return 'name';
  if (/^Org\d+$/.test(stripped))      return 'org';
  if (/^Phone\d+$/.test(stripped))    return 'phone';
  if (/^Address\d+$/.test(stripped))  return 'address';
  if (/^Url\d+$/.test(stripped))      return 'url';
  if (/^Id\d+$/.test(stripped))       return 'external_id';
  if (/^Account\d+$/.test(stripped))  return 'account_id';
  if (/^Email\d+$/.test(stripped))    return 'email';   // malformed-email fallback surface
  if (/^m\d+$/.test(stripped))        return 'email_local';
  if (/^d\d+\.invalid$/.test(stripped)) return 'domain';
  return undefined;
};

/** Look up a single matched alias token's real value: suffix-strip (and drop the
 *  `@domain` half of an email composite) → kind → `byKindBaseAlias`. Undefined
 *  when the token isn't a known alias surface. */
const lookupAliasReal = (ledger: Ledger, token: string): string | undefined => {
  const base = stripAliasSuffix(token.split('@')[0]);
  const kind = kindFromBase(base);
  if (!kind) return undefined;
  return ledger.byKindBaseAlias.get(kindKey(kind, base))?.real_value;
};

/**
 * D-167 B3 — the `LedgerKind` an alias TOKEN denotes, derived PURELY from its
 * shape (no ledger lookup): `pii.Person1` → `'name'`, `pii.Org1` → `'org'`,
 * `pii.Phone1.gb` → `'phone'`, `m1@d1.invalid` → `'email_local'`. Used at the
 * chat dispatch boundary to FIELD-SCOPE a follow-up entity-ref search
 * (`contact.search`) BEFORE restore turns the alias into a bare value and loses
 * the field it came from (D6) — so an aliased query self-routes to the right
 * column regardless of which arg the model placed it in or whether it passed a
 * `kind`.
 *
 * Gated on a SHAPE-SPECIFIC, case-insensitive match of a genuine emitted-alias
 * surface (`ALIAS_SURFACE_CI`): the `pii.`-prefixed readable family with a real
 * kind word + digits (+ optional geo/iso suffix), or the `m<N>@d<M>.invalid` email
 * composite / `d<N>.invalid` bare domain. So a BARE `Org1`/`Person1` (no prefix),
 * a `pii.`-prefixed non-kind token (`pii.hello`), AND a raw string that merely
 * CONTAINS `.invalid` (`Org1.invalid`, `m1@foo.invalid`) are all rejected by the
 * gate — only the exact emitted shapes route. CASE-INSENSITIVE like
 * `restoreInString`: the exact-case base is tried first, then the canonical casing
 * (`pii.org1` / `PII.PERSON1` / `pii.phone1.GB` → `pii.Org1` / `pii.Person1` /
 * `pii.Phone1`), so a case-mutated alias echo — prefix OR geo/iso suffix —
 * self-routes EXACTLY when it would also restore (a mismatch would restore the
 * value yet search the wrong column). Mirrors `lookupAliasReal`'s suffix-strip +
 * email-composite handling but returns the KIND, not the real value (a pure shape
 * function — the routing decision needs no session ledger). Undefined when the
 * token is not a routable alias surface (a bare domain → `'domain'`, address /
 * url / id → their kinds — the caller's arg-map has no field for those, so they
 * are not re-routed either).
 */
const ALIAS_SURFACE_CI =
  /^(?:cap\d*_)?(?:pii\.(?:person|org|phone|address|url|id|account|email)\d+(?:\.[a-z0-9-]+){0,3}|m\d+@d\d+\.invalid|d\d+\.invalid)$/i;
export const ledgerKindForAlias = (token: string): LedgerKind | undefined => {
  if (typeof token !== 'string' || !ALIAS_SURFACE_CI.test(token)) return undefined;
  // Direct (canonical-case echo, the common path), then the re-cased form for a
  // case-mutated echo (`pii.org1`, `PII.PERSON1`, `pii.phone1.GB`) — mirrors restore.
  return (
    kindFromBase(stripAliasSuffix(token.split('@')[0]))
    ?? kindFromBase(stripAliasSuffix(toCanonicalCasing(token).split('@')[0]))
  );
};

/** The combined alias-token pattern (`/gi`) — composite email FIRST (so it wins
 *  as a WHOLE token over the trailing bare-domain alt → no corrupt
 *  `M1@<real-domain>`), then the readable family with its optional `cap_` sibling
 *  prefix + `pii.` prefix (Slice 2) + geo/iso suffix, then the bare domain.
 *  Bare `m<N>` is DELIBERATELY absent — it is indistinguishable from a literal
 *  "M1"/"m2" (model codes, "M1 MacBook"); every emitted email alias is the
 *  composite or `pii.Email<N>`, never a standalone `m<N>`. */
const ALIAS_TOKEN_PATTERN =
  /\b(?:cap\d*_)?m\d+@d\d+\.invalid\b|\b(?:cap\d*_)?pii\.(?:Person|Org|Phone|Address|Url|Id|Account|Email)\d+(?:\.[a-z0-9-]+){0,3}\b|\b(?:cap\d*_)?d\d+\.invalid\b/gi;

/**
 * Restore aliases in arbitrary text. Spec §"Runtime flow" step 6.
 *
 * ONE pass over `ALIAS_TOKEN_PATTERN`, trying an EXACT-case lookup first (the LLM
 * almost always echoes the canonical `pii.Person1` shape) and falling back to a
 * canonicalized lookup for a case-mutated echo (`pii.person1` / `PII.PERSON1`).
 * Unknown aliases — and a bare un-prefixed `Person1` a user typed — pass through
 * unchanged.
 *
 * A SINGLE `replace` never re-scans its own output. That is load-bearing for the
 * D-167 Slice 3 escape: an escape entry maps a fresh slot (`pii.Person2`) to the
 * user's TYPED LITERAL (`pii.Person1`), which is ITSELF a `pii.*`-shaped token. A
 * two-pass restore would emit the literal in pass 1, then pass 2 would re-match
 * it and restore it AGAIN into whatever real value the literal's base aliases —
 * corrupting the literal and leaking the real value. The single pass emits the
 * literal verbatim. For every NON-escape entry (real_value is a real-world name /
 * email / phone, never `pii.*`-shaped) the old second pass was a no-op over the
 * first pass's output, so this is behavior-identical to the prior two-pass.
 */
export const restoreInString = (ledger: Ledger, text: string): string => {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(ALIAS_TOKEN_PATTERN, (match) => {
    const exact = lookupAliasReal(ledger, match);
    if (exact !== undefined) return exact;
    const canonical = toCanonicalCasing(match);
    if (canonical !== match) {
      const ci = lookupAliasReal(ledger, canonical);
      if (ci !== undefined) return ci;
    }
    return match;
  });
};

const toCanonicalCasing = (alias: string): string => {
  // Try to re-case `pii.person1`/`PII.PERSON1` → `pii.Person1` etc. so the
  // kindFromBase regex matches. Conservative: lowercase the `pii.` prefix,
  // capitalize the word's first letter, lowercase the rest except `.invalid`.
  if (alias.startsWith('cap_') || /^cap\d+_/.test(alias)) {
    const us = alias.indexOf('_');
    return alias.slice(0, us + 1) + toCanonicalCasing(alias.slice(us + 1));
  }
  // Readable-family `pii.` prefix (any casing) → lowercase it, recurse on the
  // word. The email composite / bare domain reach here without a `pii.` prefix.
  const pm = alias.match(/^pii\./i);
  if (pm) {
    return PII_ALIAS_PREFIX + toCanonicalCasing(alias.slice(pm[0].length));
  }
  const m = alias.match(/^([A-Za-z]+)(\d.*)$/);
  if (!m) return alias;
  const wordRaw = m[1];
  // Lowercase a trailing `.invalid` literal so a case-mutated domain alias
  // (`D1.INVALID`) canonicalizes to `d1.invalid` and matches the lowercase
  // byKindBaseAlias key + `kindFromBase`'s domain test. Geo/iso suffixes on
  // other kinds (`pii.Phone1.GB`) are stripped before lookup, so they don't need it.
  const tail = m[2].replace(/\.invalid$/i, '.invalid');
  const word = wordRaw.length > 1
    ? wordRaw[0].toUpperCase() + wordRaw.slice(1).toLowerCase()
    : wordRaw.toLowerCase();   // single letter (m, d) stays lowercase
  return `${word}${tail}`;
};

/* ──────────────── Overlap-reveal (D-167 recall↔PII collision) ──────────────── */

/**
 * The user-disclosed token set for overlap-reveal — the `[\p{L}\p{N}]+` content
 * tokens of a USER-authored string, each `normalizeForMatch`-folded (the SAME
 * fold the known-value automaton + `buildKnownValueIndex` dedup use, so a
 * disclosed token and an entity token compare EXACTLY as the matcher treats them
 * equal). The fold is CASING-insensitive (per-unit `toUpperCase`) but NOT accent-
 * or script-normalised — an accent/script variant ("Jose" vs "José", "Strasse"
 * vs "Straße") folds differently and so does not overlap, falling to the bare
 * opaque alias. That is FAIL-CLOSED (less revealed, never more — no leak) and is
 * the comfort layer's documented ASCII bias, shared with `scanContent` /
 * `decomposeToTokens` (design §6 "Overlap tokenization"). Single-code-point
 * tokens are dropped as noise (mirrors `decomposeToTokens`' ≥2 floor) — a lone
 * "a"/"I" is not a coreference key. Counted in CODE POINTS (`[...t]`), not UTF-16
 * units, so a lone astral character isn't kept while a BMP one is dropped.
 *
 * The caller unions every USER-authored surface this turn (the current
 * `user_message` + user-role `chat_tail`) so a name the user typed an earlier
 * turn still counts as disclosed; assistant text is NOT disclosed (the model
 * generated it from aliases, never saw the raw value).
 */
export const tokenizeForOverlap = (text: string): Set<string> => {
  const out = new Set<string>();
  if (typeof text !== 'string' || text.length === 0) return out;
  for (const tok of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if ([...tok].length < 2) continue;
    out.add(normalizeForMatch(tok));
  }
  return out;
};

/** Max overlap-suffix segments — bounded to the alias grammar's `{0,3}` geo/iso
 *  slot (`ALIAS_TOKEN_PATTERN` / `stripAliasSuffix`) so a decorated name alias
 *  still parses + restores. Two tokens ("sarah.smith") already pin a coreference;
 *  the cap just bounds a pathological many-token name. */
const MAX_OVERLAP_SEGMENTS = 3;

/** Compose the lowercase dotted overlap suffix for one entity real value against
 *  the user-disclosed token set: the entity's OWN tokens (in entity order) the
 *  user already disclosed, sanitised to the alias suffix charset `[a-z0-9-]`
 *  (lowercased; any other char dropped) and deduped. Empty when nothing overlaps
 *  (→ a bare, fully-opaque alias) or every overlapping token sanitises away
 *  (non-Latin scripts — the comfort-layer ASCII bias, design §6 "Overlap
 *  tokenization"). Revealing a disclosed token is ZERO marginal leak — the user
 *  typed it — so there is deliberately NO commonness filter here (unlike the B4
 *  seed-side `shouldSeedEntityValue` gate). */
const overlapSuffix = (realValue: string, disclosed: ReadonlySet<string>): string => {
  const segs: string[] = [];
  const seen = new Set<string>();
  for (const tok of realValue.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!disclosed.has(normalizeForMatch(tok))) continue;
    const seg = tok.toLowerCase().replace(/[^a-z0-9-]+/g, '');
    if (seg.length === 0 || seen.has(seg)) continue;
    seen.add(seg);
    segs.push(seg);
    if (segs.length >= MAX_OVERLAP_SEGMENTS) break;
  }
  return segs.join('.');
};

/**
 * D-167 (recall↔PII) — OVERLAP-REVEAL. Decorate each bare name/org alias in
 * ALREADY-ALIASED text with the fragment the user already disclosed, as a dotted
 * suffix: `pii.Person1` → `pii.Person1.sarah` when the user typed "Sarah" and the
 * aliased entity is "Sarah Smith".
 *
 * The collision (design §3): the user types a partial reference ("Sarah", already
 * sent raw); a `memory.recall` surfaces the full "Sarah Smith"; PII (correctly)
 * aliases it to `pii.Person1` — but the alias HIDES the coreference key, severing
 * the user's "Sarah" from the recalled entity, destroying the recall's whole
 * value. Revealing ONLY the disclosed overlap restores the link while leaking
 * nothing new: the fragment is already public (the user typed it) AND it is the
 * shared token that re-binds the reference. Protection scales with disclosure —
 * unreferenced stays opaque `pii.Person1`, partially-named becomes
 * `pii.Person1.sarah`, the unrevealed rest ("Smith") stays hidden.
 *
 * Scope — bare `pii.Person<N>` / `pii.Org<N>` ONLY (the readable kinds with NO
 * existing suffix): a partial first-name / org token is the coreference pattern.
 * Phone/address aliases already spend the suffix slot on geo/iso and a partial
 * phone/email is not a coreference key; email composites, and any alias ALREADY
 * carrying a suffix (a geo/iso suffix, or a prior overlap pass) are left untouched
 * — so this is IDEMPOTENT. The `.suffix` rides the alias grammar's existing geo/iso
 * slot, so `restoreInString` strips it (`stripAliasSuffix`) and round-trips the
 * base: ZERO new restore machinery, the hard zero-failure-restore invariant
 * preserved.
 *
 * Pure; the ledger is read-only (real-value lookups), never mutated. Reuses the
 * canonical `ALIAS_TOKEN_PATTERN` scan + `ledgerKindForAlias` / `lookupAliasReal`
 * / `stripAliasSuffix`, so casing siblings (`cap_pii.Person1`) decorate + restore
 * by the same machinery a canonical alias does.
 */
export const decorateOverlapReveal = (
  ledger: Ledger,
  text: string,
  disclosed: ReadonlySet<string>,
): string => {
  if (typeof text !== 'string' || text.length === 0 || disclosed.size === 0) return text;
  return text.replace(ALIAS_TOKEN_PATTERN, (match) => {
    const kind = ledgerKindForAlias(match);
    if (kind !== 'name' && kind !== 'org') return match;     // Person/Org readable family only
    if (stripAliasSuffix(match) !== match) return match;     // already suffixed → leave (idempotent)
    const real = lookupAliasReal(ledger, match);
    if (real === undefined) return match;                    // not a known emitted alias
    const suffix = overlapSuffix(real, disclosed);
    return suffix.length > 0 ? `${match}.${suffix}` : match;
  });
};

/* ──────────────── Pre-scan reserve/escape (D-167 Slice 3) ──────────────── */

/**
 * A `pii.<Word><N>` readable-family token (optional `cap_` casing-sibling prefix,
 * optional geo/iso suffix) a user may type as a LITERAL — the residual Slice 2
 * leaves (Slice 2 made a bare `Person1` no longer an alias; the PREFIXED
 * `pii.Person1` a user types still restores to whatever real value holds that
 * slot). Mirrors `ALIAS_TOKEN_PATTERN`'s readable-family arm (same `cap_` prefix +
 * alternation + suffix shape + `\b` boundaries), so the pre-scan covers EVERY
 * literal restore could un-alias.
 *
 * CASE-INSENSITIVE (`/gi`) — DELIBERATELY symmetric with restore. Restore is
 * case-insensitive (an LLM case-mutates the alias it echoes), so a case-MUTATED
 * user literal (`pii.person1`, `PII.PERSON1`) would slip past a case-sensitive
 * pre-scan yet STILL un-alias on restore — a leak. `preScanString` canonicalizes
 * each match to find the slot, reserves/escapes it, and keys the restore entry on
 * the AS-TYPED token so the user's exact casing round-trips. A token whose `cap_`
 * / `pii.` PREFIX is case-mutated (`CAP_PII.Org1`) canonicalizes to nothing
 * `kindFromBase` recognizes, so it's skipped — but restore can't map it EITHER
 * (the same prefix-canonicalization is case-sensitive there), so it passes through
 * both unchanged: fail-safe, not a leak. The pre-scan now has NO leak residual. */
const PRE_SCAN_PII_TOKEN =
  /\b(?:cap\d*_)?pii\.(?:Person|Org|Phone|Address|Url|Id|Account|Email)\d+(?:\.[a-z0-9-]+){0,3}\b/gi;

/** Register one reserve/escape entry: indexed by `baseAlias` for restore lookup
 *  (`byKindBaseAlias`) + by the literal for cross-occurrence / cross-turn REUSE
 *  (`preScanLiterals`), and DELIBERATELY NOT in `byKindRealValue` — the content
 *  pass iterates that map, and a `pii.*`-shaped `real_value` there would let
 *  `scanContent` re-process the emitted alias. `real_value` is the user's literal
 *  token: exactly what restore must return. */
const registerPreScanEntry = (
  ledger: Ledger,
  kind: LedgerKind,
  literal: string,
  baseAlias: string,
  aliasValue: string,
): RedactionAliasEntry => {
  const entry: RedactionAliasEntry = {
    scope_id: ledger.scope_id,
    kind,
    real_value: literal,
    alias_value: aliasValue,
    first_observed_at: {},
    created_at: Date.now(),
  };
  ledger.byKindBaseAlias.set(kindKey(kind, baseAlias), entry);
  ledger.preScanLiterals.set(kindKey(kind, literal), entry);
  return entry;
};

/**
 * Pre-scan ONE string for user-typed `pii.*` literal tokens, reserving/escaping
 * each so it round-trips through restore instead of colliding with an allocated
 * alias (D-167 Slice 3). Per token:
 *   - REUSE — the same literal token seen before (this packet OR a prior turn,
 *     via the persistent `preScanLiterals` index) → emit its prior decision's
 *     surface, so one literal renders consistently everywhere.
 *   - RESERVE — the base slot is free → register a self-map (restore returns the
 *     literal verbatim) and leave the token unchanged. The slot is now claimed,
 *     so a later real value is aliased PAST it (skip-aware `nextCounter`).
 *   - ESCAPE — the base slot is already taken (a real value, or another turn's
 *     reservation), OR the literal is a `cap_` casing sibling (always escaped, to
 *     a BARE slot — see the inline note) → allocate a FRESH slot, map it back to
 *     the literal, and REPLACE the token with the fresh alias so the model can't
 *     conflate it with the real alias on that base. Restore unwinds it to the literal.
 * Case-insensitive (matches restore): each match is CANONICALIZED to find the
 * slot, but the entry keys on the AS-TYPED token so a case-mutated literal
 * (`pii.person1`) round-trips to the user's exact casing instead of leaking.
 *
 * Fail-safe: every branch round-trips the user's exact text; a collision can
 * only degrade to passthrough, never leak a real value or corrupt the literal.
 * Returns the (possibly rewritten) text + whether any token was ESCAPED (a
 * reserve / reuse-of-a-reserve leaves the text byte-identical). */
const preScanString = (
  ledger: Ledger,
  text: string,
): { text: string; escaped: boolean } => {
  if (typeof text !== 'string' || text.length === 0 || !/pii\./i.test(text)) {
    return { text, escaped: false };
  }
  let escaped = false;
  const out = text.replace(PRE_SCAN_PII_TOKEN, (token) => {
    // Canonicalize first — the token may be case-mutated (`pii.person1`,
    // `PII.PERSON1`). The CANONICAL base keys `byKindBaseAlias` (slot identity,
    // shared with real aliases + the skip-aware counter); the AS-TYPED `token`
    // keys `preScanLiterals` (per-casing reuse) and is the `real_value` restore
    // returns — the user's exact text.
    const base = stripAliasSuffix(toCanonicalCasing(token));
    const kind = kindFromBase(base);
    if (!kind) return token;                                   // not a real pii.* surface
    const prior = ledger.preScanLiterals.get(kindKey(kind, token));
    if (prior) {
      if (prior.alias_value !== token) escaped = true;
      return prior.alias_value;                                // REUSE
    }
    // A `cap_` casing-sibling literal ALWAYS escapes to a fresh BARE slot — never
    // reserve it under its `cap_` base: a later `scanContent` casing variant calls
    // `allocSibling`, which would re-`set` that same `cap_…` key and clobber the
    // reservation (→ leak). Escaping to a bare `pii.<Word><N>` slot lands outside
    // the sibling keyspace, so `allocSibling` can never collide — and `allocSibling`
    // needs no change. A bare literal reserves a free slot / escapes a taken one.
    const isCapSibling = /^cap\d*_/.test(base);
    if (!isCapSibling && !ledger.byKindBaseAlias.has(kindKey(kind, base))) {
      registerPreScanEntry(ledger, kind, token, base, token); // RESERVE (self-map)
      return token;
    }
    const freshBase = defaultBaseAlias(kind, nextCounter(ledger, kind));
    registerPreScanEntry(ledger, kind, token, freshBase, freshBase); // ESCAPE
    escaped = true;
    return freshBase;
  });
  return { text: out, escaped };
};

/**
 * Pre-scan a nested value (objects / arrays / strings) for user-typed `pii.*`
 * literal tokens and reserve/escape each against the ledger (D-167 Slice 3) —
 * the WHOLE-packet collision-proofing pass an egress orchestrator runs ONCE,
 * BEFORE the alias pass. Walks every string leaf; object KEYS are NOT pre-scanned
 * (a key is a machine identifier, not user prose — a `pii.*`-shaped key is a
 * vanishing edge left to restore's existing key-blindness). Returns a deep copy
 * with escapes applied + whether any token was escaped, so the caller keeps its
 * byte-identity fast path when nothing was rewritten.
 *
 * MUST run EXACTLY ONCE per packet: a second pass would re-see an escaped token
 * (`pii.Person2`) as a fresh literal and escape it AGAIN (a cascade). The
 * orchestration seams (`aliasChatAiInput`, `piiProtect`) call it at the top —
 * never the per-field aliasers (`aliasFields` / `aliasArgs`), which the chat
 * path invokes more than once. */
export const preScanReservePii = <T>(
  ledger: Ledger,
  value: T,
): { value: T; escaped: boolean } => {
  let escaped = false;
  const mapString = (s: string): string => {
    const res = preScanString(ledger, s);
    if (res.escaped) escaped = true;
    return res.text;
  };
  return { value: walk(value, mapString) as T, escaped };
};

/**
 * Restore aliases inside arbitrary nested args (objects / arrays / strings).
 * Unknown aliases pass through unchanged — comfort feature, no rejection.
 *
 * The approval-preview surface (D-157 preflight gate) renders this output
 * so the user sees the real call (`email alice@acme.com`) rather than the
 * alias (`email m1@d1.invalid`).
 */
export const restoreArgs = <T>(ledger: Ledger, args: T): T => {
  // VALUE-only (keys untouched). This is the SHARED restore behind
  // `restoreArgsForApproval`, recipe `pii-restore`, and `restoreAll`, so it must
  // NOT rewrite object keys: a legitimate map key that happens to LOOK like an
  // alias (`pii.Person1`, `m1@d1.invalid`) in an approval preview / recipe output must
  // pass through unchanged (codex adversarial-review). The narrow chat case where
  // the model could copy an aliased map KEY into `tool_calls[].args` is handled by
  // `restoreArgsAndKeys`, scoped at that one egress surface — see its doc.
  return walk(args, (s) => restoreInString(ledger, s)) as T;
};

/**
 * KEY-AWARE restore — un-aliases both object KEYS and string values. Symmetric
 * with the key-aware `aliasArgs`, and NARROWLY scoped to the one surface that
 * needs it: the model-emitted `tool_calls[].args`. The uniform chat egress aliases
 * a result map's keys (a contact-email-keyed result is shown to the model as
 * `{"m1@d1.invalid": …}`), so if the model copies that alias key into a later tool
 * call's args map, dispatch must receive the REAL key — else the tool gets
 * `m1@d1.invalid` as real data (codex adversarial-review).
 *
 * This is DELIBERATELY separate from `restoreArgs` so the shared approval-preview /
 * recipe restore stays key-blind and never rewrites a legitimate alias-shaped key.
 * A real key (not an alias) restores to itself; a restored key landing on a
 * prototype-unsafe name is dropped by `walk` (defence-in-depth); a key collision
 * (both an alias key and its real key present — unreachable for real model data)
 * collapses last-wins. Returns a deep copy.
 */
export const restoreArgsAndKeys = <T>(ledger: Ledger, args: T): T => {
  const mapValue = (s: string) => restoreInString(ledger, s);
  const mapKey = (s: string) => restoreKeyString(ledger, s);
  return walk(args, mapValue, mapKey) as T;
};

/** Inverse of `aliasKeyString` — un-alias a JSON object KEY. Beyond the prose
 *  `restoreInString` pass it ALSO un-aliases a non-email alias embedded after an
 *  identifier separator (`owner_Id1` → `owner_CONTACT-77`), symmetric with the
 *  key-aware egress, using ALPHANUMERIC boundaries (so `_` / `.` / `-` are
 *  boundaries). Longest-alias-first. Emails restore via `restoreInString`'s
 *  composite handling. Best-effort: an unknown alias passes through unchanged. */
const restoreKeyString = (ledger: Ledger, key: string): string => {
  let out = restoreInString(ledger, key);
  const entries = Array.from(ledger.byKindRealValue.values())
    .filter((e) => e.kind !== 'email_local' && e.kind !== 'domain' && e.alias_value.length > 0)
    .sort((a, b) => b.alias_value.length - a.alias_value.length);
  for (const entry of entries) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(entry.alias_value)}(?![A-Za-z0-9])`, 'g');
    out = out.replace(pattern, entry.real_value);
  }
  return out;
};

/**
 * Forward mirror of `restoreArgs` — re-alias nested args (objects / arrays /
 * strings) by content-scanning every string leaf against the ledger, replacing
 * any ledger-known real value with its alias. The chat-mode egress seam uses it
 * to re-alias `prior_tool_calls[].args` before a reinvoke re-egresses them: the
 * tool loop restored the model's aliased args to real for dispatch, so without a
 * re-alias a contact the model referenced by alias in an earlier round would
 * re-egress RAW.
 *
 * VALUE-based (the ledger-anchored `scanContent`), NOT a dot-path field tag — so
 * an arbitrary arg key containing a literal dot (`{"filter.email": …}`), which a
 * dot-path resolver mis-resolves, can't let the value silently escape the scan.
 *
 * KEY-AWARE (unlike `restoreArgs`): a tool args / result payload is unknown-shaped,
 * so a ledger-known value can sit in a JSON KEY (a result map keyed by a contact
 * email, `{"alice@acme.com": …}`), not just a value. The walk scans both keys and
 * values, so PII in a key is aliased too (codex adversarial-review). KEYS use the
 * `aliasKeyString` mapper, which also catches a non-email value embedded after an
 * identifier separator (`owner_Alice Chen`, `x_CONTACT-77`) — a machine-key shape
 * the prose word-boundary scanner alone misses. This is safe for the model-egress
 * use (`prior_tool_calls` / `correction_context`): that feedback is never restored
 * or dispatched, so an aliased key needs no symmetric un-alias. A real value and
 * its own alias both present as keys (unreachable for real tool data — an alias is
 * never raw data) collapses last-wins.
 *
 * Allocates casing-sibling / domain-anchored email rows exactly like any content
 * pass. Unknown spans pass through unchanged (ledger-anchored — no NER, no fresh
 * allocation beyond domain-anchored email completion). Returns a deep copy.
 */
export const aliasArgs = <T>(ledger: Ledger, args: T, counters?: RedactionCounters): T => {
  const mapValue = (s: string) => scanContent(ledger, s, counters).text;
  const mapKey = (s: string) => aliasKeyString(ledger, s, counters);
  return walk(args, mapValue, mapKey) as T;
};

/**
 * D-167 (recall path) — re-alias nested RECALL content (objects / arrays / strings)
 * from a `memory.*` tool result for egress. The forward mirror of `aliasArgs`, but
 * each string leaf runs the CONTACT-INDEX content pass (`aliasKnownValuesInContent`,
 * seed ⊇ scan) instead of the ledger-anchored `scanContent`, then the
 * `decorateOverlapReveal` overlap pass. This is the cross-session recall fix
 * ([[pii-memory-recall-leak-confirmed]]): today's egress aliases only values
 * ALREADY in the session ledger, so a contact recalled from a PRIOR session (never
 * surfaced this session) egresses RAW. Seeding from the contact known-value index
 * aliases it regardless; the overlap pass then re-reveals only the user-disclosed
 * fragment (`pii.Person1.sarah`) so the recall's coreference survives the alias.
 *
 * KEY-AWARE like `aliasArgs` (a contact value embedded in a result-map KEY is
 * aliased ledger-anchored via `aliasKeyString`) — keys carry no user-facing
 * coreference, so they are NOT overlap-decorated. `counters` (when supplied) is
 * bumped only by the content replacement, never by the seed. Returns a deep copy;
 * the input is never mutated. Ledger-anchored beyond the index seeds — no NER, no
 * fresh allocation past the index's known values + domain-anchored email completion.
 */
export const aliasRecallArgs = <T>(
  ledger: Ledger,
  args: T,
  index: KnownValueIndex,
  identifierSeeds: readonly KnownValueIdentifierSeed[],
  disclosed: ReadonlySet<string>,
  counters?: RedactionCounters,
): T => {
  const mapValue = (s: string): string =>
    decorateOverlapReveal(
      ledger,
      aliasKnownValuesInContent(ledger, s, index, identifierSeeds, counters).text,
      disclosed,
    );
  const mapKey = (s: string): string => aliasKeyString(ledger, s, counters);
  return walk(args, mapValue, mapKey) as T;
};

/** Alias a JSON object KEY (D-167 N.10). A key is a machine identifier, so beyond
 *  the prose/email `scanContent` pass it ALSO aliases a non-email ledger value
 *  embedded after an identifier separator — the prose pass's leading word-boundary
 *  `(?<![\w.@-])` treats `_` as part of the identifier, so `owner_Alice Chen` /
 *  `x_CONTACT-77` would keep the raw value. This second pass uses ALPHANUMERIC
 *  boundaries (so `_` / `.` / `-` / space are boundaries, but a mid-alphanumeric
 *  substring like `John` in `Johnam` is NOT — no over-alias). Longest-real-value-
 *  first; a casing variant allocates a sibling exactly like the content pass.
 *
 *  Emails are left to `scanContent` (its domain pass greedily consumes a local-part
 *  PREFIX, so `x_alice@acme.com` aliases), so this pass excludes them. Two bounded
 *  EMAIL residuals stay raw, both pre-existing `scanContent` behaviour (they affect
 *  free-text values too, not just keys) and accepted as out-of-scope:
 *    1. an email with a FRESH (never-aliased) domain — fundamental: ledger-anchored,
 *       no NER, so a never-seen email can't be aliased (same class as any brand-new
 *       value);
 *    2. a KNOWN-domain email with a boundary-breaking SUFFIX (`alice@acme.com_status`)
 *       — fixable only by relaxing the prose-tuned email boundary; an unusual
 *       composite-key shape, deliberately left raw (owner decision). */
const aliasKeyString = (
  ledger: Ledger,
  key: string,
  counters?: RedactionCounters,
): string => {
  let out = scanContent(ledger, key, counters).text;
  const entries = Array.from(ledger.byKindRealValue.values())
    .filter((e) => e.kind !== 'email_local' && e.kind !== 'domain' && e.real_value.length > 0)
    .sort((a, b) => b.real_value.length - a.real_value.length);
  for (const entry of entries) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(entry.real_value)}(?![A-Za-z0-9])`, 'gi');
    out = out.replace(pattern, (match) => {
      if (counters) counters.content_text_replacements += 1;
      return match === entry.real_value ? entry.alias_value : allocSibling(ledger, entry, match).alias_value;
    });
  }
  return out;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `mapKey` (optional) maps object KEYS too — the egress (`aliasArgs`) direction
 *  passes it so ledger-known PII in a key is aliased; the restore direction omits
 *  it (keys are not un-aliased — see `aliasArgs`). */
const walk = (
  value: unknown,
  mapString: (s: string) => string,
  mapKey?: (s: string) => string,
): unknown => {
  if (value == null) return value;
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) return value.map(v => walk(v, mapString, mapKey));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      const outKey = mapKey ? mapKey(k) : k;
      // Defence-in-depth: a mapped key (a restored real value, or an alias) that
      // lands on a prototype-unsafe name is dropped rather than assigned. Aliases
      // never collide with these; a restored key only could if a real value were
      // literally `__proto__` (a contact named that) — drop it.
      if (DANGEROUS_KEYS.has(outKey)) continue;
      out[outKey] = walk(v, mapString, mapKey);
    }
    return out;
  }
  return value;
};

/* ──────────────── Structured-packet field aliasing (D-167 P1 / P4 shared) ──────────────── */

/**
 * Deep structural copy — prototype-safe, mirrors `walk`'s recursion without
 * the string mapper. `aliasFields` clones before mutating so the caller's
 * packet is never touched: the chat-mode egress aliaser hands the copy to the
 * LLM while the orchestrator keeps the real packet for audit, and the
 * recipe-mode `pii-protect` transform leaves its input value intact.
 */
const deepClonePacket = (value: unknown): unknown => {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClonePacket);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = deepClonePacket(v);
  }
  return out;
};

/** Dot-path read. Numeric segments index arrays (`contacts.0.email`).
 *  Returns undefined for an absent path or a prototype-pollution segment. */
const getAtPath = (root: unknown, path: string): unknown => {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (DANGEROUS_KEYS.has(seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Dot-path write — sets only when the full parent chain already exists and
 *  is an object/array. A missing parent or prototype-pollution segment is a
 *  no-op: the comfort-layer stance never fabricates structure to place an
 *  alias, and aliasing is best-effort (a field the resolver named but the
 *  packet doesn't carry simply passes through). */
const setAtPath = (root: unknown, path: string, value: unknown): void => {
  if (!path) return;
  const segs = path.split('.');
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i];
    if (DANGEROUS_KEYS.has(seg)) return;
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[seg];
  }
  const last = segs[segs.length - 1];
  if (DANGEROUS_KEYS.has(last)) return;
  if (cur == null || typeof cur !== 'object') return;
  (cur as Record<string, unknown>)[last] = value;
};

/**
 * Alias a structured value's tagged fields in two ordered passes
 * (spec §"Runtime flow" steps 2-3) — the shared core behind the chat-mode
 * egress aliaser (D-167 P1) and the recipe-mode `pii-protect` transform
 * (D-167 P4).
 *
 *   1. Identifier pass — every non-`'content'` field aliases first, so the
 *      ledger (and its email / URL `'domain'` side-effects) is fully
 *      populated before any content text is scanned.
 *   2. Content pass — every `'content'` field then scan-replaces against the
 *      now-populated ledger (ledger-anchored only; no NER, no fresh
 *      allocation beyond domain-anchored email completion — see `scanContent`).
 *
 * `fields` are dot-paths into `data`; a path that is ABSENT (or null) is skipped —
 * there is nothing to protect. A path that is PRESENT is always handled: see
 * `aliasIdentifierValue`. Returns a deep copy — the input is never mutated.
 * `counters`, when supplied, accumulates the per-kind counts that feed the audit
 * `redaction_summary`.
 */

/**
 * Replacement for a PRESENT tagged value whose SHAPE the identifier pass cannot safely
 * alias (today: a bare object at an identifier-tagged path).
 *
 * FAIL-CLOSED, and that is the whole point. A `privacy` tag is a PROMISE that the field
 * is protected. These passes used to `continue` on any shape they did not expect, which
 * is indistinguishable from "nothing to do" — nothing throws, nothing logs, no test goes
 * red, and the real value simply egresses. That is exactly how `MAIL_SCHEMA`'s `to` / `cc`
 * (address ARRAYS, tagged `privacy: 'email'`) sent every mail recipient's address to the
 * cloud LLM in the clear. Arrays are now handled; anything still unhandled is REDACTED
 * rather than leaked, and the marker is loud enough that whoever authored the tag sees it.
 *
 * The right fix for an object is to tag its dotted sub-paths (`mailing_address.address1`),
 * exactly as the shipped schemas do — not to tag the object. This marker is the tripwire
 * that says so.
 */
export const PII_UNALIASABLE = '[pii.unaliasable]';

/**
 * Alias ONE value at a tagged identifier path, whatever its shape. Total by construction:
 * every branch either aliases, recurses, or fail-closed redacts — none falls through.
 *
 *   · absent / null   → returned as-is. Nothing to protect; a schema legitimately declares
 *                       fields a given vendor does not project.
 *   · string          → aliased (the ordinary case).
 *   · number/boolean  → aliased via its string form. A numeric vendor id (Pipedrive) or a
 *                       phone stored as a number at a TAGGED path is still PII; skipping it
 *                       would egress the real value, and the alias is a string regardless.
 *   · array           → ELEMENT-WISE against the same ledger, recursively (so nested lists
 *                       work). A recipient who is also the sender gets the SAME alias.
 *   · object          → `PII_UNALIASABLE`. We cannot know WHICH leaf carries the identifier,
 *                       and blanket-aliasing every leaf would alias the coarse city / state
 *                       / country that D-167 open-question #9 deliberately leaves visible.
 *                       So it does not go out at all.
 */
const aliasIdentifierValue = (
  ledger: Ledger,
  kind: Exclude<PiiFieldTag['kind'], 'content'>,
  value: unknown,
  counters?: RedactionCounters,
  path?: string,
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length === 0
      ? value
      : aliasIdentifierField(ledger, kind, value, counters, path);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return aliasIdentifierField(ledger, kind, String(value), counters, path);
  }
  if (Array.isArray(value)) {
    return value.map((element) => aliasIdentifierValue(ledger, kind, element, counters, path));
  }
  // An OBJECT at an ADDRESS path is not an error — it is a STRUCTURED ADDRESS, and it is the
  // one shape where we can know exactly which leaf is which. Handling it here is what makes
  // the postcode recoverable in prose: the record hands us the whole address, so the ledger
  // learns the postcode's NEIGHBOURS (city / state) and can match the layouts it really
  // appears in. Without that, the postcode is unmatchable — a bare `94043` is
  // indistinguishable from an invoice number and is deliberately withheld.
  //
  // STRUCTURE IS PRESERVED, which is the whole reason we do not collapse the object into one
  // alias: each leaf keeps its OWN alias and restores to its OWN value, so
  // `{street, city, state, zip}` round-trips as `{street, city, state, zip}`. The composite
  // entry `registerAddressComposite` allocates is never written into a field — it exists only
  // so the content scan can recognise the address written out in prose.
  //
  // The COARSE leaves (city / state / country) stay VISIBLE, per open-question #9: the model
  // needs region grain for timezone reasoning, and the geo-suffixed alias
  // (`pii.Address1.mountain-view.ca`) carries it anyway.
  if (kind === 'address') {
    const record = value as Record<string, unknown>;
    const parts = readAddressComponents(record);
    if (parts !== undefined) {
      // Leaves FIRST, composites second — so the record's own fields take the low alias
      // numbers (`pii.Address1` / `pii.Address2`) and the prose-only layouts take the rest.
      // Purely cosmetic, but the model reads these numbers.
      const out: Record<string, unknown> = { ...record };
      for (const [key, leaf] of Object.entries(out)) {
        if (ADDRESS_COARSE_KEYS.has(key)) continue;
        if (typeof leaf !== 'string' || leaf.length === 0) continue;
        out[key] = aliasIdentifierField(ledger, kind, leaf, counters, path);
      }
      registerAddressComposite(ledger, parts, path);
      return out;
    }
  }
  return PII_UNALIASABLE;
};

/**
 * Identifier pass over one already-cloned structured value — aliases every
 * non-`'content'` tagged field, populating the ledger (and its email / URL
 * `'domain'` side-effects) before any content scan runs. Mutates `clone` in
 * place. Narrowing: after the `'content'` skip, `field.kind` is
 * `Exclude<…, 'content'>`, exactly `aliasIdentifierField`'s kind parameter.
 */
const aliasIdentifierPass = (
  ledger: Ledger,
  clone: unknown,
  fields: readonly PiiFieldTag[],
  counters?: RedactionCounters,
): void => {
  for (const field of fields) {
    // Hoisted so the non-`content` narrowing survives into `aliasIdentifierValue`'s
    // callbacks (TypeScript discards property narrowing across a closure boundary).
    const kind = field.kind;
    if (kind === 'content') continue;
    const value = getAtPath(clone, field.path);
    // Absent / null → the field is genuinely not on this record. Everything PRESENT is
    // handled by `aliasIdentifierValue` — string, number, array, or fail-closed redact.
    // There is deliberately NO `continue` on an unexpected shape: that is precisely the
    // silent skip that let every mail recipient egress raw.
    if (value === null || value === undefined) continue;
    setAtPath(clone, field.path, aliasIdentifierValue(ledger, kind, value, counters, field.path));
  }
};

/**
 * Content pass over one already-cloned structured value — scan-replaces every
 * `'content'` tagged field against the (now-populated) ledger. Mutates in place.
 */
const aliasContentPass = (
  ledger: Ledger,
  clone: unknown,
  fields: readonly PiiFieldTag[],
  counters?: RedactionCounters,
): void => {
  for (const field of fields) {
    if (field.kind !== 'content') continue;
    const value = getAtPath(clone, field.path);
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value.length === 0) continue;
      setAtPath(clone, field.path, scanContent(ledger, value, counters).text);
      continue;
    }
    // ANY other present shape — a list of free-text lines, a structured body — deep-walks
    // every STRING leaf and scans it. Unlike the identifier pass, recursing here is safe by
    // CONSTRUCTION and needs no fail-closed branch: `content` is SCAN-ONLY. It replaces
    // values ALREADY in the ledger and never seeds new ones, so it cannot over-alias a
    // coarse field the way a blanket identifier alias would. `walk` is prototype-safe.
    setAtPath(
      clone,
      field.path,
      walk(value, (s) => scanContent(ledger, s, counters).text),
    );
  }
};

export const aliasFields = (
  ledger: Ledger,
  data: PiiAliasableData,
  fields: readonly PiiFieldTag[],
  counters?: RedactionCounters,
): PiiAliasableData => {
  const clone = deepClonePacket(data) as PiiAliasableData;
  aliasIdentifierPass(ledger, clone, fields, counters);
  aliasContentPass(ledger, clone, fields, counters);
  return clone;
};

/**
 * Batch variant for a top-level D-162 list — the recipe-mode `pii-protect`
 * transform's array path. Runs the two passes ACROSS THE WHOLE LIST: every
 * object element's identifier fields alias first (fully populating the shared
 * ledger + its `'domain'` side-effects), THEN every element's content fields
 * and every bare-string element scan against that populated ledger.
 *
 * Doing the identifier pass list-wide before any content scan is load-bearing
 * for the privacy invariant: a per-element `aliasFields` map would scan item 0's
 * content against an empty ledger when the value it should alias is anchored by
 * a structured field on item 1 — leaving real PII raw based purely on element
 * order. Here element order can't leak: the single shared ledger is fully
 * populated before the first content scan. `fields` dot-paths are relative to
 * EACH element. Returns a new array; inputs are never mutated (deep-cloned).
 */
export const aliasFieldsBatch = (
  ledger: Ledger,
  items: readonly unknown[],
  fields: readonly PiiFieldTag[],
  counters?: RedactionCounters,
): unknown[] => {
  const clones = items.map((item) => deepClonePacket(item));
  // Pass 1 — identifier fields on every object element (skip strings / other).
  for (const clone of clones) {
    if (clone !== null && typeof clone === 'object' && !Array.isArray(clone)) {
      aliasIdentifierPass(ledger, clone, fields, counters);
    }
  }
  // Pass 2 — content fields on object elements + bare-string elements, all
  // scanned against the now-fully-populated shared ledger.
  return clones.map((clone) => {
    if (typeof clone === 'string') return scanContent(ledger, clone, counters).text;
    if (clone !== null && typeof clone === 'object' && !Array.isArray(clone)) {
      aliasContentPass(ledger, clone, fields, counters);
    }
    return clone;
  });
};

/* ──────────────── Run-local ledger store (D-167 P4 recipe transforms) ──────────────── */

/**
 * A run-local ledger store — the pure-RAM substrate behind the recipe-mode
 * `pii-protect` / `pii-restore` transforms (D-167 P4).
 *
 * Why a handle + store instead of returning the ledger inline: a recipe
 * aliases data in a `pii-protect` step, hands the aliases to an AI step, then
 * un-aliases the result in a later `pii-restore` step. The ledger that bridges
 * those steps holds the REAL PII values — so it must never travel through
 * `step.*` state (which can be audited / persisted / broadcast). Instead
 * `pii-protect` returns an opaque `ledger_handle`; the real values stay in
 * this store, in process RAM only. No ledger row ever lands on disk
 * (spec §Transform exports).
 *
 * Lifecycle: the recued-server engine mints one store per recipe run and hands
 * it to every transform via `TransformContext.piiLedgerStore`; the store (and
 * its real-PII ledgers) is dropped — garbage-collected — when the run returns.
 * There is no cross-run / cross-recipe / cross-session sharing; a recipe that
 * needs session-aligned aliasing belongs in chat mode (D-167 P1), which owns
 * the session-scoped ledger.
 *
 * Run-global numbering (D-167 Slice 2): every ledger a store mints shares ONE
 * alias namespace (counters + forward/reverse indices). So two `pii-protect`
 * steps in the same run never both mint `pii.Person1` / `m1@d1.invalid` for
 * DIFFERENT people — the second step continues the run's counters — and the
 * same real value seen by both steps collapses to one alias (better LLM
 * cross-step consistency). That run-wide uniqueness is what makes `restoreAll`
 * over a run's combined output collision-free.
 */
export interface PiiLedgerStore {
  /** Mint a fresh ledger + its opaque handle. The handle is unique across
   *  every store in the process (per-store sequence × a process-global store
   *  sequence), so a handle accidentally carried into another run never
   *  resolves against the wrong ledger — it just misses. */
  create(): { handle: string; ledger: Ledger };
  /** Resolve a ledger by handle. Undefined for an unknown / dropped handle:
   *  the hard restore invariant is "never throw / never corrupt", not "always
   *  find a ledger", so the caller passes its data through unchanged. */
  get(handle: string): Ledger | undefined;
  /** Restore every alias minted by ANY ledger this store owns, run-wide, inside
   *  a JSON-like nested value. Walks strings / arrays / plain objects exactly as
   *  `restoreArgs` does (the existing `pii-restore` path): prototype-unsafe keys
   *  (`__proto__` / `constructor` / `prototype`) are dropped and non-plain
   *  objects (Date / Map / class instances) are not preserved verbatim — so feed
   *  it the JSON-like recipe output, not arbitrary class instances. The engine
   *  calls this on a run's output before `dispose` so a run-local alias can never
   *  reach the user even when the recipe's `pii-restore` step is missing,
   *  skipped, or halted (D-167 Slice 3). Collision-free because the store's
   *  ledgers share one alias namespace (see `createPiiLedgerStore`), so no two
   *  ledgers ever mint the same alias for different values. After `dispose` every
   *  alias misses and the value passes through unchanged — the same hard restore
   *  invariant as `get` (never throw). */
  restoreAll<T>(data: T): T;
  /** Drop every ledger (and the real PII it holds) this store owns. The engine
   *  calls this the moment a recipe run resolves — INCLUDING when a budget
   *  timeout makes the caller abandon a still-running inner run — so real
   *  values don't linger in RAM past the run from the caller's perspective,
   *  rather than waiting for GC to reclaim the store. After dispose, `get`
   *  returns undefined for every prior handle (a late restore on an abandoned
   *  run then passes through unchanged — harmless, its result is discarded). */
  dispose(): void;
  /** § 7 follow-on (pii-ledger-in-checkpoint) — the store's durable snapshot
   *  for a D-157 preflight pause, or undefined when the run never minted a
   *  ledger nor an alias (the common case — no checkpoint field at all).
   *  Pure JSON (deep-copied; shares nothing with the live maps), suitable for
   *  `Checkpoint.pii_ledgers` verbatim. `createPiiLedgerStore(snapshot)`
   *  round-trips it: old handles resolve, counters/forward maps continue, new
   *  mints can't collide — so a resumed run restores pre-pause aliases AND a
   *  second pause re-serializes the combined state (multi-pause chains).
   *  Entry-object identity across the forward/reverse/pre-scan indices is NOT
   *  preserved by the round-trip — functionally irrelevant, entries are
   *  written once at allocation and only ever read. */
  serialize(): PiiLedgerStoreSnapshot | undefined;
}

// Process-global monotonic sequence so handles are unique across ALL stores in
// the process (each store also counts its own ledgers). Deterministic — no
// Date.now / Math.random — so transform tests are reproducible;
// `_resetPiiLedgerState` zeroes it. Mirrors privacy.ts's `hash_replace`
// counter precedent.
let storeSeq = 0;

export const createPiiLedgerStore = (
  snapshot?: PiiLedgerStoreSnapshot,
): PiiLedgerStore => {
  // § 7 follow-on (pii-ledger-in-checkpoint) — hydrating from a checkpoint
  // snapshot re-uses the PAUSED store's `sid` and continues its `ledger_seq`,
  // so a resumed run's NEW mints (`pii-ledger:<sid>.<seq+1>…`) can never
  // collide with a pre-pause handle carried in `step_state`. Bumping the
  // process-global sequence past the snapshot's sid keeps handle uniqueness
  // ACROSS stores intact in the new process too (a later fresh store can't
  // re-issue this sid). Fresh stores (no snapshot) behave exactly as before.
  const snapSid = snapshot && Number.isFinite(snapshot.sid) ? snapshot.sid : undefined;
  if (snapSid !== undefined) storeSeq = Math.max(storeSeq, snapSid);
  const sid = snapSid ?? (storeSeq += 1);
  let ledgerSeq =
    snapshot && Number.isFinite(snapshot.ledger_seq) ? snapshot.ledger_seq : 0;
  // One alias namespace shared across every ledger this store mints (D-167
  // Slice 2): alias numbers stay unique run-wide and the same real value
  // collapses to one alias across protect steps, which is what makes
  // `restoreAll` over a run's combined output collision-free.
  const shared = createAliasNamespace();
  const ledgers = new Map<string, Ledger>();
  if (snapshot) {
    // Restore the shared namespace from the snapshot's entry arrays. Deep-
    // copied on serialize, so mutating the live maps never touches the
    // checkpoint row. Member shapes are tolerated loosely (`?? []`) — the
    // snapshot is engine-written and `isCheckpoint`-narrowed upstream, but a
    // missing member must degrade to "fewer restored entries", never a throw.
    for (const [k, e] of snapshot.by_kind_real_value ?? []) {
      shared.byKindRealValue.set(k, e);
    }
    for (const [k, e] of snapshot.by_kind_base_alias ?? []) {
      shared.byKindBaseAlias.set(k, e);
    }
    for (const [k, n] of snapshot.counters ?? []) {
      shared.counters.set(k as LedgerKind, n);
    }
    for (const [k, n] of snapshot.sibling_counters ?? []) {
      shared.siblingCounters.set(k, n);
    }
    for (const [k, e] of snapshot.pre_scan_literals ?? []) {
      shared.preScanLiterals.set(k, e);
    }
    // Re-register the paused run's handles so `step.<protect>.ledger_handle`
    // strings carried in the checkpoint's `step_state` resolve to a live
    // ledger view over the restored namespace.
    for (const handle of snapshot.handles ?? []) {
      if (typeof handle === 'string' && handle.length > 0) {
        ledgers.set(handle, createLedger(handle, shared));
      }
    }
  }
  // A stable ledger view over the shared namespace for `restoreAll`. Restore
  // reads only `byKindBaseAlias`, so any view over the shared maps resolves every
  // alias minted by any per-handle ledger. Not registered in `ledgers` (its
  // `.restore` scope_id can't collide with a numeric handle), so `get` never
  // returns it.
  const restoreView = createLedger(`pii-ledger:${sid}.restore`, shared);
  return {
    create() {
      const handle = `pii-ledger:${sid}.${(ledgerSeq += 1)}`;
      const ledger = createLedger(handle, shared);
      ledgers.set(handle, ledger);
      return { handle, ledger };
    },
    get(handle) {
      return typeof handle === 'string' ? ledgers.get(handle) : undefined;
    },
    restoreAll<T>(data: T): T {
      // Fast path: this store has never minted an alias, so there is nothing to
      // restore — return the value untouched (same reference). Restore reads
      // only `byKindBaseAlias`, so an empty map means a guaranteed pass-through.
      // This matters because the engine calls `restoreAll` on EVERY run's
      // output before dispose (D-167 Slice 3); without this guard `restoreArgs`
      // would deep-rebuild every object/array and run the restore regexes over
      // every string of the ~all recipes that never call `pii-protect`. It is
      // also the post-`dispose` pass-through path, since dispose clears the map.
      if (shared.byKindBaseAlias.size === 0) return data;
      return restoreArgs(restoreView, data);
    },
    dispose() {
      ledgers.clear();
      // Drop the shared namespace too — the per-handle ledger wrappers only
      // reference these maps, so clearing `ledgers` alone would leave the real
      // PII reachable through `restoreView` until GC. After this, `restoreAll`
      // passes through unchanged.
      shared.byKindRealValue.clear();
      shared.byKindBaseAlias.clear();
      shared.counters.clear();
      shared.siblingCounters.clear();
      shared.preScanLiterals.clear();
    },
    serialize() {
      // Nothing minted AND nothing aliased ⇒ nothing to carry (the common
      // case — the checkpoint stays snapshot-free and resume mints a plain
      // fresh store). A handle with still-empty maps IS carried: its restore
      // resolves to an empty ledger, which passes through identically, but
      // counter/seq continuity must survive for later mints.
      if (ledgers.size === 0 && shared.byKindBaseAlias.size === 0) {
        return undefined;
      }
      // `structuredClone` deep-copies the entry objects so the snapshot
      // shares nothing with the live maps — a post-pause mutation (or the
      // engine's dispose) can never reach into a written checkpoint row.
      return structuredClone({
        sid,
        ledger_seq: ledgerSeq,
        handles: [...ledgers.keys()],
        by_kind_real_value: [...shared.byKindRealValue.entries()],
        by_kind_base_alias: [...shared.byKindBaseAlias.entries()],
        counters: [...shared.counters.entries()] as Array<[string, number]>,
        sibling_counters: [...shared.siblingCounters.entries()],
        pre_scan_literals: [...shared.preScanLiterals.entries()],
      });
    },
  };
};

// Lazily-created process singleton for callers that invoke the transforms with
// a TransformContext that doesn't thread a per-run store (direct unit tests, or
// any non-engine host). The recued-server engine ALWAYS mints a per-run store,
// so this singleton is never reached on the production recipe path — it exists
// purely so `pii-protect` / `pii-restore` round-trip correctly when called
// standalone. It is NOT per-run-scoped (its ledgers persist for the process
// lifetime), which is acceptable only because production never uses it.
let fallbackStore: PiiLedgerStore | undefined;

export const getFallbackPiiLedgerStore = (): PiiLedgerStore => {
  if (!fallbackStore) fallbackStore = createPiiLedgerStore();
  return fallbackStore;
};

/** Test hook — reset the process-global store sequence + drop the fallback
 *  singleton so each test starts from clean, deterministic state. */
export const _resetPiiLedgerState = (): void => {
  storeSeq = 0;
  fallbackStore = undefined;
};
