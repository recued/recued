/** D-145 PB3 — orchestrator end-to-end tests.
 *
 *  executeRecuedRequest correctness:
 *    - validates RecuedRequest before deriving plan
 *    - dispatches policy callback with PlanDraft
 *    - appends PrimitiveCall rows in policy-emitted order
 *    - capacity_spec rows feed plan.capacity_checks[]
 *    - applies redact_user_request stamping
 *    - merges audit_policy with substrate defaults
 *    - validates composition + plan IR before persisting
 *    - persists only after every validator passes
 *    - Dry Run preview path produces preview_no_op plan */

import { describe, it, expect } from 'vitest';

import {
  CompositionRuleError,
  executeRecuedRequest,
  type ExecuteRecuedRequestContext,
  type OrchestrationPolicy,
} from '../orchestrator/index.js';
import {
  createPrimitiveRegistry,
  type PrimitiveRegistryDeps,
} from '../primitives/index.js';
import * as capacity from '../capacity/index.js';

import {
  REDACTED_USER_REQUEST_MARKER,
  RecuedRequestValidationError,
  type RecuedPlan,
  type RecuedRequest,
} from '@recued/contracts';

const buildStubDeps = (): PrimitiveRegistryDeps => {
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry({
    bridgeStateProbe: { getOnline: () => true, getLoggedIn: () => true },
    ingredientRegistryProbe: {
      isInstalled: () => true,
      getBumpedAt: () => 0,
      getSelectorTtlMs: () => 7 * 24 * 60 * 60 * 1000,
    },
    permissionRegistryProbe: { hasPermission: () => true },
    connectionHealthProbe: { isHealthy: () => true },
    sourceEnablementProbe: { hasEnabledSource: () => true },
    quotaHeadroomProbe: { hasHeadroom: () => true },
    warehouseRefResolver: { resolve: () => true },
  });
  return {
    capacity_spec: {
      registry,
      cache,
      walkContext: {
        audit_emitter: capacity.createCapacityAuditEmitter({ logActivity() {} }),
        transparency_emitter: capacity.createNoopTransparencyEmitter(),
      },
    },
    'data.fetch': {
      adapter: { fetch: async () => ({ rows: [{ id: 1 }], total_count: 1 }) },
    },
    'memory.recall': {
      adapter: { recall: async () => ({ entries: [], total_count: 0 }) },
    },
    'memory.write': {
      adapter: { write: async () => ({ memory_id: 'm1', provenance_edges_written: 0 }) },
    },
    'enrichment.lookup': {
      adapter: { lookup: async () => ({ rows: [], total_count: 0 }) },
    },
    'ai.synthesize': {
      adapter: {
        synthesize: async () => ({
          response: 'hello',
          events: [],
          provider: 'openai',
          model_id: 'gpt-4o-mini',
          total_tokens: 100,
        }),
      },
    },
    'bridge.dispatch': {
      adapter: { dispatch: async () => ({ success: true }) },
    },
    'recipe.invoke': {
      adapter: { invoke: async () => ({ success: true }) },
    },
    'approval.request': {
      adapter: { request: async () => ({ decision: 'approved', responded_at: 1000 }) },
    },
    'provenance.link': {
      adapter: { link: async () => ({ ok: true, edges_written: 0 }) },
    },
  };
};

const buildCtx = (overrides: Partial<ExecuteRecuedRequestContext> = {}): ExecuteRecuedRequestContext => ({
  registry: createPrimitiveRegistry(buildStubDeps()),
  policy: async () => ({ status: 'completed', user_response: 'ok' }),
  default_tier: 'fast',
  default_ai_provider: 'openai',
  default_ai_model_id: 'gpt-4o-mini',
  now: () => 1000,
  mint_id: () => 'fixed-id',
  ...overrides,
});

const baseRequest: RecuedRequest = {
  request_id: 'req-1',
  user_request: 'what did I commit to mom?',
  surface: 'webclient',
};

// ── Validation ──────────────────────────────────────────────────────

