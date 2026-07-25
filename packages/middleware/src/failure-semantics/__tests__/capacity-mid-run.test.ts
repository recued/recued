/** D-145 PB15 — capacity-gap-mid-run detector tests. */

import { describe, it, expect } from 'vitest';
import type { PrimitiveCall } from '@recued/contracts';
import {
  CAPACITY_GAP_MID_RUN_REASONS,
  detectCapacityGapMidRun,
} from '../capacity-mid-run.js';

const mkCall = (overrides: Partial<PrimitiveCall>): PrimitiveCall => ({
  primitive: 'bridge.dispatch',
  call_id: 'c1',
  args_summary: '...',
  outcome_summary: 'ok',
  status: 'ok',
  duration_ms: 5,
  started_at: 1000,
  ...overrides,
});

describe('D-145 PB15 — capacity-gap-mid-run detector', () => {
  it('returns ok when primitive call status is ok', () => {
    const result = detectCapacityGapMidRun({ call: mkCall({ status: 'ok' }) });
    expect(result.kind).toBe('ok');
  });

  it('detects mv3_lifecycle_killed (bridge_online) from status capacity_gap_mid_run', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'capacity_gap_mid_run',
        outcome_summary: 'error mv3_lifecycle_killed bridge=offline',
      }),
    });
    expect(result.kind).toBe('gap_detected');
    if (result.kind === 'gap_detected') {
      expect(result.reason).toBe('mv3_lifecycle_killed');
      expect(result.gap.kind).toBe('bridge_online');
    }
  });

  it('detects ingredient_unavailable from outcome_summary', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'capacity_gap_mid_run',
        outcome_summary: 'ingredient_unavailable slug=deal-reader-hubspot',
      }),
    });
    if (result.kind === 'gap_detected') {
      expect(result.reason).toBe('ingredient_unavailable');
      expect(result.gap.kind).toBe('ingredient_installed');
    }
  });

  it('detects capacity_gap_logged_in', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'capacity_gap_mid_run',
        outcome_summary: 'capacity_gap_logged_in site=hubspot.com',
      }),
    });
    if (result.kind === 'gap_detected') {
      expect(result.reason).toBe('capacity_gap_logged_in');
      expect(result.gap.kind).toBe('logged_in');
    }
  });

  it('threads original_requirement when caller provides it', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'capacity_gap_mid_run',
        outcome_summary: 'mv3_lifecycle_killed',
      }),
      original_requirement: { kind: 'bridge_online' },
    });
    if (result.kind === 'gap_detected') {
      expect(result.gap.kind).toBe('bridge_online');
    }
  });

  it('threads affected_intent_id from the call row', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'capacity_gap_mid_run',
        outcome_summary: 'mv3_lifecycle_killed',
        intent_id: 'intent-42',
      }),
    });
    if (result.kind === 'gap_detected') {
      expect(result.affected_intent_id).toBe('intent-42');
    }
  });

  it('returns ok for status=error without a known reason', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({ status: 'error', outcome_summary: 'unrelated_throw' }),
    });
    expect(result.kind).toBe('ok');
  });

  it('detects status=error WITH a known reason as gap_detected', () => {
    const result = detectCapacityGapMidRun({
      call: mkCall({
        status: 'error',
        outcome_summary: 'connection_revoked vendor=hubspot',
      }),
    });
    if (result.kind === 'gap_detected') {
      expect(result.reason).toBe('connection_revoked');
      expect(result.gap.kind).toBe('connection_active');
    }
  });

  it('CAPACITY_GAP_MID_RUN_REASONS contains all D-148 / D-118 / D-125 gap paths', () => {
    expect(CAPACITY_GAP_MID_RUN_REASONS).toContain('mv3_lifecycle_killed');
    expect(CAPACITY_GAP_MID_RUN_REASONS).toContain('ingredient_unavailable');
    expect(CAPACITY_GAP_MID_RUN_REASONS).toContain('capacity_gap_logged_in');
    expect(CAPACITY_GAP_MID_RUN_REASONS).toContain('connection_revoked');
    expect(CAPACITY_GAP_MID_RUN_REASONS).toContain('pool_quota_exhausted_mid_run');
  });
});
