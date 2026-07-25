/** D-192 C-2 (Stance 2) — the contact contribution-projection substrate.
 *
 *  Covers the C-2a source-priority ladder + the projection resolver. These are
 *  the ONE place "which value wins" is decided, so the tests pin the full
 *  tiebreak chain (ladder → recency → confidence) and — most importantly — the
 *  RUNTIME FLOOR for an undeclared source. That floor is not defensive
 *  boilerplate: this arc's own scar is that a widened union degrades
 *  `Record<Union, …>` into `Record<string, …>`, whose miss returns `undefined`,
 *  and `undefined` in a numeric comparison POISONS a sort rather than losing it.
 *
 *  Spec: D-192; decisions-log § D-192 C-2. */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_ATTRIBUTE_KINDS,
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_CONTRIBUTION_SOURCE_PRIORITY,
  contactContributionRank,
  isContactAttributeKind,
  isContactContributionSource,
  resolveContribution,
  resolveContributionsByKind,
  type ContactContribution,
} from '../contact-contribution.js';
import { CONTACT_ALIAS_KINDS } from '../contact-identity.js';

/** Terse contribution factory — every field explicit at the call site matters,
 *  so defaults are deliberately neutral (equal `as_of` + equal `confidence`)
 *  and each test perturbs exactly the one axis it is pinning. */
const c = (
  source: string,
  over: Partial<ContactContribution<string>> = {},
): ContactContribution<string> => ({
  kind: 'org',
  value: `v:${source}`,
  source,
  confidence: 0.5,
  as_of: 1_000,
  ...over,
});

describe('D-192 C-2a — the source-priority ladder', () => {
  it('enumerates the ladder strongest-first', () => {
    expect([...CONTACT_CONTRIBUTION_SOURCES]).toEqual([
      'manual',
      'user_confirmed',
      'vendor_meta',
      'contact_book',
      'derived',
      'ai_inferred',
      'domain_inferred',
    ]);
  });

  it('derives ranks from the array so the two can never drift', () => {
    CONTACT_CONTRIBUTION_SOURCES.forEach((source, i) => {
      expect(CONTACT_CONTRIBUTION_SOURCE_PRIORITY[source]).toBe(i);
    });
  });

  it('ranks manual strongest and domain_inferred weakest', () => {
    expect(contactContributionRank('manual')).toBeLessThan(
      contactContributionRank('vendor_meta'),
    );
    // contact_book sits BELOW crm on purpose — address books rot, CRMs are
    // curated (by a human; just not this one).
    expect(contactContributionRank('vendor_meta')).toBeLessThan(
      contactContributionRank('contact_book'),
    );
    expect(contactContributionRank('domain_inferred')).toBeGreaterThan(
      contactContributionRank('ai_inferred'),
    );
  });

  it('discriminates declared sources', () => {
    expect(isContactContributionSource('vendor_meta')).toBe(true);
    expect(isContactContributionSource('legacy')).toBe(false);
    expect(isContactContributionSource(null)).toBe(false);
  });

  // ── The runtime floor ──────────────────────────────────────────
  it('ranks an UNDECLARED source last — never undefined', () => {
    const rank = contactContributionRank('some_future_vendor_source');
    expect(Number.isFinite(rank)).toBe(true);
    for (const known of CONTACT_CONTRIBUTION_SOURCES) {
      expect(rank).toBeGreaterThan(contactContributionRank(known));
    }
  });

  it('an undeclared source LOSES to every declared one (fail closed)', () => {
    // The failure this pins: if the rank lookup returned `undefined`, every
    // `<` / `>` against it would be false and the winner would be decided by
    // scan order — i.e. silently by SQLite row order.
    const winner = resolveContribution([
      c('wat_is_this', { value: 'unknown' }),
      c('domain_inferred', { value: 'weakest_known' }),
    ]);
    expect(winner?.value).toBe('weakest_known');
  });

  it('still picks a winner when EVERY source is undeclared', () => {
    const winner = resolveContribution([
      c('mystery_a', { as_of: 1 }),
      c('mystery_b', { as_of: 2 }),
    ]);
    // Equal (floored) rank ⇒ falls through to recency.
    expect(winner?.source).toBe('mystery_b');
  });
});