describe('executeRecuedRequest — validation', () => {
  it('throws RecuedRequestValidationError on missing request_id', async () => {
    await expect(
      executeRecuedRequest({ ...baseRequest, request_id: '' }, buildCtx()),
    ).rejects.toBeInstanceOf(RecuedRequestValidationError);
  });

  it('throws on unknown surface', async () => {
    await expect(
      executeRecuedRequest(
        { ...baseRequest, surface: 'unknown' as never },
        buildCtx(),
      ),
    ).rejects.toBeInstanceOf(RecuedRequestValidationError);
  });

  it('passes valid request through to policy', async () => {
    let policyCalled = false;
    const ctx = buildCtx({
      policy: async () => {
        policyCalled = true;
        return { status: 'completed', user_response: 'ok' };
      },
    });
    await executeRecuedRequest(baseRequest, ctx);
    expect(policyCalled).toBe(true);
  });
});

// ── Plan IR scaffolding ─────────────────────────────────────────────

describe('executeRecuedRequest — plan IR scaffolding', () => {
  it('stamps plan_id from request_id', async () => {
    const plan = await executeRecuedRequest(baseRequest, buildCtx());
    expect(plan.plan_id).toBe('req-1');
  });

  it('stamps goal_id from request.goal_id when present', async () => {
    const plan = await executeRecuedRequest({ ...baseRequest, goal_id: 'goal-A' }, buildCtx());
    expect(plan.goal_id).toBe('goal-A');
  });

  it('defaults goal_id to request_id when omitted', async () => {
    const plan = await executeRecuedRequest(baseRequest, buildCtx());
    expect(plan.goal_id).toBe('req-1');
  });

  it('stamps started_at from request.received_at when present', async () => {
    const plan = await executeRecuedRequest(
      { ...baseRequest, received_at: 500 },
      buildCtx(),
    );
    expect(plan.started_at).toBe(500);
  });

  it('D-164 P6.7 — selection_trace defaults to an empty catalog-assembly snapshot', async () => {
    const plan = await executeRecuedRequest(
      {
        ...baseRequest,
        intents: [
          { intent_id: 'i1', kind: 'commitment_extract', topic_tags: ['email'] },
        ],
        context_breadth: 'wide',
      },
      buildCtx(),
    );
    expect(plan.selection_trace.catalog_section_counts).toEqual({});
    expect(plan.selection_trace.catalog_short_circuited).toBe(false);
  });
});

// ── Policy + draft ──────────────────────────────────────────────────

describe('executeRecuedRequest — policy + draft', () => {
  it('appends PrimitiveCall rows the policy invokes', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      await draft.invoke('memory.recall', { entity_id: 'mom' });
      await draft.invoke('enrichment.lookup', { topic: 'preferred_channel_by_contact' });
      await draft.invoke('ai.synthesize', {
        tier: 'fast',
        pool_policy: 'free_only',
        packet: {},
      });
      await draft.invoke('memory.write', {
        kind: 'recipe_insight',
        summary: 's',
        reason_code: 'response_synthesized',
      });
      return { status: 'completed', user_response: 'mom said yes' };
    };
    const ctx = buildCtx({ policy });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.primitive_calls.length).toBe(4);
    expect(plan.primitive_calls.map((c) => c.primitive)).toEqual([
      'memory.recall',
      'enrichment.lookup',
      'ai.synthesize',
      'memory.write',
    ]);
  });

  it('feeds capacity_spec checks into plan.capacity_checks[]', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      await draft.invoke('capacity_spec', {
        spec: {
          capacities: [{ kind: 'bridge_online' }],
          remediations: { bridge_online: { action: 'noop', user_facing_copy: '' } },
        },
      });
      return { status: 'completed', user_response: 'ok' };
    };
    const ctx = buildCtx({ policy });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.capacity_checks.length).toBe(1);
    expect(plan.capacity_checks[0]!.kind).toBe('bridge_online');
  });

  it('lets policy include + omit context entries', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      draft.includeContext({
        source_ref: 'data.contact.<contact_id>.profile',
        content_class: 'contact_profile_meta',
        persist_policy: 'persist',
      });
      draft.omitContext({
        source_ref: 'social.facebook.lookup',
        reason_code: 'privacy_class',
        content_stored: false,
      });
      return { status: 'completed', user_response: 'ok' };
    };
    const ctx = buildCtx({ policy });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.included_context.length).toBe(1);
    expect(plan.omitted_context.length).toBe(1);
  });

  it('snapshot returns the freshest plan after every invoke', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      expect(draft.snapshot().primitive_calls.length).toBe(0);
      await draft.invoke('memory.recall', {});
      expect(draft.snapshot().primitive_calls.length).toBe(1);
      return { status: 'completed', user_response: 'ok' };
    };
    await executeRecuedRequest(baseRequest, buildCtx({ policy }));
  });
});

