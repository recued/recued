import { describe, it, expect } from 'vitest';
import { createQuotaTracker } from '../quota.js';
import type { FreePoolApiEntry } from '../types.js';

const apiEntry = (over: Partial<FreePoolApiEntry> = {}): FreePoolApiEntry => ({
  id: 'e1',
  type: 'api',
  provider: 'openai-compatible',
  model: 'llama-3.3-70b',
  api_key: 'k',
  speed: 'fast',
  supports_json: true,
  enabled: true,
  ...over,
});

describe('createQuotaTracker', () => {
  it('reports disabled entries as unavailable', () => {
    const q = createQuotaTracker();
    const status = q.statusFor(apiEntry({ enabled: false }));
    expect(status).toEqual({ available: false, reason: 'disabled' });
  });

  it('reports missing api_key and model on api entries', () => {
    const q = createQuotaTracker();
    expect(q.statusFor(apiEntry({ api_key: '' }))).toEqual({
      available: false,
      reason: 'no_key',
    });
    expect(q.statusFor(apiEntry({ model: '' }))).toEqual({
      available: false,
      reason: 'no_model',
    });
  });

  it('excludes entries that hit the daily token cap', () => {
    const q = createQuotaTracker();
    const e = apiEntry({ daily_cap_tokens: 1000 });
    q.recordUsage(e.id, 500);
    expect(q.statusFor(e)).toEqual({ available: true });
    q.recordUsage(e.id, 500);
    expect(q.statusFor(e)).toEqual({ available: false, reason: 'quota_exhausted' });
  });

  it('excludes entries that hit the RPM cap in the current 60s window', () => {
    const q = createQuotaTracker();
    const e = apiEntry({ rpm_cap: 2 });
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    q.registerRequest(e.id, t0);
    q.registerRequest(e.id, t0 + 1000);
    expect(q.statusFor(e, t0 + 2000)).toEqual({ available: false, reason: 'quota_exhausted' });
    // After 60s the window slides and the earlier timestamps drop off
    expect(q.statusFor(e, t0 + 65_000)).toEqual({ available: true });
  });

  it('resets daily tokens on UTC midnight boundary', () => {
    const q = createQuotaTracker();
    const e = apiEntry({ daily_cap_tokens: 100 });
    const t0 = Date.parse('2026-04-18T23:00:00Z');
    q.recordUsage(e.id, 100, t0);
    expect(q.statusFor(e, t0 + 60_000)).toEqual({ available: false, reason: 'quota_exhausted' });
    const t1 = Date.parse('2026-04-19T00:05:00Z');
    expect(q.statusFor(e, t1)).toEqual({ available: true });
  });

  it('tokensToday returns accumulated usage per id (0 for unknown)', () => {
    const q = createQuotaTracker();
    expect(q.tokensToday('slot_1')).toBe(0);
    q.recordUsage('slot_1', 400);
    q.recordUsage('slot_1', 350);
    q.recordUsage('slot_2', 100);
    expect(q.tokensToday('slot_1')).toBe(750);
    expect(q.tokensToday('slot_2')).toBe(100);
    expect(q.tokensToday('never-used')).toBe(0);
  });

  it('advances + reports the round-robin cursor per source key', () => {
    const q = createQuotaTracker();
    expect(q.currentCursor('free_pool:fast')).toBe(0);
    q.advanceCursor('free_pool:fast');
    q.advanceCursor('free_pool:fast');
    expect(q.currentCursor('free_pool:fast')).toBe(2);
    expect(q.currentCursor('free_pool:quality')).toBe(0);
  });

  it('snapshot round-trips through rehydration', () => {
    const q = createQuotaTracker();
    const e = apiEntry({ daily_cap_tokens: 1000 });
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    q.recordUsage(e.id, 300, t0);
    q.advanceCursor('free_pool:fast');
    const snap = q.snapshot();

    const q2 = createQuotaTracker(snap);
    expect(q2.currentCursor('free_pool:fast')).toBe(1);
    expect(q2.snapshot().tokens_today[e.id]).toBe(300);
    // Usage carries forward — adding 700 more should now exhaust
    q2.recordUsage(e.id, 700, t0 + 1000);
    expect(q2.statusFor(e, t0 + 2000)).toEqual({ available: false, reason: 'quota_exhausted' });
  });

  // ────────────────────────────────────────────────────────────────
  // Post-429 cooldown — cross-call rate-limit memory
  // ────────────────────────────────────────────────────────────────

  it('markRateLimited makes an entry report quota_exhausted until the cooldown expires', () => {
    const q = createQuotaTracker();
    const e = apiEntry();
    const t0 = Date.parse('2026-04-18T00:00:00Z');

    // Eligible before the cooldown.
    expect(q.statusFor(e, t0)).toEqual({ available: true });

    // Explicit Retry-After: 30 seconds.
    q.markRateLimited(e.id, 30_000, t0);

    expect(q.statusFor(e, t0 + 1_000)).toEqual({ available: false, reason: 'quota_exhausted' });
    expect(q.statusFor(e, t0 + 29_999)).toEqual({ available: false, reason: 'quota_exhausted' });
    // Expires exactly at the boundary.
    expect(q.statusFor(e, t0 + 30_000)).toEqual({ available: true });
  });

  it('markRateLimited defaults to 60s when no Retry-After is provided', () => {
    const q = createQuotaTracker();
    const e = apiEntry();
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    q.markRateLimited(e.id, undefined, t0);
    expect(q.statusFor(e, t0 + 59_999)).toEqual({ available: false, reason: 'quota_exhausted' });
    expect(q.statusFor(e, t0 + 60_000)).toEqual({ available: true });
  });

  it('markRateLimited defaults to 60s when Retry-After is zero or negative', () => {
    const q = createQuotaTracker();
    const e = apiEntry();
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    q.markRateLimited(e.id, 0, t0);
    expect(q.statusFor(e, t0 + 1_000)).toEqual({ available: false, reason: 'quota_exhausted' });
    expect(q.statusFor(e, t0 + 60_000)).toEqual({ available: true });
  });

  it('cooldown works for slot ids too (not just pool entry ids)', () => {
    // Slots pass their stable key (`slot_1` / `slot_2`) as the entry id.
    // The tracker doesn't care what the id looks like — just that it
    // matches the lookup.
    const q = createQuotaTracker();
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    expect(q.isInCooldown('slot_1', t0)).toBe(false);
    q.markRateLimited('slot_1', 10_000, t0);
    expect(q.isInCooldown('slot_1', t0 + 5_000)).toBe(true);
    expect(q.isInCooldown('slot_1', t0 + 10_000)).toBe(false);
    // Isolated from slot_2.
    expect(q.isInCooldown('slot_2', t0 + 5_000)).toBe(false);
  });

  it('isInCooldown prunes the entry once the cooldown expires', () => {
    const q = createQuotaTracker();
    const t0 = Date.parse('2026-04-18T00:00:00Z');
    q.markRateLimited('x', 1000, t0);
    expect(q.isInCooldown('x', t0 + 500)).toBe(true);
    expect(q.isInCooldown('x', t0 + 2000)).toBe(false);
    // After pruning, a fresh mark takes effect cleanly.
    q.markRateLimited('x', 500, t0 + 2000);
    expect(q.isInCooldown('x', t0 + 2200)).toBe(true);
  });
});
