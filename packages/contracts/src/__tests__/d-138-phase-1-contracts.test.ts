/** D-138 Phase 1 — contract-layer acceptance tests.
 *
 *  Covers the pure-contracts surface P1 ships:
 *    - Predicate-based contact-match algorithm (deterministic;
 *      ≥2-field gate; nickname-alias resolution; null-field handling)
 *    - Phone canonicalization (E.164 + fallback chain)
 *    - Mailing-address canonicalization (per-field normalization +
 *      structured exact match)
 *    - Blocking-key derivation helpers
 *    - resolveContactIdentity chain walk (cycle + chain-cap throws)
 *    - MCP-catalog ratchet (Reviewer #12 — `contact.merge.*` excluded)
 *    - Closed-list registry exports (NICKNAME_ALIASES,
 *      CONTACT_MATCH_FIELDS, CONTACT_MERGE_RPC_METHODS) */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_MATCH_FIELDS,
  CONTACT_MATCH_MIN_FIELDS,
  CONTACT_MERGE_RPC_METHODS,
  CONTACT_REDIRECT_CHAIN_LIMIT,
  COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES,
  MCP_TOOL_CATALOG,
  MCP_RESERVED_RPC_PREFIXES,
  NICKNAME_ALIASES,
  canonicalPairKey,
  canonicalizeMailingAddress,
  canonicalizePhone,
  deriveAddressZipCountryKey,
  deriveCompanyNorm,
  deriveNameKey,
  evaluateContactMatch,
  isMcpToolName,
  isPairRejected,
  isReservedLocalRpc,
  levenshtein,
  resolveContactIdentity,
  resolvePhoneCountryCode,
  type ContactRecord,
  type MailingAddress,
} from '../index.js';

// Minimal fixture builder — enough fields to feed `evaluateContactMatch`.
const contact = (input: Partial<ContactRecord> & { email: string }): ContactRecord => ({
  _id: input.email,
  _collection: 'contact',
  first_seen: 1,
  last_interaction: 1,
  interaction_count: 1,
  source: 'email_from',
  created_at: 1,
  updated_at: 1,
  platform_ids: [],
  ...input,
});

describe('D-138 P1 — closed-list constants', () => {
  it('CONTACT_MATCH_FIELDS is the 4-field closed list', () => {
    expect(CONTACT_MATCH_FIELDS).toEqual(['name', 'company', 'phone', 'mailing_address']);
  });
  it('CONTACT_MATCH_MIN_FIELDS is 2', () => {
    expect(CONTACT_MATCH_MIN_FIELDS).toBe(2);
  });
  it('COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES is 2 (consumer-provider cardinality cutoff)', () => {
    expect(COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES).toBe(2);
  });
  it('CONTACT_REDIRECT_CHAIN_LIMIT is 32 (safety bound)', () => {
    expect(CONTACT_REDIRECT_CHAIN_LIMIT).toBe(32);
  });
  it('CONTACT_MERGE_RPC_METHODS lists every substrate rpc (P1 + P3)', () => {
    expect([...CONTACT_MERGE_RPC_METHODS].sort()).toEqual([
      'contact.merge.confirm',
      'contact.merge.list',
      'contact.merge.reject',
      'contact.merge.resolve_remerge_prompt',
      // D-138 P3 — Settings → Contacts → "Scan now" trigger
      'contact.merge.scan_now',
      'contact.merge.split',
      'contact.merge.undo_rejection',
    ]);
  });
});

describe('D-138 P1 — NICKNAME_ALIASES registry', () => {
  it('seeds with at least 20 canonical-name clusters (English-language v1)', () => {
    expect(NICKNAME_ALIASES.length).toBeGreaterThanOrEqual(20);
  });
  it('every cluster has a non-empty canonical + at least one alias', () => {
    for (const cluster of NICKNAME_ALIASES) {
      expect(cluster.canonical.length).toBeGreaterThan(0);
      expect(cluster.aliases.length).toBeGreaterThan(0);
    }
  });
  it('canonical / alias tokens are lowercased', () => {
    for (const cluster of NICKNAME_ALIASES) {
      expect(cluster.canonical).toBe(cluster.canonical.toLowerCase());
      for (const alias of cluster.aliases) expect(alias).toBe(alias.toLowerCase());
    }
  });
  it('canonical Bob/Robert / Liz/Elizabeth / Bill/William clusters exist', () => {
    const names = NICKNAME_ALIASES.map((c) => c.canonical);
    expect(names).toContain('robert');
    expect(names).toContain('elizabeth');
    expect(names).toContain('william');
    expect(names).toContain('katherine');
  });
});