// ── Privacy: redact_user_request ────────────────────────────────────

describe('executeRecuedRequest — redact_user_request', () => {
  it('stamps the redaction marker when audit_policy.redact_user_request is true', async () => {
    const plan = await executeRecuedRequest(
      {
        ...baseRequest,
        user_request: 'sensitive content',
        audit_policy: { redact_user_request: true },
      },
      buildCtx(),
    );
    expect(plan.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
  });

  it('preserves user_request when redaction is false', async () => {
    const plan = await executeRecuedRequest(baseRequest, buildCtx());
    expect(plan.user_request).toBe('what did I commit to mom?');
  });

  it('merges audit_policy with substrate defaults', async () => {
    const plan = await executeRecuedRequest(
      { ...baseRequest, audit_policy: { retain_for_days: 30 } },
      buildCtx(),
    );
    expect(plan.audit_policy.retain_for_days).toBe(30);
    expect(plan.audit_policy.high_assurance).toBe(false);
    expect(plan.audit_policy.redact_user_request).toBe(false);
  });
});

// ── Composition rule enforcement ────────────────────────────────────

describe('executeRecuedRequest — composition rules', () => {
  it('refuses to persist when composition rule violated (pre-execution catch)', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      // Invokes bridge.dispatch without preceding capacity_spec — rule 6.
      // Codex P1 fold: pre-execution gate throws CompositionRuleError;
      // the orchestrator catches it + maps to cancelled_capacity_gap
      // status without persisting (per § B.15.4 capacity gap).
      await draft.invoke('bridge.dispatch', { kind: 'click', ingredient_slug: 'foo' });
      return { status: 'completed', user_response: 'oops' };
    };
    const persisted: RecuedPlan[] = [];
    const ctx = buildCtx({
      policy,
      persist: async (p) => {
        persisted.push(p);
      },
    });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.status).toBe('cancelled_capacity_gap');
    expect(plan.failure_class).toBe('capacity');
    expect(persisted.length).toBe(0);
  });

  it('still refuses to persist on post-flight composition violation (e.g. memory.write before ai.synthesize)', async () => {
    // This path doesn't go through the bridge.dispatch pre-check —
    // tests the validator-at-finalization branch.
    const policy: OrchestrationPolicy = async (draft) => {
      // memory.write before any ai.synthesize ok — rule 5 violation,
      // not caught pre-execution.
      await draft.invoke('memory.recall', {});
      await draft.invoke('memory.write', {
        kind: 'recipe_insight',
        summary: 's',
        reason_code: 'r',
      });
      await draft.invoke('enrichment.lookup', { topic: 'preferred_channel_by_contact' });
      await draft.invoke('ai.synthesize', {
        tier: 'fast',
        pool_policy: 'free_only',
        packet: {},
      });
      return { status: 'completed', user_response: 'ok' };
    };
    const persisted: RecuedPlan[] = [];
    const ctx = buildCtx({
      policy,
      persist: async (p) => {
        persisted.push(p);
      },
    });
    await expect(executeRecuedRequest(baseRequest, ctx)).rejects.toBeInstanceOf(
      CompositionRuleError,
    );
    expect(persisted.length).toBe(0);
  });

  it('persists when composition rules pass', async () => {
    const persisted: RecuedPlan[] = [];
    const ctx = buildCtx({
      persist: async (p) => {
        persisted.push(p);
      },
    });
    await executeRecuedRequest(baseRequest, ctx);
    expect(persisted.length).toBe(1);
  });
});

// ── Dry Run preview ─────────────────────────────────────────────────

describe('executeRecuedRequest — Dry Run preview', () => {
  it('threads preview flag into PrimitiveExecuteContext', async () => {
    const policy: OrchestrationPolicy = async (draft) => {
      const result = await draft.invoke('memory.write', {
        kind: 'recipe_insight',
        summary: 's',
        reason_code: 'r',
      });
      expect(result.call.status).toBe('preview_no_op');
      return { status: 'preview_no_op', user_response: 'preview' };
    };
    const plan = await executeRecuedRequest(
      { ...baseRequest, preview: true },
      buildCtx({ policy }),
    );
    expect(plan.status).toBe('preview_no_op');
    expect(plan.primitive_calls[0]!.status).toBe('preview_no_op');
  });
});

