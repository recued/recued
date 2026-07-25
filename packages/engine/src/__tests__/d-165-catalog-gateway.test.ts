import { describe, it, expect } from 'vitest';
import {
  PreflightRequiredSignal,
  canonicalArgHash,
  isPreflightRequiredSignal,
  projectResolvedArgs,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  ExecutionSource,
  GatewayCallAudit,
  GraphQLExecutionBinding,
  IngredientManifest,
  OperationPaginationSpec,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
  ConnectorExecutionBinding,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { CliInvocationCall, ExecutionContext, IngredientExecutor } from '../types.js';

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

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

/** Default REST binding for operation `x` (`GET /x/{{id}}`). Tests that need a
 *  different verb / static wire bits pass their own binding. */
const restBinding = (extras: Partial<ApiExecutionBinding> = {}): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'GET',
  path_template: '/x/{{id}}',
  ...extras,
} as ApiExecutionBinding);

const surfacesWith = (binding: ApiExecutionBinding | undefined): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: binding ? { x: binding } : {},
  },
});

const cliBinding = (
  extras: Partial<ConnectorExecutionBinding> = {},
): ConnectorExecutionBinding => ({
  kind: 'cli_invocation',
  argv_template: ['codex', 'exec', '--cd', '{repo_dir}', '{task}'],
  stdin_handling: 'none',
  shape: 'text',
  exit_code_handling: 'zero_is_success',
  ...extras,
} as ConnectorExecutionBinding);

const connectorSurfacesWith = (
  binding: ConnectorExecutionBinding | undefined,
): ProviderSurfaces => ({
  connector: {
    runtime: {
      transport: 'stdio',
      wire_protocol: 'cli_invocation',
      package_ref: 'system_binary:codex',
      entry_point: 'codex',
      expected_protocol_version: 1,
    },
    lifecycle: {
      auth: { method: 'none' },
      connect: { idempotent: true, startup_timeout_ms: 30_000 },
      invoke: { default_method_timeout_ms: 30_000 },
      disconnect: { graceful_shutdown_timeout_ms: 30_000 },
      reconnect_policy: 'manual_only',
      persistent_connection: false,
      idle_disconnect_ms: 0,
    },
    executes: binding ? { x: binding } : {},
  },
});

const manifestFor = (
  op: OperationSpec,
  binding: ApiExecutionBinding | null = restBinding(),
): IngredientManifest => ({
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
  // `null` → no binding (surface declares an empty `executes`), exercising the
  // gateway's fail-closed `no_api_binding` path. (Passing `undefined` would
  // trigger the default `restBinding()`.)
  surfaces: surfacesWith(binding ?? undefined),
});

const connectorManifestFor = (
  op: OperationSpec,
  binding: ConnectorExecutionBinding | null = cliBinding(),
): IngredientManifest => ({
  ...manifestFor(op),
  surfaces: connectorSurfacesWith(binding ?? undefined),
});

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  /** D-182 §7.2 — the per-contract cli reachability verdict the harness's
   *  resolver returns (default `true` — reachable; pass `false` to exercise the
   *  fail-closed `cli_reachability_disabled` deny). */
  cliReachable?: boolean;
  executor?: IngredientExecutor;
  cliExecutor?: (call: CliInvocationCall) => Promise<unknown>;
  result?: unknown;
  cliResult?: unknown;
  manifestGetter?: (slug: string) => IngredientManifest | null;
  onCatalogDispatchProceed?: ExecutionContext['onCatalogDispatchProceed'];
} = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const cliCalls: CliInvocationCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = opts.result ?? { ok: true };
  const ingredientExecutor: IngredientExecutor = async (
    slug,
    input,
    output,
    stepOptions,
    stepMeta,
  ) => {
    executorCalls.push({ slug, input, output, stepOptions, stepMeta });
    if (opts.executor) return opts.executor(slug, input, output, stepOptions, stepMeta);
    return fallbackResult;
  };
  const hasProfile = Object.prototype.hasOwnProperty.call(opts, 'profile');
  const cliReachable = Object.prototype.hasOwnProperty.call(opts, 'cliReachable')
    ? opts.cliReachable ?? false
    : true;
  const cliInvocationExecutor = opts.cliExecutor
    ?? (opts.cliResult !== undefined
      ? async (call: CliInvocationCall) => {
          cliCalls.push(call);
          return opts.cliResult;
        }
      : undefined);
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor,
    ...(cliInvocationExecutor ? { cliInvocationExecutor } : {}),
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    // D-182 §7.2 — cli ops authorize via this per-contract reachability resolver,
    // never a connection profile. The harness returns a fixed verdict regardless
    // of (principal, ingredient, operation).
    cliReachabilityResolver: () => cliReachable,
    ...(opts.manifestGetter ? { manifestGetter: opts.manifestGetter } : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
    ...(opts.onCatalogDispatchProceed
      ? { onCatalogDispatchProceed: opts.onCatalogDispatchProceed }
      : {}),
  };

  return { ctx, executorCalls, cliCalls, auditCalls, fallbackResult };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  stepMeta?: Record<string, unknown>,
) => runCatalogOperation(
  ctx,
  manifest,
  'pub/cat',
  { operation: 'x', connection: 'raw-connection' },
  'primary-connection',
  undefined,
  undefined,
  stepMeta as any,
);

