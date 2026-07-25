import { describe, it, expect } from 'vitest';
import { createQuotaTracker } from '../quota.js';

/** D-131 Phase 4 — QuotaTracker embeddings counter tests.
 *
 *  Validates the surface split:
 *    - `recordEmbeddingsUsage` updates both `tokens_today` (shared cap)
 *      and `embeddings_tokens_today` (breakout for visibility).
 *    - `embeddingsTokensToday` returns the embeddings-only counter.
 *    - Snapshot/hydrate round-trip preserves the breakout.
 *    - Daily reset clears both counters in lockstep.
 *
 *  D-174 R28 Slice C — the embeddings executor now records against the fixed
 *  `embeddings_slot` key (a dedicated slot; the slot_1→slot_2→free-pool
 *  cascade + the cross-surface cooldown-sharing tests were retired with it).
 *  The QuotaTracker API itself is unchanged, so these key-agnostic counter
 *  tests still hold. */

// ────────────────────────────────────────────────────────────────
// recordEmbeddingsUsage + embeddingsTokensToday
// ────────────────────────────────────────────────────────────────

describe('QuotaTracker — embeddings counter', () => {
  it('recordEmbeddingsUsage updates both tokens_today and embeddings_tokens_today', () => {
    const q = createQuotaTracker();
    q.recordEmbeddingsUsage('embeddings_slot', 50);
    const snap = q.snapshot();
    expect(snap.tokens_today['embeddings_slot']).toBe(50);
    expect(snap.embeddings_tokens_today?.['embeddings_slot']).toBe(50);
    expect(q.embeddingsTokensToday('embeddings_slot')).toBe(50);
  });

  it('recordUsage does NOT touch the embeddings counter', () => {
    // Chat path uses recordUsage. The embeddings counter must stay
    // empty so the breakout reflects only embeddings traffic.
    const q = createQuotaTracker();
    q.recordUsage('slot_1', 100);
    expect(q.embeddingsTokensToday('slot_1')).toBe(0);
    expect(q.snapshot().embeddings_tokens_today).toBeUndefined();
    expect(q.snapshot().tokens_today['slot_1']).toBe(100);
  });

  it('mixed traffic — chat + embeddings against the same key sums correctly', () => {
    const q = createQuotaTracker();
    q.recordUsage('k', 200);              // chat call
    q.recordEmbeddingsUsage('k', 30);     // embeddings call
    q.recordUsage('k', 70);               // another chat call
    const snap = q.snapshot();
    expect(snap.tokens_today['k']).toBe(300);
    expect(snap.embeddings_tokens_today?.['k']).toBe(30);
    expect(q.embeddingsTokensToday('k')).toBe(30);
  });

  it('embeddings_tokens_today invariant: <= tokens_today for every entry', () => {
    // Unit invariant — `embeddings` is a strict subset of `total`.
    // A regression that double-counted embeddings (e.g. forgetting to
    // also bump `tokens_today`) would break this.
    const q = createQuotaTracker();
    q.recordUsage('a', 10);
    q.recordEmbeddingsUsage('a', 25);
    q.recordEmbeddingsUsage('b', 5);
    const snap = q.snapshot();
    expect(snap.tokens_today['a']).toBeGreaterThanOrEqual(snap.embeddings_tokens_today!['a']);
    expect(snap.tokens_today['b']).toBeGreaterThanOrEqual(snap.embeddings_tokens_today!['b']);
  });

  it('embeddingsTokensToday returns 0 for an entry with no embeddings traffic', () => {
    const q = createQuotaTracker();
    q.recordUsage('slot_1', 100);
    expect(q.embeddingsTokensToday('slot_1')).toBe(0);
    expect(q.embeddingsTokensToday('never-touched')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Snapshot round-trip
// ────────────────────────────────────────────────────────────────

describe('QuotaTracker — snapshot/hydrate round-trip', () => {
  it('preserves embeddings_tokens_today across hydrate', () => {
    const q1 = createQuotaTracker();
    q1.recordEmbeddingsUsage('embeddings_slot', 42);
    q1.recordEmbeddingsUsage('other', 7);
    q1.recordUsage('embeddings_slot', 8); // chat — bumps tokens_today only
    const snap = q1.snapshot();

    const q2 = createQuotaTracker(snap);
    expect(q2.embeddingsTokensToday('embeddings_slot')).toBe(42);
    expect(q2.embeddingsTokensToday('other')).toBe(7);
    expect(q2.snapshot().tokens_today['embeddings_slot']).toBe(50);
  });

  it('omits embeddings_tokens_today from snapshot when empty', () => {
    // Smaller snapshots for the chat-only case — common path stays
    // backward-compatible with consumers that only look at tokens_today.
    const q = createQuotaTracker();
    q.recordUsage('slot_1', 100);
    const snap = q.snapshot();
    expect(snap.embeddings_tokens_today).toBeUndefined();
  });

  it('round-trips a chat-only snapshot without introducing the breakout', () => {
    const original = createQuotaTracker();
    original.recordUsage('slot_1', 50);
    const snap = original.snapshot();
    const hydrated = createQuotaTracker(snap);
    expect(hydrated.embeddingsTokensToday('slot_1')).toBe(0);
    expect(hydrated.snapshot().embeddings_tokens_today).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Daily reset
// ────────────────────────────────────────────────────────────────

describe('QuotaTracker — daily reset clears embeddings counter in lockstep', () => {
  it('rolling to a new UTC day clears both counters', () => {
    const day1 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01 12:00 UTC
    const day2 = Date.UTC(2026, 0, 2, 12, 0, 0); // next day
    const q = createQuotaTracker();
    q.recordEmbeddingsUsage('embeddings_slot', 100, day1);
    expect(q.embeddingsTokensToday('embeddings_slot')).toBe(100);
    // recordUsage on day 2 triggers maybeReset internally.
    q.recordUsage('other', 1, day2);
    expect(q.embeddingsTokensToday('embeddings_slot')).toBe(0);
    expect(q.snapshot().tokens_today['embeddings_slot']).toBeUndefined();
  });
});
