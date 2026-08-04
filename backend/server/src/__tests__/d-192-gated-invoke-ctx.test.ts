/** D-192 — the gated-invoke spine's ctx derivation, test-pinned
 *  (carried from the ExecutionSource-threading slice `b70cce4d`, which
 *  review-verified but could not pin it: `runCatalogOperation` was a
 *  direct import with no seam; the admission-seam slice added
 *  `SourceMirrorFetchDeps.invokeCatalogOperation`).
 *
 *  What must hold (D-153/D-182 threading semantics):
 *   - a caller-triggered request (`execution_source` present) runs the
 *     scoped engine ctx under the CALLER's identity — `actor` from the
 *     source, `contract_id` via `executionSourceContractId`, the source
 *     VERBATIM on the ctx (audit attribution + the catalog gateway's
 *     per-actor `contract.override` tightening), the honest
 *     `trigger_source`, and the intent-burst `correlation_id`;
 *   - a background request (sync poll / write executor / CRM canonical
 *     poll — no source) keeps the `system` posture byte-identical:
 *     `actor: 'system'`, `trigger_source: 'reactive'`, no source, no
 *     contract id;
 *   - the audit step meta carries the SAME actor + the caller's step id
 *     and synthetic recipe id. */

import { describe, expect, it } from 'vitest';
import type { ExecutionSource, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import type { ExecutionContext } from '@recued/engine';
import { IngredientError } from '@recued/ingredients';

import {
  runGatedCatalogOperation,
  type SourceMirrorFetchDeps,
} from '../source-mirror/fetch.js';

const AUDIT_RECIPE: RecipeDefinition = {
  recipe_id: 'work-entity-source-read',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'test synthetic',
    description: 'ctx-derivation pin',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const MANIFEST = {
  slug: 'ctx-catalog',
  kind: 'connection',
  risk_tier: 'read',
  operations: { 'task.read': { operation_id: 'task.read', risk_tier: 'read' } },
} as never;

const REAL_GATE_MANIFEST = {
  slug: 'ctx-catalog',
  name: 'Context catalog',
  description: 'Real-gate typed-error fixture',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { 'task.read': { operation_id: 'task.read', risk_tier: 'read' } },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.test',
      auth: { kind: 'none' },
      executes: {
        'task.read': {
          kind: 'rest',
          method: 'GET',
          path_template: '/tasks/{task_id}',
        },
      },
    },
  },
} as unknown as IngredientManifest;

interface CapturedInvoke {
  ctx: ExecutionContext;
  stepMeta: unknown;
  operation: string;
  connection: string;
}

const harness = (): {
  deps: SourceMirrorFetchDeps;
  captured: CapturedInvoke[];
} => {
  const captured: CapturedInvoke[] = [];
  const deps = {
    executorConfig: {
      manifests: { get: () => null },
    },
    profiles: { get: () => null },
    // The injection seam under pin — replaces the gateway call itself so
    // the test observes the EXACT ctx this module derived.
    invokeCatalogOperation: (async (
      ctx: ExecutionContext,
      _manifest: unknown,
      _slug: string,
      call: { operation: string },
      connection: string,
      _a: unknown,
      _b: unknown,
      stepMeta: unknown,
    ) => {
      captured.push({ ctx, stepMeta, operation: call.operation, connection });
      return { result: { ok: true } };
    }) as never,
    // The bound-executor construction precedes the invoke — stub it so
    // the fake executorConfig never has to satisfy the real builder.
    buildExecutor: (() => (async () => ({ result: null }))) as never,
  } as unknown as SourceMirrorFetchDeps;
  return { deps, captured };
};

