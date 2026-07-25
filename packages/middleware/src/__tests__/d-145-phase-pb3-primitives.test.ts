/** D-145 PB3 — per-primitive contract tests.
 *
 *  Each of the 10 primitives is tested in isolation with a mock
 *  adapter (substitutability invariant per § B.1.3). Tests cover:
 *    - normal `ok` path emits well-formed PrimitiveCall
 *    - error path returns `status: 'error'` (or `'capacity_gap'`)
 *    - args_summary / outcome_summary carry no raw payload
 *    - Dry Run preview path (mutating primitives only) emits
 *      `status: 'preview_no_op'` without invoking the adapter */

import { describe, it, expect } from 'vitest';

import {
  AI_POOL_POLICIES,
  APPROVAL_DECISIONS,
  DATA_FETCH_COLLECTIONS,
  MEMORY_RECALL_AXES,
  createAISynthesizePrimitive,
  createApprovalRequestPrimitive,
  createBridgeDispatchPrimitive,
  createCapacitySpecPrimitive,
  createDataFetchPrimitive,
  createEnrichmentLookupPrimitive,
  createMemoryRecallPrimitive,
  createMemoryWritePrimitive,
  createProvenanceLinkPrimitive,
  createRecipeInvokePrimitive,
} from '../primitives/index.js';
import * as capacity from '../capacity/index.js';

import type { CapacitySpec, CapacityProbeResult } from '@recued/contracts';

const baseCtx = (overrides: Partial<{ run_id: string; intent_id: string; preview: boolean }> = {}) => ({
  run_id: overrides.run_id ?? 'run-1',
  ...(overrides.intent_id !== undefined ? { intent_id: overrides.intent_id } : {}),
  ...(overrides.preview ? { preview: true } : {}),
  now: () => 1000,
  mint_call_id: () => 'call-1',
});

// ── capacity_spec primitive ─────────────────────────────────────────

describe('capacity_spec primitive', () => {
  const buildDeps = (probeOk: boolean) => {
    const invalidationSource = capacity.createCapacityInvalidationSource();
    const cache = capacity.createCapacityCache({ invalidationSource });
    const probeFn = async (): Promise<CapacityProbeResult> =>
      probeOk ? { ok: true } : { ok: false, detail: 'gap' };
    const probe = { kind: 'bridge_online' as const, probe: probeFn };
    const registry = capacity.createCapacityProbeRegistry({
      bridgeStateProbe: { getOnline: () => probeOk, getLoggedIn: () => probeOk },
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
    registry.override(probe);
    return {
      registry,
      cache,
      walkContext: {
        audit_emitter: capacity.createCapacityAuditEmitter({ logActivity() {} }),
        transparency_emitter: capacity.createNoopTransparencyEmitter(),
      },
    };
  };

  it('emits ok PrimitiveCall when walker passes', async () => {
    const prim = createCapacitySpecPrimitive(buildDeps(true));
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }],
      remediations: { bridge_online: { action: 'noop', user_facing_copy: '' } },
    };
    const result = await prim.execute({ spec }, baseCtx());
    expect(result.call.primitive).toBe('capacity_spec');
    expect(result.call.status).toBe('ok');
    expect(result.result.walk_result.ok).toBe(true);
  });

  it('emits capacity_gap PrimitiveCall when walker halts', async () => {
    const prim = createCapacitySpecPrimitive(buildDeps(false));
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }],
      remediations: { bridge_online: { action: 'show_bridge_install_prompt', user_facing_copy: 'Install bridge' } },
    };
    const result = await prim.execute({ spec }, baseCtx());
    expect(result.call.status).toBe('capacity_gap');
    expect(result.result.walk_result.ok).toBe(false);
  });

  it('propagates intent_id onto PrimitiveCall', async () => {
    const prim = createCapacitySpecPrimitive(buildDeps(true));
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }],
      remediations: { bridge_online: { action: 'noop', user_facing_copy: '' } },
    };
    const result = await prim.execute({ spec }, baseCtx({ intent_id: 'intent-A' }));
    expect(result.call.intent_id).toBe('intent-A');
  });

  it('args_summary carries kind counts not payload', async () => {
    const prim = createCapacitySpecPrimitive(buildDeps(true));
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }, { kind: 'annotation_not_required' }],
      remediations: {
        bridge_online: { action: 'noop', user_facing_copy: '' },
        annotation_not_required: { action: 'noop', user_facing_copy: '' },
      },
    };
    const result = await prim.execute({ spec }, baseCtx());
    expect(result.call.args_summary).toContain('capacities=2');
    expect(result.call.args_summary).toContain('bridge_online=1');
  });
});