// ── Policy throw handling ───────────────────────────────────────────

describe('executeRecuedRequest — policy throw', () => {
  it('captures policy throw as cancelled_malformed_ai status (sanitized class)', async () => {
    const policy: OrchestrationPolicy = async () => {
      throw new Error('policy boom — leaks user content like contact-secret-id');
    };
    const plan = await executeRecuedRequest(baseRequest, buildCtx({ policy }));
    expect(plan.status).toBe('cancelled_malformed_ai');
    expect(plan.failure_class).toBe('synthesis');
    // Codex P1 fold (privacy): user_response carries the sanitized
    // error class name (constructor.name), never the raw Error.message
    // which could leak user content.
    expect(plan.user_response).toContain('Error');
    expect(plan.user_response).not.toContain('policy boom');
    expect(plan.user_response).not.toContain('contact-secret-id');
  });

  it('does NOT persist on policy throw', async () => {
    const policy: OrchestrationPolicy = async () => {
      throw new Error('boom');
    };
    let persisted = 0;
    const ctx = buildCtx({
      policy,
      persist: async () => {
        persisted += 1;
      },
    });
    await executeRecuedRequest(baseRequest, ctx);
    expect(persisted).toBe(0);
  });
});

// ── Codex P1 fold — composition rule #6 pre-execution gate ──────────

describe('executeRecuedRequest — pre-execution composition gate (Codex P1)', () => {
  it('refuses to invoke bridge.dispatch adapter when capacity_spec missing', async () => {
    let bridgeAdapterCalled = false;
    const deps = buildStubDeps();
    deps['bridge.dispatch'] = {
      adapter: {
        dispatch: async () => {
          bridgeAdapterCalled = true;
          return { success: true };
        },
      },
    };
    const ctx = buildCtx({
      registry: createPrimitiveRegistry(deps),
      policy: async (draft) => {
        // Invokes bridge.dispatch with NO preceding capacity_spec ok —
        // pre-check throws CompositionRuleError.
        await draft.invoke('bridge.dispatch', {
          kind: 'click',
          ingredient_slug: 'foo',
        });
        return { status: 'completed', user_response: 'ok' };
      },
    });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    // The orchestrator's catch block routes CompositionRuleError to a
    // capacity failure — not 'cancelled_malformed_ai'.
    expect(plan.status).toBe('cancelled_capacity_gap');
    expect(plan.failure_class).toBe('capacity');
    // Critical: the adapter MUST NOT have been called.
    expect(bridgeAdapterCalled).toBe(false);
  });

  it('allows bridge.dispatch when capacity_spec ok precedes for same intent', async () => {
    let bridgeAdapterCalled = false;
    const deps = buildStubDeps();
    deps['bridge.dispatch'] = {
      adapter: {
        dispatch: async () => {
          bridgeAdapterCalled = true;
          return { success: true };
        },
      },
    };
    const policy: OrchestrationPolicy = async (draft) => {
      await draft.invoke(
        'capacity_spec',
        {
          spec: {
            capacities: [{ kind: 'bridge_online' }],
            remediations: { bridge_online: { action: 'noop', user_facing_copy: '' } },
          },
        },
        { intent_id: 'i1' },
      );
      await draft.invoke(
        'bridge.dispatch',
        { kind: 'click', ingredient_slug: 'foo' },
        { intent_id: 'i1' },
      );
      return { status: 'completed', user_response: 'ok' };
    };
    const ctx = buildCtx({ registry: createPrimitiveRegistry(deps), policy });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.status).toBe('completed');
    expect(bridgeAdapterCalled).toBe(true);
  });

  it('refuses bridge.dispatch when capacity_spec ok is for DIFFERENT intent', async () => {
    let bridgeAdapterCalled = false;
    const deps = buildStubDeps();
    deps['bridge.dispatch'] = {
      adapter: {
        dispatch: async () => {
          bridgeAdapterCalled = true;
          return { success: true };
        },
      },
    };
    const policy: OrchestrationPolicy = async (draft) => {
      await draft.invoke(
        'capacity_spec',
        {
          spec: {
            capacities: [{ kind: 'bridge_online' }],
            remediations: { bridge_online: { action: 'noop', user_facing_copy: '' } },
          },
        },
        { intent_id: 'i1' },
      );
      // Bridge dispatch with intent_id=i2 — capacity ok was for i1.
      await draft.invoke(
        'bridge.dispatch',
        { kind: 'click', ingredient_slug: 'foo' },
        { intent_id: 'i2' },
      );
      return { status: 'completed', user_response: 'ok' };
    };
    const ctx = buildCtx({ registry: createPrimitiveRegistry(deps), policy });
    const plan = await executeRecuedRequest(baseRequest, ctx);
    expect(plan.status).toBe('cancelled_capacity_gap');
    expect(plan.failure_class).toBe('capacity');
    expect(bridgeAdapterCalled).toBe(false);
  });
});