describe('D-165 catalog gateway', () => {
  it('dispatches admitted read operations under the catalog slug with the resolved wire params + connection, and audits success', async () => {
    const manifest = manifestFor(operation('read'));
    const result = { value: 42 };
    const { ctx, executorCalls, auditCalls } = makeHarness({ result });

    await expect(run(ctx, manifest)).resolves.toBe(result);

    expect(executorCalls).toHaveLength(1);
    // D-165 RUNTIME — direct surface dispatch runs under the CATALOG's own
    // slug (no wrapper hop); the binding supplies method + path, the gateway
    // folds in connection_kind + the engine-resolved connection.
    expect(executorCalls[0].slug).toBe('pub/cat');
    expect(executorCalls[0].input).toEqual({
      method: 'GET',
      path: '/x/{{id}}',
      connection_kind: 'api',
      connection: 'primary-connection',
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      connection_name: 'primary-connection',
    });
  });

  it('folds exact REST JSON integer modes into engine-owned adapter inputs', async () => {
    const binding = restBinding({
      method: 'POST',
      response_json: { unsafe_integers: 'string' },
      request_json: { decimal_integer_fields: ['person_id', 'assignee_ids[]'] },
    } as Partial<ApiExecutionBinding>);
    const manifest = manifestFor(operation('read'), binding);
    const { ctx, executorCalls } = makeHarness();

    await run(ctx, manifest);

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({
      __rc_json_unsafe_integers: 'string',
      __rc_json_decimal_integer_fields: '["person_id","assignee_ids[]"]',
    });
  });

  it('preserves lossless response parsing on Link-header continuation pages', async () => {
    const manifest = manifestFor(operation('read'), restBinding({
      response_json: { unsafe_integers: 'string' },
    } as Partial<ApiExecutionBinding>));
    (manifest.operations!.x as OperationSpec).pagination = {
      style: 'link_header',
      header: 'link',
    };
    const dispatched: Array<Record<string, unknown>> = [];
    const { ctx } = makeHarness({
      executor: async (_slug, input) => {
        const wire = input as Record<string, unknown>;
        dispatched.push(wire);
        return dispatched.length === 1
          ? {
              status: 200,
              headers: { link: '<https://api.example.com/x?page=2>; rel="next"' },
              result: [{ id: '9007199254741623' }],
            }
          : { status: 200, headers: {}, result: [{ id: '9007199254741650' }] };
      },
    });

    await run(ctx, manifest);

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0].__rc_json_unsafe_integers).toBe('string');
    expect(dispatched[1]).toMatchObject({
      method: 'GET',
      path: '/x?page=2',
      __rc_json_unsafe_integers: 'string',
    });
  });

  it('runs the host proceed reservation after admission and before provider dispatch', async () => {
    const order: string[] = [];
    const manifest = manifestFor(operation('read'));
    const { ctx } = makeHarness({
      onCatalogDispatchProceed: (call) => {
        expect(call).toMatchObject({
          ingredient_slug: 'pub/cat',
          operation_id: 'pub/cat.x',
          connection_name: 'primary-connection',
        });
        order.push('usage');
      },
      executor: async () => {
        order.push('dispatch');
        return { ok: true };
      },
    });

    await run(ctx, manifest);
    expect(order).toEqual(['usage', 'dispatch']);
  });

  it('crosses no provider boundary when the host proceed reservation denies', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({
      onCatalogDispatchProceed: () => {
        throw new Error('tool_call usage limit exceeded');
      },
    });

    await expect(run(ctx, manifest)).rejects.toThrow('tool_call usage limit exceeded');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('translates the binding + args into connection-api wire params; strips engine-locked keys from args (case-insensitively) and the binding wins on method/path', async () => {
    const manifest = manifestFor(
      operation('read'),
      restBinding({
        method: 'GET',
        path_template: '/deals/{{deal_id}}',
        static_query: { properties: 'dealname,amount' },
      } as Partial<ApiExecutionBinding>),
    );
    const { ctx, executorCalls } = makeHarness();

    await runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      {
        operation: 'x',
        // args carry the path-param value + a body field + a legit custom
        // header, PLUS a battery of hostile D-112 lock-bypass attempts: redirect
        // the call (method/url), and inject auth/cookie/host headers using MIXED
        // CASE to slip past a case-sensitive lock check (Codex review HIGH). The
        // binding/lock must defeat all of them.
        args: {
          deal_id: '42',
          'body.x': 1,
          'header.X-Trace': 'ok',
          method: 'DELETE',
          path: '/evil',
          url: 'https://evil.test',
          'header.Authorization': 'Bearer evil',
          'header.Cookie': 'sid=evil',
          'header.Host': 'evil.test',
          // whitespace-padded variant — must also strip (Codex verify LOW).
          'header.Authorization ': 'Bearer trailing-space-evil',
        },
        connection: 'raw',
      },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    );

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toEqual({
      deal_id: '42',
      'body.x': 1,
      // legit custom header survives; `path` is not a locked key but the binding
      // overwrites it last anyway.
      'header.X-Trace': 'ok',
      'query.properties': 'dealname,amount',
      // binding-owned, applied LAST — the hostile method/path are overwritten;
      // `url` + mixed-case `header.Authorization`/`Cookie`/`Host` are stripped.
      method: 'GET',
      path: '/deals/{{deal_id}}',
      connection_kind: 'api',
      connection: 'primary-connection',
    });
  });

  it('fails a closed request schema before an approval pause or provider dispatch', async () => {
    const manifest = manifestFor(operation('write', {
      request_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['header.Idempotency-Key', 'body.amount'],
        properties: {
          'header.Idempotency-Key': { type: 'string', minLength: 1, maxLength: 255 },
          'body.amount': { type: 'integer', minimum: 1 },
        },
      },
    }), restBinding({ method: 'POST', path_template: '/charges' }));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      {
        operation: 'x',
        args: {
          'header.Idempotency-Key': 'idem-1',
          'body.amount': 2_500,
          body_raw: 'amount=1',
        },
      },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow("undeclared argument 'body_raw'");

    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        failure_mode: 'request_schema_violation',
        operation_id: 'pub/cat.x',
      }),
    ]);
  });

  it('enforces required, type, range, and pattern constraints on closed request schemas', async () => {
    const manifest = manifestFor(operation('read', {
      request_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'amount'],
        properties: {
          session_id: { type: 'string', pattern: '^cs_', maxLength: 20 },
          amount: { type: 'integer', minimum: 1, maximum: 10_000 },
        },
      },
    }), restBinding({ path_template: '/sessions/{{session_id}}' }));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { amount: 10 } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow("missing required argument 'session_id'");
    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { session_id: 'not-a-session', amount: 10 } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow("argument 'session_id' does not match its required pattern");
    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { session_id: 'cs_test_1', amount: 10.5 } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow("argument 'amount' must be integer");
    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { session_id: `cs_${'x'.repeat(20)}`, amount: 10 } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow("argument 'session_id' is longer than 20");

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { session_id: 'cs_test_1', amount: 10 } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).resolves.toEqual({ ok: true });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]?.input).toMatchObject({ session_id: 'cs_test_1', amount: 10 });
    expect(auditCalls).toHaveLength(5);
    expect(auditCalls.slice(0, 4).every((entry) =>
      entry.failure_mode === 'request_schema_violation'))
      .toBe(true);
    expect(auditCalls[4]).toMatchObject({ outcome: 'success' });
  });

  it('fails closed on an unsupported strict-schema keyword even if publish validation was bypassed', async () => {
    const manifest = manifestFor(operation('read', {
      request_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', format: 'uri' },
        },
      },
    }), restBinding({ path_template: '/sessions/{{session_id}}' }));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { session_id: 'cs_test_1' } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(
      "invalid closed request schema: property 'session_id' uses unsupported keyword 'format'",
    );

    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        failure_mode: 'request_schema_violation',
      }),
    ]);
  });

  it('D-182 merge_query — a recipe query.properties UNIONS with the binding static list (static first, deduped)', async () => {
    const manifest = manifestFor(
      operation('read'),
      restBinding({
        method: 'GET',
        path_template: '/deals/{{deal_id}}',
        static_query: { properties: 'dealname,amount' },
        merge_query: ['properties'],
      } as Partial<ApiExecutionBinding>),
    );
    const { ctx, executorCalls } = makeHarness();

    await runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { deal_id: '42', 'query.properties': 'custom_a,amount,custom_b' }, connection: 'raw' },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    );

    expect(executorCalls).toHaveLength(1);
    // Static defaults first, recipe extras appended, the duplicate `amount` dropped.
    expect((executorCalls[0].input as Record<string, unknown>)['query.properties']).toBe(
      'dealname,amount,custom_a,custom_b',
    );
  });

  it('D-182 merge_query absent — static_query still CLOBBERS a recipe query.properties (call-target lock preserved)', async () => {
    const manifest = manifestFor(
      operation('read'),
      restBinding({
        method: 'GET',
        path_template: '/deals/{{deal_id}}',
        static_query: { properties: 'dealname,amount' },
      } as Partial<ApiExecutionBinding>),
    );
    const { ctx, executorCalls } = makeHarness();

    await runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { deal_id: '42', 'query.properties': 'custom_a' }, connection: 'raw' },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    );

    expect(executorCalls).toHaveLength(1);
    expect((executorCalls[0].input as Record<string, unknown>)['query.properties']).toBe('dealname,amount');
  });

  it('strips an engine-locked static_header at runtime even if it bypassed the publish validator', async () => {
    // The validator rejects locked header names in static_headers at publish,
    // but a hand-edited community/ JSON could carry one — the gateway's runtime
    // re-strip must drop it (Codex verify LOW / defense-in-depth).
    const manifest = manifestFor(
      operation('read'),
      restBinding({
        method: 'GET',
        path_template: '/x',
        static_headers: { Cookie: 'sid=evil', 'X-Ok': 'keep' },
      } as Partial<ApiExecutionBinding>),
    );
    const { ctx, executorCalls } = makeHarness();

    await run(ctx, manifest);

    expect(executorCalls).toHaveLength(1);
    const input = executorCalls[0].input;
    expect(input['header.Cookie']).toBeUndefined();
    expect(input['header.X-Ok']).toBe('keep');
  });

  it('pauses ask verdicts with a PreflightRequiredSignal and does not dispatch or audit', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();
    // D-209 Slice B — a CONTRACTED dispatch (LOW `read` ceiling) so the write HOLDS
    // for approval instead of relaxing on the owner's own `admin` trust.
    const contractedCtx: ExecutionContext = {
      ...ctx,
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    };
    let caught: unknown;

    try {
      await run(contractedCtx, manifest);
    } catch (e) {
      caught = e;
    }

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe('pub/cat.x');
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('write');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('executes resumed ask verdicts when preflight was already admitted', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(
      run(ctx, manifest, {
        preflight_admitted: true,
        // D-165 op-identity binding — match the re-resolved (slug, operation,
        // connection) the `run` helper drives (`pub/cat` / `pub/cat.x` /
        // `primary-connection`).
        preflight_approved_target: {
          ingredient_slug: 'pub/cat',
          operation_id: 'pub/cat.x',
          connection_name: 'primary-connection',
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].slug).toBe('pub/cat');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      operation_id: 'pub/cat.x',
      risk_tier: 'write',
    });
  });

  it('fails closed without a connection profile and audits the deny reason', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({ profile: null });
    let caught: unknown;

    try {
      await run(ctx, manifest);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(caught)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'no_connection_profile',
    });
  });

  it('fails closed with no_api_binding when the admitted operation has no surface binding', async () => {
    // surfaces present but `executes` empty → no binding for `x`.
    const manifest = manifestFor(operation('read'), null);
    const { ctx, executorCalls, auditCalls } = makeHarness();
    let caught: unknown;

    try {
      await run(ctx, manifest);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no_api_binding/);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'no_api_binding',
    });
  });

  it('fails closed with unsupported_binding_kind for a realtime/subscription binding (not a synchronous dispatch)', async () => {
    const manifest = manifestFor(
      operation('read'),
      { kind: 'webhook_subscription', signature_scheme: 'hubspot_v3' } as ApiExecutionBinding,
    );
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(run(ctx, manifest)).rejects.toThrow(/unsupported_binding_kind/);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'unsupported_binding_kind',
    });
  });

  // D-192 Gate E′ Gap 4a — the transport protocol registry (`PROTOCOL_EXECUTORS`)
  // is the SINGLE seam mapping `binding.kind` → executor, and adding a protocol is
  // opt-IN (a new registry entry). So a binding kind with NO entry must fail closed
  // at dispatch — never silently no-op or dispatch untranslated. `webhook_subscription`
  // is covered above; this pins the remaining unregistered realtime kinds so the whole
  // "kind absent from the registry ⇒ fail closed" set stays inert-but-safe.
  it.each(['queue_subscription', 'push_channel'] as const)(
    'fails closed with unsupported_binding_kind for the unregistered transport kind %s',
    async (kind) => {
      const manifest = manifestFor(
        operation('read'),
        { kind } as unknown as ApiExecutionBinding,
      );
      const { ctx, executorCalls, auditCalls } = makeHarness();

      await expect(run(ctx, manifest)).rejects.toThrow(/unsupported_binding_kind/);
      // No executor call — dispatch was refused BEFORE any IO.
      expect(executorCalls).toHaveLength(0);
      expect(auditCalls[0]).toMatchObject({
        outcome: 'failed',
        failure_mode: 'unsupported_binding_kind',
      });
    },
  );

  it('dispatches a GraphQL binding as POST { query, variables } with the args as the variables', async () => {
    const manifest = manifestFor(
      operation('read'),
      {
        kind: 'graphql',
        operation_type: 'query',
        endpoint_path: '/graphql',
        query: 'query Deal($id: ID!) { deal(id: $id) { id } }',
      } as ApiExecutionBinding,
    );
    // A data-present response (the connection-api `{ status, headers, result }`
    // envelope, `result` = the GraphQL body) so the fail-when-data-null gate
    // passes and the dispatch resolves.
    const { ctx, executorCalls } = makeHarness({
      result: { status: 200, headers: {}, result: { data: { deal: { id: '42' } } } },
    });

    await runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { id: '42' }, connection: 'raw' },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    );

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].slug).toBe('pub/cat');
    expect(executorCalls[0].input).toEqual({
      method: 'POST',
      path: '/graphql',
      'body.query': 'query Deal($id: ID!) { deal(id: $id) { id } }',
      'body.variables': { id: '42' },
      connection_kind: 'api',
      connection: 'primary-connection',
    });
  });

  // ── D-192 Gate E′ — GraphQL response envelope (fail-when-data-null) ──
  //
  // GraphQL rides the shared HTTP transport but returns HTTP 200 even on
  // failure, carrying `{ data, errors }`. The gateway reads the op's data
  // payload at the binding's `result_data_path` (default `data`) and fails the
  // step when it is null/absent — otherwise a failed op is a silent empty
  // success. Partial data (a present-but-nulls payload) is tolerated.

  const graphqlManifest = (extras: Partial<GraphQLExecutionBinding> = {}): IngredientManifest =>
    manifestFor(operation('read'), {
      kind: 'graphql',
      operation_type: 'query',
      endpoint_path: '/graphql',
      query: 'query Deal($id: ID!) { deal(id: $id) { id } }',
      ...extras,
    } as ApiExecutionBinding);

  const runGraphql = (ctx: ExecutionContext, manifest: IngredientManifest) =>
    runCatalogOperation(
      ctx, manifest, 'pub/cat',
      { operation: 'x', args: { id: '42' }, connection: 'raw' },
      'primary-connection', undefined, undefined, undefined,
    );

  it('graphql: passes a data-present response through unchanged and audits success', async () => {
    const result = { status: 200, headers: {}, result: { data: { deal: { id: '42' } } } };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(runGraphql(ctx, graphqlManifest())).resolves.toBe(result);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'success' });
  });

  it('graphql: fails when data is null, surfacing errors[] and auditing graphql_error exactly ONCE', async () => {
    const result = {
      status: 200,
      headers: {},
      result: { data: null, errors: [{ message: 'Not authorized' }] },
    };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(runGraphql(ctx, graphqlManifest()))
      .rejects.toThrow(/returned no data at 'data' — Not authorized/);
    // Exactly one audit row — the specific graphql_error, NOT a second generic
    // `error` row from the catch-all (the failureAudited guard).
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'failed', failure_mode: 'graphql_error' });
  });

  it('graphql: fails when data is absent even with no errors[] (empty/malformed response)', async () => {
    const result = { status: 200, headers: {}, result: {} };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(runGraphql(ctx, graphqlManifest()))
      .rejects.toThrow(/returned no data at 'data'\./);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'failed', failure_mode: 'graphql_error' });
  });

  it('graphql: tolerates partial data (payload present with nulls inside) as success', async () => {
    const result = {
      status: 200,
      headers: {},
      result: { data: { deal: null }, errors: [{ message: 'deal not found' }] },
    };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(runGraphql(ctx, graphqlManifest())).resolves.toBe(result);
    expect(auditCalls[0]).toMatchObject({ outcome: 'success' });
  });

  it('graphql: reads the data payload at a custom result_data_path', async () => {
    const result = { status: 200, headers: {}, result: { viewer: { id: 'me' } } };
    const { ctx } = makeHarness({ result });

    await expect(
      runGraphql(ctx, graphqlManifest({ result_data_path: 'viewer' })),
    ).resolves.toBe(result);
  });

  it('graphql: result_data_path of "" treats the whole response body as the data payload', async () => {
    const result = { status: 200, headers: {}, result: { id: 'root' } };
    const { ctx } = makeHarness({ result });

    await expect(
      runGraphql(ctx, graphqlManifest({ result_data_path: '' })),
    ).resolves.toBe(result);
  });

  it('graphql: a null payload at a custom result_data_path still fails', async () => {
    const result = {
      status: 200,
      headers: {},
      result: { viewer: null, errors: [{ message: 'nope' }] },
    };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(
      runGraphql(ctx, graphqlManifest({ result_data_path: 'viewer' })),
    ).rejects.toThrow(/returned no data at 'viewer' — nope/);
    expect(auditCalls[0]).toMatchObject({ failure_mode: 'graphql_error' });
  });

  it('graphql: a prototype-sensitive result_data_path reads no inherited value (own-property walk) and fails', async () => {
    // Runtime backstop for a hand-built binding the validator would reject:
    // `__proto__` must NOT resolve to Object.prototype (a truthy inherited
    // value) and mask an absent data payload as success.
    const result = { status: 200, headers: {}, result: { data: null } };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(
      runGraphql(ctx, graphqlManifest({ result_data_path: '__proto__' })),
    ).rejects.toThrow(/returned no data at '__proto__'/);
    expect(auditCalls[0]).toMatchObject({ failure_mode: 'graphql_error' });
  });

  it('fails closed with unsupported_binding_kind for a graphql SUBSCRIPTION binding (needs WS/SSE, not POST)', async () => {
    const manifest = manifestFor(
      operation('read'),
      {
        kind: 'graphql',
        operation_type: 'subscription',
        endpoint_path: '/graphql',
        query: 'subscription { dealUpdated { id } }',
      } as ApiExecutionBinding,
    );
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(run(ctx, manifest)).rejects.toThrow(/unsupported_binding_kind/);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'unsupported_binding_kind',
    });
  });

  // D-192 #8g — graphql_relay pagination. The cursor rides a GraphQL VARIABLE, so
  // (unlike the rest wire-param styles) it can only walk inside the graphql
  // executor, after the fail-when-data-null gate passes on page 1.
  it('graphql: walks Relay pageInfo pagination, merging nodes at result_path', async () => {
    const pagination: OperationPaginationSpec = {
      style: 'graphql_relay',
      page_size: { variable: 'first', value: 50 },
      page_info_path: 'data.issues.pageInfo',
      cursor_variable: 'after',
    };
    const manifest = graphqlManifest();
    (manifest.operations!.x as OperationSpec).pagination = pagination;
    // Records envelope = the connection's `nodes` array (walked + merged here).
    (manifest.operations!.x as OperationSpec).result_path = 'data.issues.nodes';

    const dispatched: Array<Record<string, unknown>> = [];
    const executor: IngredientExecutor = async (_slug, input) => {
      dispatched.push(input as Record<string, unknown>);
      const vars = (input as Record<string, unknown>)['body.variables'] as Record<string, unknown>;
      if (vars?.after === undefined) {
        return {
          status: 200,
          headers: {},
          result: { data: { issues: {
            nodes: [{ id: 'N1' }],
            pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
          } } },
        };
      }
      expect(vars.after).toBe('CUR1');
      return {
        status: 200,
        headers: {},
        result: { data: { issues: {
          nodes: [{ id: 'N2' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } },
      };
    };
    const { ctx, auditCalls } = makeHarness({ executor });

    const out = (await runGraphql(ctx, manifest)) as {
      result: { data: { issues: { nodes: unknown[] } } };
    };

    // Nodes merged across both pages at the op's result_path.
    expect(out.result.data.issues.nodes).toEqual([{ id: 'N1' }, { id: 'N2' }]);
    expect(dispatched).toHaveLength(2);
    // Page 1 carries the declared page-size variable (injected by beforeDispatch)
    // alongside the caller's variables, but no cursor yet.
    expect(dispatched[0]['body.variables']).toEqual({ id: '42', first: 50 });
    // The follow page re-issues the SAME query with the `after` cursor set plus the
    // page-size variable, alongside the caller's original variables.
    expect(dispatched[1]['body.variables']).toEqual({ id: '42', after: 'CUR1', first: 50 });
    const audit = auditCalls.find((c) => c.outcome === 'success');
    expect(audit?.pages_fetched).toBe(2);
    expect(audit?.truncated).not.toBe(true);
  });

  it('graphql: a single relay page (hasNextPage false) certifies complete in one call', async () => {
    const pagination: OperationPaginationSpec = {
      style: 'graphql_relay',
      page_info_path: 'data.issues.pageInfo',
      cursor_variable: 'after',
    };
    const manifest = graphqlManifest();
    (manifest.operations!.x as OperationSpec).pagination = pagination;
    (manifest.operations!.x as OperationSpec).result_path = 'data.issues.nodes';

    const result = {
      status: 200,
      headers: {},
      result: { data: { issues: {
        nodes: [{ id: 'N1' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } },
    };
    const { ctx, auditCalls } = makeHarness({ result });

    await expect(runGraphql(ctx, manifest)).resolves.toBe(result);
    const audit = auditCalls.find((c) => c.outcome === 'success');
    expect(audit?.pages_fetched).toBe(1);
    expect(audit?.truncated).not.toBe(true);
  });

  it('dispatches admitted cli_invocation connector bindings through the CLI executor and audits connector success', async () => {
    const manifest = connectorManifestFor(operation('write', { timeout_ms: 15_000 }));
    const cliResult = {
      mode: 'foreground',
      exit_code: 0,
      stdout: 'done',
      duration_ms: 10,
    };
    const { ctx, executorCalls, cliCalls, auditCalls } = makeHarness({ cliResult });

    // D-182 §7.2 — a cli op is CONNECTION-LESS; it authorizes via the
    // per-contract reachability the harness wires (default reachable), NOT a
    // connection profile. The dispatched `connection` is empty + the audit reflects that.
    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      {
        operation: 'x',
        args: {
          repo_dir: '/repo',
          task: 'ship it',
        },
      },
      '',
      undefined,
      undefined,
      {
        preflight_admitted: true,
        preflight_approved_target: {
          ingredient_slug: 'pub/cat',
          operation_id: 'pub/cat.x',
          connection_name: '',
        },
      } as any,
    )).resolves.toBe(cliResult);

    expect(executorCalls).toHaveLength(0);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toMatchObject({
      slug: 'pub/cat',
      operation_key: 'x',
      operation_id: 'pub/cat.x',
      args: { repo_dir: '/repo', task: 'ship it' },
      timeout_ms: 15_000,
      binding: { kind: 'cli_invocation' },
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'write',
      connection_name: '',
      surface_kind: 'connector',
    });
  });

  it('fails closed with no_cli_executor when an admitted cli_invocation has no runtime hook', async () => {
    const manifest = connectorManifestFor(operation('read'));
    // cli read op auto-admits via the harness's default reachability, then
    // fails closed for the missing executor.
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { repo_dir: '/repo', task: 'ship it' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/no_cli_executor/);

    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'no_cli_executor',
      surface_kind: 'connector',
    });
  });

  it('D-182 §7.2 — denies a connection-less cli op with cli_reachability_disabled (NOT no_connection_profile) when not reachable', async () => {
    const manifest = connectorManifestFor(operation('read'));
    // Not reachable — the gap-closing path: a connection-less cli op must NEVER
    // deny `no_connection_profile`; it answers `cli_reachability_disabled`
    // (no allowlist row admits the run's principal at this risk tier).
    const { ctx, executorCalls, cliCalls, auditCalls } = makeHarness({ cliReachable: false });

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { repo_dir: '/repo', task: 'ship it' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow();

    expect(executorCalls).toHaveLength(0);
    expect(cliCalls ?? []).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'cli_reachability_disabled',
      surface_kind: 'connector',
      connection_name: '',
    });
  });

  it('D-182 §7.2 — admits + dispatches a reachable cli read op through the CLI executor (no connection profile in play)', async () => {
    const manifest = connectorManifestFor(operation('read'));
    const cliResult = { mode: 'foreground', exit_code: 0, stdout: 'ok', duration_ms: 5 };
    // No connection profile is even consulted — a profile that DENIES would not
    // block the cli op (its authorization is reachability). Prove it by
    // wiring a deny-all profile alongside the default reachable verdict.
    const { ctx, cliCalls, auditCalls } = makeHarness({
      profile: null,
      cliResult,
    });

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { repo_dir: '/repo', task: 'ship it' } },
      '',
      undefined,
      undefined,
      undefined,
    )).resolves.toBe(cliResult);

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toMatchObject({
      slug: 'pub/cat',
      operation_key: 'x',
      binding: { kind: 'cli_invocation' },
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      risk_tier: 'read',
      surface_kind: 'connector',
      connection_name: '',
    });
  });

  it('D-182 §7.2 — a cli op whose connector runtime resolves NO tool is STILL classified as cli (reachability keys on the ingredient, not the tool) — denies cli_reachability_disabled, never no_connection_profile', async () => {
    // empty entry_point + a non-`system_binary:` package_ref → no resolvable
    // tool. Authorization no longer keys on the tool (reachability keys on the
    // ingredient slug + risk tier), so the op is still cli (cli_invocation
    // binding) and must deny via the cli branch when not reachable — never fall
    // to the connection profile (`no_connection_profile`).
    const manifest: IngredientManifest = {
      ...connectorManifestFor(operation('read')),
      surfaces: {
        connector: {
          runtime: {
            transport: 'stdio',
            wire_protocol: 'cli_invocation',
            package_ref: 'opaque-ref',
            entry_point: '',
            expected_protocol_version: 1,
          },
          lifecycle: {
            auth: { method: 'none' },
            connect: { idempotent: true, startup_timeout_ms: 30_000 },
            invoke: { default_method_timeout_ms: 30_000 },
            disconnect: { graceful_shutdown_timeout_ms: 30_000 },
            reconnect_policy: 'manual_only',
            persistent_connection: false,
            idle_disconnect_ms: 0,
          },
          executes: { x: cliBinding() },
        },
      },
    };
    // Not reachable — proves the cli branch is taken regardless of whether a tool
    // can be resolved from the runtime.
    const { ctx, cliCalls, auditCalls } = makeHarness({ cliReachable: false });

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { repo_dir: '/repo', task: 'ship it' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow();

    expect(cliCalls ?? []).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'cli_reachability_disabled',
      surface_kind: 'connector',
    });
  });

  it('D-182 §7 (codex HIGH) — an op carrying BOTH a dispatchable rest binding AND a cli_invocation connector binding is authorized as http/connection (profile), NOT cli — dispatch precedence + auth precedence stay in lockstep', async () => {
    // A mixed-surface op (not a decomposer output, but a possible malformed /
    // hand-authored manifest). Dispatch prefers the rest binding → the op must
    // authorize via the CONNECTION PROFILE, never cli reachability (which would
    // otherwise bypass connection-profile authorization).
    const manifest: IngredientManifest = {
      ...manifestFor(operation('read')),
      surfaces: {
        ...surfacesWith(restBinding()),
        ...connectorSurfacesWith(cliBinding()),
      },
    };
    // Profile DENIES (null) but reachability would ADMIT (default reachable). If
    // the op wrongly took the cli path it would admit + dispatch; taking the
    // (correct) profile path denies `no_connection_profile`.
    const { ctx, executorCalls, cliCalls, auditCalls } = makeHarness({ profile: null });

    await expect(runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', args: { id: '1' } },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow();

    expect(executorCalls).toHaveLength(0);
    expect(cliCalls ?? []).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'no_connection_profile',
      connection_name: 'primary-connection',
    });
  });

  it('rethrows execution errors and audits them as failed calls', async () => {
    const manifest = manifestFor(operation('read'));
    const boom = new Error('boom');
    const { ctx, auditCalls } = makeHarness({
      executor: async () => {
        throw boom;
      },
    });
    let caught: unknown;

    try {
      await run(ctx, manifest);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(boom);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'error',
    });
  });

  it('rethrows downstream PreflightRequiredSignal without auditing it as a failure', async () => {
    const manifest = manifestFor(operation('read'));
    const signal = new PreflightRequiredSignal('downstream approval', {
      tool_slug: 'commit.gateway',
      risk_tier: 'write',
      reason: 'commit boundary',
    });
    const { ctx, executorCalls, auditCalls } = makeHarness({
      executor: async () => {
        throw signal;
      },
    });
    let caught: unknown;

    try {
      await run(ctx, manifest);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(signal);
    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect(executorCalls).toHaveLength(1);
    expect(auditCalls.filter((event) => event.outcome === 'failed')).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});

describe('static_body (D-192)', () => {
  const WIQL = 'SELECT [System.Id] FROM WorkItems';
  const wiqlManifest = (
    static_body: Record<string, string> = { query: WIQL },
  ): IngredientManifest => manifestFor(
    operation('read'),
    restBinding({
      method: 'POST',
      path_template: '/_apis/wit/wiql',
      static_body,
    } as Partial<ApiExecutionBinding>),
  );
  const postManifestWithoutStaticBody = (): IngredientManifest => manifestFor(
    operation('read'),
    restBinding({
      method: 'POST',
      path_template: '/_apis/wit/wiql',
    }),
  );
  const runWiql = (
    ctx: ExecutionContext,
    manifest: IngredientManifest,
    args: Record<string, unknown> = {},
  ) => runCatalogOperation(
    ctx,
    manifest,
    'pub/cat',
    { operation: 'x', args, connection: 'raw' },
    'primary-connection',
    undefined,
    undefined,
    undefined,
  );

  it('dispatches static_body as body.* wire args', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest());

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toEqual({
      'body.query': WIQL,
      method: 'POST',
      path: '/_apis/wit/wiql',
      connection_kind: 'api',
      connection: 'primary-connection',
    });
  });

  it('CLOBBERS a caller body.query with the static value', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest(), { 'body.query': 'caller-query' });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input['body.query']).toBe(WIQL);
  });

  it('strips caller body_raw when static_body is present', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest(), {
      body_raw: '{"query":"caller-query"}',
      'body.project': 'Recued',
    });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).not.toHaveProperty('body_raw');
    expect(executorCalls[0].input['body.project']).toBe('Recued');
  });

  it('emits an exact empty JSON object for an explicitly empty static_body', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest({}));

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({
      body_raw: '{}',
      method: 'POST',
      path: '/_apis/wit/wiql',
    });
  });

  it('prefers dynamic structured fields over the empty-body fallback', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest({}), {
      body_raw: '{"client_id":"caller-owned"}',
      'body.cursor': 'next-page',
    });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).not.toHaveProperty('body_raw');
    expect(executorCalls[0].input['body.cursor']).toBe('next-page');
  });

  it('passes caller body_raw through unchanged when the binding has no static_body', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, postManifestWithoutStaticBody(), { body_raw: '{"query":"caller-query"}' });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input['body_raw']).toBe('{"query":"caller-query"}');
  });

  it('composes other caller body.* keys alongside static_body without overriding static keys', async () => {
    const { ctx, executorCalls } = makeHarness();

    await runWiql(ctx, wiqlManifest({ query: WIQL, apiVersion: '7.1' }), {
      'body.query': 'caller-query',
      'body.project': 'Recued',
      'body.top': 50,
    });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({
      'body.query': WIQL,
      'body.apiVersion': '7.1',
      'body.project': 'Recued',
      'body.top': 50,
    });
  });
});

