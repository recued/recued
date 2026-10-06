/**
 * D-167 Slice 3, for the OTHER way a run hands its result on (2026-10-06).
 *
 * A run's rendered output has always been restored against its PII ledger at the
 * end (`resolveOutputRender`). A fired `output.exchange` was not: its `data` came
 * straight from the step stores, so an alias this run's `pii-protect` minted
 * (`pii.Person1`, `m1@d1.invalid`) went to the receiver — a peer recipe, a
 * callback, a chat turn reading it — whose own ledger knows nothing of it, or
 * means someone else by it.
 *
 * Pinned through the real `executeRecipe`, on BOTH exit paths (the no-budget one
 * every ordinary run takes, and the budget race): the d-232 suite records a
 * wiring that served one path and not the other with every unit test green.
 */
import { describe, expect, it } from 'vitest';

import { createPiiLedgerStore, getTransform } from '@recued/transforms';

import { executeRecipe } from '../execute.js';
import { buildExchangeFirePayload, type ExchangeFirePayload } from '../fire-exchange-output.js';
import type { ExecutionContext, ExecutionResult } from '../types.js';

const RAW = { from: 'dana@northwind.example', note: 'Dana asked for the addendum' };

const recipe = (budget_ms?: number) => ({
  recipe_id: 'answerer',
  version: 1,
  metadata: {
    name: 'a', description: '', author: 'x', supported_platforms: [],
    ...(budget_ms !== undefined ? { budget_ms } : {}),
  },
  variables: {},
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [{ path: 'from', kind: 'email' }],
    },
  ],
  // No pii-restore: the exchange reads the aliased value directly.
  output: {
    exchange: {
      ref: 'exch_1',
      deliver_to: '{{step.protect.aliased.from}}',
      data: { sender: '{{step.protect.aliased.from}}', record: '{{step.protect.aliased}}' },
    },
  },
}) as any;

const run = async (budget_ms?: number) => {
  const fired: ExchangeFirePayload[] = [];
  const ctx: ExecutionContext = {
    recipe: recipe(budget_ms),
    stores: { vault: {}, config: {}, step: {}, context: { raw: structuredClone(RAW) }, meta: {} } as any,
    ingredientExecutor: async () => null,
    exchangeFireHandler: (p) => { fired.push(p); },
  } as ExecutionContext;
  const result = await executeRecipe(ctx);
  // The run itself really aliased: the protect step's stored output is in alias form.
  expect((ctx.stores.step.protect as { aliased: { from: string } }).aliased.from).toBe('m1@d1.invalid');
  return { result, fired };
};

describe('a fired exchange is restored like a rendered output', () => {
  for (const [path, budget] of [['the no-budget path', undefined], ['the budget path', 60_000]] as const) {
    it(`carries the real values the run's pii-protect aliased — ${path}`, async () => {
      const { result, fired } = await run(budget);
      expect(result.success).toBe(true);
      expect(fired).toHaveLength(1);
      expect(fired[0]!.data).toEqual({ sender: RAW.from, record: RAW });
      // Routing read from step data is restored too: an alias address delivers nowhere.
      expect(fired[0]!.deliver_to).toBe(RAW.from);
      expect(JSON.stringify(fired[0])).not.toMatch(/m1@d1\.invalid|pii\./u);
    });
  }

  it('restores a failed run\'s error text, which can quote the aliased data it failed on', () => {
    const store = createPiiLedgerStore();
    const protect = getTransform('pii-protect')!;
    const { aliased } = protect(
      { data: { name: 'Dana Whitfield' }, fields: [{ path: 'name', kind: 'name' }] },
      { piiLedgerStore: store } as never,
    ) as { aliased: { name: string } };
    expect(aliased.name).toMatch(/^pii\.Person\d+$/u);

    const failed = {
      recipe_id: 'answerer', recipe_hash: 'h', success: false, output: {}, steps: [],
      errors: [{ code: 'AI_OUTPUT_INVALID', message: `the model answered about ${aliased.name}` }],
      duration_ms: 1, validation_issues: [],
    } as unknown as ExecutionResult;
    const ctx = { stores: { step: {} }, piiLedgerStore: store } as unknown as ExecutionContext;
    const payload = buildExchangeFirePayload({ ref: 'exch_1', deliver_to: 'pub/reply' } as never, ctx, failed);

    expect(JSON.stringify(payload.errors)).toContain('the model answered about Dana Whitfield');
  });
});
