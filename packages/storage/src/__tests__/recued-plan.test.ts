/** D-145 PB2 — RecuedPlan store storage discipline tests.
 *
 *  Covers persistence + retrieval + listing windows + retention pruning
 *  + idempotent append + runtime validator gate. Server-side signing
 *  round-trip lives in `backend/server/src/__tests__/d-145-phase-pb2-
 *  signing.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  REDACTED_USER_REQUEST_MARKER,
  RecuedPlanValidationError,
  type RecuedPlan,
} from '@recued/contracts';
import { createInMemoryCollection } from '../in-memory.js';
import { RECUED_PLAN_KIND, createRecuedPlanStore } from '../recued-plan.js';

const baseSelectionTrace = () => ({
  recipe_candidates_considered: 0,
  recipe_candidates_selected: [],
  recipe_candidates_dropped: [],
  commitment_context_pulled: false,
  commitment_rows_count: 0,
  catalog_section_counts: {},
  catalog_short_circuited: false,
});

const buildBasePlan = (overrides: Partial<RecuedPlan> = {}): RecuedPlan => ({
  plan_id: 'plan-001',
  goal_id: 'goal-001',
  user_request: 'baseline request',
  considered_sources: [],
  capacity_checks: [],
  included_context: [],
  omitted_context: [],
  selection_trace: baseSelectionTrace(),
  model_tier: 'fast',
  ai_provider: 'anthropic',
  ai_model_id: 'claude-haiku-4-5',
  primitive_calls: [],
  status: 'completed',
  user_visible_internal_steps: [],
  user_response: 'ok',
  user_events: [],
  provenance_links: [],
  audit_policy: {
    retain_for_days: 90,
    high_assurance: false,
    redact_user_request: false,
  },
  started_at: 1_736_000_000_000,
  completed_at: 1_736_000_001_000,
  ...overrides,
});

describe('D-145 PB2 — RecuedPlanStore.append + get', () => {
  it("RECUED_PLAN_KIND mirrors contracts' memory entry kind", () => {
    expect(RECUED_PLAN_KIND).toBe('recued_plan');
  });

  it('persists a valid plan + retrieves byte-identical', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    const plan = buildBasePlan();
    await store.append(plan);
    const got = await store.get(plan.plan_id);
    expect(got).toEqual(plan);
  });

  it('get returns null for missing plan_id', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('append is idempotent on plan_id (overwrite-on-rewrite)', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    const v1 = buildBasePlan({ user_response: 'first' });
    const v2 = buildBasePlan({ user_response: 'second' });
    await store.append(v1);
    await store.append(v2);
    const got = await store.get('plan-001');
    expect(got?.user_response).toBe('second');
    expect(await store.size()).toBe(1);
  });

  it('runtime validator rejects malformed plans (gate at write)', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    const bad = buildBasePlan();
    (bad as { status: string }).status = 'definitely_not_a_status';
    await expect(store.append(bad)).rejects.toThrowError(
      RecuedPlanValidationError,
    );
    expect(await store.size()).toBe(0);
  });

  it('rejects content_stored: true bypassed via cast', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    const bad = buildBasePlan({
      omitted_context: [
        {
          source_ref: 'data.contact.x.body_inline',
          reason_code: 'privacy_class',
          // synthetic violation — bypasses tsc literal-false gate
          content_stored: true,
        } as unknown as RecuedPlan['omitted_context'][number],
      ],
    });
    await expect(store.append(bad)).rejects.toThrowError(
      RecuedPlanValidationError,
    );
  });
});

describe('D-145 PB2 — RecuedPlanStore.list filters', () => {
  const seed = async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    await store.append(
      buildBasePlan({ plan_id: 'p-1', goal_id: 'g-1', started_at: 1_000 }),
    );
    await store.append(
      buildBasePlan({ plan_id: 'p-2', goal_id: 'g-2', started_at: 2_000 }),
    );
    await store.append(
      buildBasePlan({
        plan_id: 'p-3',
        goal_id: 'g-1',
        started_at: 3_000,
        status: 'cancelled_by_user',
        failure_class: 'capacity',
      }),
    );
    return store;
  };

  it('default order is newest-first by started_at', async () => {
    const store = await seed();
    const list = await store.list();
    expect(list.map((p) => p.plan_id)).toEqual(['p-3', 'p-2', 'p-1']);
  });

  it("opts.order='asc' reverses to oldest-first", async () => {
    const store = await seed();
    const list = await store.list({ order: 'asc' });
    expect(list.map((p) => p.plan_id)).toEqual(['p-1', 'p-2', 'p-3']);
  });

  it('opts.limit caps the result', async () => {
    const store = await seed();
    const list = await store.list({ limit: 2 });
    expect(list).toHaveLength(2);
  });

  it('opts.since + opts.until window inclusive lower / exclusive upper', async () => {
    const store = await seed();
    const list = await store.list({ since: 2_000, until: 3_000 });
    expect(list.map((p) => p.plan_id)).toEqual(['p-2']);
  });

  it('opts.goal_id filters', async () => {
    const store = await seed();
    const list = await store.list({ goal_id: 'g-1' });
    expect(list.map((p) => p.plan_id)).toEqual(['p-3', 'p-1']);
  });

  it('opts.status filters', async () => {
    const store = await seed();
    const list = await store.list({ status: 'cancelled_by_user' });
    expect(list.map((p) => p.plan_id)).toEqual(['p-3']);
  });
});

describe('D-145 PB2 — RecuedPlanStore.delete + clearOlderThan + clearAll', () => {
  it('delete returns true on hit / false on miss', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    await store.append(buildBasePlan());
    expect(await store.delete('plan-001')).toBe(true);
    expect(await store.delete('plan-001')).toBe(false);
    expect(await store.size()).toBe(0);
  });

  it('clearOlderThan drops by started_at cutoff', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    await store.append(buildBasePlan({ plan_id: 'old', started_at: 100 }));
    await store.append(buildBasePlan({ plan_id: 'mid', started_at: 500 }));
    await store.append(buildBasePlan({ plan_id: 'new', started_at: 1_000 }));
    const removed = await store.clearOlderThan(500);
    expect(removed).toBe(1);
    expect(await store.size()).toBe(2);
    expect(await store.get('old')).toBeNull();
    expect(await store.get('mid')).not.toBeNull();
  });

  it('clearAll empties the store', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    await store.append(buildBasePlan({ plan_id: 'a' }));
    await store.append(buildBasePlan({ plan_id: 'b' }));
    await store.clearAll();
    expect(await store.size()).toBe(0);
  });
});

describe('D-145 PB2 — redact_user_request shape persists round-trip', () => {
  it('redacted plan persists with the marker + flag', async () => {
    const store = createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());
    const plan = buildBasePlan({
      user_request: REDACTED_USER_REQUEST_MARKER,
      audit_policy: {
        retain_for_days: 90,
        high_assurance: false,
        redact_user_request: true,
      },
    });
    await store.append(plan);
    const got = await store.get(plan.plan_id);
    expect(got?.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    expect(got?.audit_policy.redact_user_request).toBe(true);
  });
});
