/** D-153 P3 — cancellation grace window + compensating-commit substrate.
 *
 *  Pins the pure contracts from packages/contracts/src/cancellation.ts:
 *  manifest metadata helpers, publish-time validation, compensation
 *  detection, and the in-memory grace-window store.
 *
 *  Spec: D-153 lines 467-485. */

import { describe, expect, it } from 'vitest';

import {
  CANCELLATION_ISSUE_CODES,
  DEFAULT_GRACE_WINDOW_MS,
  GRACE_WINDOW_OUTCOMES,
  MAX_GRACE_WINDOW_MS,
  createInMemoryGraceWindowStore,
  getEffectiveGraceWindowMs,
  isCancellationIssueCode,
  isCompensatingCommit,
  isGraceWindowOutcome,
  manifestSupportsGraceCancel,
  validateCancellationManifest,
  type CancellationIssueCode,
  type GraceWindowEntry,
  type GraceWindowOutcome,
  type IngredientManifest,
} from '@recued/contracts';

const EXPECTED_CANCELLATION_ISSUE_CODES: readonly CancellationIssueCode[] = [
  'cancellation_partner_invalid_type',
  'cancellation_partner_self_reference',
  'grace_window_ms_invalid_type',
  'grace_window_ms_out_of_range',
  'grace_window_ms_without_partner',
] as const;

const EXPECTED_GRACE_WINDOW_OUTCOMES: readonly GraceWindowOutcome[] = [
  'released',
  'cancelled_in_grace',
] as const;

type CancellationManifestForValidation = Parameters<
  typeof validateCancellationManifest
>[0];

const issueCodesFor = (
  manifest: CancellationManifestForValidation,
): CancellationIssueCode[] =>
  validateCancellationManifest(manifest).map((issue) => issue.code);

const makeEntry = (
  overrides: Partial<GraceWindowEntry> = {},
): GraceWindowEntry => ({
  grace_id: 'grace-1',
  tool_slug: 'x.create',
  cancellation_partner: 'x.delete',
  window_ms: DEFAULT_GRACE_WINDOW_MS,
  admitted_at: 1_000,
  payload: { step: 'payload' },
  ...overrides,
});

describe('D-153 P3 — constants', () => {
  it('pins the default grace window at 5000ms', () => {
    expect(DEFAULT_GRACE_WINDOW_MS).toBe(5000);
  });

  it('pins the maximum grace window at 60000ms', () => {
    expect(MAX_GRACE_WINDOW_MS).toBe(60000);
  });
});

describe('D-153 P3 — manifestSupportsGraceCancel', () => {
  it('returns true when cancellation_partner is a non-empty string', () => {
    expect(manifestSupportsGraceCancel({ cancellation_partner: 'x.delete' })).toBe(true);
  });

  it('returns false when cancellation_partner is absent', () => {
    expect(manifestSupportsGraceCancel({})).toBe(false);
  });

  it('returns false when cancellation_partner is an empty string', () => {
    expect(manifestSupportsGraceCancel({ cancellation_partner: '' })).toBe(false);
  });
});

describe('D-153 P3 — getEffectiveGraceWindowMs', () => {
  it('returns null when no cancellation_partner is declared', () => {
    expect(getEffectiveGraceWindowMs({})).toBeNull();
  });

  it('returns the explicit grace_window_ms when cancellation_partner is declared', () => {
    expect(getEffectiveGraceWindowMs({
      cancellation_partner: 'x.delete',
      grace_window_ms: 1234,
    })).toBe(1234);
  });

  it('falls back to DEFAULT_GRACE_WINDOW_MS when partner is declared and grace_window_ms is omitted', () => {
    expect(getEffectiveGraceWindowMs({ cancellation_partner: 'x.delete' })).toBe(
      DEFAULT_GRACE_WINDOW_MS,
    );
  });

  it('preserves explicit zero instead of falling back to the default', () => {
    expect(getEffectiveGraceWindowMs({
      cancellation_partner: 'x.delete',
      grace_window_ms: 0,
    })).toBe(0);
  });
});

