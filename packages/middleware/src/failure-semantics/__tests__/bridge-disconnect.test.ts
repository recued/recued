/** D-145 PB15 — bridge-disconnect-after-Dry-Run tests. */

import { describe, it, expect } from 'vitest';
import type { CapacityCheck, RecuedPlan } from '@recued/contracts';
import { decideBridgeDisconnectPath } from '../bridge-disconnect.js';

const mkPlan = (overrides: Partial<RecuedPlan> = {}): RecuedPlan =>
  ({
    plan_id: 'plan-1',
    goal_id: 'goal-1',
    user_request: 'do x',
    considered_sources: [],
    capacity_checks: [],
    included_context: [],
    omitted_context: [],
    selection_trace: {
      recipe_candidates_considered: 0,
      recipe_candidates_selected: [],
      recipe_candidates_dropped: [],
      commitment_context_pulled: false,
      commitment_rows_count: 0,
      catalog_section_counts: {},
      catalog_short_circuited: false,
    },
    model_tier: 'fast',
    ai_provider: '',
    ai_model_id: '',
    primitive_calls: [],
    status: 'preview_no_op',
    user_visible_internal_steps: [],
    user_response: '',
    user_events: [],
    provenance_links: [],
    audit_policy: { retain_for_days: 90, high_assurance: false, redact_user_request: false },
    started_at: 1000,
    completed_at: 1100,
    ...overrides,
  });

const mkCheck = (overrides: Partial<CapacityCheck>): CapacityCheck => ({
  kind: 'bridge_online',
  capacity_key: 'bridge_online',
  ok: true,
  cached: false,
  checked_at: 1000,
  ...overrides,
});

describe('D-145 PB15 — bridge-disconnect-after-Dry-Run', () => {
  it('proceeds when bridge_online check is ok', () => {
    const result = decideBridgeDisconnectPath({
      dry_run_plan: mkPlan(),
      confirm_time_walks: [mkCheck({ ok: true })],
    });
    expect(result.kind).toBe('proceed');
  });

  it('halts cancelled_capacity_gap when bridge_online check fails', () => {
    const result = decideBridgeDisconnectPath({
      dry_run_plan: mkPlan({ plan_id: 'dr-1' }),
      confirm_time_walks: [mkCheck({ ok: false })],
    });
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.result.status).toBe('cancelled_capacity_gap');
      expect(result.result.failure_class).toBe('capacity');
      expect(result.result.user_response).toMatch(/dr-1/);
    }
  });

  it('degrades to fallback when bridge gap + fallback available', () => {
    const result = decideBridgeDisconnectPath({
      dry_run_plan: mkPlan({ plan_id: 'dr-2' }),
      confirm_time_walks: [mkCheck({ ok: false })],
      has_bridge_free_fallback: true,
    });
    expect(result.kind).toBe('degrade_to_fallback');
    if (result.kind === 'degrade_to_fallback') {
      expect(result.note).toMatch(/dr-2/);
    }
  });

  it('proceeds when bridge_online not in walk list (no bridge requirement)', () => {
    const result = decideBridgeDisconnectPath({
      dry_run_plan: mkPlan(),
      confirm_time_walks: [
        mkCheck({ kind: 'ingredient_installed', capacity_key: 'ingredient_installed:foo', ok: true }),
      ],
    });
    expect(result.kind).toBe('proceed');
  });

  it('ignores non-bridge_online check failures (only bridge gap triggers)', () => {
    const result = decideBridgeDisconnectPath({
      dry_run_plan: mkPlan(),
      confirm_time_walks: [
        mkCheck({ kind: 'bridge_online', ok: true }),
        mkCheck({ kind: 'logged_in', capacity_key: 'logged_in:hubspot', ok: false }),
      ],
    });
    expect(result.kind).toBe('proceed');
  });
});