describe('D-138 P1 — evaluateContactMatch', () => {
  const baseAddress: MailingAddress = {
    address1: '123 main street',
    city: 'springfield',
    state: 'IL',
    zip: '62701',
    country: 'US',
  };

  it('determinism — same inputs → same output (1000×)', () => {
    const a = contact({
      email: 'bob@x.com',
      name: 'Bob Smith',
      company: 'Acme',
      company_norm: 'acme',
      phone: '+14155551234',
    });
    const b = contact({
      email: 'b@y.com',
      name: 'Bob Smith',
      company: 'Acme',
      company_norm: 'acme',
      phone: '+14155551234',
    });
    const first = evaluateContactMatch(a, b);
    for (let i = 0; i < 1_000; i++) {
      const r = evaluateContactMatch(a, b);
      expect(r).toEqual(first);
    }
  });

  it('1 matching field → no candidate (predicate gate at 2)', () => {
    const a = contact({ email: 'a@x.com', name: 'Alice Jones' });
    const b = contact({ email: 'b@y.com', name: 'Alice Jones' });
    expect(evaluateContactMatch(a, b)).toEqual({ matches: false, matched_fields: ['name'] });
  });

  it('2 matching fields → candidate', () => {
    const a = contact({
      email: 'a@x.com',
      name: 'Alice Jones',
      company: 'Acme',
      company_norm: 'acme',
    });
    const b = contact({
      email: 'b@y.com',
      name: 'Alice Jones',
      company: 'Acme',
      company_norm: 'acme',
    });
    const r = evaluateContactMatch(a, b);
    expect(r.matches).toBe(true);
    expect(r.matched_fields.sort()).toEqual(['company', 'name']);
  });

  it('Bob/Robert nickname alias surfaces with company match', () => {
    const a = contact({
      email: 'bob.smith@acme.com',
      name: 'Bob Smith',
      company: 'Acme',
      company_norm: 'acme',
    });
    const b = contact({
      email: 'robert.smith@acme.com',
      name: 'Robert Smith',
      company: 'Acme',
      company_norm: 'acme',
    });
    const r = evaluateContactMatch(a, b);
    expect(r.matches).toBe(true);
    expect(r.matched_fields.sort()).toEqual(['company', 'name']);
  });

  it('nickname alias respects per-token rule — different last names defeat name field', () => {
    const a = contact({ email: 'bob@x.com', name: 'Bob Smith', company: 'Acme', company_norm: 'acme' });
    const b = contact({ email: 'rob@y.com', name: 'Robert Jones', company: 'Acme', company_norm: 'acme' });
    const r = evaluateContactMatch(a, b);
    // Last-token mismatch defeats the name field; only company matches → 1 field → no candidate.
    expect(r.matched_fields).toEqual(['company']);
    expect(r.matches).toBe(false);
  });

  it('phone NULL on either side disqualifies the phone field', () => {
    const a = contact({
      email: 'a@x.com',
      name: 'Alice Jones',
      phone: '+14155551234',
      company: 'Acme',
      company_norm: 'acme',
    });
    const b = contact({
      email: 'b@y.com',
      name: 'Alice Jones',
      // phone null
      company: 'Acme',
      company_norm: 'acme',
    });
    const r = evaluateContactMatch(a, b);
    // 2 fields match (name + company); phone doesn't count.
    expect(r.matched_fields.sort()).toEqual(['company', 'name']);
    expect(r.matches).toBe(true);
  });

  it('mailing_address structured exact — same address1+city+zip+country counts even if state differs', () => {
    const a = contact({
      email: 'a@x.com',
      name: 'Alice Jones',
      mailing_address: { ...baseAddress, state: 'IL' },
    });
    const b = contact({
      email: 'b@y.com',
      name: 'Alice Jones',
      mailing_address: { ...baseAddress, state: 'IA' /* wrong but zip+country still match */ },
    });
    const r = evaluateContactMatch(a, b);
    expect(r.matched_fields.sort()).toEqual(['mailing_address', 'name']);
    expect(r.matches).toBe(true);
  });

  it('mailing_address differing address2 does NOT defeat the match', () => {
    const a = contact({
      email: 'a@x.com',
      name: 'Alice Jones',
      mailing_address: { ...baseAddress, address2: 'apt 1' },
    });
    const b = contact({
      email: 'b@y.com',
      name: 'Alice Jones',
      mailing_address: { ...baseAddress, address2: 'apt 2' },
    });
    expect(evaluateContactMatch(a, b).matches).toBe(true);
  });

  it('same-company same-name surfaces as candidate (vendor name fields omit middle names)', () => {
    // Bob Smith vs Bob Adam Smith both at Acme — vendor fields store
    // firstname + lastname omitting middle names, so both rows carry
    // name='Bob Smith'. Predicate fires; user reviews + rejects.
    const a = contact({
      email: 'bob.smith@acme.com',
      name: 'Bob Smith',
      company: 'Acme',
      company_norm: 'acme',
    });
    const b = contact({
      email: 'bob.adam.smith@acme.com',
      name: 'Bob Smith',
      company: 'Acme',
      company_norm: 'acme',
    });
    const r = evaluateContactMatch(a, b);
    expect(r.matches).toBe(true);
    expect(r.matched_fields.sort()).toEqual(['company', 'name']);
  });
});

