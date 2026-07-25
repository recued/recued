/** D-165 — step-runner integration: a recipe step targeting a catalog-form
 *  ingredient routes through the gateway end-to-end.
 *
 *  Exercises the FULL entry path the recipe hits (which the unit tests on
 *  `runCatalogOperation` skip): `runStep` → `runIngredient` →
 *  `isCatalogForm(manifest)` detection → `resolveCatalogConnection`
 *  (resolving the STEP-LEVEL `connection: '{{config.x}}'` ref against the
 *  stores) → `runCatalogOperation` → direct surface dispatch + audit. Proves
 *  a HubSpot-shaped step admits a granted read, dispatches over the operation's
 *  REST surface binding with the resolved connection, and audits.
 *
 *  Spec: docs/d-165-spec.md § Runtime flow. */

import { describe, it, expect } from 'vitest';
import type {
  GatewayCallAudit,
  IngredientManifest,
  RecipeStep,
} from '@recued/contracts';
import { runStep } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

/** Catalog-form HubSpot-shaped manifest (inline; mirrors the real
 *  `hubspot-catalog.json` shape). Static wrapper `risk_tier: 'read'` is
 *  deliberately low — the operations carry the real risk (Invariant 1). */
const catalogManifest: IngredientManifest = {
  slug: 'hubspot-catalog',
  name: 'HubSpot (catalog)',
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.read': {
      operation_id: 'recued-core/hubspot.deal.read',
      risk_tier: 'read',
      groups: ['recued-core/hubspot.deals.read'],
    },
    'email.compose': {
      operation_id: 'recued-core/hubspot.email.compose',
      risk_tier: 'write',
      groups: ['recued-core/hubspot.emails.write'],
      approval: 'ask',
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.hubapi.com',
      auth: { kind: 'none' },
      executes: {
        'deal.read': {
          kind: 'rest', method: 'GET', path_template: '/crm/v3/objects/deals/{{deal_id}}',
        },
        'email.compose': {
          kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/emails',
        },
      },
    },
  },
};

const makeCtx = (opts: {
  allowed: string[];
}): {
  ctx: ExecutionContext;
  executorCalls: Array<{ slug: string; input: Record<string, unknown> }>;
  auditCalls: GatewayCallAudit[];
} => {
  const executorCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
  const auditCalls: GatewayCallAudit[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input });
    return { ok: true };
  };
  const ctx = {
    recipe: { recipe_id: 'r1', steps: [] } as any,
    stores: { config: { hs: 'my-hubspot' }, step: {} } as any,
    ingredientExecutor,
    // D-209 Slice B — contracted-dispatch source ⇒ LOW `read` ceiling ⇒ a write op
    // HOLDS for approval (reads still admit at any ceiling).
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: 'k1',
    },
    manifestGetter: (slug: string) => (slug === 'hubspot-catalog' ? catalogManifest : null),
    connectionProfileResolver: () => ({ allowed_operations: opts.allowed }),
    onGatewayCall: (e: GatewayCallAudit) => {
      auditCalls.push(e);
    },
  } as unknown as ExecutionContext;
  return { ctx, executorCalls, auditCalls };
};