// ── data.fetch primitive ────────────────────────────────────────────

describe('data.fetch primitive', () => {
  it('emits ok PrimitiveCall on adapter success', async () => {
    const prim = createDataFetchPrimitive({
      adapter: { fetch: async () => ({ rows: [{ a: 1 }, { b: 2 }], total_count: 2 }) },
    });
    const result = await prim.execute({ collection: 'mail' }, baseCtx());
    expect(result.call.status).toBe('ok');
    expect(result.result.rows.length).toBe(2);
    expect(result.call.outcome_summary).toContain('rows=2');
  });

  it('emits ok_partial when adapter reports degraded sources', async () => {
    const prim = createDataFetchPrimitive({
      adapter: { fetch: async () => ({ rows: [], total_count: 0, sources_degraded: ['gmail'] }) },
    });
    const result = await prim.execute({ collection: 'mail' }, baseCtx());
    expect(result.call.status).toBe('ok_partial');
    expect(result.call.outcome_summary).toContain('degraded=1');
  });

  it('emits error when adapter throws (sanitized class, not raw message)', async () => {
    const prim = createDataFetchPrimitive({
      adapter: {
        fetch: async () => {
          // Codex P1 fold (privacy): the raw Error.message ('store offline'
          // here, but in production it might carry user content like an
          // SQL row dump or a vendor-API error body) MUST NOT appear in
          // outcome_summary. Only the constructor name leaks, which is
          // attribution-safe.
          throw new Error('store offline contains user content like email@example.com');
        },
      },
    });
    const result = await prim.execute({ collection: 'mail' }, baseCtx());
    expect(result.call.status).toBe('error');
    expect(result.call.outcome_summary).toBe('error Error');
    expect(result.call.outcome_summary).not.toContain('store offline');
    expect(result.call.outcome_summary).not.toContain('email@example.com');
  });

  it('emits error class name from custom Error subclass', async () => {
    class TimeoutError extends Error {
      constructor() {
        super('connection timed out after 30s, partial response: <PII redacted>');
      }
    }
    const prim = createDataFetchPrimitive({
      adapter: {
        fetch: async () => {
          throw new TimeoutError();
        },
      },
    });
    const result = await prim.execute({ collection: 'mail' }, baseCtx());
    expect(result.call.outcome_summary).toBe('error TimeoutError');
  });

  it('emits error on unknown collection', async () => {
    const prim = createDataFetchPrimitive({
      adapter: { fetch: async () => ({ rows: [] }) },
    });
    const result = await prim.execute({ collection: 'xyz' as never }, baseCtx());
    expect(result.call.status).toBe('error');
    expect(result.call.outcome_summary).toContain('unknown_collection');
  });

  it('args_summary carries filter keys not values', async () => {
    const prim = createDataFetchPrimitive({
      adapter: { fetch: async () => ({ rows: [] }) },
    });
    const result = await prim.execute(
      { collection: 'contact', filter: { email: 'sensitive@example.com', tag: 'vip' } },
      baseCtx(),
    );
    expect(result.call.args_summary).toContain('email,tag');
    expect(result.call.args_summary).not.toContain('sensitive@example.com');
  });

  it('exposes the closed collection list', () => {
    expect(DATA_FETCH_COLLECTIONS).toContain('mail');
    expect(DATA_FETCH_COLLECTIONS).toContain('shared');
    expect(DATA_FETCH_COLLECTIONS).toHaveLength(9);
  });
});

// ── memory.recall primitive ─────────────────────────────────────────