describe('D-138 P1 — canonicalizePhone', () => {
  it('US 10-digit national → +1 prefix', () => {
    expect(canonicalizePhone('(415) 555-1234', 'US')).toBe('+14155551234');
  });
  it('US 11-digit with leading 1 → +1 prefix', () => {
    expect(canonicalizePhone('1-415-555-1234', 'US')).toBe('+14155551234');
  });
  it('already-E.164 input is preserved', () => {
    expect(canonicalizePhone('+447123456789')).toBe('+447123456789');
  });
  it('UK input with GB country code', () => {
    expect(canonicalizePhone('07123 456789', 'GB')).toBe('+4407123456789');
  });
  it('returns null on unparseable input', () => {
    expect(canonicalizePhone('not-a-phone')).toBeNull();
    expect(canonicalizePhone('')).toBeNull();
    expect(canonicalizePhone(undefined)).toBeNull();
  });
  it('explicit defaultCountryCode wins over emailHint', () => {
    expect(canonicalizePhone('07123456789', 'GB', 'foo@example.fr')).toBe('+4407123456789');
  });
  it('falls through to email-TLD heuristic when no explicit code', () => {
    expect(canonicalizePhone('07123456789', undefined, 'foo@example.de')).toBe('+4907123456789');
  });
  it('round-trips deterministically', () => {
    const out = canonicalizePhone('(415) 555-1234', 'US');
    for (let i = 0; i < 100; i++) {
      expect(canonicalizePhone('(415) 555-1234', 'US')).toBe(out);
    }
  });
});

describe('D-138 P1 — resolvePhoneCountryCode', () => {
  it('explicit code precedence', () => {
    expect(resolvePhoneCountryCode('US')).toBe('+1');
    expect(resolvePhoneCountryCode('+44')).toBe('+44');
  });
  it('email-TLD fallback', () => {
    expect(resolvePhoneCountryCode(undefined, 'foo@example.uk')).toBe('+44');
    expect(resolvePhoneCountryCode(undefined, 'foo@example.de')).toBe('+49');
  });
  it('returns null when no signal', () => {
    expect(resolvePhoneCountryCode()).toBeNull();
    expect(resolvePhoneCountryCode(undefined, 'foo@bar.com')).toBeNull();
  });
});

describe('D-138 P1 — canonicalizeMailingAddress', () => {
  it('round-trips a full US address', () => {
    const out = canonicalizeMailingAddress({
      address1: '123 Main St.',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
    });
    expect(out).toEqual({
      address1: '123 main street',
      city: 'springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
    });
  });
  it('expands abbreviations (St./Ave./Blvd.)', () => {
    const out = canonicalizeMailingAddress({
      address1: '500 Park Ave.',
      city: 'New York',
      state: 'NY',
      zip: '10022',
      country: 'US',
    });
    expect(out!.address1).toBe('500 park avenue');
  });
  it('returns null when a required field is missing', () => {
    expect(canonicalizeMailingAddress({ address1: '1 St.', city: 'X', country: 'US' })).toBeNull();
    expect(canonicalizeMailingAddress({ address1: '1 St.', city: 'X', zip: '1', country: 'US' })).not.toBeNull();
  });
  it('province aliases state for international', () => {
    const out = canonicalizeMailingAddress({
      address1: '1 King St',
      city: 'Toronto',
      province: 'Ontario',
      postal_code: 'M5H 1A1',
      country: 'CA',
    });
    expect(out!.state).toBe('ontario');
    expect(out!.zip).toBe('M5H 1A1');
    expect(out!.country).toBe('CA');
  });
  it('uppercases ISO country code from full names', () => {
    const out = canonicalizeMailingAddress({
      address1: '1 King St',
      city: 'Toronto',
      state: 'ON',
      zip: 'M5H 1A1',
      country: 'Canada',
    });
    expect(out!.country).toBe('CA');
  });
});

