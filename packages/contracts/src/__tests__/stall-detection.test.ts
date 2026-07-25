/** D-181 Slice 3 — the pure stall-detection decision core.
 *
 *  Locks the §6 semantics: signal-emitting contracts flag on no progress for
 *  k·T; the generous fail-safe trips on the silent hard cap; and the
 *  kill-vs-flag split is by run origin (unattended kills on either, attended
 *  kills only on the fail-safe). */

import { describe, expect, it } from 'vitest';
import {
  evaluateStall,
  resolveProgressContract,
  runAttentionForTriggerSource,
  STALL_FACTOR_K,
  SILENT_OP_HARD_CAP_MS,
  DEFAULT_EXPECTED_INTERVAL_MS,
  UNATTENDED_TRIGGER_SOURCES,
  type StallEvalInput,
} from '../stall-detection.js';
import { PROGRESS_CONTRACTS, type ProgressContract } from '../execution-lane.js';
import { INGREDIENT_KINDS, type IngredientKind } from '../ingredient.js';

const base = (over: Partial<StallEvalInput>): StallEvalInput => ({
  contract: 'file-growth',
  origin: 'unattended',
  started_at: 0,
  last_signal_at: 0,
  now: 0,
  ...over,
});

describe('runAttentionForTriggerSource', () => {
  it('classifies the unattended trigger sources', () => {
    for (const ts of UNATTENDED_TRIGGER_SOURCES) {
      expect(runAttentionForTriggerSource(ts)).toBe('unattended');
    }
  });

  it('classifies interactive / unknown / absent sources as attended', () => {
    for (const ts of ['manual', 'mcp', 'slack', 'telegram', 'email', 'chat', 'bogus']) {
      expect(runAttentionForTriggerSource(ts)).toBe('attended');
    }
    expect(runAttentionForTriggerSource(undefined)).toBe('attended');
  });
});

describe('resolveProgressContract', () => {
  it('prefers the manifest declaration over the kind default', () => {
    expect(resolveProgressContract({ kind: 'service', progress_contract: 'file-growth' }))
      .toBe('file-growth');
  });

  it('falls back to silent for a service op with no declaration', () => {
    expect(resolveProgressContract({ kind: 'service' })).toBe('silent');
  });

  it('returns a valid contract for every ingredient kind', () => {
    for (const kind of INGREDIENT_KINDS) {
      const c = resolveProgressContract({ kind: kind as IngredientKind });
      expect(PROGRESS_CONTRACTS).toContain(c);
    }
  });
});

describe('evaluateStall — progress (no_progress) threshold', () => {
  const t = DEFAULT_EXPECTED_INTERVAL_MS['file-growth'];

  it('does not flag a slow-but-progressing op (recent signal)', () => {
    // idle just under k·T → not stalled, not flagged.
    const d = evaluateStall(base({
      last_signal_at: 1_000,
      now: 1_000 + STALL_FACTOR_K * t - 1,
    }));
    expect(d.flagged).toBe(false);
    expect(d.stalled).toBe(false);
    expect(d.reason).toBeNull();
  });

  it('flags + kills an unattended op idle for ≥ k·T', () => {
    const d = evaluateStall(base({
      origin: 'unattended',
      last_signal_at: 0,
      now: STALL_FACTOR_K * t,
    }));
    expect(d.flagged).toBe(true);
    expect(d.stalled).toBe(true);
    expect(d.reason).toBe('no_progress');
  });

  it('flags but does NOT kill an attended op idle for ≥ k·T (human governs)', () => {
    const d = evaluateStall(base({
      origin: 'attended',
      last_signal_at: 0,
      now: STALL_FACTOR_K * t,
    }));
    expect(d.flagged).toBe(true);
    expect(d.stalled).toBe(false);
    expect(d.reason).toBe('no_progress');
  });

  it('a fresh signal resets idleness (the slow-but-growing op is spared)', () => {
    const d = evaluateStall(base({
      origin: 'unattended',
      started_at: 0,
      last_signal_at: 10 * STALL_FACTOR_K * t, // signalled recently despite a long run
      now: 10 * STALL_FACTOR_K * t + 1,
    }));
    expect(d.flagged).toBe(false);
    expect(d.stalled).toBe(false);
  });
});

describe('evaluateStall — silent contract + the generous fail-safe', () => {
  it('a silent op is never flagged on no-progress (no signal to detect)', () => {
    const d = evaluateStall(base({
      contract: 'silent',
      origin: 'unattended',
      last_signal_at: 0,
      now: SILENT_OP_HARD_CAP_MS - 1,
    }));
    expect(d.flagged).toBe(false);
    expect(d.stalled).toBe(false);
  });

  it('a silent op is bounded only by the hard cap', () => {
    const d = evaluateStall(base({
      contract: 'silent',
      origin: 'unattended',
      started_at: 0,
      now: SILENT_OP_HARD_CAP_MS,
    }));
    expect(d.stalled).toBe(true);
    expect(d.reason).toBe('silent_cap');
  });

  it('the fail-safe kills even an ATTENDED op (fired then walked away)', () => {
    const d = evaluateStall(base({
      contract: 'file-growth',
      origin: 'attended',
      started_at: 0,
      last_signal_at: SILENT_OP_HARD_CAP_MS, // kept signalling, but ran past the cap
      now: SILENT_OP_HARD_CAP_MS,
    }));
    expect(d.stalled).toBe(true);
    expect(d.reason).toBe('silent_cap');
  });

  it('silent_cap takes precedence over no_progress in the reason', () => {
    const d = evaluateStall(base({
      contract: 'file-growth',
      origin: 'unattended',
      started_at: 0,
      last_signal_at: 0,
      now: SILENT_OP_HARD_CAP_MS, // both conditions met
    }));
    expect(d.stalled).toBe(true);
    expect(d.reason).toBe('silent_cap');
  });
});

describe('evaluateStall — overrides + edges', () => {
  it('honors custom T and k', () => {
    const d = evaluateStall(base({
      origin: 'unattended',
      expected_interval_ms: 1_000,
      factor_k: 3,
      last_signal_at: 0,
      now: 3_000,
    }));
    expect(d.stalled).toBe(true);
    expect(d.reason).toBe('no_progress');
  });

  it('clamps negative clock skew to zero idle/run', () => {
    const d = evaluateStall(base({
      started_at: 1_000,
      last_signal_at: 1_000,
      now: 500, // clock went backwards
    }));
    expect(d.idle_ms).toBe(0);
    expect(d.run_ms).toBe(0);
    expect(d.stalled).toBe(false);
  });

  it('reports idle_ms and run_ms', () => {
    const d = evaluateStall(base({ started_at: 0, last_signal_at: 200, now: 1_200 }));
    expect(d.run_ms).toBe(1_200);
    expect(d.idle_ms).toBe(1_000);
  });
});