describe('D-153 P3 — validateCancellationManifest', () => {
  it('accepts a valid partner plus explicit grace window', () => {
    expect(validateCancellationManifest({
      slug: 'x.create',
      cancellation_partner: 'x.delete',
      grace_window_ms: 5000,
    })).toEqual([]);
  });

  it('accepts a valid partner without grace_window_ms', () => {
    expect(validateCancellationManifest({
      slug: 'x.create',
      cancellation_partner: 'x.delete',
    })).toEqual([]);
  });

  it('emits cancellation_partner_invalid_type for empty-string and non-string partners', () => {
    expect(issueCodesFor({
      slug: 'x.create',
      cancellation_partner: '',
    })).toEqual(['cancellation_partner_invalid_type']);

    expect(issueCodesFor({
      slug: 'x.create',
      cancellation_partner: 42 as unknown as string,
    })).toEqual(['cancellation_partner_invalid_type']);
  });

  it('emits cancellation_partner_self_reference when the partner equals slug', () => {
    expect(issueCodesFor({
      slug: 'x.create',
      cancellation_partner: 'x.create',
    })).toEqual(['cancellation_partner_self_reference']);
  });

  it('emits grace_window_ms_invalid_type for NaN, Infinity, and non-number values', () => {
    for (const grace_window_ms of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5000' as unknown as number,
    ]) {
      expect(issueCodesFor({
        slug: 'x.create',
        cancellation_partner: 'x.delete',
        grace_window_ms,
      })).toEqual(['grace_window_ms_invalid_type']);
    }
  });

  it('emits grace_window_ms_out_of_range below zero and above MAX_GRACE_WINDOW_MS', () => {
    for (const grace_window_ms of [-1, MAX_GRACE_WINDOW_MS + 1]) {
      expect(issueCodesFor({
        slug: 'x.create',
        cancellation_partner: 'x.delete',
        grace_window_ms,
      })).toEqual(['grace_window_ms_out_of_range']);
    }
  });

  it('accepts grace_window_ms boundary values 0 and MAX_GRACE_WINDOW_MS', () => {
    for (const grace_window_ms of [0, MAX_GRACE_WINDOW_MS]) {
      expect(issueCodesFor({
        slug: 'x.create',
        cancellation_partner: 'x.delete',
        grace_window_ms,
      })).toEqual([]);
    }
  });

  it('emits grace_window_ms_without_partner only when the partner field is absent', () => {
    expect(issueCodesFor({
      slug: 'x.create',
      grace_window_ms: 5000,
    })).toEqual(['grace_window_ms_without_partner']);
  });

  it('does not emit grace_window_ms_without_partner for a present but malformed partner', () => {
    for (const cancellation_partner of ['', 42 as unknown as string]) {
      const codes = issueCodesFor({
        slug: 'x.create',
        cancellation_partner,
        grace_window_ms: 5000,
      });

      expect(codes).toContain('cancellation_partner_invalid_type');
      expect(codes).not.toContain('grace_window_ms_without_partner');
    }
  });
});

describe('D-153 P3 — closed-list predicates', () => {
  it('CANCELLATION_ISSUE_CODES is the exact five-code closed list', () => {
    expect(CANCELLATION_ISSUE_CODES).toEqual(EXPECTED_CANCELLATION_ISSUE_CODES);
  });

  it('isCancellationIssueCode accepts every closed-list value', () => {
    for (const code of CANCELLATION_ISSUE_CODES) {
      expect(isCancellationIssueCode(code)).toBe(true);
    }
  });

  it('isCancellationIssueCode rejects junk strings and non-strings', () => {
    for (const value of ['unknown', '', 42, null, undefined, {}]) {
      expect(isCancellationIssueCode(value)).toBe(false);
    }
  });

  it('GRACE_WINDOW_OUTCOMES is the exact two-outcome closed list', () => {
    expect(GRACE_WINDOW_OUTCOMES).toEqual(EXPECTED_GRACE_WINDOW_OUTCOMES);
  });

  it('isGraceWindowOutcome accepts every closed-list value', () => {
    for (const outcome of GRACE_WINDOW_OUTCOMES) {
      expect(isGraceWindowOutcome(outcome)).toBe(true);
    }
  });

  it('isGraceWindowOutcome rejects junk strings and non-strings', () => {
    for (const value of ['unknown', '', 42, null, undefined, {}]) {
      expect(isGraceWindowOutcome(value)).toBe(false);
    }
  });
});

describe('D-153 P3 — isCompensatingCommit', () => {
  it('returns true for a non-empty predecessor_commit_id', () => {
    expect(isCompensatingCommit({ predecessor_commit_id: 'commit-1' })).toBe(true);
  });

  it('returns false for undefined, null, and empty-string predecessor_commit_id values', () => {
    expect(isCompensatingCommit({})).toBe(false);
    expect(isCompensatingCommit({ predecessor_commit_id: undefined })).toBe(false);
    expect(isCompensatingCommit({ predecessor_commit_id: null })).toBe(false);
    expect(isCompensatingCommit({ predecessor_commit_id: '' })).toBe(false);
  });
});