describe('D-138 P1 — blocking-key derivers (Reviewer #6)', () => {
  it('deriveNameKey collapses case + nickname-canonicalizes first token', () => {
    expect(deriveNameKey('Bob Smith')).toBe('robert smith');
    expect(deriveNameKey('Robert Smith')).toBe('robert smith');
    expect(deriveNameKey('LIZ MORRIS')).toBe('elizabeth morris');
  });
  it('deriveNameKey returns null for single-token names', () => {
    expect(deriveNameKey('Madonna')).toBeNull();
  });
  it('deriveAddressZipCountryKey produces zip|country', () => {
    expect(
      deriveAddressZipCountryKey({
        address1: '1 main',
        city: 'x',
        state: 'IL',
        zip: '62701',
        country: 'US',
      }),
    ).toBe('62701|US');
    expect(deriveAddressZipCountryKey(null)).toBeNull();
  });
  it('deriveCompanyNorm strips suffixes + lowercases', () => {
    expect(deriveCompanyNorm('Acme Inc.')).toBe('acme');
    expect(deriveCompanyNorm('Acme LLC')).toBe('acme');
    expect(deriveCompanyNorm('Acme Co.')).toBe('acme');
    expect(deriveCompanyNorm('Acme Limited')).toBe('acme');
    expect(deriveCompanyNorm('  Acme   Industries ')).toBe('acme industries');
  });
  it('deriveCompanyNorm returns null for empty', () => {
    expect(deriveCompanyNorm(null)).toBeNull();
    expect(deriveCompanyNorm(undefined)).toBeNull();
  });
});

describe('D-138 P1 — resolveContactIdentity (Reviewer #2)', () => {
  it('returns canonical email + chain_depth=0 when row has no merged_into', () => {
    const lookup = (e: string) => ({ merged_into: undefined as string | undefined });
    const result = resolveContactIdentity('bob@x.com', lookup);
    expect(result).toEqual({ canonical_email: 'bob@x.com', chain_depth: 0 });
  });

  it('walks merged_into chain to terminal canonical', () => {
    const graph = new Map<string, { merged_into?: string }>([
      ['a@x.com', { merged_into: 'b@x.com' }],
      ['b@x.com', { merged_into: 'c@x.com' }],
      ['c@x.com', {}],
    ]);
    const lookup = (e: string) => graph.get(e) ?? null;
    expect(resolveContactIdentity('a@x.com', lookup)).toEqual({
      canonical_email: 'c@x.com',
      chain_depth: 2,
    });
  });

  it('throws on cycle', () => {
    const graph = new Map<string, { merged_into?: string }>([
      ['a@x.com', { merged_into: 'b@x.com' }],
      ['b@x.com', { merged_into: 'a@x.com' }],
    ]);
    const lookup = (e: string) => graph.get(e) ?? null;
    expect(() => resolveContactIdentity('a@x.com', lookup)).toThrow(/cycle/);
  });

  it('throws on chain length exceeded', () => {
    const graph = new Map<string, { merged_into?: string }>();
    for (let i = 0; i < CONTACT_REDIRECT_CHAIN_LIMIT + 5; i++) {
      graph.set(`a${i}@x.com`, { merged_into: `a${i + 1}@x.com` });
    }
    const lookup = (e: string) => graph.get(e) ?? null;
    expect(() => resolveContactIdentity('a0@x.com', lookup)).toThrow(/exceeded/);
  });

  it('throws on invalid input email', () => {
    expect(() => resolveContactIdentity('not-an-email', () => null)).toThrow(/invalid_email/);
  });
});