describe('memory.recall primitive', () => {
  it('emits ok PrimitiveCall on adapter success', async () => {
    const prim = createMemoryRecallPrimitive({
      adapter: {
        recall: async () => ({
          entries: [{ memory_id: 'm1', kind: 'recipe_insight', summary: 's', ts: 1 }],
          total_count: 1,
        }),
      },
    });
    const result = await prim.execute({ entity_id: 'contact-1' }, baseCtx());
    expect(result.call.status).toBe('ok');
    expect(result.result.entries.length).toBe(1);
  });

  it('emits error on unknown axis', async () => {
    const prim = createMemoryRecallPrimitive({
      adapter: { recall: async () => ({ entries: [], total_count: 0 }) },
    });
    const result = await prim.execute({ axis: 'nonsense' as never }, baseCtx());
    expect(result.call.status).toBe('error');
    expect(result.call.outcome_summary).toContain('unknown_axis');
  });

  it('args_summary marks entity_scoped without entity_id leak', async () => {
    const prim = createMemoryRecallPrimitive({
      adapter: { recall: async () => ({ entries: [], total_count: 0 }) },
    });
    const result = await prim.execute(
      { entity_id: 'contact-secret-id-12345', kinds: ['recipe_insight'] },
      baseCtx(),
    );
    expect(result.call.args_summary).toContain('entity_scoped');
    expect(result.call.args_summary).not.toContain('contact-secret-id-12345');
  });

  it('exposes the closed axis list', () => {
    expect(MEMORY_RECALL_AXES).toEqual(['event', 'ingestion']);
  });
});

// ── memory.write primitive ──────────────────────────────────────────

