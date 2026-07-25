/** D-177 read-gating analog — readable-collection vocabulary + the door-config
 *  authoring inverse (`scopeRestrictionsFromReadableCollections`). The forward
 *  scope→readable-set derivation retired in slice 6 (re-homed to grant rows). */

import { describe, expect, it } from 'vitest';
import {
  READABLE_COLLECTIONS,
  SCOPE_FENCE_KEEP_PATTERNS,
  isReadableCollection,
  scopeRestrictionsFromReadableCollections,
  type ReadableCollection,
} from '../read-collection-grant.js';
import { evaluateScopeRestrictions, matchScopePattern } from '../policy-enforcement.js';

describe('D-177 read fence — vocabulary', () => {
  it('is the closed user-data collection set (no infra/sidecar)', () => {
    // Root incoming webhook + accepted form-response resources are in the set;
    // `service` / `shared` / `annotation` / `link` / `memory` stay excluded.
    expect([...READABLE_COLLECTIONS].sort()).toEqual(
      [
        'booking',
        'calendar',
        'commitment',
        'contact',
        'file',
        'form_response',
        'mail',
        'note',
        'project',
        'task',
        'webhook',
      ],
    );
    // Infra / sidecar collections are NOT governed by this fence.
    for (const infra of ['service', 'shared', 'annotation', 'link', 'memory']) {
      expect(isReadableCollection(infra)).toBe(false);
    }
  });
});

describe('Lane A step 2 — scopeRestrictionsFromReadableCollections (the authoring inverse)', () => {
  const all = new Set<ReadableCollection>(READABLE_COLLECTIONS);

  it('ALL governed collections ⇒ [] (read-all baseline; the UI deletes the cell)', () => {
    expect(scopeRestrictionsFromReadableCollections(all)).toEqual([]);
  });

  it('a proper subset ⇒ keep-patterns + one data.<c>.* per allowed collection', () => {
    const allowed = new Set<ReadableCollection>(['mail', 'calendar']);
    const restrictions = scopeRestrictionsFromReadableCollections(allowed);
    expect(restrictions).toEqual([
      ...SCOPE_FENCE_KEEP_PATTERNS,
      'data.mail.*',
      'data.calendar.*',
    ]);
  });

  it('produces a fence that admits EXACTLY the allowed governed collections at the execute gate', () => {
    // The production consumer (`resolveContractScopeRestrictions`) feeds this array to
    // `evaluateScopeRestrictions`; assert the round-trip THERE (granted set → restrictions
    // → per-collection verdict) rather than through the retired forward derivation. Every
    // singleton + a few mixed subsets + empty (fences all) + full (⇒ [] ⇒ admit-all).
    const subsets: ReadableCollection[][] = [
      [],
      ...READABLE_COLLECTIONS.map((c) => [c]),
      ['mail', 'contact', 'project'],
      [...READABLE_COLLECTIONS],
      [...READABLE_COLLECTIONS].slice(0, 7),
    ];
    for (const subset of subsets) {
      const allowed = new Set<ReadableCollection>(subset);
      const restrictions = scopeRestrictionsFromReadableCollections(allowed);
      for (const c of READABLE_COLLECTIONS) {
        const verdict = evaluateScopeRestrictions(restrictions, `data.${c}`).verdict;
        expect(verdict).toBe(allowed.has(c) ? 'admit' : 'deny');
      }
    }
  });

  it('keep-patterns admit the non-governed scope families at the execute gate', () => {
    const restrictions = scopeRestrictionsFromReadableCollections(
      new Set<ReadableCollection>(['mail']),
    );
    // Non-governed families stay admitted (their own gates decide)…
    expect(evaluateScopeRestrictions(restrictions, 'connection.api').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(restrictions, 'data.enrichment').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(restrictions, 'data.shared').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(restrictions, 'data.memory').verdict).toBe('admit');
    // …the allowed collection is admitted, a blocked one is denied…
    expect(evaluateScopeRestrictions(restrictions, 'data.mail').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(restrictions, 'data.contact').verdict).toBe('deny');
    // …and the timeline fallback scope fails CLOSED (deliberately no keep-pattern).
    expect(evaluateScopeRestrictions(restrictions, 'data.timeline').verdict).toBe('deny');
  });

  it('no keep-pattern matches any governed data.<collection> path', () => {
    for (const pattern of SCOPE_FENCE_KEEP_PATTERNS) {
      for (const c of READABLE_COLLECTIONS) {
        expect(matchScopePattern(pattern, `data.${c}`)).toBe(false);
      }
    }
  });
});