describe('D-138 P1 — pair-key + rejection helpers', () => {
  it('canonicalPairKey orders lexicographically', () => {
    expect(canonicalPairKey('a@x.com', 'b@x.com')).toBe('a@x.com|b@x.com');
    expect(canonicalPairKey('b@x.com', 'a@x.com')).toBe('a@x.com|b@x.com');
  });
  it('isPairRejected against pre-computed Set', () => {
    const set = new Set<string>(['a@x.com|b@x.com']);
    expect(isPairRejected('a@x.com', 'b@x.com', set)).toBe(true);
    expect(isPairRejected('b@x.com', 'a@x.com', set)).toBe(true);
    expect(isPairRejected('a@x.com', 'c@x.com', set)).toBe(false);
  });
});

describe('D-138 P1 — Levenshtein bound', () => {
  it('returns 0 on equality, ≤2 on close strings, >2 on distant', () => {
    expect(levenshtein('bob', 'bob')).toBe(0);
    expect(levenshtein('bob', 'bib')).toBe(1);
    expect(levenshtein('bob', 'rob')).toBe(1);
    expect(levenshtein('bob', 'robert')).toBeGreaterThan(2);
  });
  it('short-circuits when length difference > 3', () => {
    expect(levenshtein('a', 'abcdefghij')).toBeGreaterThan(3);
  });
});

