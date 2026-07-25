import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLOSED_RETENTION_MS,
  DEFAULT_INTENT_BURST_MS,
  EnvelopeStore,
} from '../envelope';
import {
  mintEnvelopeId,
  type EnvelopeId,
} from '../types';

const id = (value: string): EnvelopeId => mintEnvelopeId(value);

describe('EnvelopeStore — openEnvelope', () => {
  it('opens a new envelope retrievable by id', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-open-1');
    const now = 1_000_000;

    store.openEnvelope(envelopeId, 'find Ada', now);

    const state = store.getEnvelope(envelopeId);
    expect(state).toEqual({ id: envelopeId, prompt: 'find Ada', opened_at: now });
    expect(state?.closed_at).toBeUndefined();
    expect(state?.result).toBeUndefined();
  });

  it('throws when called twice with the same id, including after close', () => {
    const store = new EnvelopeStore();
    const freshId = id('req-open-duplicate');
    const closedId = id('req-open-closed');
    const now = 1_000_000;

    store.openEnvelope(freshId, 'fresh', now);
    expect(() => store.openEnvelope(freshId, 'fresh again', now + 1))
      .toThrow('EnvelopeStore: envelope already open: req-open-duplicate');

    store.openEnvelope(closedId, 'closed', now);
    store.closeEnvelope(closedId, 'done', now + 1);
    expect(() => store.openEnvelope(closedId, 'closed again', now + 2))
      .toThrow('EnvelopeStore: envelope already open: req-open-closed');
  });

  it('allows multiple distinct ids to coexist', () => {
    const store = new EnvelopeStore();
    const first = id('req-open-a');
    const second = id('req-open-b');

    store.openEnvelope(first, 'first prompt', 1_000_000);
    store.openEnvelope(second, 'second prompt', 1_000_100);

    expect(store.getEnvelope(first)?.prompt).toBe('first prompt');
    expect(store.getEnvelope(second)?.prompt).toBe('second prompt');
  });
});

describe('EnvelopeStore — closeEnvelope', () => {
  it('closes an open envelope with closed_at and result', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-close-1');

    store.openEnvelope(envelopeId, 'summarize', 1_000_000);
    store.closeEnvelope(envelopeId, 'answer', 1_000_500);

    expect(store.getEnvelope(envelopeId)).toEqual({
      id: envelopeId,
      prompt: 'summarize',
      opened_at: 1_000_000,
      closed_at: 1_000_500,
      result: 'answer',
    });
  });

  it('is idempotent and preserves the first close result', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-close-idempotent');

    store.openEnvelope(envelopeId, 'ask', 1_000_000);
    store.closeEnvelope(envelopeId, 'first result', 1_000_200);
    store.closeEnvelope(envelopeId, 'second result', 1_000_900);

    expect(store.getEnvelope(envelopeId)?.closed_at).toBe(1_000_200);
    expect(store.getEnvelope(envelopeId)?.result).toBe('first result');
  });

  it('does nothing when id was never opened', () => {
    const store = new EnvelopeStore();
    const known = id('req-close-known');
    const unknown = id('req-close-unknown');

    store.openEnvelope(known, 'known', 1_000_000);
    expect(() => store.closeEnvelope(unknown, 'ignored', 1_000_500)).not.toThrow();

    expect(store.getEnvelope(known)).toEqual({
      id: known,
      prompt: 'known',
      opened_at: 1_000_000,
    });
    expect(store.getEnvelope(unknown)).toBeUndefined();
  });

  it('accepts undefined result as a valid close', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-close-undefined');

    store.openEnvelope(envelopeId, 'no-result', 1_000_000);
    store.closeEnvelope(envelopeId, undefined, 1_000_300);

    expect(store.getEnvelope(envelopeId)?.closed_at).toBe(1_000_300);
    expect(store.getEnvelope(envelopeId)?.result).toBeUndefined();
  });
});

describe('EnvelopeStore — getEnvelope', () => {
  it('returns the state for an open envelope', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-get-open');

    store.openEnvelope(envelopeId, 'open', 1_000_000);

    expect(store.getEnvelope(envelopeId)?.closed_at).toBeUndefined();
    expect(store.getEnvelope(envelopeId)?.prompt).toBe('open');
  });

  it('returns the state for a closed envelope', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-get-closed');

    store.openEnvelope(envelopeId, 'closed', 1_000_000);
    store.closeEnvelope(envelopeId, 'result', 1_000_100);

    expect(store.getEnvelope(envelopeId)?.closed_at).toBe(1_000_100);
    expect(store.getEnvelope(envelopeId)?.result).toBe('result');
  });

  it('returns undefined for an unknown id', () => {
    const store = new EnvelopeStore();

    expect(store.getEnvelope(id('req-get-unknown'))).toBeUndefined();
  });
});

