/** D-145 PA8 — `resolveContactReference` primitive (§ A.4.5).
 *
 *  Covers:
 *    - exact-match chat_alias resolution (single high-confidence)
 *    - exact-match platform_id resolution
 *    - ambiguous chat_alias → alternatives surfaced (no auto-pick)
 *    - network_domain_hint disambiguation
 *    - recent_contacts disambiguation
 *    - empty / unknown reference handling
 *    - normalize-then-match invariant (case + Unicode + whitespace)
 *
 *  The primitive is pure — closures stand in for the storage lookups so
 *  these tests don't touch SQLite. */

import { describe, expect, it } from 'vitest';

import {
  resolveContactReference,
  type ContactAliasRecord,
  type ContactAliasPlatform,
  type ContactReferenceContext,
  type ContactReferenceLookups,
  type NetworkDomain,
} from '../contact-identity.js';

const makeAlias = (
  contact_id: string,
  pattern: string,
  overrides: Partial<ContactAliasRecord> = {},
): ContactAliasRecord => {
  const normalized = pattern.toLowerCase().trim().replace(/\s+/g, ' ');
  return {
    id: `alias_${contact_id}_${normalized}`,
    contact_id,
    kind: overrides.kind ?? 'chat_alias',
    alias_pattern: pattern,
    alias_pattern_normalized: normalized,
    source: overrides.source ?? 'manual',
    confidence: overrides.confidence ?? 1.0,
    created_at: overrides.created_at ?? 1_700_000_000_000,
    ...(overrides.platform !== undefined ? { platform: overrides.platform } : {}),
    ...(overrides.last_resolved_at !== undefined
      ? { last_resolved_at: overrides.last_resolved_at }
      : {}),
  };
};

const makeLookups = (opts: {
  chatRows?: ContactAliasRecord[];
  platformRows?: ContactAliasRecord[];
  domains?: Record<string, NetworkDomain[]>;
}): ContactReferenceLookups => {
  const chatRows = opts.chatRows ?? [];
  const platformRows = opts.platformRows ?? [];
  const domains = opts.domains ?? {};
  return {
    chat_aliases_by_normalized: (n) =>
      chatRows.filter((r) => r.kind === 'chat_alias' && r.alias_pattern_normalized === n),
    platform_alias_by_key: (platform, n) =>
      platformRows.find(
        (r) =>
          r.kind === 'platform_id' &&
          r.platform === platform &&
          r.alias_pattern_normalized === n,
      ) ?? null,
    network_domains_for: (cid) => domains[cid] ?? [],
  };
};

const EMPTY_CTX: ContactReferenceContext = { recent_contacts: [] };

describe('D-145 PA8 — resolveContactReference / chat_alias single match', () => {
  it('returns the matched contact_id with the alias confidence', () => {
    const lookups = makeLookups({
      chatRows: [makeAlias('mary', 'mom', { confidence: 1.0 })],
    });
    const out = resolveContactReference('mom', EMPTY_CTX, lookups);
    expect(out).toEqual({ contact_id: 'mary', confidence: 1.0, alternatives: [] });
  });

  it('normalizes the reference before lookup (case-insensitive)', () => {
    const lookups = makeLookups({
      chatRows: [makeAlias('mary', 'mom')],
    });
    expect(resolveContactReference('MOM', EMPTY_CTX, lookups).contact_id).toBe('mary');
    expect(resolveContactReference('  Mom  ', EMPTY_CTX, lookups).contact_id).toBe('mary');
    expect(resolveContactReference('Mom\t', EMPTY_CTX, lookups).contact_id).toBe('mary');
  });

  it('handles internal-whitespace collapse (the cheese guy)', () => {
    const lookups = makeLookups({
      chatRows: [makeAlias('cheese', 'the cheese guy')],
    });
    expect(resolveContactReference('the   Cheese  Guy', EMPTY_CTX, lookups).contact_id)
      .toBe('cheese');
  });

  it('Unicode NFC normalizes combining marks (María)', () => {
    const lookups = makeLookups({
      chatRows: [makeAlias('maria', 'maría')],
    });
    // Decomposed: "i" + combining tilde would be wrong char; using ñ-ish via NFD
    const decomposed = 'María'.normalize('NFD');
    expect(resolveContactReference(decomposed, EMPTY_CTX, lookups).contact_id).toBe('maria');
  });

  it('returns null with empty alternatives when no match', () => {
    const lookups = makeLookups({ chatRows: [makeAlias('mary', 'mom')] });
    expect(resolveContactReference('dad', EMPTY_CTX, lookups))
      .toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });

  it('returns null on empty / whitespace reference', () => {
    const lookups = makeLookups({ chatRows: [makeAlias('mary', 'mom')] });
    expect(resolveContactReference('', EMPTY_CTX, lookups))
      .toEqual({ contact_id: null, confidence: 0, alternatives: [] });
    expect(resolveContactReference('   ', EMPTY_CTX, lookups))
      .toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });
});