describe('D-138 P1 — MCP catalog ratchet (Reviewer #12)', () => {
  it('contact.merge.* never appears in MCP_TOOL_CATALOG', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      expect(tool.startsWith('contact.merge.')).toBe(false);
    }
  });
  it('housekeeping.* never appears in MCP_TOOL_CATALOG', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      expect(tool.startsWith('housekeeping.')).toBe(false);
    }
  });
  it('isReservedLocalRpc flags every contact.merge.* method', () => {
    for (const m of CONTACT_MERGE_RPC_METHODS) {
      expect(isReservedLocalRpc(m)).toBe(true);
    }
  });
  it('isReservedLocalRpc returns false for normal MCP tool names', () => {
    expect(isReservedLocalRpc('recued_runRecipe')).toBe(false);
    expect(isReservedLocalRpc('recued_dataTimeline')).toBe(false);
  });
  it('isMcpToolName recognizes static + dynamic tools', () => {
    expect(isMcpToolName('recued_listRecipes')).toBe(true);
    expect(isMcpToolName('recued_ingredient_deal-reader-hubspot')).toBe(true);
    expect(isMcpToolName('contact.merge.list')).toBe(false);
  });
  it('MCP_RESERVED_RPC_PREFIXES includes contact.merge. + housekeeping. + upstream_merge. + D-145 PA8 alias / identity surfaces + D-148 W3.FU exposure. + D-148 FU4 tls_domain. + D-148 A.6.5 tls. + D-148 A.11 key. + D-148 A.5.3/A.6.5 pro. + D-148 A.6.5/A.9 passport. + D-137 P5 follow-on chat.inbound_token. + D-149 P3 reception. + D-148 A.2.1/A.6.5 pair. + D-163 Slice C notifications. + D-145 PA10 follow-on packs. + D-221 Records.', () => {
    // D-138 P5 widens the prefix list with `upstream_merge.` so the
    // outbox rpcs stay local-UI only. D-145 PA8 § A.4.4 widens it
    // again with `contact.alias.` + `contact.identity.` so the per-pair
    // private-vocabulary alias substrate stays out of MCP responses
    // to external AI clients. D-148 W3.FU adds `exposure.` so the
    // operator-only path-routing toggle grid stays out of the MCP
    // surface. D-148 follow-up #4 adds `tls_domain.` so external AI
    // agents cannot upload / replace / remove the server's TLS cert
    // (channel-isolation invariant). D-148 follow-up #5 adds
    // `pro_acme.` so the Pro DDNS unbind flow stays operator-only —
    // releasing a Pro handle reshapes every paired client's pin.
    // D-137 P5 follow-on adds `chat.inbound_token.` so external MCP
    // agents can never issue / edit-grants / revoke / delete tokens
    // that gate the MCP surface itself (would let a peer mint itself
    // a fresh max-grants credential, widen another peer's grants,
    // etc.). D-149 P3 adds `reception.` so external AI agents cannot
    // create / enable / revoke / rotate reception endpoints — the
    // public-facing reception surface exposes user data to anonymous
    // visitors; an MCP-channel mutation would be catastrophic.
    // D-148 § A.4.4 adds `token.` so external AI agents cannot drive
    // bearer rotation — a compromised agent could otherwise forcibly
    // invalidate every paired client's session in a loop.
    // D-148 § A.6.5 adds `tls.` (distinct from `tls_domain.`) so
    // external AI agents cannot trigger TLS cert rotation — a
    // compromised agent could force-rotate the cert, briefly breaking
    // every pinned client's verify step + flooding the audit log.
    // D-148 § A.5.3 / § A.6.5 adds `pro.` so external AI agents cannot
    // mutate the Pro subscription bearer slot — a compromised agent
    // could otherwise stop renewals via `pro.signOut` or swap in an
    // attacker-controlled bearer via `pro.authenticate`. `pro.current`
    // is reserved as well because even the safe-display fragment
    // leaks the existence of an authenticated subscription.
    // D-148 § A.6.5 + § A.9 adds `passport.` so external AI agents
    // cannot fetch the passport projection. The `passport.fetch` rpc
    // deliberately skips the `passport.exported` high-assurance audit
    // row (every WS reconnect would otherwise flood the ledger); that
    // exemption is safe ONLY behind the reserved-prefix gate. If
    // `passport.` ever leaks onto the MCP surface, a compromised agent
    // could enumerate the verify substrate at high cadence to exfil
    // identity fingerprints + LAN claims through the ledger-free path.
    // Channel-isolation invariant.
    // D-148 § A.2.1 / D-156 P10 keeps `pair.` reserved so external
    // AI agents cannot participate in the pair credential ceremony.
    // `pair.registerRecoveryKey` binds the realm to a 24-word
    // mnemonic; `pair.list` + `pair.revoke` enumerate / destroy
    // paired devices. A compromised agent could loop-revoke every
    // paired client or overwrite the recovery-key sentinel on a
    // fresh-realm server. Channel-isolation invariant.
    // D-163 Slice C adds `notifications.` so external AI agents cannot
    // mutate the per-pair Settings → Notifications surface. A
    // compromised agent could otherwise disable every approval-bearing
    // channel (silent-strand every `ask`), enable a togglable channel
    // backed by an attacker-controlled credential to redirect fan-out,
    // or overwrite the anti-phishing verification phrase on the email
    // ask landing page (the user's lone tell that the page is
    // genuine). Channel-isolation invariant.
    // D-145 PA10 follow-on adds `packs.` so external AI agents cannot
    // drive `packs.install`. A pack install transaction commits recipes
    // + body-content MCP grants in one atomic step; a compromised agent
    // calling the rpc could (a) land body-content MCP grants the user
    // never approved, or (b) upsert arbitrary recipes into the per-pair
    // store. Settings
    // → Packs is the sole writer. Channel-isolation invariant.
    // D-169 P0 adds `bridge.` so external AI agents cannot drive
    // `bridge.capabilityProfile.push`. A compromised agent could
    // otherwise shadow another bridge's `granted_origins` (redirecting
    // multi-bridge dispatches to itself) or zero every bridge's profile
    // in a loop, denying service to the eligibility filter.
    // Channel-isolation invariant.
    // D-169 P1 added `'system.'` for the new `system.status` rpc
    // (channel-isolation — `paired_client_count` discloses
    // device-fleet topology); the parallel ratchet update in this
    // test was missed at landing time + caught by the D-169 P1.5
    // regression sweep.
    // D-166 added `'collection.connection.'` (operation-group grant /
    // enroll surface) + `'collection.contract.'` (the `contract.override.*`
    // authoring family AND, with the contract_id lifecycle slice, the
    // `mintContract` / `revokeContract` / `listContracts` Settings → Privacy →
    // Contracts methods). An MCP-channel agent must never mint itself a
    // contract, author/remove its own policy override, nor enumerate the
    // user's posture. D-211 adds `'collection.operation.'` for the global
    // owner-authored risk / approval replacement on a pack operation. An MCP
    // caller is governed by that replacement but may never author or enumerate
    // it. Channel-isolation invariant.
    // D-221 adds `records.` because namespace browsing, raw row access, exports,
    // retention/quota policy, purge, and accounting repair are owner control
    // plane operations. External agents may reach business operations only
    // through installed, grant-gated receiving recipes.
    expect([...MCP_RESERVED_RPC_PREFIXES].sort()).toEqual([
      // D-175 P5 — account ↔ server binding (operator / local-UI only).
      'account.',
      // Reactive-substrate slice 1 — automation rules (schedules /
      // event-triggers / auto-run arm-disarm) are owner-surface
      // autonomous-execution policy.
      'auto_run.',
      'bridge.',
      // D-214 — owner-only explicit execution feedback.
      'chat.execution.',
      'chat.inbound_token.',
      // D-182 §7.2 — cli reachability grid rpc (owner-only; authors a
      // connection-less cli tool's per-contract reachability allowlist).
      'cli.reachability.',
      'collection.connection.',
      'collection.contract.',
      'collection.hostname.',
      'collection.operation.',
      'contact.alias.',
      'contact.identity.',
      // D-205 #5 — selective CRM promotion. Deciding that a stranger belongs in your
      // PERSONAL contact graph is a judgement about who you know — the same class of
      // decision as a merge, and the exact judgement `hydrate_on_match` refuses to
      // make on your behalf. An agent may READ the graph (subject to the
      // `data.contact` collection grant); it may not decide who is IN it.
      'contact.import.',
      'contact.merge.',
      // Grant-foundation slice 3 (D-187 amendment) — the unified (contract × grant)
      // matrix CRUD (operator-only; an agent must never self-widen its grants).
      'contract.grant.',
      // D-139 P5 — the `data.contact.engagements.list` WS-rpc returns the
      // FULL engagement-row shape (body included) for the owner's own paired
      // clients; external agents reach engagement evidence only through the
      // body-stripped `recued_contactEngagementsList` tool.
      'data.contact.engagements.',
      // R27 delta-B — user-initiated DDNS pause/resume (`ddns.setEnabled` /
      // `ddns.status`) is owner-only local-UI; an external agent must never take
      // a user's DDNS publication offline nor read the pause posture.
      'ddns.',
      // D-259 — standing-work CRUD remains owner-only; MCP gets only the
      // same-token attended-run recued_stopRecipe capability.
      'dishes.',
      // D-181 slice 4 — the `execution.*` live-control surface (owner-only;
      // kill/cancel/promote a running heavy op + the active-list reads).
      'execution.',
      'exposure.',
      // Accepted intake responses contain arbitrary visitor-authored values;
      // the full-shape read RPC is owner-local and never an MCP surface.
      'form_response.',
      'housekeeping.',
      'ingredient.',
      // R26.4 Delta 3 (D-148 § A.11) — Key Health + Rotation Center
      // (operator-only; `key.rotate` de-pairs clients / cascades
      // rotations, `key.health` leaks the key inventory + compromise
      // posture).
      'key.',
      // LAN-URL kickstart — `network.local_urls` is a local-UI reachability
      // read (the server's own bind addresses); an MCP agent has no need to
      // enumerate them.
      'network.',
      'notifications.',
      'packs.',
      'pair.',
      'passport.',
      'pii.',
      'pro.',
      'pro_acme.',
      // D-175 P8 — Pro convenience status (operator / local-UI only).
      'pro_convenience.',
      'reception.',
      // Recipe-editor authoring seam — the `recipe.*` rpc family is owner /
      // local-UI only. The read surfaces stay off MCP by catalog omission;
      // the authoring writes (`recipe.save` / `recipe.validate`) get the
      // stronger reserved-prefix gate (the Kitchen editor is the only caller;
      // agents author via the MCP `recued_saveRecipe` tool).
      'recipe.',
      // D-179 — install config edits are owner autonomous-execution policy.
      'recipe_config.',
      'records.',
      'schedules.',
      // D-196 S2 — seller cockpit read model (owner-only; exposes customer
      // roster, seller settings, readiness, and usage rollups).
      'server.seller.',
      // Supervision feature — cli-daemon keep-alive (owner-only; an MCP-channel
      // agent must never enrol / flip / start / stop a supervised daemon).
      'supervision.',
      'system.',
      'tls.',
      'tls_domain.',
      'token.',
      'triggers.',
      // D-178 — release/update rpc family (owner-only, out of MCP).
      'update.',
      // D-172 step 4 — resumable-upload rpc family (operator-only file
      // ingest). Pre-existing reservation whose ratchet entry was missed
      // at landing; added here alongside the D-148 A.11 `key.` entry.
      'upload.',
      'upstream_merge.',
      // Poll-manager / G6 — watch pause/resume + topology read are
      // owner-surface autonomous-execution policy, same class as
      // `schedules.` / `triggers.` / `auto_run.`.
      'watch.',
      // D-201 Slice 1 — ingress/credential lifecycle is owner control-plane
      // state; future webhook profile surfaces inherit this reservation.
      'webhook.',
    ]);
  });
});