describe('D-192 — runGatedCatalogOperation ctx derivation (the threading pin)', () => {
  it('threads a caller source verbatim: actor, contract_id, trigger, correlation', async () => {
    const { deps, captured } = harness();
    const doorSource: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-9',
      tool_call_id: 'call-9',
      mcp_token_id: 't9',
      contract_id: 'contract-door-9',
    } as ExecutionSource;

    const outcome = await runGatedCatalogOperation(deps, {
      connection_name: 'acme',
      manifest: MANIFEST,
      catalogSlug: 'ctx-catalog',
      operationKey: 'task.read',
      args: { task_id: 'r1' },
      auditRecipe: AUDIT_RECIPE,
      stepId: 'targeted_read',
      execution_source: doorSource,
      trigger_source: 'mcp',
      correlation_id: 'call-9',
    });

    expect(outcome.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const { ctx, stepMeta, operation, connection } = captured[0]!;
    expect(operation).toBe('task.read');
    expect(connection).toBe('acme');
    expect(ctx.actor).toBe('contracted_user');
    expect(ctx.contract_id).toBe('contract-door-9');
    // VERBATIM — the audit row and the gateway's per-actor override
    // tightening both key on the exact source object.
    expect(ctx.execution_source).toBe(doorSource);
    expect(ctx.trigger_source).toBe('mcp');
    expect(ctx.correlation_id).toBe('call-9');
    expect(ctx.recipe).toBe(AUDIT_RECIPE);
    expect(stepMeta).toEqual({
      step_id: 'targeted_read',
      recipe_id: 'work-entity-source-read',
      actor: 'contracted_user',
    });
  });

  it('keeps the background system posture byte-identical when no source rides the request', async () => {
    const { deps, captured } = harness();

    const outcome = await runGatedCatalogOperation(deps, {
      connection_name: 'acme',
      manifest: MANIFEST,
      catalogSlug: 'ctx-catalog',
      operationKey: 'task.read',
      args: {},
      auditRecipe: AUDIT_RECIPE,
      stepId: 'source_sync',
    });

    expect(outcome.ok).toBe(true);
    const { ctx, stepMeta } = captured[0]!;
    expect(ctx.actor).toBe('system');
    expect(ctx.trigger_source).toBe('reactive');
    expect(ctx.execution_source).toBeUndefined();
    expect(ctx.contract_id).toBeUndefined();
    expect(ctx.correlation_id).toBeUndefined();
    expect(stepMeta).toEqual({
      step_id: 'source_sync',
      recipe_id: 'work-entity-source-read',
      actor: 'system',
    });
  });

  it('preserves only the typed API_NOT_FOUND signal across the gated outcome seam', async () => {
    const { deps } = harness();
    deps.invokeCatalogOperation = (async () => {
      throw Object.assign(new Error('provider returned 404'), { code: 'API_NOT_FOUND' });
    }) as never;

    const outcome = await runGatedCatalogOperation(deps, {
      connection_name: 'acme',
      manifest: MANIFEST,
      catalogSlug: 'ctx-catalog',
      operationKey: 'task.read',
      args: { task_id: 'gone' },
      auditRecipe: AUDIT_RECIPE,
      stepId: 'write_verify',
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      reason: 'provider returned 404',
      error_code: 'API_NOT_FOUND',
    });

    deps.invokeCatalogOperation = (async () => {
      throw Object.assign(new Error('provider returned 500'), { code: 'API_RATE_LIMITED' });
    }) as never;
    const other = await runGatedCatalogOperation(deps, {
      connection_name: 'acme',
      manifest: MANIFEST,
      catalogSlug: 'ctx-catalog',
      operationKey: 'task.read',
      args: { task_id: 'unknown' },
      auditRecipe: AUDIT_RECIPE,
      stepId: 'write_verify',
    });
    expect(other).toEqual({
      ok: false,
      kind: 'error',
      reason: 'provider returned 500',
    });
  });

  it('preserves API_NOT_FOUND through the real catalog gateway and engine call', async () => {
    const deps = {
      executorConfig: {
        manifests: { get: () => REAL_GATE_MANIFEST },
      },
      profiles: {
        get: () => ({
          allowed_operations: ['task.read'],
          catalog_slug: REAL_GATE_MANIFEST.slug,
        }),
      },
      buildExecutor: () => (async () => {
        throw new IngredientError('API_NOT_FOUND', 'provider returned 404');
      }) as never,
    } as unknown as SourceMirrorFetchDeps;

    const outcome = await runGatedCatalogOperation(deps, {
      connection_name: 'acme',
      manifest: REAL_GATE_MANIFEST,
      catalogSlug: REAL_GATE_MANIFEST.slug,
      operationKey: 'task.read',
      args: { task_id: 'gone' },
      auditRecipe: AUDIT_RECIPE,
      stepId: 'write_verify',
    });

    expect(outcome).toMatchObject({
      ok: false,
      kind: 'error',
      reason: 'provider returned 404',
      error_code: 'API_NOT_FOUND',
    });
  });
});