describe('D-165 P1 — catalog-form step routes through the gateway', () => {
  it('admits a granted read, resolves the step-level connection ref, and dispatches over the surface binding', async () => {
    const { ctx, executorCalls, auditCalls } = makeCtx({ allowed: ['deal.read'] });
    const step: RecipeStep = {
      id: 'fetch',
      ingredient: 'hubspot-catalog',
      connection: '{{config.hs}}',
      input: { operation: 'deal.read', args: { deal_id: '7' } },
    } as unknown as RecipeStep;

    const log = await runStep(step, ctx);

    expect(log.error).toBeNull();
    expect(log.result).toEqual({ ok: true });
    // Direct surface dispatch under the CATALOG slug, with the RESOLVED
    // connection ('my-hubspot', not the raw '{{config.hs}}' ref) + the
    // binding's method/path folded into the connection-api input.
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].slug).toBe('hubspot-catalog');
    expect(executorCalls[0].input).toEqual({
      deal_id: '7',
      method: 'GET',
      path: '/crm/v3/objects/deals/{{deal_id}}',
      connection_kind: 'api',
      connection: 'my-hubspot',
    });
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'hubspot-catalog',
      operation_id: 'recued-core/hubspot.deal.read',
      connection_name: 'my-hubspot',
      risk_tier: 'read',
    });
  });

  it('resolves {{ref}} VALUES inside a literal catalog args OBJECT before dispatch (slice 3 / Codex MEDIUM-2)', async () => {
    const { ctx, executorCalls } = makeCtx({ allowed: ['deal.read'] });
    // A prior step output the id; the catalog op references it inside its args
    // object. Before the fix, a literal `args` object was passed UNRESOLVED, so
    // `deal_id` reached the adapter as the literal string '{{step.prev.id}}'.
    (ctx.stores as unknown as { step: Record<string, unknown> }).step.prev = { id: '7' };
    const step: RecipeStep = {
      id: 'fetch',
      ingredient: 'hubspot-catalog',
      connection: '{{config.hs}}',
      input: { operation: 'deal.read', args: { deal_id: '{{step.prev.id}}' } },
    } as unknown as RecipeStep;

    const log = await runStep(step, ctx);

    expect(log.error).toBeNull();
    expect(executorCalls).toHaveLength(1);
    // The ref VALUE inside the args object is resolved to the concrete id.
    expect(executorCalls[0].input.deal_id).toBe('7');
    expect(executorCalls[0].input).not.toHaveProperty('deal_id', '{{step.prev.id}}');
  });

  it('pauses a write operation for approval (PreflightRequiredSignal escapes runStep)', async () => {
    const { ctx, executorCalls } = makeCtx({ allowed: ['email.compose'] });
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'hubspot-catalog',
      connection: '{{config.hs}}',
      input: { operation: 'email.compose', args: { subject: 'hi', body: 'there' } },
    } as unknown as RecipeStep;

    // runStep re-throws the preflight signal (it is control flow, not a
    // step error) — the execute loop catches it and ends with
    // awaiting_approval. It must NOT be swallowed into log.error.
    await expect(runStep(step, ctx)).rejects.toMatchObject({
      name: 'PreflightRequiredSignal',
      risk_tier: 'write',
    });
    expect(executorCalls).toHaveLength(0);
  });

  it('threads ingredient_version into catalog manifest lookup', async () => {
    const { ctx, executorCalls } = makeCtx({ allowed: ['deal.read'] });
    const lookups: Array<{ slug: string; version: number | undefined }> = [];
    ctx.manifestGetter = (slug: string, requestedVersion?: number) => {
      lookups.push({ slug, version: requestedVersion });
      return slug === 'hubspot-catalog' && requestedVersion === 7 ? catalogManifest : null;
    };
    const step: RecipeStep = {
      id: 'fetch',
      ingredient: 'hubspot-catalog',
      ingredient_version: 7,
      connection: '{{config.hs}}',
      input: { operation: 'deal.read', args: { deal_id: '7' } },
    } as unknown as RecipeStep;

    const log = await runStep(step, ctx);

    expect(log.error).toBeNull();
    expect(executorCalls).toHaveLength(1);
    expect(lookups[0]).toEqual({ slug: 'hubspot-catalog', version: 7 });
  });

  it('fails closed when a pinned catalog manifest does not resolve', async () => {
    const { ctx, executorCalls } = makeCtx({ allowed: ['deal.read'] });
    ctx.manifestGetter = () => null;
    const step: RecipeStep = {
      id: 'fetch',
      ingredient: 'hubspot-catalog',
      ingredient_version: 6,
      connection: '{{config.hs}}',
      input: { operation: 'deal.read', args: { deal_id: '7' } },
    } as unknown as RecipeStep;

    const log = await runStep(step, ctx);

    expect(log.error?.message).toMatch(/version 6 not found/);
    expect(executorCalls).toHaveLength(0);
  });
});