// ── Codex P1 fold — Dry Run preview stickiness ──────────────────────

describe('executeRecuedRequest — preview stickiness (Codex P1)', () => {
  it('policy CANNOT clear preview by passing preview: false override', async () => {
    let memoryAdapterCalled = false;
    const deps = buildStubDeps();
    deps['memory.write'] = {
      adapter: {
        write: async () => {
          memoryAdapterCalled = true;
          return { memory_id: 'never', provenance_edges_written: 0 };
        },
      },
    };
    const policy: OrchestrationPolicy = async (draft) => {
      // Try to defeat Dry Run by passing preview: false. The orchestrator
      // must remain in preview mode — preview is sticky once the request
      // declares it.
      const result = await draft.invoke(
        'memory.write',
        { kind: 'recipe_insight', summary: 's', reason_code: 'r' },
        { preview: false } as never,
      );
      // Despite the override, preview_no_op stuck.
      expect(result.call.status).toBe('preview_no_op');
      return { status: 'preview_no_op', user_response: 'preview' };
    };
    await executeRecuedRequest(
      { ...baseRequest, preview: true },
      buildCtx({ registry: createPrimitiveRegistry(deps), policy }),
    );
    expect(memoryAdapterCalled).toBe(false);
  });

  it('policy CAN add preview: true override even when request preview is false', async () => {
    let memoryAdapterCalled = false;
    const deps = buildStubDeps();
    deps['memory.write'] = {
      adapter: {
        write: async () => {
          memoryAdapterCalled = true;
          return { memory_id: 'never', provenance_edges_written: 0 };
        },
      },
    };
    const policy: OrchestrationPolicy = async (draft) => {
      const result = await draft.invoke(
        'memory.write',
        { kind: 'recipe_insight', summary: 's', reason_code: 'r' },
        { preview: true },
      );
      expect(result.call.status).toBe('preview_no_op');
      return { status: 'completed', user_response: 'ok' };
    };
    await executeRecuedRequest(
      baseRequest, // preview not set on request
      buildCtx({ registry: createPrimitiveRegistry(deps), policy }),
    );
    expect(memoryAdapterCalled).toBe(false);
  });
});

// ── Failure_class pairing ───────────────────────────────────────────

describe('executeRecuedRequest — status / failure_class pairing', () => {
  it('passes failure_class through when status != completed', async () => {
    const policy: OrchestrationPolicy = async () => ({
      status: 'cancelled_capacity_gap',
      failure_class: 'capacity',
      user_response: 'capacity gap blocked',
    });
    const plan = await executeRecuedRequest(baseRequest, buildCtx({ policy }));
    expect(plan.status).toBe('cancelled_capacity_gap');
    expect(plan.failure_class).toBe('capacity');
  });

  it('refuses to persist plan with status != completed and no failure_class', async () => {
    const policy: OrchestrationPolicy = async () => ({
      status: 'cancelled_capacity_gap',
      user_response: 'oops',
    });
    let persisted = 0;
    const ctx = buildCtx({
      policy,
      persist: async () => {
        persisted += 1;
      },
    });
    await expect(executeRecuedRequest(baseRequest, ctx)).rejects.toThrow(
      /RecuedPlan malformed/,
    );
    expect(persisted).toBe(0);
  });
});
