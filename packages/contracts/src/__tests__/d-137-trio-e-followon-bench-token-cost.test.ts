/** D-137 Trio #E follow-on — `computeBenchTokenCost` algebra.
 *
 *  Per the design: Recued tracks tokens, not cost. Rates drift,
 *  vary per pool, and each consumer wants its own source of truth.
 *  This helper is the per-row report-time multiplication: caller
 *  brings rates, helper returns cost in caller's unit.
 *
 *  Semantics covered:
 *    1. Bare input/output cost (no cache, no reasoning).
 *    2. Cache_read at a discounted rate.
 *    3. Cache_write at a surcharge rate.
 *    4. Reasoning at a separate rate (subset of output_tokens).
 *    5. Fallthrough: missing cache rate → input rate; missing
 *       reasoning rate → output rate.
 *    6. Zero-token edge case → zero cost.
 *    7. Anthropic-shape: input_tokens already includes cache (per
 *       the Trio #E adapter normalization). Cost is the same whether
 *       cache is broken out or rolled in, AS LONG AS rates are
 *       supplied consistently (cache_read rate matches input rate
 *       when caller wants flat billing).
 *    8. cache_read + cache_write together. */

import { describe, expect, it } from 'vitest';
import {
  BENCH_TOKEN_RATE_KEYS,
  BENCH_TOKEN_RATE_KEY_SET,
  computeBenchTokenCost,
} from '../d-150-bench-support.js';

describe('BENCH_TOKEN_RATE_KEYS closed list', () => {
  it('enrolls input + output + cache_read + cache_write + reasoning', () => {
    expect([...BENCH_TOKEN_RATE_KEYS].sort()).toEqual(
      ['cache_read', 'cache_write', 'input', 'output', 'reasoning'],
    );
  });

  it('set membership matches array', () => {
    for (const k of BENCH_TOKEN_RATE_KEYS) {
      expect(BENCH_TOKEN_RATE_KEY_SET.has(k)).toBe(true);
    }
    expect(BENCH_TOKEN_RATE_KEY_SET.size).toBe(BENCH_TOKEN_RATE_KEYS.length);
  });
});

