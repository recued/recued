/** D-209 #1 — the per-door ceiling at the REAL catalog-dispatch chokepoint.
 *
 *  `ctx.contract_snapshot` now rides onto the engine ctx, and the gateway's
 *  `dispatchCeiling` reads its authored `max_risk_without_approval` (honored
 *  only on a contract_id match). These tests dispatch a write-tier op through
 *  the real `runCatalogOperation`:
 *
 *    - contracted source, no snapshot           → HOLDS (PreflightRequiredSignal)
 *    - own door's snapshot, ceiling `admin`     → DISPATCHES (silent admit)
 *    - ANOTHER contract's snapshot, `admin`     → still HOLDS
 *
 *  The hold case is the pre-existing D-209 Slice-B behavior; the other two are
 *  what this slice adds. */

import { describe, expect, it, vi } from 'vitest';
import {
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  ContractSnapshot,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const SLUG = 'pub/cat';
const SHORT_OP = 'x';
const OPERATION_ID = 'pub/cat.x';
const CONNECTION = 'primary-connection';
const DOOR_CONTRACT_ID = 'door-contract-1';

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: [SHORT_OP],
});

const operation = (risk_tier: OperationRiskTier): OperationSpec => ({
  operation_id: OPERATION_ID,
  risk_tier,
  groups: ['g'],
});

const restBinding = (): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/x/{{id}}',
} as ApiExecutionBinding);

const surfaces = (): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.test',
    auth: { kind: 'none' },
    executes: { [SHORT_OP]: restBinding() },
  },
});

const manifestFor = (op: OperationSpec): IngredientManifest => ({
  slug: SLUG,
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { [SHORT_OP]: op },
  surfaces: surfaces(),
});

const snapshotFor = (
  contract_id: string,
  ceiling?: ContractSnapshot['max_risk_without_approval'],
): ContractSnapshot => ({
  contract_id,
  contract_version: 'v1',
  allowed_tools: [SLUG],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
  ...(ceiling === undefined ? {} : { max_risk_without_approval: ceiling }),
});

const makeHarness = (opts: { snapshot?: ContractSnapshot } = {}): {
  ctx: ExecutionContext;
  ingredientExecutor: ReturnType<typeof vi.fn<IngredientExecutor>>;
} => {
  const ingredientExecutor = vi.fn<IngredientExecutor>().mockResolvedValue({ ok: true });
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: DOOR_CONTRACT_ID,
    },
    ...(opts.snapshot === undefined ? {} : { contract_snapshot: opts.snapshot }),
    connectionProfileResolver: () => allowedProfile(),
  };
  return { ctx, ingredientExecutor };
};

const run = (ctx: ExecutionContext): Promise<unknown> => runCatalogOperation(
  ctx,
  manifestFor(operation('write')),
  SLUG,
  {
    operation: SHORT_OP,
    args: { id: '42' },
    connection: 'raw-connection',
  },
  CONNECTION,
  undefined,
  undefined,
  undefined,
);

describe('D-209 #1 — per-door ceiling at the catalog-dispatch chokepoint', () => {
  it('a contracted write with NO snapshot holds (the Slice-B baseline this raises from)', async () => {
    const { ctx, ingredientExecutor } = makeHarness();
    let thrown: unknown;
    try {
      await run(ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect(isPreflightRequiredSignal(thrown)).toBe(true);
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('the door\'s OWN authored `admin` ceiling admits the granted write silently', async () => {
    const { ctx, ingredientExecutor } = makeHarness({
      snapshot: snapshotFor(DOOR_CONTRACT_ID, 'admin'),
    });
    await expect(run(ctx)).resolves.toEqual({ ok: true });
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('ANOTHER contract\'s snapshot never raises this dispatch — the write still holds', async () => {
    const { ctx, ingredientExecutor } = makeHarness({
      snapshot: snapshotFor('some-other-contract', 'admin'),
    });
    let thrown: unknown;
    try {
      await run(ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('the door\'s own snapshot WITHOUT the field keeps the hold (absent = flat default)', async () => {
    const { ctx, ingredientExecutor } = makeHarness({
      snapshot: snapshotFor(DOOR_CONTRACT_ID),
    });
    let thrown: unknown;
    try {
      await run(ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });
});
