/** D-145 PB4 — composition strategy descriptor tests.
 *
 *  Per § B.3.1 + § B.3.3. Pins the per-tier strategy bag the
 *  orchestrator policy + PB17 Stage 2 composer read. */

import { describe, it, expect } from 'vitest';

import {
  COMPOSITION_STRATEGIES,
  COMPOSITION_STRATEGY_KINDS,
  resolveCompositionStrategy,
} from '../tier-strategy/composition-strategy.js';

describe('D-145 PB4 — composition strategy table (§ B.3.1)', () => {
  it('fast tier is narrow_and_rank with engine pre-ranking', () => {
    const s = COMPOSITION_STRATEGIES.fast;
    expect(s.kind).toBe('narrow_and_rank');
    expect(s.engine_pre_ranks).toBe(true);
    expect(s.attach_provenance_breadcrumbs).toBe(false);
    expect(s.allows_reasoning_trace).toBe(false);
  });

  it('mid tier is narrow_and_merge — engine narrows, AI merges', () => {
    const s = COMPOSITION_STRATEGIES.mid;
    expect(s.kind).toBe('narrow_and_merge');
    expect(s.engine_pre_ranks).toBe(false);
    expect(s.attach_provenance_breadcrumbs).toBe(false);
    expect(s.allows_reasoning_trace).toBe(false);
  });

  it('reasoning tier is governed_exploration with provenance breadcrumbs + reasoning trace', () => {
    const s = COMPOSITION_STRATEGIES.reasoning;
    expect(s.kind).toBe('governed_exploration');
    expect(s.engine_pre_ranks).toBe(false);
    expect(s.attach_provenance_breadcrumbs).toBe(true);
    expect(s.allows_reasoning_trace).toBe(true);
  });

  it('budget proxies to TIER_PACKET_BUDGETS at every tier', () => {
    expect(COMPOSITION_STRATEGIES.fast.budget.max_packet_bytes).toBe(1_024);
    expect(COMPOSITION_STRATEGIES.mid.budget.max_packet_bytes).toBe(8_192);
    expect(COMPOSITION_STRATEGIES.reasoning.budget.max_packet_bytes).toBe(32_768);
  });

  it('resolveCompositionStrategy returns the table entry', () => {
    expect(resolveCompositionStrategy('fast')).toBe(COMPOSITION_STRATEGIES.fast);
    expect(resolveCompositionStrategy('mid')).toBe(COMPOSITION_STRATEGIES.mid);
    expect(resolveCompositionStrategy('reasoning')).toBe(COMPOSITION_STRATEGIES.reasoning);
  });

  it('COMPOSITION_STRATEGY_KINDS pins exactly 3 closed-list entries', () => {
    expect(COMPOSITION_STRATEGY_KINDS).toEqual([
      'narrow_and_rank',
      'narrow_and_merge',
      'governed_exploration',
    ]);
  });
});