describe('computeBenchTokenCost — pure per-row multiplication', () => {
  it('basic input/output with no cache or reasoning', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50 },
      { input: 1, output: 2 },
    );
    expect(cost).toBe(100 * 1 + 50 * 2);
  });

  it('zero tokens → zero cost', () => {
    expect(computeBenchTokenCost(
      { input_tokens: 0, output_tokens: 0 },
      { input: 999, output: 999 },
    )).toBe(0);
  });

  it('cache_read billed at cache_read rate when supplied', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 60 },
      { input: 10, output: 20, cache_read: 1 },
    );
    // non-cached input = 100 - 60 = 40 @ 10 = 400
    // cache_read = 60 @ 1 = 60
    // output = 50 @ 20 = 1000
    // total = 1460
    expect(cost).toBe(40 * 10 + 60 * 1 + 50 * 20);
  });

  it('cache_write billed at cache_write rate when supplied', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, cache_write_input_tokens: 30 },
      { input: 10, output: 20, cache_write: 12.5 },
    );
    // non-cached input = 100 - 30 = 70 @ 10 = 700
    // cache_write = 30 @ 12.5 = 375
    // output = 50 @ 20 = 1000
    expect(cost).toBe(70 * 10 + 30 * 12.5 + 50 * 20);
  });

  it('reasoning billed at reasoning rate (subset of output)', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, reasoning_tokens: 30 },
      { input: 10, output: 20, reasoning: 60 },
    );
    // input = 100 @ 10 = 1000
    // non-reasoning output = 50 - 30 = 20 @ 20 = 400
    // reasoning = 30 @ 60 = 1800
    expect(cost).toBe(100 * 10 + 20 * 20 + 30 * 60);
  });

  it('missing cache_read rate falls through to input rate', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 60 },
      { input: 10, output: 20 }, // no cache_read rate supplied
    );
    // All input bills at flat 10 (cache fallthrough) → 100 * 10 = 1000
    // output = 50 @ 20 = 1000
    expect(cost).toBe(100 * 10 + 50 * 20);
  });

  it('missing cache_write rate falls through to input rate', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, cache_write_input_tokens: 30 },
      { input: 10, output: 20 },
    );
    expect(cost).toBe(100 * 10 + 50 * 20);
  });

  it('missing reasoning rate falls through to output rate', () => {
    const cost = computeBenchTokenCost(
      { input_tokens: 100, output_tokens: 50, reasoning_tokens: 30 },
      { input: 10, output: 20 },
    );
    expect(cost).toBe(100 * 10 + 50 * 20);
  });

  it('Anthropic-shape: input_tokens already includes cache buckets', () => {
    // Per Trio #E P2 fold #2, Anthropic adapter folds cache into
    // input_tokens. Given matching rates, the cost is computed once
    // correctly regardless of how the buckets sum.
    const usage = {
      input_tokens: 100, // = 70 non-cached + 30 cache_read normalized
      output_tokens: 50,
      cache_read_input_tokens: 30,
    };
    const flatBilling = computeBenchTokenCost(usage, { input: 10, output: 20 });
    const discountedBilling = computeBenchTokenCost(usage, {
      input: 10,
      output: 20,
      cache_read: 1, // 90% discount
    });
    // Flat: 100 × 10 + 50 × 20 = 2000
    // Discounted: 70 × 10 + 30 × 1 + 50 × 20 = 1730
    expect(flatBilling).toBe(2000);
    expect(discountedBilling).toBe(1730);
    expect(discountedBilling).toBeLessThan(flatBilling);
  });

  it('cache_read + cache_write together', () => {
    const cost = computeBenchTokenCost(
      {
        input_tokens: 100, // 50 non-cached + 30 read + 20 write
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_write_input_tokens: 20,
      },
      { input: 10, output: 20, cache_read: 1, cache_write: 12.5 },
    );
    // non-cached = 50 @ 10 = 500
    // cache_read = 30 @ 1 = 30
    // cache_write = 20 @ 12.5 = 250
    // output = 50 @ 20 = 1000
    expect(cost).toBe(500 + 30 + 250 + 1000);
  });

  it('floors to zero when cache buckets exceed input_tokens (defensive)', () => {
    // Caller violated the contract by supplying cache > input. The
    // helper does NOT throw — it floors the non-cached portion to 0
    // so downstream cost is at least non-negative for that bucket.
    const cost = computeBenchTokenCost(
      {
        input_tokens: 10,
        output_tokens: 50,
        cache_read_input_tokens: 100, // bogus: > input
      },
      { input: 10, output: 20, cache_read: 1 },
    );
    // non-cached input floored to 0
    expect(cost).toBe(0 + 100 * 1 + 50 * 20);
  });

  it('handles fractional rates ($ per Mtok = 1e-6 per token)', () => {
    // Anthropic Claude Opus rate ~$15/Mtok input, $75/Mtok output.
    // 1 Mtok input = 1_000_000 tokens × 15e-6 = $15.
    const cost = computeBenchTokenCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      { input: 15e-6, output: 75e-6 },
    );
    expect(cost).toBeCloseTo(15 + 75, 6);
  });

  it('Codex P2 fold #1 — unit guard: raw Mtok values produce inflated cost', () => {
    // The helper does NOT auto-detect units. A caller passing raw
    // published Mtok numbers (`input: 15` for "$15/Mtok") against a
    // 1M-token row gets a wildly inflated number. The test pins this
    // behaviour so future readers see the failure mode explicitly +
    // pairs with the docstring that says "convert Mtok to per-token
    // before passing".
    const inflated = computeBenchTokenCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      { input: 15, output: 75 }, // WRONG: raw Mtok values
    );
    expect(inflated).toBe(90_000_000); // 15M + 75M = 90M, NOT 90

    // Caller scaled correctly:
    const correct = computeBenchTokenCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      { input: 15 / 1_000_000, output: 75 / 1_000_000 },
    );
    expect(correct).toBeCloseTo(90, 6);
  });
});