// D-182 §6 / §10 step 7 — op-level audit identity on `GatewayCallAudit`.
// The Gateway records each op call directly (`recipe_id` optional); these three
// fields make a call auditable INDEPENDENT of a recipe — the raw-op (§8) path.
describe('D-182 step 7 — op-level audit identity', () => {
  const mcpSource: ExecutionSource = {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'agent-1',
    tool_call_id: 'tc-1',
    mcp_token_id: 'mt-1',
    contract_id: 'k-1',
  };
  // `run` dispatches with no `args` key, so the hashed payload is `{}`.
  const EMPTY_ARGS_HASH = canonicalArgHash(projectResolvedArgs({})).canonical_payload_hash;

  it('stamps execution_source + origin_unit_id + canonical_arg_hash when the source is wired', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({ result: { ok: true } });
    const ctxWithSource: ExecutionContext = {
      ...ctx,
      execution_source: mcpSource,
      correlation_id: 'corr-1',
      run_id: 'run-1',
    };

    await run(ctxWithSource, manifest);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].execution_source).toEqual(mcpSource);
    // mcp → `burst` origin unit keyed on the correlation id (`deriveOriginUnit`).
    expect(auditCalls[0].origin_unit_id).toBe('corr-1');
    expect(auditCalls[0].canonical_arg_hash).toBe(EMPTY_ARGS_HASH);
  });

  it('omits execution_source + origin_unit_id when no source is wired, but still stamps canonical_arg_hash (source-independent)', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({ result: { ok: true } });

    await run(ctx, manifest);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].execution_source).toBeUndefined();
    expect(auditCalls[0].origin_unit_id).toBeUndefined();
    expect(auditCalls[0].canonical_arg_hash).toBe(EMPTY_ARGS_HASH);
  });

  it('audits a recipe-less (raw-op) call with NO recipe_id / step_id — no synthetic recipe, still op-level attributable', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({ result: { ok: true } });
    // A raw op forms a context with no recipe (ExecutionContext.recipe optional).
    const recipelessCtx: ExecutionContext = {
      ...ctx,
      recipe: undefined,
      execution_source: mcpSource,
      correlation_id: 'corr-raw',
      run_id: 'run-raw',
    };

    await run(recipelessCtx, manifest);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].recipe_id).toBeUndefined();
    expect(auditCalls[0].step_id).toBeUndefined();
    // op-level identity stands in for the absent recipe.
    expect(auditCalls[0].origin_unit_id).toBe('corr-raw');
    expect(auditCalls[0].execution_source).toEqual(mcpSource);
  });

  it('omits origin_unit_id (but keeps execution_source) when the derived unit id is degenerate — a source-bearing mcp ctx with no correlation_id', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({ result: { ok: true } });
    // mcp `deriveOriginUnit` keys directly off correlation_id; an absent one would
    // derive `''` — the guard omits it rather than persist a meaningless grouping id.
    const ctxNoCorrelation: ExecutionContext = {
      ...ctx,
      execution_source: mcpSource,
      run_id: 'run-1',
      // correlation_id deliberately unset
    };

    await run(ctxNoCorrelation, manifest);

    expect(auditCalls[0].execution_source).toEqual(mcpSource);
    expect('origin_unit_id' in auditCalls[0]).toBe(false);
  });

  it('also stamps the identity on a DENY outcome (the early gate path, before op resolution)', async () => {
    const manifest = manifestFor(operation('read'));
    // No profile ⇒ fail-closed deny (`no_connection_profile`).
    const { ctx, auditCalls } = makeHarness({ profile: null });
    const ctxWithSource: ExecutionContext = {
      ...ctx,
      execution_source: mcpSource,
      correlation_id: 'corr-deny',
      run_id: 'run-deny',
    };

    await expect(run(ctxWithSource, manifest)).rejects.toThrow();

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].outcome).toBe('failed');
    expect(auditCalls[0].execution_source).toEqual(mcpSource);
    expect(auditCalls[0].origin_unit_id).toBe('corr-deny');
    expect(auditCalls[0].canonical_arg_hash).toBe(EMPTY_ARGS_HASH);
  });
});