describe('D-153 P3 — createInMemoryGraceWindowStore', () => {
  it('admit then get round-trips the entry, and get returns undefined for an unknown id', () => {
    const store = createInMemoryGraceWindowStore();
    const entry = makeEntry();

    store.admit(entry);

    expect(store.get(entry.grace_id)).toBe(entry);
    expect(store.get('missing')).toBeUndefined();
  });

  it('throws when admitting a duplicate grace_id', () => {
    const store = createInMemoryGraceWindowStore();
    const entry = makeEntry();

    store.admit(entry);

    expect(() => store.admit({ ...entry, payload: { duplicate: true } })).toThrow(
      /already held/,
    );
  });

  it('cancelInGrace returns the cancelled entry and removes it', () => {
    const store = createInMemoryGraceWindowStore();
    const entry = makeEntry();

    store.admit(entry);

    expect(store.cancelInGrace(entry.grace_id)).toEqual({
      outcome: 'cancelled_in_grace',
      entry,
    });
    expect(store.get(entry.grace_id)).toBeUndefined();
    expect(store.cancelInGrace(entry.grace_id)).toEqual({ outcome: 'not_found' });
  });

  it('releaseExpired releases expired entries in admission order and leaves unexpired entries held', () => {
    let t = 200;
    const store = createInMemoryGraceWindowStore(() => t);
    const expiredFirst = makeEntry({
      grace_id: 'expired-first',
      admitted_at: 100,
      window_ms: 50,
    });
    const expiredSecond = makeEntry({
      grace_id: 'expired-second',
      admitted_at: 110,
      window_ms: 20,
    });
    const stillHeld = makeEntry({
      grace_id: 'still-held',
      admitted_at: 175,
      window_ms: 30,
    });

    store.admit(expiredFirst);
    store.admit(expiredSecond);
    store.admit(stillHeld);

    expect(store.releaseExpired()).toEqual([expiredFirst, expiredSecond]);
    expect(store.get(expiredFirst.grace_id)).toBeUndefined();
    expect(store.get(expiredSecond.grace_id)).toBeUndefined();
    expect(store.get(stillHeld.grace_id)).toBe(stillHeld);
    expect(store.list()).toEqual([stillHeld]);

    t = 205;
    expect(store.releaseExpired()).toEqual([stillHeld]);
    expect(store.size()).toBe(0);
  });

  it('releases an entry whose admitted_at plus window_ms exactly equals now()', () => {
    const store = createInMemoryGraceWindowStore(() => 150);
    const entry = makeEntry({
      grace_id: 'boundary',
      admitted_at: 100,
      window_ms: 50,
    });

    store.admit(entry);

    expect(store.releaseExpired()).toEqual([entry]);
    expect(store.get(entry.grace_id)).toBeUndefined();
  });

  it('releases a 0ms-window entry on the next tick', () => {
    let t = 501;
    const store = createInMemoryGraceWindowStore(() => t);
    const entry = makeEntry({
      grace_id: 'zero-window',
      admitted_at: 500,
      window_ms: 0,
    });

    store.admit(entry);

    expect(store.releaseExpired()).toEqual([entry]);
    expect(store.size()).toBe(0);
  });

  it('list returns entries in admission order and size matches list length', () => {
    const store = createInMemoryGraceWindowStore();
    const first = makeEntry({ grace_id: 'first' });
    const second = makeEntry({ grace_id: 'second' });
    const third = makeEntry({ grace_id: 'third' });

    store.admit(first);
    store.admit(second);
    store.admit(third);

    const listed = store.list();
    expect(listed).toEqual([first, second, third]);
    expect(store.size()).toBe(listed.length);
  });
});

describe('D-153 P3 — IngredientManifest type surface', () => {
  it('accepts cancellation_partner and grace_window_ms fields', () => {
    const manifest: IngredientManifest = {
      slug: 'x.create',
      name: 'Create X',
      description: 'Creates X',
      author: 'recued',
      kind: 'http',
      category: 'action',
      risk_tier: 'write',
      input: {},
      output: {},
      cancellation_partner: 'x.delete',
      grace_window_ms: 5000,
    };

    expect(manifest.cancellation_partner).toBe('x.delete');
    expect(manifest.grace_window_ms).toBe(5000);
  });
});
