/** D-145 PA8 — Contact identity extensions.
 *
 *  Three substrate additions per spec § A.4:
 *
 *   1. `identity_status` — `'mention_only' | 'partial' | 'verified'`
 *      column on `data_contact`. mention_only contacts have no email
 *      (conversational references like "mom" / "the cheese guy");
 *      partial contacts have name + (phone OR address) but no email;
 *      verified contacts have a canonical email and full D-138
 *      reconciliation applies.
 *
 *   2. `network_domain` — multi-value closed-list annotation on
 *      `data_contact` from `{ family, work, social, other }`. Drives
 *      per-domain trust controls, peer-MCP grant scopes, and
 *      extraction-confirmation UX.
 *
 *   3. `contact_alias` — separate substrate table with two `kind`
 *      branches: `'chat_alias'` (natural-language references) and
 *      `'platform_id'` (external platform IDs with a `platform`
 *      discriminator). Per-pair only; never sync to cloud; never
 *      returned via MCP to external AI clients.
 *
 *  Plus the `resolveContactReference` primitive that branches by
 *  reference shape (string for chat_alias / `{ platform, id }` object
 *  for platform_id) and returns the matched contact_id (or null with
 *  alternatives on ambiguity).
 *
 *  Spec: docs/d-145-spec.md § A.4.
 *
 *  D-192 C-2: the alias `source` vocabulary + its rank were folded into the one
 *  contribution ladder (`contact-contribution.ts`) — see `ContactAliasSource`. */

import {
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_CONTRIBUTION_SOURCE_SET,
  contactContributionRank,
  isContactContributionSource,
  type ContactContributionSource,
} from './contact-contribution.js';

// ────────────────────────────────────────────────────────────────
// § A.4.1 — `identity_status`
// ────────────────────────────────────────────────────────────────

/** Closed-list contact identity status. Default for any newly-derived
 *  contact (mail / calendar / manual upsert with email) is `'verified'`;
 *  chat-extraction stubs that lack canonical email start as
 *  `'mention_only'`. */
export const CONTACT_IDENTITY_STATUSES = ['mention_only', 'partial', 'verified'] as const;
export type ContactIdentityStatus = (typeof CONTACT_IDENTITY_STATUSES)[number];

export const CONTACT_IDENTITY_STATUS_SET: ReadonlySet<string> = new Set(CONTACT_IDENTITY_STATUSES);

export const isContactIdentityStatus = (v: unknown): v is ContactIdentityStatus =>
  typeof v === 'string' && CONTACT_IDENTITY_STATUS_SET.has(v);

/** Default for contacts that arrive with a canonical email — all the
 *  pre-PA8 contact paths (mail-derive / calendar-derive / contact.upsert
 *  with email) hit this default. */
export const DEFAULT_CONTACT_IDENTITY_STATUS: ContactIdentityStatus = 'verified';

// ────────────────────────────────────────────────────────────────
// § A.4.2 — `network_domain`
// ────────────────────────────────────────────────────────────────

/** Closed-list network-domain values — multi-value on a contact (a
 *  colleague who became a friend may be both `'work'` and `'social'`).
 *  Free-form user tags ride alongside in a separate annotation slot
 *  but don't drive substrate logic. */
export const NETWORK_DOMAINS = ['family', 'work', 'social', 'other'] as const;
export type NetworkDomain = (typeof NETWORK_DOMAINS)[number];

export const NETWORK_DOMAIN_SET: ReadonlySet<string> = new Set(NETWORK_DOMAINS);

export const isNetworkDomain = (v: unknown): v is NetworkDomain =>
  typeof v === 'string' && NETWORK_DOMAIN_SET.has(v);

/** Validate + dedupe a network_domain array. Throws on unknown values
 *  rather than silently dropping — chat-extraction emit paths rely on
 *  the substrate rejecting malformed annotations at write time so the
 *  user-facing surface stays clean. */
