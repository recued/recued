/** D-165 P3.path-picker (Slice 3b) — gateway ENFORCEMENT of an operation's
 *  `path_scope`. The pure `checkPathScope` primitive is unit-tested in
 *  `packages/contracts/src/__tests__/d-165-p3-path-scope.test.ts` (Slice 3a);
 *  these tests pin how `runCatalogOperation` WIRES it: the placement
 *  (after the deny gate, BEFORE the ask pause), the `path_scope_violation`
 *  audit detail, the whole-account default when no resolver is wired, and that
 *  approval can never bypass the scope. Mirrors `d-165-catalog-gateway.test.ts`. */
import { describe, it, expect } from 'vitest';
import { isPreflightRequiredSignal } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  PathScopeContract,
  ProviderSurfaces,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

type ExecutorCall = { slug: string; input: Record<string, unknown> };

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: ['x'],
});

const operation = (
  risk_tier: OperationRiskTier,
  path_scope?: PathScopeContract,
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...(path_scope ? { path_scope } : {}),
});

const restBinding = (): ApiExecutionBinding =>
  ({ kind: 'rest', method: 'GET', path_template: '/x' } as ApiExecutionBinding);

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

const makeHarness = (opts: {
  /** When the KEY is present, wire a resolver returning this (a `string` scopes
   *  the connection; `undefined` exercises the whole-account default). When the
   *  key is ABSENT, no resolver is wired at all (a host with no connection
   *  store) — also whole-account. */
  subresourcePath?: string | undefined;
  /** Full resolver override — for the async + never-consulted (throwing) cases. */
  subresourceResolver?: ExecutionContext['connectionSubresourcePathResolver'];
  executor?: IngredientExecutor;
} = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input });
    if (opts.executor) return opts.executor(slug, input, undefined, undefined, undefined);
    return { ok: true };
  };
  const hasSubPath = Object.prototype.hasOwnProperty.call(opts, 'subresourcePath');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    connectionProfileResolver: () => allowedProfile(),
    ...(opts.subresourceResolver
      ? { connectionSubresourcePathResolver: opts.subresourceResolver }
      : hasSubPath
        ? { connectionSubresourcePathResolver: () => opts.subresourcePath }
        : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };
  return { ctx, executorCalls, auditCalls };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  args: Record<string, unknown> = {},
  stepMeta?: Record<string, unknown>,
) =>
  runCatalogOperation(
    ctx,
    manifest,
    'pub/cat',
    { operation: 'x', args, connection: 'raw' },
    'primary-connection',
    undefined,
    undefined,
    stepMeta as never,
  );

/** Capture a rejection without letting `await expect().rejects` swallow the
 *  thrown value's identity (we assert on `isPreflightRequiredSignal`). */
const capture = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
};