describe('D-192 C-2a — resolveContribution tiebreak chain', () => {
  it('returns null for no contributions (absent ≠ empty)', () => {
    expect(resolveContribution([])).toBeNull();
  });

  it('1. ladder beats everything — even a fresher, more confident rival', () => {
    const winner = resolveContribution([
      c('vendor_meta', { as_of: 9_999, confidence: 1.0, value: 'crm' }),
      c('manual', { as_of: 1, confidence: 0.1, value: 'typed_by_hand' }),
    ]);
    // This is the whole point of C-2b's provenance-preserving backfill: a CRM
    // import must NEVER overwrite what the user typed, however stale or unsure.
    expect(winner?.value).toBe('typed_by_hand');
  });

  it('2. within a rung, recency wins', () => {
    const winner = resolveContribution([
      c('vendor_meta', { as_of: 100, confidence: 1.0, value: 'old' }),
      c('vendor_meta', { as_of: 200, confidence: 0.2, value: 'fresh' }),
    ]);
    expect(winner?.value).toBe('fresh');
  });

  it('3. same rung + same recency ⇒ confidence wins', () => {
    const winner = resolveContribution([
      c('contact_book', { as_of: 100, confidence: 0.3, value: 'unsure' }),
      c('contact_book', { as_of: 100, confidence: 0.9, value: 'sure' }),
    ]);
    expect(winner?.value).toBe('sure');
  });

  it('is deterministic on a total tie — first seen holds', () => {
    // A projection that flickered between two equally-ranked values would be
    // worse than a wrong one: it would be unreproducible.
    const a = c('manual', { value: 'a' });
    const b = c('manual', { value: 'b' });
    expect(resolveContribution([a, b])?.value).toBe('a');
    expect(resolveContribution([b, a])?.value).toBe('b');
  });

  it('is order-independent for a genuine winner', () => {
    const rows = [
      c('ai_inferred', { value: 'guess' }),
      c('manual', { value: 'truth' }),
      c('vendor_meta', { value: 'crm' }),
    ];
    expect(resolveContribution(rows)?.value).toBe('truth');
    expect(resolveContribution([...rows].reverse())?.value).toBe('truth');
  });
});

describe('D-192 C-2a — resolveContributionsByKind (the projection)', () => {
  it('resolves each field INDEPENDENTLY — never row-level last-writer-wins', () => {
    const projected = resolveContributionsByKind([
      c('manual', { kind: 'org', value: 'Acme (typed)' }),
      c('vendor_meta', { kind: 'org', value: 'Acme Corp (crm)' }),
      c('vendor_meta', { kind: 'title', value: 'VP Sales' }),
    ]);

    // The contact keeps a hand-typed org AND a CRM-sourced title at once —
    // each field independently takes its strongest assertion.
    expect(projected.get('org')?.value).toBe('Acme (typed)');
    expect(projected.get('title')?.value).toBe('VP Sales');
    expect(projected.size).toBe(2);
  });

  it('omits a kind with no contributions', () => {
    const projected = resolveContributionsByKind([c('manual', { kind: 'org' })]);
    expect(projected.has('photo')).toBe(false);
  });

  it('carries provenance through, so the row can render WHERE a value came from', () => {
    const projected = resolveContributionsByKind([
      c('contact_book', { kind: 'title', value: 'Engineer' }),
    ]);
    expect(projected.get('title')?.source).toBe('contact_book');
  });
});

describe('D-192 C-2 — the kind vocabularies (identifier ÷ attribute split)', () => {
  it('attributes are descriptive facts — phone is NOT among them', () => {
    expect([...CONTACT_ATTRIBUTE_KINDS]).toEqual([
      'name',
      'org',
      'title',
      'address',
      'photo',
      'birthday',
    ]);
    // A phone number is something you MATCH a person by (D-138 predicate +
    // contact_phone_forms), so it belongs to the identifier axis. Storing it in
    // both would split-brain the projection.
    expect(isContactAttributeKind('phone')).toBe(false);
  });

  it('identifiers carry the two C-2 additions — email demotes to an alias here', () => {
    expect([...CONTACT_ALIAS_KINDS]).toEqual([
      'chat_alias',
      'platform_id',
      'email_alias',
      'phone_alias',
    ]);
  });

  it('title + photo — the universal gap the attribute store closes', () => {
    expect(isContactAttributeKind('title')).toBe(true);
    expect(isContactAttributeKind('photo')).toBe(true);
  });
});
