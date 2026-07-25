/** D-161 Part B (P3) — timeline / Memory actor-lane contracts.
 *
 *  Covers the pure lane primitives in `timeline-lanes.ts`:
 *    - `TIMELINE_DEFAULT_ORIGIN_ACTORS` — the foreground set + its
 *      independence from P2's input-trust default (I-8: distinct axes).
 *    - `originActorPassesTimelineFilter` — no-filter / empty-filter pass-all
 *      (I-9 gold-path default), undefined-origin → 'system' (P1 column
 *      default), in/out-of-set membership.
 *    - `sanitizeTimelineOriginFilter` — untyped wire coercion: non-array /
 *      empty / all-invalid → undefined (never an accidental empty feed),
 *      mixed → valid subset, dedupe, frozen.
 *
 *  Spec: docs/d-161-spec.md § N.8 / A.7 / I-7 / I-8 / I-9 / O-2.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ORIGIN_ACCEPTANCE,
  TIMELINE_DEFAULT_ORIGIN_ACTORS,
  originActorPassesTimelineFilter,
  sanitizeTimelineOriginFilter,
  type Actor,
} from '../index.js';

describe('D-161 P3 — TIMELINE_DEFAULT_ORIGIN_ACTORS (the foreground set)', () => {
  it('is exactly the gold-path lane: user_self + system', () => {
    expect([...TIMELINE_DEFAULT_ORIGIN_ACTORS]).toEqual(['user_self', 'system']);
  });

  it('is frozen so the shared reference cannot be mutated', () => {
    expect(Object.isFrozen(TIMELINE_DEFAULT_ORIGIN_ACTORS)).toBe(true);
  });

  it('does NOT include the outside-actor lanes (contracted_user / anonymous)', () => {
    expect(TIMELINE_DEFAULT_ORIGIN_ACTORS).not.toContain('contracted_user');
    expect(TIMELINE_DEFAULT_ORIGIN_ACTORS).not.toContain('anonymous');
  });

  it('is a DISTINCT reference from P2 input-trust default — same value, separate axis (I-8)', () => {
    // The two defaults coincide in value but are independently-evaluated
    // axes (display-foregrounding vs injection-surface). They must not be
    // the same object, or changing one silently moves the other.
    expect(TIMELINE_DEFAULT_ORIGIN_ACTORS).not.toBe(DEFAULT_ORIGIN_ACCEPTANCE);
    expect([...TIMELINE_DEFAULT_ORIGIN_ACTORS]).toEqual([
      ...DEFAULT_ORIGIN_ACCEPTANCE,
    ]);
  });
});

describe('D-161 P3 — originActorPassesTimelineFilter', () => {
  const ALL: Actor[] = ['user_self', 'contracted_user', 'system', 'anonymous'];

  it('undefined filter → every actor passes (no narrowing — I-9 default)', () => {
    for (const a of ALL) {
      expect(originActorPassesTimelineFilter(a, undefined)).toBe(true);
    }
  });

  it('empty filter → every actor passes (no narrowing)', () => {
    for (const a of ALL) {
      expect(originActorPassesTimelineFilter(a, [])).toBe(true);
    }
  });

  it('narrows to the named lane(s)', () => {
    expect(originActorPassesTimelineFilter('contracted_user', ['contracted_user'])).toBe(true);
    expect(originActorPassesTimelineFilter('anonymous', ['contracted_user'])).toBe(false);
    expect(originActorPassesTimelineFilter('user_self', ['user_self', 'system'])).toBe(true);
    expect(originActorPassesTimelineFilter('anonymous', ['user_self', 'system'])).toBe(false);
  });

  it('undefined origin_actor reads in the system lane (P1 column-default semantics)', () => {
    expect(originActorPassesTimelineFilter(undefined, ['system'])).toBe(true);
    expect(originActorPassesTimelineFilter(undefined, TIMELINE_DEFAULT_ORIGIN_ACTORS)).toBe(true);
    expect(originActorPassesTimelineFilter(undefined, ['user_self'])).toBe(false);
    expect(originActorPassesTimelineFilter(undefined, ['contracted_user', 'anonymous'])).toBe(false);
  });
});

describe('D-161 P3 — sanitizeTimelineOriginFilter (untyped wire coercion)', () => {
  it('non-array inputs → undefined (no filter)', () => {
    expect(sanitizeTimelineOriginFilter(undefined)).toBeUndefined();
    expect(sanitizeTimelineOriginFilter(null)).toBeUndefined();
    expect(sanitizeTimelineOriginFilter('user_self')).toBeUndefined();
    expect(sanitizeTimelineOriginFilter(42)).toBeUndefined();
    expect(sanitizeTimelineOriginFilter({ 0: 'user_self' })).toBeUndefined();
  });

  it('empty array → undefined (a caller passing [] never empties the feed)', () => {
    expect(sanitizeTimelineOriginFilter([])).toBeUndefined();
  });

  it('array of all-invalid members → undefined (degrade to no-filter, not empty)', () => {
    expect(sanitizeTimelineOriginFilter(['nope', 123, null, {}])).toBeUndefined();
  });

  it('keeps only valid Actor members, in first-seen order', () => {
    expect([
      ...(sanitizeTimelineOriginFilter(['contracted_user', 'anonymous']) ?? []),
    ]).toEqual(['contracted_user', 'anonymous']);
  });

  it('drops unknown members but keeps the valid subset (forward-compat client)', () => {
    expect([
      ...(sanitizeTimelineOriginFilter(['user_self', 'future_actor', 'system']) ?? []),
    ]).toEqual(['user_self', 'system']);
  });

  it('de-duplicates repeated actors', () => {
    expect([
      ...(sanitizeTimelineOriginFilter(['system', 'system', 'user_self', 'system']) ?? []),
    ]).toEqual(['system', 'user_self']);
  });

  it('returns a frozen array', () => {
    const out = sanitizeTimelineOriginFilter(['user_self']);
    expect(out).toBeDefined();
    expect(Object.isFrozen(out)).toBe(true);
  });
});
