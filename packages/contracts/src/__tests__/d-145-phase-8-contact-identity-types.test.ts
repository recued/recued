/** D-145 PA8 — Contact identity types + closed-list invariants.
 *
 *  Asserts the substrate's closed-list discipline (identity_status,
 *  network_domain, contact_alias kind, alias platform, alias source)
 *  and the normalization helpers. Spec § A.4.1 + § A.4.2 + § A.4.3. */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_IDENTITY_STATUSES,
  CONTACT_IDENTITY_STATUS_SET,
  isContactIdentityStatus,
  DEFAULT_CONTACT_IDENTITY_STATUS,
  NETWORK_DOMAINS,
  NETWORK_DOMAIN_SET,
  isNetworkDomain,
  sanitizeNetworkDomains,
  CONTACT_ALIAS_KINDS,
  CONTACT_ALIAS_KIND_SET,
  isContactAliasKind,
  CONTACT_ALIAS_PLATFORMS,
  CONTACT_ALIAS_PLATFORM_SET,
  isContactAliasPlatform,
  CONTACT_ALIAS_SOURCES,
  CONTACT_ALIAS_SOURCE_SET,
  isContactAliasSource,
  normalizeAliasPattern,
  validateContactAliasInput,
  ContactIdentityValidationError,
  CONTACT_ALIAS_MCP_EXPOSURE,
  CONTACT_ALIAS_SYNC_TRANSPORTS,
  aliasIncomingOutranks,
} from '../contact-identity.js';
import {
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_CONTRIBUTION_SOURCE_SET,
} from '../contact-contribution.js';

describe('D-145 PA8 — identity_status closed list (§ A.4.1)', () => {
  it('lists exactly mention_only, partial, verified', () => {
    expect([...CONTACT_IDENTITY_STATUSES]).toEqual(['mention_only', 'partial', 'verified']);
    expect(CONTACT_IDENTITY_STATUS_SET.size).toBe(3);
  });
  it('default is verified — matches the existing-contact pre-PA8 semantics', () => {
    expect(DEFAULT_CONTACT_IDENTITY_STATUS).toBe('verified');
  });
  it('isContactIdentityStatus accepts every value in the closed list', () => {
    for (const v of CONTACT_IDENTITY_STATUSES) {
      expect(isContactIdentityStatus(v)).toBe(true);
    }
  });
  it('isContactIdentityStatus rejects unknowns + non-strings', () => {
    expect(isContactIdentityStatus('VERIFIED')).toBe(false);
    expect(isContactIdentityStatus('archived')).toBe(false);
    expect(isContactIdentityStatus(undefined)).toBe(false);
    expect(isContactIdentityStatus(123)).toBe(false);
  });
});

describe('D-145 PA8 — network_domain closed list (§ A.4.2)', () => {
  it('lists exactly family, work, social, other', () => {
    expect([...NETWORK_DOMAINS]).toEqual(['family', 'work', 'social', 'other']);
    expect(NETWORK_DOMAIN_SET.size).toBe(4);
  });
  it('isNetworkDomain accepts every value in the closed list', () => {
    for (const v of NETWORK_DOMAINS) {
      expect(isNetworkDomain(v)).toBe(true);
    }
  });
  it('isNetworkDomain rejects unknowns', () => {
    expect(isNetworkDomain('hobby')).toBe(false);
    expect(isNetworkDomain('Work')).toBe(false);
    expect(isNetworkDomain(null)).toBe(false);
  });
  it('sanitizeNetworkDomains preserves order + dedupes', () => {
    expect(sanitizeNetworkDomains(['work', 'social', 'work'])).toEqual(['work', 'social']);
  });
  it('sanitizeNetworkDomains accepts empty', () => {
    expect(sanitizeNetworkDomains([])).toEqual([]);
  });
  it('sanitizeNetworkDomains throws on unknown values — never silently drops', () => {
    expect(() => sanitizeNetworkDomains(['work', 'hobby'] as readonly string[]))
      .toThrow(ContactIdentityValidationError);
  });
});

describe('D-145 PA8 — contact_alias kind closed list (§ A.4.3)', () => {
  // Widened by D-192 C-2: `email_alias` + `phone_alias` join the identifier
  // axis (email demotes from PK to an alias; phone is matchable, not
  // descriptive). The PA8 pair still anchors the front of the list.
  it('lists chat_alias, platform_id + the two C-2 identifier kinds', () => {
    expect([...CONTACT_ALIAS_KINDS]).toEqual([
      'chat_alias',
      'platform_id',
      'email_alias',
      'phone_alias',
    ]);
    expect(CONTACT_ALIAS_KIND_SET.size).toBe(4);
  });
  it('isContactAliasKind discriminates', () => {
    expect(isContactAliasKind('chat_alias')).toBe(true);
    expect(isContactAliasKind('platform_id')).toBe(true);
    expect(isContactAliasKind('email_alias')).toBe(true);
    expect(isContactAliasKind('phone_alias')).toBe(true);
    expect(isContactAliasKind('alias')).toBe(false);
  });
});