export const sanitizeNetworkDomains = (input: readonly string[]): NetworkDomain[] => {
  const out: NetworkDomain[] = [];
  const seen = new Set<NetworkDomain>();
  for (const v of input) {
    if (!isNetworkDomain(v)) {
      throw new ContactIdentityValidationError(
        `network_domain_unknown: "${v}"`,
        'network_domain',
      );
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// § A.4.3 — Unified `contact_alias` table
// ────────────────────────────────────────────────────────────────

/** The IDENTIFIER axis — every value you can MATCH a person by. All kinds share
 *  the same row shape; resolution branches on `kind`.
 *
 *   - `chat_alias`  — natural-language references ("mom", "my landlord").
 *   - `platform_id` — external-platform identifiers.
 *   - `email_alias` — D-192 C-2. **An email address.** This is where "email
 *     demotes from PK to an alias" actually happens: a contact carries MANY
 *     emails, and `contacts.email` becomes the PROJECTED primary (the winning
 *     `email_alias`). It also subsumes `merged_into` — a merged loser's email
 *     becomes an `email_alias` of the survivor, so "any known email → this
 *     person" is one indexed lookup instead of a redirect-chain walk.
 *   - `phone_alias` — D-192 C-2. A phone number. An IDENTIFIER, not an
 *     attribute: it drives the D-138 merge predicate and has a derived match
 *     index (`contact_phone_forms`). See `contact-contribution.ts` for why it
 *     is deliberately not a `contact_attribute`.
 *
 *  Descriptive facts (name / org / title / address / photo / birthday) are the
 *  other axis — `contact_attribute`. */
export const CONTACT_ALIAS_KINDS = [
  'chat_alias',
  'platform_id',
  'email_alias',
  'phone_alias',
] as const;
export type ContactAliasKind = (typeof CONTACT_ALIAS_KINDS)[number];

export const CONTACT_ALIAS_KIND_SET: ReadonlySet<string> = new Set(CONTACT_ALIAS_KINDS);

export const isContactAliasKind = (v: unknown): v is ContactAliasKind =>
  typeof v === 'string' && CONTACT_ALIAS_KIND_SET.has(v);

/** Closed list of platforms accepted at PA8. Expansion is one-line
 *  registry edit; a fresh platform requires no other substrate work
 *  until a Bridge ingredient ships for it. */
export const CONTACT_ALIAS_PLATFORMS = [
  'facebook',
  'x',
  'instagram',
  'linkedin',
  'github',
  'substack',
] as const;
export type ContactAliasPlatform = (typeof CONTACT_ALIAS_PLATFORMS)[number];

export const CONTACT_ALIAS_PLATFORM_SET: ReadonlySet<string> = new Set(CONTACT_ALIAS_PLATFORMS);

export const isContactAliasPlatform = (v: unknown): v is ContactAliasPlatform =>
  typeof v === 'string' && CONTACT_ALIAS_PLATFORM_SET.has(v);

/** Provenance of an alias write.
 *
 *  ⚠ **D-192 C-2 unified this onto `ContactContributionSource`.** PA8 shipped a
 *  private 4-value vocabulary here (`user_set` / `chat_confirmed` / `tag_button`
 *  / `ai_inferred`) — which made THREE overlapping provenance vocabularies in
 *  one substrate (this, `ContactCompanySource`, and `ContactSource`), and, more
 *  fatally, could not express the one thing the contact SOURCE family needs: an
 *  alias learned by IMPORT. There is no `contact_book` or `vendor_meta` rung in
 *  the old list, so a Google-imported `email_alias` had no honest provenance to
 *  record at all.
 *
 *  Now there is ONE ladder (`contact-contribution.ts`), and aliases rank on it
 *  exactly as attributes do. The old values map: `user_set → manual`,
 *  `chat_confirmed` / `tag_button` → `user_confirmed`, `ai_inferred` unchanged.
 *  Pre-launch, zero installs — replaced outright, no shim. */
export type ContactAliasSource = ContactContributionSource;

export const CONTACT_ALIAS_SOURCES = CONTACT_CONTRIBUTION_SOURCES;

export const CONTACT_ALIAS_SOURCE_SET: ReadonlySet<string> =
  CONTACT_CONTRIBUTION_SOURCE_SET;

export const isContactAliasSource = isContactContributionSource;

/** Substrate row shape for a contact_alias entry. `platform` MUST
 *  be present when `kind = 'platform_id'` and MUST be NULL when
 *  `kind = 'chat_alias'` — the partial unique indexes per A.4.3
 *  enforce this. */
export interface ContactAliasRecord {
  /** ULID. */
  id: string;
  /** FK → `contacts.contact_id`. */
  contact_id: string;
  /** Branches the resolver. */
  kind: ContactAliasKind;
  /** Only present when `kind === 'platform_id'`. */
  platform?: ContactAliasPlatform;
  /** Original alias / id as supplied by the writer (display + audit). */
  alias_pattern: string;
  /** Generated at write — lowercase + Unicode NFC + trim +
   *  collapsed-whitespace. Index target. */
  alias_pattern_normalized: string;
  /** Provenance — the trust RUNG (how much to trust it). */
  source: ContactAliasSource;
  /** D-192 C-2 — provenance's other half: the source INSTANCE (WHO supplied it),
   *  e.g. `google.personal.contact`. Optional because an alias may be written by
   *  a path with no Source behind it; a `manual` write fills it automatically.
   *
   *  Two jobs, same as its `contact_attribute` twin: it keeps the projection's
   *  provenance HONEST (a phone imported from Google must not be reported as
   *  hand-typed), and it makes Source TEARDOWN possible — purging a disconnected
   *  account's aliases needs to know which rows were its. */
  source_id?: string;
  /** 0..1; `'manual'` is always 1.0. */
  confidence: number;
  /** Unix-ms UTC. */
  created_at: number;
  /** Unix-ms UTC; bumped on resolver match. */
  last_resolved_at?: number;
}

/** Input shape for `upsertContactAlias`. `id` + `created_at` set by
 *  the storage layer. Validators run before insert. */
export interface ContactAliasInput {
  contact_id: string;
  kind: ContactAliasKind;
  platform?: ContactAliasPlatform;
  alias_pattern: string;
  source: ContactAliasSource;
  /** D-192 C-2 — the source INSTANCE (WHO). An IMPORTER must supply it; a
   *  `manual` write may omit it (the store fills `CONTACT_SOURCE_ID_MANUAL` —
   *  there is exactly one of the user, so it is knowable, not guessed). Any
   *  other source that omits it records NO instance, and the projection then
   *  honestly reports "unknown" rather than fabricating one. */
  source_id?: string;
  confidence?: number;
  /** Override id for tests. Production callers omit. */
  id?: string;
  /** Override created_at for tests. Production callers omit. */
  created_at?: number;
}

/** § A.4.3 — alias-pattern normalization. Lowercased + Unicode NFC +
 *  trimmed + whitespace collapsed. Idempotent: `normalize(normalize(x)) === normalize(x)`.
 *  Examples that collapse: `"Mom"`, `"mom "`, `"MOM"`, `" mom\t"` →
 *  `"mom"`; `"Café"` and `"Café"` → `"café"` (NFC). */
export const normalizeAliasPattern = (raw: string): string => {
  if (typeof raw !== 'string') return '';
  // NFC first so combining-character sequences canonicalize before
  // lowercasing. Keeping NFC after lowercase would still work; this
  // ordering minimizes surprising-locale quirks (e.g. Turkish dotless-i).
  const nfc = raw.normalize('NFC');
  const lowered = nfc.toLowerCase();
  const trimmed = lowered.trim();
  // Collapse runs of internal whitespace (any Unicode whitespace) to
  // single spaces so `"the   cheese  guy"` and `"the cheese guy"`
  // collapse together.
  return trimmed.replace(/\s+/gu, ' ');
};

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

export class ContactIdentityValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ContactIdentityValidationError';
    this.field = field;
  }
}

/** Pre-write validation for a contact_alias input. Throws on any
 *  violation; storage layer trusts the validated shape. */
export const validateContactAliasInput = (input: ContactAliasInput): void => {
  if (typeof input.contact_id !== 'string' || !input.contact_id.length) {
    throw new ContactIdentityValidationError('contact_id_required', 'contact_id');
  }
  if (!isContactAliasKind(input.kind)) {
    throw new ContactIdentityValidationError(
      `kind_unknown: "${String(input.kind)}"`,
      'kind',
    );
  }
  if (input.kind === 'platform_id') {
    if (!input.platform || !isContactAliasPlatform(input.platform)) {
      throw new ContactIdentityValidationError(
        `platform_required_for_platform_id: "${String(input.platform)}"`,
        'platform',
      );
    }
  } else if (input.platform !== undefined) {
    // Only `platform_id` carries a platform. Every other kind
    // (`chat_alias` / `email_alias` / `phone_alias`) MUST leave it NULL —
    // their partial unique indexes are defined without it, so a stray
    // platform would silently escape dedup rather than error.
    throw new ContactIdentityValidationError(
      `platform_forbidden_for_kind: ${input.kind}`,
      'platform',
    );
  }
  if (typeof input.alias_pattern !== 'string') {
    throw new ContactIdentityValidationError('alias_pattern_required', 'alias_pattern');
  }
  const normalized = normalizeAliasPattern(input.alias_pattern);
  if (!normalized.length) {
    throw new ContactIdentityValidationError('alias_pattern_empty', 'alias_pattern');
  }
  if (!isContactAliasSource(input.source)) {
    throw new ContactIdentityValidationError(
      `source_unknown: "${String(input.source)}"`,
      'source',
    );
  }
  // D-192 C-2 — `manual` is the ladder's name for PA8's `user_set`. A hand-typed
  // alias is certain by construction; a caller claiming otherwise has a bug.
  if (input.source === 'manual' && input.confidence !== undefined && input.confidence !== 1.0) {
    throw new ContactIdentityValidationError(
      'manual_confidence_must_be_one',
      'confidence',
    );
  }
  if (
    input.confidence !== undefined &&
    (typeof input.confidence !== 'number' ||
      Number.isNaN(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  ) {
    throw new ContactIdentityValidationError(
      `confidence_out_of_range: ${String(input.confidence)}`,
      'confidence',
    );
  }
  // D-192 C-2 — the PA8 rule "only `user_set` may claim confidence 1.0" is
  // REMOVED, because it is now provably redundant AND actively harmful.
  //
  // It existed when rank and confidence competed: a very confident weak writer
  // might have out-argued the user. Under the C-2a ladder they no longer
  // compete — `aliasIncomingOutranks` settles the RUNG first and only consults
  // confidence WITHIN a rung, so a 1.0-confidence `ai_inferred` can never beat
  // a 0.1-confidence `manual`. The invariant the rule protected is now
  // structural.
  //
  // Keeping it would have been a footgun: every imported alias (`vendor_meta`,
  // `contact_book`) would have to remember to fake a sub-1.0 confidence to pass
  // validation — punishing sources that are, in fact, certain about an email
  // address they are the system of record for.
};

/** Returns true iff `incoming` outranks `stored` for upsert override.
 *  Stronger source wins; on tie, higher confidence wins.
 *
 *  ⚠ **The comparison direction INVERTS vs the PA8 original.** The old private
 *  `CONTACT_ALIAS_SOURCE_RANK` counted UP (`user_set: 4` beat `ai_inferred: 1`),
 *  so it asked `incRank > storedRank`. The C-2a ladder counts DOWN — rank 0
 *  (`manual`) is the STRONGEST, mirroring `TRANSPARENCY_REDACTION_TIER_PRIORITY`
 *  — so the correct question is `incRank < storedRank`. Getting this backwards
 *  would not crash: it would silently let the WEAKEST writer win every alias
 *  conflict, which is the kind of inversion only a test catches. Hence the test
 *  that pins `manual` beating `ai_inferred` explicitly. */
export const aliasIncomingOutranks = (
  incoming: { source: ContactAliasSource; confidence: number },
  stored: { source: ContactAliasSource; confidence: number },
): boolean => {
  const incRank = contactContributionRank(incoming.source);
  const storedRank = contactContributionRank(stored.source);
  if (incRank !== storedRank) return incRank < storedRank; // LOWER rank = stronger
  return incoming.confidence > stored.confidence;
};

// ────────────────────────────────────────────────────────────────
// § A.4.5 — `resolveContactReference` primitive
// ────────────────────────────────────────────────────────────────

/** Reference shape supplied to the resolver. A string is treated as a
 *  chat_alias lookup; an object with `platform` + `id` is treated as
 *  a platform_id lookup. */
export type ContactReference = string | { platform: ContactAliasPlatform; id: string };

/** Context the resolver consults to break ties on chat_alias matches.
 *
 *  - `recent_contacts` is a list of `contact_id` values seen recently
 *    in the conversation; the resolver prefers them on tie.
 *  - `conversation_thread` is a thread identifier (mail-message id /
 *    chat-thread id) — used by upstream callers for binding the recent
 *    contacts list; opaque to the resolver itself in PA8.
 *  - `network_domain_hint` filters candidates whose contact has a
 *    matching network_domain assignment. */
export interface ContactReferenceContext {
  recent_contacts: readonly string[];
  conversation_thread?: string;
  network_domain_hint?: NetworkDomain;
}

/** Resolver result.
 *
 *  - `{ contact_id: string, alternatives: [] }` — single high-confidence
 *    match.
 *  - `{ contact_id: null, alternatives: [...] }` — multiple candidates;
 *    caller surfaces the disambiguation UX.
 *  - `{ contact_id: null, alternatives: [] }` — no match; caller may
 *    create a `mention_only` contact stub.
 */
export interface ContactReferenceResolution {
  contact_id: string | null;
  confidence: number;
  alternatives: readonly string[];
}

/** Closure shape the resolver consumes. Storage layer passes a closure
 *  over `contact_alias` + `data_contact`; pure tests pass an in-memory
 *  fixture. */
export interface ContactReferenceLookups {
  /** All chat_alias rows whose normalized alias pattern matches the
   *  reference exactly. The substrate normalizes the reference before
   *  comparison; this lookup operates on the normalized form. */
  chat_aliases_by_normalized: (normalized: string) => readonly ContactAliasRecord[];
  /** Single platform_id row keyed on `(platform, normalized_pattern)`,
   *  or null if not attached to any contact. The cross-contact
   *  uniqueness index per § A.4.3 guarantees at most one match. */
  platform_alias_by_key: (
    platform: ContactAliasPlatform,
    normalized: string,
  ) => ContactAliasRecord | null;
  /** Network-domain assignment for a contact_id. Used for
   *  `network_domain_hint` disambiguation. Returns the contact's
   *  network_domain array (empty array if none assigned). */
  network_domains_for: (contact_id: string) => readonly NetworkDomain[];
}

/** § A.4.5 — `resolveContactReference` primitive.
 *
 *  Branches by reference shape; consults storage closures for the
 *  match; applies disambiguation rules.
 *
 *  chat_alias rules:
 *    1. Exact match on normalized alias pattern.
 *    2. If multiple, filter by `network_domain_hint` (when supplied).
 *    3. If still multiple, prefer matches whose contact_id appears in
 *       `recent_contacts`.
 *    4. If still multiple, return null + alternatives (caller
 *       disambiguates).
 *
 *  platform_id rules:
 *    1. Exact lookup on `(platform, normalized_id)`.
 *    2. The cross-contact uniqueness invariant guarantees ≤ 1 result;
 *       no tie-breaking needed.
 */
export const resolveContactReference = (
  reference: ContactReference,
  context: ContactReferenceContext,
  lookups: ContactReferenceLookups,
): ContactReferenceResolution => {
  if (
    reference !== null &&
    typeof reference === 'object' &&
    'platform' in reference &&
    'id' in reference
  ) {
    return resolvePlatformId(reference.platform, reference.id, lookups);
  }
  if (typeof reference === 'string') {
    return resolveChatAlias(reference, context, lookups);
  }
  return { contact_id: null, confidence: 0, alternatives: [] };
};

const resolvePlatformId = (
  platform: ContactAliasPlatform,
  id: string,
  lookups: ContactReferenceLookups,
): ContactReferenceResolution => {
  if (!isContactAliasPlatform(platform)) {
    return { contact_id: null, confidence: 0, alternatives: [] };
  }
  const normalized = normalizeAliasPattern(id);
  if (!normalized.length) {
    return { contact_id: null, confidence: 0, alternatives: [] };
  }
  const row = lookups.platform_alias_by_key(platform, normalized);
  if (!row) return { contact_id: null, confidence: 0, alternatives: [] };
  return { contact_id: row.contact_id, confidence: row.confidence, alternatives: [] };
};

const resolveChatAlias = (
  reference: string,
  context: ContactReferenceContext,
  lookups: ContactReferenceLookups,
): ContactReferenceResolution => {
  const normalized = normalizeAliasPattern(reference);
  if (!normalized.length) {
    return { contact_id: null, confidence: 0, alternatives: [] };
  }

  const matches = lookups.chat_aliases_by_normalized(normalized);
  if (matches.length === 0) {
    return { contact_id: null, confidence: 0, alternatives: [] };
  }

  // Collapse multiple alias rows pointing at the same contact_id into
  // one candidate, taking max confidence. This handles the case where
  // a single contact has multiple chat aliases that happen to share a
  // normalized form (rare, but possible if users add the same alias
  // case-variant twice — the partial unique index actually prevents
  // this, but keep the dedup defensive).
  const byContact = new Map<string, number>();
  for (const m of matches) {
    const prev = byContact.get(m.contact_id);
    if (prev === undefined || m.confidence > prev) {
      byContact.set(m.contact_id, m.confidence);
    }
  }

  let candidates = Array.from(byContact.entries()).map(([contact_id, confidence]) => ({
    contact_id,
    confidence,
  }));

  if (candidates.length === 1) {
    const [c] = candidates;
    if (!c) return { contact_id: null, confidence: 0, alternatives: [] };
    return { contact_id: c.contact_id, confidence: c.confidence, alternatives: [] };
  }

  // Multiple candidates — apply disambiguation pipeline.
  if (context.network_domain_hint !== undefined) {
    const hint = context.network_domain_hint;
    const filtered = candidates.filter((c) =>
      lookups.network_domains_for(c.contact_id).includes(hint),
    );
    if (filtered.length === 1) {
      const [c] = filtered;
      if (!c) return { contact_id: null, confidence: 0, alternatives: [] };
      return { contact_id: c.contact_id, confidence: c.confidence, alternatives: [] };
    }
    if (filtered.length > 1) candidates = filtered;
  }

  if (context.recent_contacts.length > 0) {
    const recent = new Set(context.recent_contacts);
    const filtered = candidates.filter((c) => recent.has(c.contact_id));
    if (filtered.length === 1) {
      const [c] = filtered;
      if (!c) return { contact_id: null, confidence: 0, alternatives: [] };
      return { contact_id: c.contact_id, confidence: c.confidence, alternatives: [] };
    }
    if (filtered.length > 1) candidates = filtered;
  }

  // Still ambiguous — return alternatives sorted by confidence DESC
  // so the caller can render the disambiguation UX in the most useful
  // order. Stable secondary sort by contact_id for determinism.
  const alternatives = candidates
    .slice()
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.contact_id.localeCompare(b.contact_id);
    })
    .map((c) => c.contact_id);
  return { contact_id: null, confidence: 0, alternatives };
};

// ────────────────────────────────────────────────────────────────
// § A.4.4 — privacy invariants (encoded as constants)
// ────────────────────────────────────────────────────────────────

/** Aliases are NEVER returned in MCP responses to external AI clients
 *  — there's no per-token override. Loaded into the MCP-tool-catalog
 *  ratchet so any future rpc that surfaces alias data hits the
 *  invariant assertion. */
export const CONTACT_ALIAS_MCP_EXPOSURE = 'never' as const;
export type ContactAliasMcpExposure = typeof CONTACT_ALIAS_MCP_EXPOSURE;

/** `contact_alias` is per-pair only — no cross-cloud sync (D-097 /
 *  D-168). The literal empty-tuple export here is the canonical sync-
 *  transport declaration for the alias substrate. */
export const CONTACT_ALIAS_SYNC_TRANSPORTS: readonly never[] = [] as const;
