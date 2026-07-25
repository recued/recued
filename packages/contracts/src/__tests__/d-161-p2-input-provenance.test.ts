/** D-161 P2 — input-provenance trust axis (the producer provenance-filter).
 *
 *  Unit-tests the pure helpers in `input-provenance.ts`: the conservative
 *  undeclared default (`user_self` + `system` only — N.9 MUST / TR-7), the
 *  declared-set resolution + acceptance check (I-7/I-8), and the source-row
 *  write-actor reader (defaults to `'system'` for rows that carry no
 *  origin facet — work entities P1 didn't stamp; A.5). */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ORIGIN_ACCEPTANCE,
  resolveOriginAcceptance,
  isOriginActorAccepted,
  readSourceOriginActor,
} from '../input-provenance.js';

describe('DEFAULT_ORIGIN_ACCEPTANCE', () => {
  it('is exactly user_self + system (the conservative security default)', () => {
    expect([...DEFAULT_ORIGIN_ACCEPTANCE]).toEqual(['user_self', 'system']);
  });

  it('is frozen so the shared reference cannot be mutated', () => {
    expect(Object.isFrozen(DEFAULT_ORIGIN_ACCEPTANCE)).toBe(true);
    expect(() => {
      (DEFAULT_ORIGIN_ACCEPTANCE as unknown as string[]).push('anonymous');
    }).toThrow();
  });
});

describe('resolveOriginAcceptance', () => {
  it('returns the conservative default when undeclared (undefined)', () => {
    expect(resolveOriginAcceptance(undefined)).toBe(DEFAULT_ORIGIN_ACCEPTANCE);
  });

  it('returns the declared list verbatim when present', () => {
    const declared = ['user_self', 'system', 'anonymous'] as const;
    expect(resolveOriginAcceptance(declared)).toBe(declared);
  });
});

describe('isOriginActorAccepted', () => {
  it('accepts user_self + system under the undeclared default', () => {
    expect(isOriginActorAccepted('user_self', undefined)).toBe(true);
    expect(isOriginActorAccepted('system', undefined)).toBe(true);
  });

  it('rejects anonymous + contracted_user under the undeclared default (TR-7)', () => {
    expect(isOriginActorAccepted('anonymous', undefined)).toBe(false);
    expect(isOriginActorAccepted('contracted_user', undefined)).toBe(false);
  });

  it('accepts an outside actor only when the producer opts in explicitly', () => {
    expect(isOriginActorAccepted('anonymous', ['user_self', 'system', 'anonymous'])).toBe(true);
    // A producer that opts into anonymous but not contracted_user still
    // rejects contracted_user — the classes are independent.
    expect(isOriginActorAccepted('contracted_user', ['user_self', 'system', 'anonymous'])).toBe(false);
  });

  it('an explicit narrow list can reject system (e.g. a user-only producer)', () => {
    expect(isOriginActorAccepted('system', ['user_self'])).toBe(false);
    expect(isOriginActorAccepted('user_self', ['user_self'])).toBe(true);
  });
});

describe('readSourceOriginActor', () => {
  it('reads the write-actor off a warehouse/enrichment source row', () => {
    expect(readSourceOriginActor({ origin_actor: 'contracted_user' })).toBe('contracted_user');
    expect(readSourceOriginActor({ origin_actor: 'anonymous' })).toBe('anonymous');
    expect(readSourceOriginActor({ origin_actor: 'user_self' })).toBe('user_self');
  });

  it("defaults to 'system' for a row with no origin facet (unstamped work entity, A.5)", () => {
    expect(readSourceOriginActor({})).toBe('system');
    expect(readSourceOriginActor({ origin_actor: undefined })).toBe('system');
  });

  it("defaults to 'system' for null / non-object / non-Actor values", () => {
    expect(readSourceOriginActor(null)).toBe('system');
    expect(readSourceOriginActor(undefined)).toBe('system');
    expect(readSourceOriginActor('a string')).toBe('system');
    expect(readSourceOriginActor(42)).toBe('system');
    // A bogus origin_actor string is not a known Actor → conservative 'system'.
    expect(readSourceOriginActor({ origin_actor: 'contracted_self' })).toBe('system');
    expect(readSourceOriginActor({ origin_actor: 'bogus' })).toBe('system');
  });
});