describe('EnvelopeStore — sweepDanglingEnvelopes', () => {
  it('closes only envelopes older than the intent burst window', () => {
    const store = new EnvelopeStore();
    const boundary = id('req-sweep-boundary');
    const stale = id('req-sweep-stale');
    const openedAt = 1_000_000;

    store.openEnvelope(boundary, 'boundary', openedAt);
    store.openEnvelope(stale, 'stale', openedAt - 1);

    const swept = store.sweepDanglingEnvelopes(openedAt + 30_000, 30_000);

    expect(swept).toEqual([stale]);
    expect(store.getEnvelope(boundary)?.closed_at).toBeUndefined();
    expect(store.getEnvelope(stale)?.closed_at).toBe(openedAt + 30_000);
  });

  it('leaves already-closed envelopes alone', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-sweep-closed');

    store.openEnvelope(envelopeId, 'closed', 1_000_000);
    store.closeEnvelope(envelopeId, 'manual', 1_000_100);

    expect(store.sweepDanglingEnvelopes(1_100_001, 30_000)).toEqual([]);
    expect(store.getEnvelope(envelopeId)?.closed_at).toBe(1_000_100);
    expect(store.getEnvelope(envelopeId)?.result).toBe('manual');
  });

  it('uses the default intent burst window when omitted', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-sweep-default');

    store.openEnvelope(envelopeId, 'default', 1_000_000);

    expect(store.sweepDanglingEnvelopes(1_000_000 + DEFAULT_INTENT_BURST_MS))
      .toEqual([]);
    expect(store.sweepDanglingEnvelopes(1_000_000 + DEFAULT_INTENT_BURST_MS + 1))
      .toEqual([envelopeId]);
  });

  it('returns empty array when the store has no envelopes', () => {
    const store = new EnvelopeStore();
    expect(store.sweepDanglingEnvelopes(2_000_000, 30_000)).toEqual([]);
  });

  it('returns empty array when no envelopes are dangling yet', () => {
    const store = new EnvelopeStore();
    const fresh = id('req-sweep-fresh');

    store.openEnvelope(fresh, 'fresh', 1_000_000);

    expect(store.sweepDanglingEnvelopes(1_010_000, 30_000)).toEqual([]);
    expect(store.getEnvelope(fresh)?.closed_at).toBeUndefined();
  });

  it('with intent_burst_ms 0 sweeps any envelope opened strictly before now', () => {
    const store = new EnvelopeStore();
    const past = id('req-sweep-zero-past');
    const present = id('req-sweep-zero-present');

    store.openEnvelope(past, 'past', 1_000_000);
    store.openEnvelope(present, 'present', 1_000_500);

    expect(store.sweepDanglingEnvelopes(1_000_500, 0)).toEqual([past]);
    expect(store.getEnvelope(past)?.closed_at).toBe(1_000_500);
    expect(store.getEnvelope(present)?.closed_at).toBeUndefined();
  });

  it('closes multiple stale envelopes in one sweep at the now argument', () => {
    const store = new EnvelopeStore();
    const first = id('req-sweep-a');
    const second = id('req-sweep-b');
    const active = id('req-sweep-active');
    const now = 1_000_000 + 60_001;

    store.openEnvelope(first, 'first', 1_000_000);
    store.openEnvelope(second, 'second', 1_000_000 - 1);
    store.openEnvelope(active, 'active', 1_000_000 + 30_000);

    expect(store.sweepDanglingEnvelopes(now, 60_000)).toEqual([first, second]);
    expect(store.getEnvelope(first)?.closed_at).toBe(now);
    expect(store.getEnvelope(second)?.closed_at).toBe(now);
    expect(store.getEnvelope(active)?.closed_at).toBeUndefined();
  });
});

