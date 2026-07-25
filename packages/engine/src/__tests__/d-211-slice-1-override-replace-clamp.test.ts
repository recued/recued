/** D-211 Slice 1 — catalog-gateway coverage for the owner override REPLACE
 *  plane (D-211 §1/§2/§8), through the REAL gate
 *  (`runCatalogOperation`; only IO — the contract scan / profile / executor —
 *  is mocked). Harness cloned from d-166-slice-4d4-override-tightening.test.ts.
 *
 *  Pins the §8 acceptance set that lands with Slice 1:
 *   (i)  owner `approval:'never'` on an authored-`always` read → silent
 *        dispatch; the row-ABSENT harness pins the restored hold. (The real
 *        rpc upsert→dispatch→delete→re-hold loop is END-TO-END covered in
 *        backend `d-166-slice-a1-contract-override-rpc.test.ts`, "RPC write to
 *        gateway read loop" — this file only injects rows via the mocked scan.);
 *   (ii) a hand-stored below-floor row (write + `never`, injected via the
 *        mocked scan — the store's write-gate would refuse it) resolves at the
 *        `ask` floor fail-closed, and where the dispatch executes the audit
 *        row surfaces `approval_clamped_from`;
 *   (iii) owner risk reclass destructive→write moves the tier consumers see
 *        (`risk_tier` on the preflight signal = the resolution output field);
 *   (iv) each missing owner field falls back to that operation's pack value;
 *   (v)  an override row has ZERO effect on reachability — the grant plane
 *        alone admits (asserted with and without the row).
 */

import { describe, expect, it } from 'vitest';
import { isPreflightRequiredSignal, operationSpecHash } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  ContractRowLike,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  PreflightRequiredSignal,
  ProviderSurfaces,
  ScanFn,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

type OverrideValue = Readonly<{
  denied?: boolean;
  approval?: 'never' | 'ask' | 'always';
  risk?: OperationRiskTier;
  op_hash?: string;
}>;

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: ['x'],
});

const operation = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...extras,
});

const restBinding = (): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'GET',
  path_template: '/x/{{id}}',
} as ApiExecutionBinding);

const surfaces = (): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: { x: restBinding() },
  },
});

const manifestFor = (op: OperationSpec): IngredientManifest => ({
  slug: 'pub/cat',
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { x: op },
  surfaces: surfaces(),
});

const overrideRow = (
  segments: readonly string[],
  value: OverrideValue,
): ContractRowLike => ({ segments, value });

const makeContractScan = (rows: readonly ContractRowLike[]): ScanFn =>
  (scope, prefixSegments) => {
    if (scope !== 'owner_operation') return [];
    return rows.filter(
      (row) =>
        prefixSegments.length <= row.segments.length
        && prefixSegments.every((seg, i) => row.segments[i] === seg),
    );
  };

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  actor?: ExecutionContext['actor'];
  overrideRows?: readonly ContractRowLike[];
  execution_source?: ExecutionContext['execution_source'];
} = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = { ok: true };
  const ingredientExecutor: IngredientExecutor = async (
    slug,
    input,
    output,
    stepOptions,
    stepMeta,
  ) => {
    executorCalls.push({ slug, input, output, stepOptions, stepMeta });
    return fallbackResult;
  };
  const hasProfile = Object.prototype.hasOwnProperty.call(opts, 'profile');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor,
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };
  ctx.actor = opts.actor ?? 'user_self';
  ctx.contractScan = makeContractScan(opts.overrideRows ?? []);
  if (opts.execution_source !== undefined) ctx.execution_source = opts.execution_source;

  return { ctx, executorCalls, auditCalls, fallbackResult };
};

const run = (ctx: ExecutionContext, manifest: IngredientManifest) =>
  runCatalogOperation(
    ctx,
    manifest,
    'pub/cat',
    { operation: 'x', connection: 'raw-connection' },
    'primary-connection',
    undefined,
    undefined,
    undefined,
  );

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e;
  }
};

/** Owner-direct chat source: contract-free `user_self` → the `admin`
 *  contract-less trust ceiling (D-209 §1.4). */
const ownerDirectSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's1',
  user_id: 'u1',
} as const;

describe('D-211 §8 (i) — owner never on an authored-always read, both directions', () => {
  const manifest = manifestFor(operation('read', { approval: 'always' }));

  it('WITHOUT the row: the authored always holds the read for approval (the baseline hold)', async () => {
    const { ctx, executorCalls, auditCalls } = makeHarness({ overrideRows: [] });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe('pub/cat.x');
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('read');
    expect((caught as PreflightRequiredSignal).owner_override_offer).toEqual({
      kind: 'never_ask',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      op_hash: operationSpecHash(manifest.operations!.x),
      approval: 'never',
    });
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('WITH the row: the op dispatches silently (executor called, audit success at approval never)', async () => {
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { approval: 'never' }),
      ],
    });

    await expect(run(ctx, manifest)).resolves.toBe(fallbackResult);
    expect(executorCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      approval: 'never',
    });
    // No clamp happened — 'never' is AT the read floor, a legal ruling.
    expect(auditCalls[0]?.approval_clamped_from).toBeUndefined();
  });
});

