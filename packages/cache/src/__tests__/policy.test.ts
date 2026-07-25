import { describe, it, expect } from 'vitest';
import { derivePolicy } from '../policy.js';

describe('derivePolicy — action category never caches', () => {
  it.each(['read', 'write', 'admin', 'destructive'] as const)(
    'action + %s → disabled',
    (risk_tier) => {
      const p = derivePolicy('action', risk_tier, 300);
      expect(p.enabled).toBe(false);
      expect(p.ttl_seconds).toBe(0);
      expect(p.stream_on_write).toBe(false);
    },
  );
});

describe('derivePolicy — non-read risk tiers never cache', () => {
  it.each(['write', 'admin', 'destructive'] as const)(
    'data + %s → disabled',
    (risk_tier) => {
      const p = derivePolicy('data', risk_tier, 300);
      expect(p.enabled).toBe(false);
    },
  );

  it.each(['write', 'admin', 'destructive'] as const)(
    'ai + %s → disabled',
    (risk_tier) => {
      const p = derivePolicy('ai', risk_tier, 300);
      expect(p.enabled).toBe(false);
    },
  );
});

describe('derivePolicy — data + read', () => {
  it('enables caching with data MIN_TTL floor (60s)', () => {
    const p = derivePolicy('data', 'read', 10);
    expect(p.enabled).toBe(true);
    expect(p.ttl_seconds).toBe(60);
  });

  it('uses recipe_ttl when above floor', () => {
    const p = derivePolicy('data', 'read', 600);
    expect(p.ttl_seconds).toBe(600);
  });

  it('streams on write', () => {
    const p = derivePolicy('data', 'read', 60);
    expect(p.stream_on_write).toBe(true);
  });

  it('does NOT peer-query on miss (data is fast enough locally)', () => {
    const p = derivePolicy('data', 'read', 60);
    expect(p.peer_query_on_miss).toBe(false);
  });
});

describe('derivePolicy — ai + read', () => {
  it('enables caching with ai MIN_TTL floor (300s)', () => {
    const p = derivePolicy('ai', 'read', 10);
    expect(p.enabled).toBe(true);
    expect(p.ttl_seconds).toBe(300);
  });

  it('peer-queries on miss (AI is slow enough to benefit)', () => {
    const p = derivePolicy('ai', 'read', 300);
    expect(p.peer_query_on_miss).toBe(true);
  });

  it('streams on write', () => {
    const p = derivePolicy('ai', 'read', 300);
    expect(p.stream_on_write).toBe(true);
  });
});

describe('derivePolicy — broadcast size cap', () => {
  it('caps broadcast at 64KB for enabled policies', () => {
    const p = derivePolicy('ai', 'read', 300);
    expect(p.max_broadcast_bytes).toBe(64 * 1024);
  });

  it('disabled policy has no broadcast budget', () => {
    const p = derivePolicy('action', 'write', 300);
    expect(p.max_broadcast_bytes).toBe(0);
  });
});
