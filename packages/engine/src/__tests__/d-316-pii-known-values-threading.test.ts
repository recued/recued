/**
 * D-316 amendment (2026-10-05) — the host's known-value matcher reaches a
 * recipe's `pii-protect` step: `ExecutionContext.piiKnownValues` → the run
 * context `executeRecipe` builds → `createTransformContext` → the transform.
 * A run, not a lone step, because the run context is rebuilt from the caller's.
 */
import { describe, it, expect } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { buildKnownValueIndex, type PiiKnownValueSource } from '@recued/transforms';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext } from '../types.js';

const RAW = { body: 'Dana Whitfield asked for the addendum' };

const recipe: RecipeDefinition = {
  recipe_id: 'content-known-values',
  version: 1,
  ttl: 300,
  metadata: { name: 'content tag', description: 'protect then restore', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [{ path: 'body', kind: 'content' }],
    },
    {
      id: 'restore',
      transform: 'pii-restore',
      data: '{{step.protect.aliased}}',
      ledger_handle: '{{step.protect.ledger_handle}}',
    },
  ],
  output: { sidebar: [] },
};

const source: PiiKnownValueSource = {
  nameOrgIndex: { index: buildKnownValueIndex([{ value: 'Dana Whitfield', kind: 'name' }]) },
  resolveIdentifiers: () => [],
  isDegraded: () => false,
};

const ctxWith = (piiKnownValues?: ExecutionContext['piiKnownValues']): ExecutionContext => ({
  recipe,
  stores: { vault: {}, config: {}, context: { raw: structuredClone(RAW) }, meta: {}, step: {} },
  ingredientExecutor: async () => null,
  ...(piiKnownValues ? { piiKnownValues } : {}),
});

describe('D-316 amendment — a run threads the host matcher into pii-protect', () => {
  it('the tagged content is aliased mid-run and restored by the later step', async () => {
    const ctx = ctxWith(() => source);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    const protect = ctx.stores.step.protect as { aliased: { body: string } };
    expect(protect.aliased.body).toMatch(/^pii\.Person\d+ asked for the addendum$/u);
    const restore = ctx.stores.step.restore as { restored: { body: string } };
    expect(restore.restored.body).toBe(RAW.body);
  });

  it('a host that lends none leaves the content tag as it was', async () => {
    const ctx = ctxWith();
    await executeRecipe(ctx);
    expect((ctx.stores.step.protect as { aliased: { body: string } }).aliased.body).toBe(RAW.body);
  });
});