describe('D-145 PA8 — resolveContactReference / chat_alias ambiguous', () => {
  it('returns alternatives sorted by confidence DESC when no context narrows', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob', 'bob', { confidence: 0.7 }),
        makeAlias('robert', 'bob', { confidence: 0.85 }),
      ],
    });
    const out = resolveContactReference('Bob', EMPTY_CTX, lookups);
    expect(out.contact_id).toBeNull();
    expect(out.alternatives).toEqual(['robert', 'bob']);
  });

  it('alternatives have stable secondary sort by contact_id', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('zeta', 'alex', { confidence: 0.5 }),
        makeAlias('alpha', 'alex', { confidence: 0.5 }),
        makeAlias('mike', 'alex', { confidence: 0.5 }),
      ],
    });
    const out = resolveContactReference('alex', EMPTY_CTX, lookups);
    expect(out.alternatives).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('network_domain_hint narrows to a single match', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob_personal', 'bob'),
        makeAlias('bob_work', 'bob'),
      ],
      domains: {
        bob_personal: ['social'],
        bob_work: ['work'],
      },
    });
    const out = resolveContactReference(
      'bob',
      { recent_contacts: [], network_domain_hint: 'work' },
      lookups,
    );
    expect(out.contact_id).toBe('bob_work');
    expect(out.alternatives).toEqual([]);
  });

  it('network_domain_hint with multiple matches still ambiguous → narrows the alternatives', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob_a', 'bob'),
        makeAlias('bob_b', 'bob'),
        makeAlias('bob_c', 'bob'),
      ],
      domains: {
        bob_a: ['work'],
        bob_b: ['work'],
        bob_c: ['social'],
      },
    });
    const out = resolveContactReference(
      'bob',
      { recent_contacts: [], network_domain_hint: 'work' },
      lookups,
    );
    expect(out.contact_id).toBeNull();
    expect(out.alternatives).toEqual(['bob_a', 'bob_b']);
  });

  it('recent_contacts narrows after network_domain_hint', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob_a', 'bob'),
        makeAlias('bob_b', 'bob'),
        makeAlias('bob_c', 'bob'),
      ],
      domains: {
        bob_a: ['work'],
        bob_b: ['work'],
        bob_c: ['social'],
      },
    });
    const out = resolveContactReference(
      'bob',
      { recent_contacts: ['bob_b'], network_domain_hint: 'work' },
      lookups,
    );
    expect(out.contact_id).toBe('bob_b');
  });

  it('recent_contacts alone narrows when no network_domain_hint', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob_a', 'bob'),
        makeAlias('bob_b', 'bob'),
      ],
    });
    const out = resolveContactReference(
      'bob',
      { recent_contacts: ['bob_b'] },
      lookups,
    );
    expect(out.contact_id).toBe('bob_b');
  });

  it('recent_contacts with multi-match keeps multiple alternatives', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob_a', 'bob', { confidence: 0.6 }),
        makeAlias('bob_b', 'bob', { confidence: 0.9 }),
        makeAlias('bob_c', 'bob'),
      ],
    });
    const out = resolveContactReference(
      'bob',
      { recent_contacts: ['bob_a', 'bob_b'] },
      lookups,
    );
    expect(out.contact_id).toBeNull();
    expect(out.alternatives).toEqual(['bob_b', 'bob_a']);
  });

  it('dedupes alias rows pointing at the same contact_id (max confidence wins)', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('mary', 'mom', { confidence: 0.7, source: 'ai_inferred' }),
        makeAlias('mary', 'mom', { confidence: 1.0, source: 'manual' }),
      ],
    });
    const out = resolveContactReference('mom', EMPTY_CTX, lookups);
    expect(out).toEqual({ contact_id: 'mary', confidence: 1.0, alternatives: [] });
  });
});

describe('D-145 PA8 — resolveContactReference / platform_id', () => {
  it('exact lookup on (platform, id) → contact_id', () => {
    const lookups = makeLookups({
      platformRows: [
        makeAlias('bob', 'bob.smith.42', {
          kind: 'platform_id',
          platform: 'facebook' as ContactAliasPlatform,
        }),
      ],
    });
    const out = resolveContactReference(
      { platform: 'facebook', id: 'bob.smith.42' },
      EMPTY_CTX,
      lookups,
    );
    expect(out).toEqual({ contact_id: 'bob', confidence: 1.0, alternatives: [] });
  });

  it('platform_id normalization is applied (lowercase + whitespace)', () => {
    const lookups = makeLookups({
      platformRows: [
        makeAlias('bob', 'bob.smith.42', {
          kind: 'platform_id',
          platform: 'facebook' as ContactAliasPlatform,
        }),
      ],
    });
    const out = resolveContactReference(
      { platform: 'facebook', id: '  Bob.Smith.42  ' },
      EMPTY_CTX,
      lookups,
    );
    expect(out.contact_id).toBe('bob');
  });

  it('no match returns null with empty alternatives', () => {
    const lookups = makeLookups({ platformRows: [] });
    const out = resolveContactReference(
      { platform: 'facebook', id: 'someone' },
      EMPTY_CTX,
      lookups,
    );
    expect(out).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });

  it('returns null on unknown platform', () => {
    const lookups = makeLookups({ platformRows: [] });
    const out = resolveContactReference(
      { platform: 'snapchat' as ContactAliasPlatform, id: 'someone' },
      EMPTY_CTX,
      lookups,
    );
    expect(out).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });

  it('returns null on empty id', () => {
    const lookups = makeLookups({});
    const out = resolveContactReference(
      { platform: 'facebook', id: '' },
      EMPTY_CTX,
      lookups,
    );
    expect(out).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });

  it('platform_id never matches a chat_alias row for the same id (kind-discriminated)', () => {
    const lookups = makeLookups({
      chatRows: [
        makeAlias('bob', 'bob.smith.42'),
      ],
      platformRows: [],
    });
    const out = resolveContactReference(
      { platform: 'facebook', id: 'bob.smith.42' },
      EMPTY_CTX,
      lookups,
    );
    expect(out).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });
});

describe('D-145 PA8 — resolveContactReference / malformed input', () => {
  it('non-object non-string reference returns null', () => {
    const lookups = makeLookups({});
    expect(
      resolveContactReference(123 as unknown as string, EMPTY_CTX, lookups),
    ).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });
  it('null reference returns null', () => {
    const lookups = makeLookups({});
    expect(
      resolveContactReference(null as unknown as string, EMPTY_CTX, lookups),
    ).toEqual({ contact_id: null, confidence: 0, alternatives: [] });
  });
});