describe('D-165 P3 path-scope gateway enforcement', () => {
  it('admits an in-scope descendant call and audits success WITHOUT a path_scope detail', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'descendant_only', target_path_template: '/photos/{key}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    await expect(run(ctx, manifest, { key: 'cat.jpg' })).resolves.toEqual({ ok: true });

    expect(executorCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].outcome).toBe('success');
    // path_scope detail rides ONLY on a violation — a clean admit carries none.
    expect(auditCalls[0].path_scope).toBeUndefined();
  });

  it('denies an out-of-scope call (connection_or_below), does not dispatch, and audits both canonical paths + the template', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'connection_or_below', target_path_template: '/{root}/{id}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(run(ctx, manifest, { root: 'private', id: 'x' }));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/outside connection/);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
      path_scope: {
        policy: 'connection_or_below',
        connection_path: '/photos',
        target_path: '/private/x',
        template: '/{root}/{id}',
        reason: 'not_in_scope',
      },
    });
  });

  it('denies an out-of-scope WRITE call BEFORE the ask pause — a path violation is never offered for approval', async () => {
    // A granted write op resolves to `ask`; the path-scope gate sits BEFORE the
    // ask pause, so an out-of-scope write fails as a path violation rather than
    // raising a PreflightRequiredSignal the user could approve.
    const manifest = manifestFor(
      operation('write', { policy: 'descendant_only', target_path_template: '/elsewhere/{key}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(run(ctx, manifest, { key: 'x' }));

    expect(err).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(err)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
      path_scope: { reason: 'not_in_scope' },
    });
  });

  it('denies a path-traversal arg (a `..` segment that would escape the scope downstream)', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'descendant_only', target_path_template: '/photos/{key}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(run(ctx, manifest, { key: '../private' }));

    expect(err).toBeInstanceOf(Error);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
      path_scope: { reason: 'path_traversal', target_path: '/photos/../private' },
    });
  });

  it('admits a connection_root op when the connection is unscoped (/)', async () => {
    const manifest = manifestFor(operation('read', { policy: 'connection_root' }));
    const { ctx, executorCalls } = makeHarness({ subresourcePath: '/' });

    await expect(run(ctx, manifest)).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });

  it('denies a connection_root op when the connection is path-scoped (no target_path in the audit)', async () => {
    const manifest = manifestFor(operation('read', { policy: 'connection_root' }));
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(run(ctx, manifest));

    expect(err).toBeInstanceOf(Error);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
      path_scope: { policy: 'connection_root', connection_path: '/photos', reason: 'connection_not_root' },
    });
    // connection_root resolves no target path — the detail must omit it.
    expect(auditCalls[0].path_scope?.target_path).toBeUndefined();
  });

  it('treats an UNWIRED resolver as whole-account (/) — a scoped policy still admits any target', async () => {
    // No connection store wired (resolver absent) ⇒ checkPathScope canonicalizes
    // undefined to `/` ⇒ every target is in-scope. Path scope is INERT, never a
    // false denial, until a connection actually carries a subresource_path.
    const manifest = manifestFor(
      operation('read', { policy: 'connection_or_below', target_path_template: '/{root}' }),
    );
    const { ctx, executorCalls } = makeHarness(); // no subresourcePath key → no resolver

    await expect(run(ctx, manifest, { root: 'anything' })).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });

  it('treats a resolver returning undefined as whole-account (/) too', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'descendant_only', target_path_template: '/{anything}' }),
    );
    const { ctx, executorCalls } = makeHarness({ subresourcePath: undefined });

    await expect(run(ctx, manifest, { anything: 'wherever' })).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });

  it('does NOT consult the resolver when the operation declares no path_scope', async () => {
    // The resolver throws — if it were called the run would reject. A no-path_scope
    // op must dispatch cleanly without ever touching it.
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls } = makeHarness({
      subresourceResolver: () => {
        throw new Error('resolver must not be consulted without a path_scope contract');
      },
    });

    await expect(run(ctx, manifest)).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });

  it('fails closed on an unresolved template token (no target path could be derived)', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'descendant_only', target_path_template: '/photos/{key}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(run(ctx, manifest, {})); // no `key` arg

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/\(unresolved\)/);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
      path_scope: { reason: 'unresolved_template_token' },
    });
    expect(auditCalls[0].path_scope?.target_path).toBeUndefined();
  });

  it('still enforces path scope on a RESUMED (preflight-admitted) call — approval cannot bypass scope', async () => {
    const manifest = manifestFor(
      operation('write', { policy: 'descendant_only', target_path_template: '/elsewhere/{key}' }),
    );
    const { ctx, executorCalls, auditCalls } = makeHarness({ subresourcePath: '/photos' });

    const err = await capture(
      run(ctx, manifest, { key: 'x' }, {
        preflight_admitted: true,
        preflight_approved_target: {
          ingredient_slug: 'pub/cat',
          operation_id: 'pub/cat.x',
          connection_name: 'primary-connection',
        },
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(err)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'path_scope_violation',
    });
  });

  it('awaits an async resolver before checking scope', async () => {
    const manifest = manifestFor(
      operation('read', { policy: 'descendant_only', target_path_template: '/photos/{key}' }),
    );
    const { ctx, executorCalls } = makeHarness({
      subresourceResolver: async () => '/photos',
    });

    await expect(run(ctx, manifest, { key: 'a.jpg' })).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });

  it('honors case_insensitive canonicalization (Notion-style ids)', async () => {
    const manifest = manifestFor(
      operation('read', {
        policy: 'connection_or_below',
        target_path_template: '/databases/{id}',
        canonicalization: 'case_insensitive',
      }),
    );
    // Connection stored case-preserving (`/Databases`); the ci flag lowercases
    // only the comparison so `/databases/x` still admits.
    const { ctx, executorCalls } = makeHarness({ subresourcePath: '/Databases' });

    await expect(run(ctx, manifest, { id: 'x' })).resolves.toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
  });
});
