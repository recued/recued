/** D-341 slice B1 — a trigger's standing pre-approval, at the catalog gate.
 *
 *  A catalog op (a pack's own op, a Records write among them) holds at the catalog gate, never at
 *  the commit gateway, whose dispatch of it is read-tier. So the catalog gate asks the host too: in
 *  its ask branch, after no session grant matched, for the hold the run's own ceiling makes (no
 *  review lift), below destructive and where the owner's policy leaves the ask waivable. The host
 *  is given the catalog's slug, the op the gate resolved, the step id and the risk, never the
 *  arguments. One that admits dispatches the op; anything else holds. The commit gateway's seam
 *  is the gateway's `d-341-trigger-preapproval-gate.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import { PreflightRequiredSignal } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  StepMeta,
  TriggerPreapprovalHooks,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { CatalogSessionGrantHooks, ExecutionContext, IngredientExecutor } from '../types.js';

const SLUG = 'pub/cat';
const SHORT_OP = 'x';
const OPERATION_ID = 'pub/cat.x';
const CONNECTION = 'primary-connection';
const STEP: StepMeta = { step_id: 'save' } as StepMeta;

const operation = (risk_tier: OperationRiskTier, extras: Partial<OperationSpec> = {}): OperationSpec => ({
  operation_id: OPERATION_ID, risk_tier, groups: ['g'], ...extras,
});

const manifestFor = (op: OperationSpec): IngredientManifest => ({
  slug: SLUG, name: 'Catalog', description: '', author: 'pub', kind: 'connection', category: 'action', risk_tier: 'read',
  input: {}, output: {}, operations: { [SHORT_OP]: op },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://api.example.test', auth: { kind: 'none' },
    executes: { [SHORT_OP]: { kind: 'rest', method: 'POST', path_template: '/x/{{id}}' } as ApiExecutionBinding } } },
});

/** A webhook's run under its door: the run sits at `read`, so a write holds for its ceiling. */
const harness = (opts: {
  admit?: TriggerPreapprovalHooks['admit'] | null;
  catalogSessionGrants?: CatalogSessionGrantHooks;
} = {}) => {
  const ingredientExecutor = vi.fn<IngredientExecutor>(async () => ({ ok: true }));
  const admit = vi.fn<TriggerPreapprovalHooks['admit']>(opts.admit ?? (() => 'tpa_1'));
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'receive-readings' } as never,
    stores: {} as never,
    ingredientExecutor,
    execution_source: { channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: 'whi_1', contract_id: 'door-1' },
    connectionProfileResolver: (): ConnectionOperationProfile => ({ allowed_operations: [SHORT_OP] }),
    ...(opts.admit !== null ? { triggerPreapprovals: { admit } } : {}),
    ...(opts.catalogSessionGrants !== undefined ? { catalogSessionGrants: opts.catalogSessionGrants } : {}),
  };
  return { ctx, admit, ingredientExecutor };
};

const run = (ctx: ExecutionContext, manifest: IngredientManifest): Promise<unknown> =>
  runCatalogOperation(ctx, manifest, SLUG, { operation: SHORT_OP, args: { id: '42' }, connection: 'raw-connection' },
    CONNECTION, undefined, undefined, STEP);

const held = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(PreflightRequiredSignal);
};

describe('D-341 slice B1 — the catalog gate asks the host for a trigger pre-approval', () => {
  it('one that admits dispatches the held op; the host is given the op the gate resolved, never the arguments', async () => {
    const { ctx, admit, ingredientExecutor } = harness();
    await expect(run(ctx, manifestFor(operation('write')))).resolves.toEqual({ ok: true });
    expect(admit).toHaveBeenCalledWith({ slug: SLUG, operation_id: OPERATION_ID, step_id: 'save', risk_tier: 'write' });
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('none, a host that fails, or no host: the op holds, and nothing is dispatched', async () => {
    for (const { ctx, ingredientExecutor } of [
      harness({ admit: () => null }),
      harness({ admit: () => { throw new Error('store unreadable'); } }),
      harness({ admit: null }),
    ]) {
      await held(run(ctx, manifestFor(operation('write'))));
      expect(ingredientExecutor).not.toHaveBeenCalled();
    }
  });

  it('is not asked for an op held at `always`, a destructive one, or one that needs no asking', async () => {
    for (const [name, manifest, holds] of [
      ['always', manifestFor(operation('write', { approval: 'always' })), true],
      ['destructive', manifestFor(operation('destructive')), true],
      ['a read', manifestFor(operation('read')), false],
    ] as const) {
      const { ctx, admit, ingredientExecutor } = harness();
      if (holds) await held(run(ctx, manifest));
      else await expect(run(ctx, manifest)).resolves.toEqual({ ok: true });
      expect(admit, name).not.toHaveBeenCalled();
      expect(ingredientExecutor, name).toHaveBeenCalledTimes(holds ? 0 : 1);
    }
  });

  it('is not asked when a session grant matched: the grant is spent instead', async () => {
    const consume = vi.fn<CatalogSessionGrantHooks['consume']>(() => true);
    const { ctx, admit } = harness({ catalogSessionGrants: { match: () => 'grant-1', consume, mint: () => undefined } });
    await expect(run(ctx, manifestFor(operation('write')))).resolves.toEqual({ ok: true });
    expect(admit).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
  });
});