describe('D-145 PA8 — contact_alias platform closed list (§ A.4.3)', () => {
  it('lists Facebook, X, Instagram, LinkedIn, GitHub, Substack', () => {
    expect([...CONTACT_ALIAS_PLATFORMS])
      .toEqual(['facebook', 'x', 'instagram', 'linkedin', 'github', 'substack']);
    expect(CONTACT_ALIAS_PLATFORM_SET.size).toBe(6);
  });
  it('isContactAliasPlatform accepts every value', () => {
    for (const v of CONTACT_ALIAS_PLATFORMS) {
      expect(isContactAliasPlatform(v)).toBe(true);
    }
  });
});

describe('D-192 C-2 — alias source is now the ONE contribution ladder', () => {
  // PA8's private 4-value vocabulary (user_set / chat_confirmed / tag_button /
  // ai_inferred) is retired. It could not express an alias learned by IMPORT —
  // there was no `contact_book` or `vendor_meta` rung — so a Google-imported
  // email_alias had no honest provenance to record at all.
  it('IS the contribution ladder — one vocabulary, not a private copy', () => {
    expect([...CONTACT_ALIAS_SOURCES]).toEqual([...CONTACT_CONTRIBUTION_SOURCES]);
    expect(CONTACT_ALIAS_SOURCE_SET).toBe(CONTACT_CONTRIBUTION_SOURCE_SET);
  });
  it('can finally express an IMPORTED alias — the reason for the unification', () => {
    expect(isContactAliasSource('contact_book')).toBe(true);
    expect(isContactAliasSource('vendor_meta')).toBe(true);
  });
  it('isContactAliasSource accepts every rung + rejects the retired names', () => {
    for (const v of CONTACT_ALIAS_SOURCES) {
      expect(isContactAliasSource(v)).toBe(true);
    }
    expect(isContactAliasSource('user_set')).toBe(false);
    expect(isContactAliasSource('tag_button')).toBe(false);
  });
});

describe('D-145 PA8 — normalizeAliasPattern (§ A.4.3)', () => {
  it('lowercases', () => {
    expect(normalizeAliasPattern('Mom')).toBe('mom');
    expect(normalizeAliasPattern('MOM')).toBe('mom');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeAliasPattern('  mom  ')).toBe('mom');
    expect(normalizeAliasPattern('\tmom\n')).toBe('mom');
  });
  it('collapses internal whitespace', () => {
    expect(normalizeAliasPattern('the   cheese  guy')).toBe('the cheese guy');
    expect(normalizeAliasPattern('the\tcheese\tguy')).toBe('the cheese guy');
  });
  it('Unicode NFC canonicalizes combining marks', () => {
    // "café" with composed é vs decomposed e + combining acute
    const composed = 'café';
    const decomposed = 'café';
    expect(normalizeAliasPattern(composed)).toBe(normalizeAliasPattern(decomposed));
    expect(normalizeAliasPattern(composed)).toBe('café');
  });
  it('is idempotent', () => {
    const samples = ['Mom', 'the   cheese  guy', '  CAFÉ  ', 'María José'];
    for (const s of samples) {
      const once = normalizeAliasPattern(s);
      expect(normalizeAliasPattern(once)).toBe(once);
    }
  });
  it('returns empty for non-string + empty input', () => {
    expect(normalizeAliasPattern('')).toBe('');
    expect(normalizeAliasPattern('   ')).toBe('');
    expect(normalizeAliasPattern(undefined as unknown as string)).toBe('');
    expect(normalizeAliasPattern(null as unknown as string)).toBe('');
  });
});

