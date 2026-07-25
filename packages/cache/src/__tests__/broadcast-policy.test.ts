import { describe, it, expect } from 'vitest';
import { isBroadcastEligible, DEFAULT_BROADCAST_POLICY } from '../broadcast-policy.js';
import type { CacheEntry } from '../types.js';

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'v1:test:x@1:abc',
  value: { some: 'payload' },
  expires_at: Date.now() + 60_000,
  recipe_id: 'r',
  ingredient_slug: 'x',
  size_bytes: 100,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  category: 'data',
  risk_tier: 'read',
  ...overrides,
});

describe('isBroadcastEligible — category filter', () => {
  it('data + read → eligible', () => {
    expect(isBroadcastEligible(mkEntry())).toBe(true);
  });

  it('ai + read → eligible', () => {
    expect(isBroadcastEligible(mkEntry({ category: 'ai' }))).toBe(true);
  });

  it('action category → NOT eligible', () => {
    expect(isBroadcastEligible(mkEntry({ category: 'action' }))).toBe(false);
  });

  it('missing category → NOT eligible (legacy rows stay local)', () => {
    expect(isBroadcastEligible(mkEntry({ category: undefined }))).toBe(false);
  });
});

describe('isBroadcastEligible — risk_tier gate', () => {
  it.each(['write', 'admin', 'destructive'] as const)(
    '%s risk_tier → NOT eligible (belt-and-suspenders)',
    (tier) => {
      expect(isBroadcastEligible(mkEntry({ risk_tier: tier }))).toBe(false);
    },
  );
});

describe('isBroadcastEligible — prefs.cache.sync_l2 gate', () => {
  it('step entry broadcasts by default (pref missing → registry default true)', () => {
    expect(isBroadcastEligible(mkEntry({ category: 'step' }))).toBe(true);
  });

  it('step entry is gated off when prefs.cache.sync_l2=false', () => {
    expect(isBroadcastEligible(
      mkEntry({ category: 'step' }),
      DEFAULT_BROADCAST_POLICY,
      { 'cache.sync_l2': false },
    )).toBe(false);
  });

  it('data entry ignores the L2 pref (pref is narrow by design)', () => {
    expect(isBroadcastEligible(
      mkEntry({ category: 'data' }),
      DEFAULT_BROADCAST_POLICY,
      { 'cache.sync_l2': false },
    )).toBe(true);
  });

  it('ai entry ignores the L2 pref (pref is narrow by design)', () => {
    expect(isBroadcastEligible(
      mkEntry({ category: 'ai' }),
      DEFAULT_BROADCAST_POLICY,
      { 'cache.sync_l2': false },
    )).toBe(true);
  });

  it('step entry broadcasts when pref explicitly true', () => {
    expect(isBroadcastEligible(
      mkEntry({ category: 'step' }),
      DEFAULT_BROADCAST_POLICY,
      { 'cache.sync_l2': true },
    )).toBe(true);
  });
});

describe('isBroadcastEligible — size cap', () => {
  it('below 64KB → eligible', () => {
    expect(isBroadcastEligible(mkEntry({ size_bytes: 50_000 }))).toBe(true);
  });

  it('above 64KB → NOT eligible (peer pulls on demand)', () => {
    expect(isBroadcastEligible(mkEntry({ size_bytes: 70_000 }))).toBe(false);
  });

  it('custom policy with tighter size cap', () => {
    const policy = { ...DEFAULT_BROADCAST_POLICY, maxBytes: 1024 };
    expect(isBroadcastEligible(mkEntry({ size_bytes: 2000 }), policy)).toBe(false);
  });
});

describe('isBroadcastEligible — custom categories', () => {
  it('policy can restrict to ai only', () => {
    const policy = { ...DEFAULT_BROADCAST_POLICY, categories: new Set(['ai']) };
    expect(isBroadcastEligible(mkEntry({ category: 'ai' }), policy)).toBe(true);
    expect(isBroadcastEligible(mkEntry({ category: 'data' }), policy)).toBe(false);
  });
});