describe('D-211 Slice 2 — authored-always write standing-ruling offer', () => {
  it('offers relax-to-ask only as the write floor, keyed to the exact global operation', async () => {
    const manifest = manifestFor(operation('write', { approval: 'always' }));
    const { ctx, executorCalls } = makeHarness({
      actor: 'contracted_user',
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).owner_override_offer).toEqual({
      kind: 'relax_to_ask',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      op_hash: operationSpecHash(manifest.operations!.x),
      approval: 'ask',
    });
    expect(executorCalls).toHaveLength(0);
  });
});

describe('D-211 §8 (ii) — a hand-stored below-floor row resolves at the floor, fail-closed', () => {
  // The write-gate refuses `approval:'never'` on a write op
  // (`owner_operation_below_floor`), so injecting the row through the mocked
  // contractScan IS the hand-stored case the spec names.
  const manifest = manifestFor(operation('write'));
  const belowFloorRow = overrideRow(['pub/cat', 'pub/cat.x'], {
    approval: 'never',
  });

  it('on a contracted door (read ceiling): the write HOLDS at ask — the stored never does not silence it', async () => {
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'contracted_user',
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { approval: 'never' }),
      ],
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('write');
    expect((caught as PreflightRequiredSignal).approval_clamped_from).toBe('never');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('where the dispatch executes (owner ceiling relaxes the clamped ask), the audit row surfaces approval_clamped_from', async () => {
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      overrideRows: [belowFloorRow],
      execution_source: ownerDirectSource,
    });

    await expect(run(ctx, manifest)).resolves.toBe(fallbackResult);
    expect(executorCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    // The stored below-floor value rides the durable row as the clamp marker.
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      risk_tier: 'write',
      approval_clamped_from: 'never',
    });
  });
});

describe('D-211 §8 (iii) — owner risk reclass destructive→write moves the tier consumers see', () => {
  it('the preflight signal (the resolution output) carries effective_risk_tier write + the ask floor', async () => {
    const manifest = manifestFor(operation('destructive'));
    const { ctx, executorCalls } = makeHarness({
      actor: 'contracted_user',
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { risk: 'write' }),
      ],
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    });

    const caught = await captureRejection(run(ctx, manifest));

    // Without the reclass this destructive op floors at `always`; with it the
    // consumers see a WRITE op at its `ask` floor — coherently (D-211 §2).
    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('write');
    expect(executorCalls).toHaveLength(0);
  });

  it('keeps the previous profile escalation after the owner value overlays the pack default', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx } = makeHarness({
      profile: {
        allowed_operations: ['x'],
        risk_overrides: { x: 'admin' },
      },
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { risk: 'write' }),
      ],
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('admin');
  });
});

describe('D-211 §8 (iv) — [pack defaults, owner replacements] per operation', () => {
  it('owner approval replaces the pack approval on that exact operation', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { approval: 'never' }),
      ],
    });

    await expect(run(ctx, manifest)).resolves.toBe(fallbackResult);
    expect(executorCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'success', approval: 'never' });
  });

  it('an absent owner approval falls back to the same operation\'s pack approval', async () => {
    const manifest = manifestFor(operation('read', { approval: 'always' }));
    const { ctx, executorCalls } = makeHarness({
      overrideRows: [
        // The owner row replaces ONLY risk; approval comes from this op's pack spec.
        overrideRow(['pub/cat', 'pub/cat.x'], { risk: 'read' }),
      ],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect(executorCalls).toHaveLength(0);
  });
});

describe('D-211 §8 (v) — an override row has ZERO effect on reachability (the grant plane alone admits)', () => {
  it('an ungranted op stays denied with the override row present — identically to without it', async () => {
    const manifest = manifestFor(operation('read'));
    const denyExpectation = {
      outcome: 'failed',
      operation_id: 'pub/cat.x',
      failure_mode: 'operation_not_granted',
    };

    // Direction 1: no override row — the missing grant denies.
    const bare = makeHarness({ profile: { allowed_operations: [] }, overrideRows: [] });
    const bareCaught = await captureRejection(run(bare.ctx, manifest));
    expect(bareCaught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(bareCaught)).toBe(false);
    expect(bare.executorCalls).toHaveLength(0);
    expect(bare.auditCalls[0]).toMatchObject(denyExpectation);

    // Direction 2: a both-fields override row cannot restore reach — the ruling
    // is risk/approval algebra, never access (§9(d): no `enabled` field exists).
    const ruled = makeHarness({
      profile: { allowed_operations: [] },
      overrideRows: [
        overrideRow(['pub/cat', 'pub/cat.x'], { approval: 'never', risk: 'read' }),
      ],
    });
    const ruledCaught = await captureRejection(run(ruled.ctx, manifest));
    expect(ruledCaught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(ruledCaught)).toBe(false);
    expect(ruled.executorCalls).toHaveLength(0);
    expect(ruled.auditCalls[0]).toMatchObject(denyExpectation);
  });
});