describe('memory.write primitive', () => {
  it('emits ok PrimitiveCall on adapter success', async () => {
    const prim = createMemoryWritePrimitive({
      adapter: { write: async () => ({ memory_id: 'm-new', provenance_edges_written: 2 }) },
    });
    const result = await prim.execute(
      { kind: 'recipe_insight', summary: 'snap', reason_code: 'response_synthesized' },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
    expect(result.result.memory_id).toBe('m-new');
  });

  it('Dry Run skips adapter and emits preview_no_op', async () => {
    let adapterCalled = false;
    const prim = createMemoryWritePrimitive({
      adapter: {
        write: async () => {
          adapterCalled = true;
          return { memory_id: 'never', provenance_edges_written: 0 };
        },
      },
      mint_preview_memory_id: () => 'preview-id',
    });
    const result = await prim.execute(
      { kind: 'recipe_insight', summary: 'snap', reason_code: 'response_synthesized' },
      baseCtx({ preview: true }),
    );
    expect(result.call.status).toBe('preview_no_op');
    expect(result.result.memory_id).toBe('preview-id');
    expect(adapterCalled).toBe(false);
  });

  it('emits error when adapter throws', async () => {
    const prim = createMemoryWritePrimitive({
      adapter: {
        write: async () => {
          throw new Error('write failed');
        },
      },
    });
    const result = await prim.execute(
      { kind: 'recipe_insight', summary: 's', reason_code: 'r' },
      baseCtx(),
    );
    expect(result.call.status).toBe('error');
  });
});

// ── enrichment.lookup primitive ─────────────────────────────────────

describe('enrichment.lookup primitive', () => {
  it('emits ok on adapter success', async () => {
    const prim = createEnrichmentLookupPrimitive({
      adapter: { lookup: async () => ({ rows: [], total_count: 0 }) },
    });
    const result = await prim.execute({ topic: 'preferred_channel_by_contact' }, baseCtx());
    expect(result.call.status).toBe('ok');
  });

  it('emits ok_partial when visibility filter applied', async () => {
    const prim = createEnrichmentLookupPrimitive({
      adapter: { lookup: async () => ({ rows: [], total_count: 0, visibility_filtered: true }) },
    });
    const result = await prim.execute({ topic: 'engagement_score_per_contact' }, baseCtx());
    expect(result.call.status).toBe('ok_partial');
    expect(result.call.outcome_summary).toContain('filtered=yes');
  });

  it('emits error when adapter throws', async () => {
    const prim = createEnrichmentLookupPrimitive({
      adapter: {
        lookup: async () => {
          throw new Error('topic not found');
        },
      },
    });
    const result = await prim.execute({ topic: 'unknown_topic' }, baseCtx());
    expect(result.call.status).toBe('error');
  });
});

// ── ai.synthesize primitive ─────────────────────────────────────────

describe('ai.synthesize primitive', () => {
  const okAdapter = {
    synthesize: async () => ({
      response: 'hello',
      events: [],
      provider: 'openai',
      model_id: 'gpt-4o',
      total_tokens: 100,
    }),
  };

  it('emits ok PrimitiveCall with no stage discriminator (single-stage)', async () => {
    const prim = createAISynthesizePrimitive({ adapter: okAdapter });
    const result = await prim.execute(
      { tier: 'fast', pool_policy: 'free_only', packet: { hi: 1 } },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
    expect('stage' in result.call).toBe(false);
  });

  it('emits ok_partial when adapter reports tier_demoted', async () => {
    const prim = createAISynthesizePrimitive({
      adapter: {
        synthesize: async () => ({
          response: '',
          events: [],
          provider: 'openai',
          model_id: 'gpt-4o',
          tier_demoted: true,
        }),
      },
    });
    const result = await prim.execute(
      { tier: 'reasoning', pool_policy: 'free_then_byok', packet: {} },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok_partial');
    expect(result.call.outcome_summary).toContain('demoted=yes');
  });

  it('emits error on unknown pool policy', async () => {
    const prim = createAISynthesizePrimitive({ adapter: okAdapter });
    const result = await prim.execute(
      { tier: 'fast', pool_policy: 'forbidden' as never, packet: {} },
      baseCtx(),
    );
    expect(result.call.status).toBe('error');
    expect(result.call.outcome_summary).toContain('unknown_pool_policy');
  });

  it('args_summary carries packet bytes not packet content', async () => {
    const prim = createAISynthesizePrimitive({ adapter: okAdapter });
    const result = await prim.execute(
      { tier: 'fast', pool_policy: 'free_only', packet: { secret: 'pii-data' } },
      baseCtx(),
    );
    expect(result.call.args_summary).toContain('packet_bytes=');
    expect(result.call.args_summary).not.toContain('pii-data');
  });

  it('exposes closed lists', () => {
    expect(AI_POOL_POLICIES).toEqual(['free_only', 'free_then_byok', 'byok_only']);
  });
});

// ── bridge.dispatch primitive ───────────────────────────────────────

describe('bridge.dispatch primitive', () => {
  it('emits ok PrimitiveCall on adapter success', async () => {
    const prim = createBridgeDispatchPrimitive({
      adapter: { dispatch: async () => ({ success: true }) },
    });
    const result = await prim.execute(
      { kind: 'click', ingredient_slug: 'facebook-profile-reader' },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
    expect(result.result.success).toBe(true);
  });

  it('emits capacity_gap_mid_run when bridge disconnects', async () => {
    const prim = createBridgeDispatchPrimitive({
      adapter: { dispatch: async () => ({ success: false, bridge_disconnected: true }) },
    });
    const result = await prim.execute(
      { kind: 'click', ingredient_slug: 'facebook-profile-reader' },
      baseCtx(),
    );
    expect(result.call.status).toBe('capacity_gap_mid_run');
  });

  it('Dry Run skips adapter', async () => {
    let called = false;
    const prim = createBridgeDispatchPrimitive({
      adapter: {
        dispatch: async () => {
          called = true;
          return { success: true };
        },
      },
    });
    const result = await prim.execute(
      { kind: 'click', ingredient_slug: 'webchat-gemini' },
      baseCtx({ preview: true }),
    );
    expect(result.call.status).toBe('preview_no_op');
    expect(called).toBe(false);
  });
});

// ── recipe.invoke primitive ─────────────────────────────────────────

describe('recipe.invoke primitive', () => {
  it('emits ok on adapter success', async () => {
    const prim = createRecipeInvokePrimitive({
      adapter: { invoke: async () => ({ success: true, step_summary: '3/3 steps' }) },
    });
    const result = await prim.execute(
      { recipe_slug: 'detect-deal-risk-hubspot', recipe_version: 2 },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
  });

  it('emits error on adapter failure', async () => {
    const prim = createRecipeInvokePrimitive({
      adapter: { invoke: async () => ({ success: false, detail: 'step 2 failed' }) },
    });
    const result = await prim.execute({ recipe_slug: 'foo' }, baseCtx());
    expect(result.call.status).toBe('error');
  });

  it('Dry Run skips adapter', async () => {
    let called = false;
    const prim = createRecipeInvokePrimitive({
      adapter: {
        invoke: async () => {
          called = true;
          return { success: true };
        },
      },
    });
    const result = await prim.execute({ recipe_slug: 'foo' }, baseCtx({ preview: true }));
    expect(result.call.status).toBe('preview_no_op');
    expect(called).toBe(false);
  });
});

// ── approval.request primitive ──────────────────────────────────────

describe('approval.request primitive', () => {
  it('approved → status=ok', async () => {
    const prim = createApprovalRequestPrimitive({
      adapter: { request: async () => ({ decision: 'approved', responded_at: 1000 }) },
    });
    const result = await prim.execute(
      { kind: 'send_email', reason: 'Send to client?' },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
  });

  it('declined → status=cancelled', async () => {
    const prim = createApprovalRequestPrimitive({
      adapter: { request: async () => ({ decision: 'declined', responded_at: 1000 }) },
    });
    const result = await prim.execute({ kind: 'k', reason: 'r' }, baseCtx());
    expect(result.call.status).toBe('cancelled');
  });

  it('timeout → status=timeout', async () => {
    const prim = createApprovalRequestPrimitive({
      adapter: { request: async () => ({ decision: 'timeout', responded_at: 1000 }) },
    });
    const result = await prim.execute({ kind: 'k', reason: 'r' }, baseCtx());
    expect(result.call.status).toBe('timeout');
  });

  it('unknown decision → status=error', async () => {
    const prim = createApprovalRequestPrimitive({
      adapter: { request: async () => ({ decision: 'maybe' as never, responded_at: 1000 }) },
    });
    const result = await prim.execute({ kind: 'k', reason: 'r' }, baseCtx());
    expect(result.call.status).toBe('error');
  });

  it('Dry Run synthesizes approved without surfacing prompt', async () => {
    let called = false;
    const prim = createApprovalRequestPrimitive({
      adapter: {
        request: async () => {
          called = true;
          return { decision: 'approved', responded_at: 1000 };
        },
      },
    });
    const result = await prim.execute({ kind: 'k', reason: 'r' }, baseCtx({ preview: true }));
    expect(result.call.status).toBe('preview_no_op');
    expect(result.result.decision).toBe('approved');
    expect(called).toBe(false);
  });

  it('exposes closed decision list', () => {
    expect(APPROVAL_DECISIONS).toEqual(['approved', 'declined', 'cancelled', 'timeout']);
  });
});

// ── provenance.link primitive ───────────────────────────────────────

describe('provenance.link primitive', () => {
  it('emits ok on adapter success', async () => {
    const prim = createProvenanceLinkPrimitive({
      adapter: { link: async () => ({ ok: true, edges_written: 3 }) },
    });
    const result = await prim.execute(
      { memory_id: 'm-1', entity_ids: ['e-1', 'e-2', 'e-3'], kind: 'engagement_to_contact' },
      baseCtx(),
    );
    expect(result.call.status).toBe('ok');
    expect(result.result.edges_written).toBe(3);
  });

  it('rule 8: adapter throw STILL emits ok status (fire-and-forget)', async () => {
    const prim = createProvenanceLinkPrimitive({
      adapter: {
        link: async () => {
          throw new Error('graph store offline contains user content like contact-secret-id');
        },
      },
    });
    const result = await prim.execute(
      { memory_id: 'm-1', entity_ids: ['e-1'], kind: 'k' },
      baseCtx(),
    );
    // Per § B.1.2 rule 8: the engine MUST not surface link emission
    // failures as blocking errors. The status remains 'ok'; the
    // outcome_summary preserves the error class (Codex P1 fold —
    // sanitized; never raw Error.message) for audit replay.
    expect(result.call.status).toBe('ok');
    expect(result.call.outcome_summary).toContain('errored=yes');
    expect(result.call.outcome_summary).toContain('detail=Error');
    expect(result.call.outcome_summary).not.toContain('contact-secret-id');
    expect(result.result.ok).toBe(false);
  });

  it('Dry Run skips adapter', async () => {
    let called = false;
    const prim = createProvenanceLinkPrimitive({
      adapter: {
        link: async () => {
          called = true;
          return { ok: true, edges_written: 1 };
        },
      },
    });
    const result = await prim.execute(
      { memory_id: 'm-1', entity_ids: ['e-1'], kind: 'k' },
      baseCtx({ preview: true }),
    );
    expect(result.call.status).toBe('preview_no_op');
    expect(called).toBe(false);
  });

  it('args_summary carries entity COUNT not ids', async () => {
    const prim = createProvenanceLinkPrimitive({
      adapter: { link: async () => ({ ok: true, edges_written: 2 }) },
    });
    const result = await prim.execute(
      { memory_id: 'm-1', entity_ids: ['contact-secret-id', 'mail-secret-id'], kind: 'k' },
      baseCtx(),
    );
    expect(result.call.args_summary).toContain('entities=2');
    expect(result.call.args_summary).not.toContain('contact-secret-id');
  });
});