describe('D-145 PA8 — validateContactAliasInput (§ A.4.3)', () => {
  it('accepts a valid chat_alias input', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'manual',
      }),
    ).not.toThrow();
  });
  it('accepts a valid platform_id input', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'platform_id',
        platform: 'facebook',
        alias_pattern: 'bob.smith.42',
        source: 'user_confirmed',
      }),
    ).not.toThrow();
  });
  it('rejects missing contact_id', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: '',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'manual',
      }),
    ).toThrowError(/contact_id_required/);
  });
  it('rejects unknown kind', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'alias' as unknown as 'chat_alias',
        alias_pattern: 'mom',
        source: 'manual',
      }),
    ).toThrowError(/kind_unknown/);
  });
  it('platform_id without platform is rejected', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'platform_id',
        alias_pattern: 'bob.smith',
        source: 'manual',
      }),
    ).toThrowError(/platform_required_for_platform_id/);
  });
  it('chat_alias with platform is rejected (partial-index invariant)', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        platform: 'facebook',
        alias_pattern: 'mom',
        source: 'manual',
      }),
    ).toThrowError(/platform_forbidden_for_kind/);
  });
  it('rejects empty + whitespace-only alias_pattern post-normalize', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: '   ',
        source: 'manual',
      }),
    ).toThrowError(/alias_pattern_empty/);
  });
  it('rejects unknown source', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'whisper' as unknown as 'manual',
      }),
    ).toThrowError(/source_unknown/);
  });
  it('manual with confidence < 1 is rejected — a hand-typed alias is certain', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'manual',
        confidence: 0.7,
      }),
    ).toThrowError(/manual_confidence_must_be_one/);
  });
  it('confidence out of [0, 1] is rejected', () => {
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'ai_inferred',
        confidence: 1.5,
      }),
    ).toThrowError(/confidence_out_of_range/);
    expect(() =>
      validateContactAliasInput({
        contact_id: 'c1',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'ai_inferred',
        confidence: -0.1,
      }),
    ).toThrowError(/confidence_out_of_range/);
  });

  // RETIRED (D-192 C-2): "a non-user source may not claim confidence 1.0".
  //
  // That rule was a guard for a world where rank and confidence COMPETED — a
  // very confident weak writer might have out-argued the user. Under the C-2a
  // ladder they no longer compete: `aliasIncomingOutranks` settles the RUNG
  // first and consults confidence only WITHIN a rung. The invariant is now
  // structural, so the rule was not merely redundant but harmful — every
  // imported alias would have had to fake a sub-1.0 confidence to pass
  // validation, punishing sources that are genuinely certain about an address
  // they are the system of record for.
  //
  // The invariant it protected is covered — with a STRONGER claim — directly
  // below: a maximally-confident `ai_inferred` still loses to a barely-confident
  // `manual`.
  it('an imported source MAY be certain — 1.0 confidence is no longer rejected', () => {
    for (const src of ['vendor_meta', 'contact_book', 'ai_inferred'] as const) {
      expect(() =>
        validateContactAliasInput({
          contact_id: 'c1',
          kind: 'chat_alias',
          alias_pattern: 'mom',
          source: src,
          confidence: 1.0,
        }),
      ).not.toThrow();
    }
  });
});

describe('D-192 C-2 — alias outrank rides the ONE ladder', () => {
  it('the LADDER dominates confidence — a certain guess never beats an unsure human', () => {
    // The structural guarantee that replaced the retired confidence rule. Note
    // the direction: the C-2a ladder counts DOWN (rank 0 = strongest), the
    // inverse of PA8's private rank map. An inverted comparison would not crash
    // — it would silently let the WEAKEST writer win every conflict.
    expect(aliasIncomingOutranks(
      { source: 'ai_inferred', confidence: 1.0 },
      { source: 'manual', confidence: 0.1 },
    )).toBe(false);
    expect(aliasIncomingOutranks(
      { source: 'manual', confidence: 0.1 },
      { source: 'ai_inferred', confidence: 1.0 },
    )).toBe(true);
  });
  it('ranks the imported rungs between the user and the model', () => {
    // vendor_meta (a curated CRM) beats contact_book (which rots), and both beat
    // a model's guess — but neither beats the user.
    expect(aliasIncomingOutranks(
      { source: 'vendor_meta', confidence: 0.5 },
      { source: 'contact_book', confidence: 0.9 },
    )).toBe(true);
    expect(aliasIncomingOutranks(
      { source: 'contact_book', confidence: 0.5 },
      { source: 'ai_inferred', confidence: 0.9 },
    )).toBe(true);
    expect(aliasIncomingOutranks(
      { source: 'vendor_meta', confidence: 1.0 },
      { source: 'manual', confidence: 1.0 },
    )).toBe(false);
  });
  it('aliasIncomingOutranks: higher-rank source wins', () => {
    expect(aliasIncomingOutranks(
      { source: 'manual', confidence: 1.0 },
      { source: 'ai_inferred', confidence: 0.9 },
    )).toBe(true);
    expect(aliasIncomingOutranks(
      { source: 'ai_inferred', confidence: 0.9 },
      { source: 'manual', confidence: 1.0 },
    )).toBe(false);
  });
  it('aliasIncomingOutranks: same source, higher confidence wins', () => {
    expect(aliasIncomingOutranks(
      { source: 'ai_inferred', confidence: 0.9 },
      { source: 'ai_inferred', confidence: 0.7 },
    )).toBe(true);
    expect(aliasIncomingOutranks(
      { source: 'ai_inferred', confidence: 0.5 },
      { source: 'ai_inferred', confidence: 0.7 },
    )).toBe(false);
  });
  it('aliasIncomingOutranks: same source + same confidence does NOT outrank (no thrash)', () => {
    expect(aliasIncomingOutranks(
      { source: 'manual', confidence: 1.0 },
      { source: 'manual', confidence: 1.0 },
    )).toBe(false);
  });
});

describe('D-145 PA8 — privacy invariants (§ A.4.4)', () => {
  it('CONTACT_ALIAS_MCP_EXPOSURE === "never"', () => {
    expect(CONTACT_ALIAS_MCP_EXPOSURE).toBe('never');
  });
  it('CONTACT_ALIAS_SYNC_TRANSPORTS is empty (per-pair only, no cloud)', () => {
    expect(CONTACT_ALIAS_SYNC_TRANSPORTS).toEqual([]);
  });
});