describe('EnvelopeStore — evictClosedEnvelopes', () => {
  it('evicts a closed envelope older than the retention window', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-evict-stale');

    store.openEnvelope(envelopeId, 'stale', 1_000_000);
    store.closeEnvelope(envelopeId, 'done', 1_000_100);

    const evicted = store.evictClosedEnvelopes(1_000_100 + 30_001, 30_000);

    expect(evicted).toEqual([envelopeId]);
    expect(store.getEnvelope(envelopeId)).toBeUndefined();
  });

  it('keeps a closed envelope at the boundary (strict greater-than)', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-evict-boundary');

    store.openEnvelope(envelopeId, 'boundary', 1_000_000);
    store.closeEnvelope(envelopeId, 'done', 1_000_100);

    // now - closed_at === retention_ms is NOT evicted.
    expect(store.evictClosedEnvelopes(1_000_100 + 30_000, 30_000)).toEqual([]);
    expect(store.getEnvelope(envelopeId)?.result).toBe('done');
  });

  it('never evicts an open envelope, however old', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-evict-open');

    store.openEnvelope(envelopeId, 'open', 1_000_000);

    // Even retention 0 leaves an open (closed_at === undefined) envelope.
    expect(store.evictClosedEnvelopes(9_000_000, 0)).toEqual([]);
    expect(store.getEnvelope(envelopeId)?.closed_at).toBeUndefined();
  });

  it('uses the default retention window when omitted', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-evict-default');

    store.openEnvelope(envelopeId, 'default', 1_000_000);
    store.closeEnvelope(envelopeId, 'done', 1_000_100);

    expect(store.evictClosedEnvelopes(1_000_100 + DEFAULT_CLOSED_RETENTION_MS))
      .toEqual([]);
    expect(store.getEnvelope(envelopeId)?.result).toBe('done');
    expect(store.evictClosedEnvelopes(1_000_100 + DEFAULT_CLOSED_RETENTION_MS + 1))
      .toEqual([envelopeId]);
    expect(store.getEnvelope(envelopeId)).toBeUndefined();
  });

  it('returns empty array when the store has no envelopes', () => {
    const store = new EnvelopeStore();
    expect(store.evictClosedEnvelopes(2_000_000, 30_000)).toEqual([]);
  });

  it('evicts only the stale-closed, leaving recent-closed + open intact', () => {
    const store = new EnvelopeStore();
    const stale = id('req-evict-multi-stale');
    const recent = id('req-evict-multi-recent');
    const open = id('req-evict-multi-open');

    store.openEnvelope(stale, 'stale', 1_000_000);
    store.closeEnvelope(stale, 'a', 1_000_000);
    store.openEnvelope(recent, 'recent', 1_000_000);
    store.closeEnvelope(recent, 'b', 1_050_000);
    store.openEnvelope(open, 'open', 1_000_000);

    const evicted = store.evictClosedEnvelopes(1_050_001, 30_000);

    expect(evicted).toEqual([stale]);
    expect(store.getEnvelope(stale)).toBeUndefined();
    expect(store.getEnvelope(recent)?.result).toBe('b');
    expect(store.getEnvelope(open)?.closed_at).toBeUndefined();
  });

  it('lets an evicted id be re-opened (the entry is gone)', () => {
    const store = new EnvelopeStore();
    const envelopeId = id('req-evict-reopen');

    store.openEnvelope(envelopeId, 'first', 1_000_000);
    store.closeEnvelope(envelopeId, 'first result', 1_000_100);
    expect(store.evictClosedEnvelopes(1_000_100 + 30_001, 30_000))
      .toEqual([envelopeId]);

    // Re-open no longer throws (contrast openEnvelope's after-close throw).
    expect(() => store.openEnvelope(envelopeId, 'reopened', 2_000_000))
      .not.toThrow();
    expect(store.getEnvelope(envelopeId)).toEqual({
      id: envelopeId,
      prompt: 'reopened',
      opened_at: 2_000_000,
    });
  });
});

describe('mintEnvelopeId — constructor', () => {
  it('returns the same string', () => {
    expect(mintEnvelopeId('req-mint-1')).toBe('req-mint-1');
  });
});

describe('DEFAULT_INTENT_BURST_MS — constant', () => {
  it('equals 60 seconds', () => {
    expect(DEFAULT_INTENT_BURST_MS).toBe(60_000);
  });
});

describe('DEFAULT_CLOSED_RETENTION_MS — constant', () => {
  it('equals 5 minutes', () => {
    expect(DEFAULT_CLOSED_RETENTION_MS).toBe(5 * 60_000);
  });
});
