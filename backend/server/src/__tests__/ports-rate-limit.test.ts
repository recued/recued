/** D-148 P6 — token-bucket rate limiter primitive. */

import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../ports/common/rate-limit.js';

describe('createRateLimiter — WS shape (100 rpc/sec)', () => {
  it('allows the first burst up to capacity', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 100, refill_window_ms: 1000, now: () => t });
    for (let i = 0; i < 100; i += 1) {
      const d = limiter.consume('client-1');
      expect(d.allowed).toBe(true);
    }
  });

  it('denies the 101st call inside the window', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 100, refill_window_ms: 1000, now: () => t });
    for (let i = 0; i < 100; i += 1) limiter.consume('c1');
    const d = limiter.consume('c1');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.retry_after_ms).toBeGreaterThan(0);
  });

  it('refills proportional to elapsed time', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 100, refill_window_ms: 1000, now: () => t });
    for (let i = 0; i < 100; i += 1) limiter.consume('c1');
    expect(limiter.consume('c1').allowed).toBe(false);
    // After 100ms (10% of window) the bucket should have ~10 tokens.
    t = 100;
    let allowed = 0;
    for (let i = 0; i < 12; i += 1) {
      if (limiter.consume('c1').allowed) allowed += 1;
    }
    // Floor of 10 — 10 or 11 acceptable depending on rounding.
    expect(allowed).toBeGreaterThanOrEqual(9);
    expect(allowed).toBeLessThanOrEqual(11);
  });

  it('isolates per-key state', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 5, refill_window_ms: 1000, now: () => t });
    for (let i = 0; i < 5; i += 1) limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('reset(key) drops the per-key bucket so the burst restarts', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 3, refill_window_ms: 1000, now: () => t });
    for (let i = 0; i < 3; i += 1) limiter.consume('c');
    expect(limiter.consume('c').allowed).toBe(false);
    limiter.reset('c');
    expect(limiter.consume('c').allowed).toBe(true);
  });

  it('clear() drops every bucket', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 1, refill_window_ms: 1000, now: () => t });
    for (const k of ['a', 'b']) {
      expect(limiter.consume(k).allowed).toBe(true);
      expect(limiter.consume(k).allowed).toBe(false);
    }
    limiter.clear();
    for (const k of ['a', 'b']) {
      expect(limiter.consume(k).allowed).toBe(true);
    }
  });
});

describe('createRateLimiter — MCP shape (60 rpc/min)', () => {
  it('60 calls succeed in the first minute, 61st fails', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 60, refill_window_ms: 60_000, now: () => t });
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.consume('mcp-tok').allowed).toBe(true);
    }
    expect(limiter.consume('mcp-tok').allowed).toBe(false);
  });

  it('after one window, bucket is fully refilled', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 60, refill_window_ms: 60_000, now: () => t });
    for (let i = 0; i < 60; i += 1) limiter.consume('mcp-tok');
    t = 60_000;
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.consume('mcp-tok').allowed).toBe(true);
    }
    expect(limiter.consume('mcp-tok').allowed).toBe(false);
  });
});

describe('createRateLimiter — max_keys bounded Map (rotating-key memory bound)', () => {
  it('evicts the oldest-inserted bucket when a new key trips the cap', () => {
    const t = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refill_window_ms: 1000,
      now: () => t,
      max_keys: 2,
    });
    limiter.consume('a'); // a: spent (capacity 1)
    limiter.consume('b'); // b: spent — Map = {a, b}
    // 'a' is still tracked + empty → denied.
    expect(limiter.consume('a').allowed).toBe(false);
    // A third distinct key trips the cap → oldest-inserted ('a') evicted.
    limiter.consume('c'); // Map was {a, b}; +c → size 3 > 2 → evict 'a'
    // 'a' was evicted → its next consume gets a FRESH full bucket (allowed).
    // Mutation check: without eviction it would still be the spent bucket → denied.
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('is unbounded when max_keys is omitted (back-compat)', () => {
    const t = 0;
    const limiter = createRateLimiter({ capacity: 1, refill_window_ms: 1000, now: () => t });
    limiter.consume('a');
    limiter.consume('b');
    limiter.consume('c');
    // No eviction → 'a' is still the spent bucket → denied.
    expect(limiter.consume('a').allowed).toBe(false);
  });
});
