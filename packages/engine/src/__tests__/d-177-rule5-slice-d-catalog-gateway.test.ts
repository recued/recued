/** D-177 N.11 rule 5 slice D — catalog Gateway scoped-grant wiring. */

import { describe, expect, it, vi } from 'vitest';

import {
  PreflightRequiredSignal,
  canonicalArgHash,
  isPreflightRequiredSignal,
  projectResolvedArgs,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ArgHashes,
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
  StepMeta,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type {
  CatalogGrantCall,
  CatalogSessionGrantHooks,
  ExecutionContext,
  IngredientExecutor,
} from '../types.js';

const SLUG = 'pub/cat';
const SHORT_OP = 'send';
const OPERATION_ID = 'pub/cat.send';
const CONNECTION = 'primary-connection';

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: [SHORT_OP],
});

const operation = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: OPERATION_ID,
  risk_tier,
  groups: ['mail'],
  authority_args: ['recipient', 'body.cc'],
  ...extras,
});

const restBinding = (extras: Partial<ApiExecutionBinding> = {}): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/send',
  ...extras,
} as ApiExecutionBinding);

const surfacesWith = (binding: ApiExecutionBinding): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.test',
    auth: { kind: 'none' },
    executes: { [SHORT_OP]: binding },
  },
});

const manifestFor = (
  op: OperationSpec,
  binding: ApiExecutionBinding = restBinding(),
): IngredientManifest => ({
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
  surfaces: surfacesWith(binding),
});

const baseArgs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipient: '<ADA@Example.COM>',
  body: { cc: ['grace@example.com'] },
  note: 'hello',
  ...overrides,
});

const hashesFor = (args: Record<string, unknown>): ArgHashes =>
  canonicalArgHash(projectResolvedArgs(args));

const makeGrantHooks = (opts: {
  match?: CatalogSessionGrantHooks['match'];
  consume?: CatalogSessionGrantHooks['consume'];
  mint?: CatalogSessionGrantHooks['mint'];
} = {}): {
  sessionGrants: CatalogSessionGrantHooks;
  match: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['match']>>;
  consume: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['consume']>>;
  mint: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['mint']>>;
} => {
  const match = vi.fn<CatalogSessionGrantHooks['match']>(
    opts.match ?? (() => 'grant-1'),
  );
  const consume = vi.fn<CatalogSessionGrantHooks['consume']>(
    opts.consume ?? (() => true),
  );
  const mint = vi.fn<CatalogSessionGrantHooks['mint']>(
    opts.mint ?? (() => undefined),
  );
  return {
    sessionGrants: { match, consume, mint },
    match,
    consume,
    mint,
  };
};

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  result?: unknown;
  catalogSessionGrants?: CatalogSessionGrantHooks;
} = {}): {
  ctx: ExecutionContext;
  executorCalls: ExecutorCall[];
  auditCalls: GatewayCallAudit[];
  ingredientExecutor: ReturnType<typeof vi.fn<IngredientExecutor>>;
} => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = opts.result ?? { ok: true };
  const ingredientExecutor = vi.fn<IngredientExecutor>().mockImplementation(
    async (slug, input, output, stepOptions, stepMeta) => {
      executorCalls.push({ slug, input, output, stepOptions, stepMeta });
      return fallbackResult;
    },
  );
  const hasProfile = Object.prototype.hasOwnProperty.call(opts, 'profile');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    // D-209 Slice B — contracted-dispatch source ⇒ LOW `read` ceiling ⇒ write ops
    // HOLD for approval (this Slice-D grant surface holds then consults grants).
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: 'k1',
    },
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    ...(opts.catalogSessionGrants !== undefined
      ? { catalogSessionGrants: opts.catalogSessionGrants }
      : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };

  return { ctx, executorCalls, auditCalls, ingredientExecutor };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  opts: {
    args?: Record<string, unknown>;
    stepMeta?: StepMeta;
    connectionName?: string;
  } = {},
): Promise<unknown> => runCatalogOperation(
  ctx,
  manifest,
  SLUG,
  {
    operation: SHORT_OP,
    args: opts.args ?? baseArgs(),
    connection: 'raw-connection',
  },
  opts.connectionName ?? CONNECTION,
  undefined,
  undefined,
  opts.stepMeta,
);

const expectPreflightRequired = async (
  promise: Promise<unknown>,
): Promise<PreflightRequiredSignal> => {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
  expect(isPreflightRequiredSignal(thrown)).toBe(true);
  return thrown as PreflightRequiredSignal;
};

describe('runCatalogOperation D-177 rule-5 slice-D scoped destinations', () => {
  it('threads authority-arg destination emails into catalog match and consume', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const { sessionGrants, match, consume, mint } = makeGrantHooks({
      match: () => 'scoped-grant-1',
    });
    const { ctx, ingredientExecutor } = makeHarness({
      catalogSessionGrants: sessionGrants,
    });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { args })).resolves.toEqual({ ok: true });

    expect(match).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith({
      ingredient_slug: SLUG,
      operation_id: OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      pre_lift_approval: 'ask',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      destination_emails: ['ada@example.com', 'grace@example.com'],
    } satisfies CatalogGrantCall);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('scoped-grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      destination_emails: ['ada@example.com', 'grace@example.com'],
    });
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('omits destination_emails when an authority arg is not email-shaped', async () => {
    const args = baseArgs({ recipient: 'msg_123' });
    const { sessionGrants, match, consume } = makeGrantHooks({
      match: () => null,
    });
    const { ctx, ingredientExecutor } = makeHarness({
      catalogSessionGrants: sessionGrants,
    });
    const manifest = manifestFor(operation('write'));

    await expectPreflightRequired(run(ctx, manifest, { args }));

    expect(match).toHaveBeenCalledTimes(1);
    expect(match.mock.calls[0]![0]).not.toHaveProperty('destination_emails');
    expect(consume).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });
});
