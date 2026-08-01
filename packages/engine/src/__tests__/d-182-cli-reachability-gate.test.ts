/** D-182 §7.2 — the ENFORCED cli reachability gate at the catalog gateway.
 *
 *  Proves the gateway authorizes a connection-less cli op against the per-contract
 *  reachability allowlist (`ExecutionContext.cliReachabilityResolver`) — NOT a
 *  connection profile: a reachable op ADMITS + dispatches; an unreachable op
 *  DENIES `cli_reachability_disabled` (never `no_connection_profile`); a THROWING
 *  resolver fails CLOSED (deny, no dispatch — Codex F-V1); the principal is
 *  resolved CONTRACT-FIRST (a self-restricted owner authorizes against the
 *  contract, not the owner row — Codex F-V2); the read keys on the dispatched
 *  OPERATION id (cli is connection-less + pack-only → a (contract × pack-op)
 *  grant; risk tier is orthogonal, NOT a key); and an absent resolver fails
 *  closed. */

import { describe, expect, it } from 'vitest';

import type {
  ConnectorExecutionBinding,
  ExecutionSource,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
} from '@recued/contracts';
import type { CliInvocationCall, ExecutionContext } from '../types.js';
import { runCatalogOperation } from '../catalog-gateway.js';

const SLUG = 'pub/cat';
const CLI_RESULT = { mode: 'foreground', exit_code: 0, stdout: 'ok', duration_ms: 1 };

const operation = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...extras,
});

/** A cli op manifest (connector `cli_invocation`, entry_point `codex`).
 *  `approval: 'never'` keeps higher risk tiers auto-admitting (the whisper
 *  transcribe analogue) so a test can exercise risk-tier keying without the
 *  approval pause. */
const cliManifest = (
  risk: OperationRiskTier = 'read',
  approvalNever = false,
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
  operations: { x: operation(risk, approvalNever ? { approval: 'never' } : {}) },
  surfaces: {
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
      executes: {
        x: {
          kind: 'cli_invocation',
          argv_template: ['codex', 'exec', '{task}'],
          stdin_handling: 'none',
          shape: 'text',
          exit_code_handling: 'zero_is_success',
        } as ConnectorExecutionBinding,
      },
    },
  } as ProviderSurfaces,
});

/** A non-cli (api/rest) read op manifest — proves a non-cli op never consults
 *  the cli reachability resolver. */
const apiManifest = (): IngredientManifest => ({
  slug: SLUG,
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { x: operation('read') },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { x: { kind: 'rest', method: 'GET', path_template: '/x' } },
    },
  } as ProviderSurfaces,
});

interface CtxOpts {
  reachability?: (p: string | null, ing: string, op: string) => boolean;
  actor?: string;
  contract_id?: string;
  execution_source?: ExecutionSource;
  profileAdmits?: boolean;
}

const makeCtx = (opts: CtxOpts) => {
  const auditCalls: GatewayCallAudit[] = [];
  const reachCalls: Array<{ principal: string | null; ingredient_id: string; operation_id: string }> = [];
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor: async () => ({ ok: true }),
    cliInvocationExecutor: async (_call: CliInvocationCall) => CLI_RESULT,
    connectionProfileResolver: () =>
      opts.profileAdmits
        ? ({ catalog_slug: SLUG, allowed_operations: ['x'] } as any)
        : null,
    ...(opts.reachability
      ? {
          cliReachabilityResolver: (p: string | null, ing: string, op: string) => {
            reachCalls.push({ principal: p, ingredient_id: ing, operation_id: op });
            return opts.reachability!(p, ing, op);
          },
        }
      : {}),
    ...((opts.actor ?? opts.execution_source?.actor) !== undefined
      ? { actor: (opts.actor ?? opts.execution_source?.actor) as any }
      : {}),
    ...(opts.contract_id !== undefined ? { contract_id: opts.contract_id } : {}),
    ...(opts.execution_source !== undefined
      ? { execution_source: opts.execution_source }
      : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  } as ExecutionContext;
  return { ctx, auditCalls, reachCalls };
};

const dispatchCli = (
  ctx: ExecutionContext,
  risk: OperationRiskTier = 'read',
  approvalNever = false,
) =>
  runCatalogOperation(
    ctx,
    cliManifest(risk, approvalNever),
    SLUG,
    { operation: 'x', args: { task: 'go' } },
    '',
    undefined,
    undefined,
    undefined,
  );

describe('D-182 §7.2 gateway — cli reachability is ENFORCED (the authoritative cli authorization)', () => {
  it('a REACHABLE cli op admits + dispatches (never reaching no_connection_profile)', async () => {
    const { ctx, auditCalls, reachCalls } = makeCtx({
      reachability: () => true,
      actor: 'user_self',
    });
    await expect(dispatchCli(ctx)).resolves.toBe(CLI_RESULT);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'success', risk_tier: 'read' });
    // The resolver was keyed on (owner principal, this ingredient, the dispatched op id).
    expect(reachCalls).toEqual([{ principal: 'user_self', ingredient_id: SLUG, operation_id: 'x' }]);
  });

  it('a scheduled cli op uses the owner reachability row, then dispatches when that exact op is granted', async () => {
    const { ctx, reachCalls } = makeCtx({
      execution_source: {
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'r1',
      },
      reachability: (principal, ingredient, op) =>
        principal === 'user_self' && ingredient === SLUG && op === 'x',
    });

    await expect(dispatchCli(ctx)).resolves.toBe(CLI_RESULT);
    expect(reachCalls).toEqual([
      { principal: 'user_self', ingredient_id: SLUG, operation_id: 'x' },
    ]);
  });

  it('a scheduled cli op still denies when the owner has not granted that op', async () => {
    const { ctx, auditCalls, reachCalls } = makeCtx({
      execution_source: {
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'r1',
      },
      reachability: () => false,
    });

    await expect(dispatchCli(ctx)).rejects.toThrow(/cli_reachability_disabled/);
    expect(reachCalls[0]?.principal).toBe('user_self');
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      failure_mode: 'cli_reachability_disabled',
    });
  });

  it('a granted scheduled cli write reaches the approval gate instead of being denied as unreachable', async () => {
    const { ctx, reachCalls } = makeCtx({
      execution_source: {
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'r1',
      },
      reachability: (principal) => principal === 'user_self',
    });

    await expect(dispatchCli(ctx, 'write')).rejects.toThrow(/requires approval/);
    expect(reachCalls[0]?.principal).toBe('user_self');
  });

  it('a contract-free reactive system fire does not inherit owner cli reachability', async () => {
    const { ctx, reachCalls } = makeCtx({
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'auto_run_tick',
        source_recipe: 'r1',
      },
      reachability: (principal) => principal !== null,
    });

    await expect(dispatchCli(ctx)).rejects.toThrow(/cli_reachability_disabled/);
    expect(reachCalls[0]?.principal).toBeNull();
  });

  it('an UNREACHABLE cli op denies cli_reachability_disabled (NOT no_connection_profile)', async () => {
    const { ctx, auditCalls } = makeCtx({
      reachability: () => false,
      actor: 'user_self',
    });
    await expect(dispatchCli(ctx)).rejects.toThrow(/cli_reachability_disabled/);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'failed', failure_mode: 'cli_reachability_disabled' });
  });

  it('a THROWING reachability resolver fails CLOSED — denies + never dispatches (Codex F-V1)', async () => {
    const { ctx, auditCalls } = makeCtx({
      reachability: () => {
        throw new Error('transient store read failure');
      },
      actor: 'user_self',
    });
    await expect(dispatchCli(ctx)).rejects.toThrow(/cli_reachability_disabled/);
    expect(auditCalls[0]).toMatchObject({ outcome: 'failed', failure_mode: 'cli_reachability_disabled' });
  });

  it('the principal is resolved CONTRACT-FIRST — a self-restricted owner authorizes against the contract (Codex F-V2)', async () => {
    // The resolver admits ONLY when keyed by the contract principal — proving the
    // gate authorizes against `contract_self`, not the owner row, for an owner
    // running under a contract they minted to limit themselves.
    const { ctx, reachCalls } = makeCtx({
      reachability: (p) => p === 'contract_self',
      actor: 'user_self',
      contract_id: 'contract_self',
    });
    await expect(dispatchCli(ctx)).resolves.toBe(CLI_RESULT);
    expect(reachCalls[0]?.principal).toBe('contract_self');
  });

  it('keys the reachability read on the dispatched OPERATION id, not the risk tier (risk demoted out of the key)', async () => {
    const { ctx, reachCalls } = makeCtx({
      reachability: () => true,
      actor: 'user_self',
    });
    // The reachability read is consulted for AUTHORIZATION, keyed on (principal,
    // ingredient, operation_id) — the risk tier never enters the key. This ctx wires no
    // execution_source → the D-209 §1.4 ceiling FAILS CLOSED to `read`, so a write op
    // HOLDS for approval; but the reachability read already fired BEFORE the approval
    // stage, keyed on the op id 'x' — proving the tier is demoted out of the key.
    await expect(dispatchCli(ctx, 'write')).rejects.toThrow(/requires approval/);
    expect(reachCalls[0]?.operation_id).toBe('x');
  });

  it('an absent reachability resolver fails closed (cli_reachability_disabled)', async () => {
    const { ctx, auditCalls } = makeCtx({ actor: 'user_self' });
    await expect(dispatchCli(ctx)).rejects.toThrow(/cli_reachability_disabled/);
    expect(auditCalls[0]).toMatchObject({ outcome: 'failed', failure_mode: 'cli_reachability_disabled' });
  });

  it('a NON-cli op never consults the cli reachability resolver', async () => {
    const { ctx, auditCalls, reachCalls } = makeCtx({
      profileAdmits: true,
      reachability: () => true,
      actor: 'user_self',
    });
    await runCatalogOperation(
      ctx,
      apiManifest(),
      SLUG,
      { operation: 'x' },
      'primary-connection',
      undefined,
      undefined,
      undefined,
    );
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ outcome: 'success' });
    expect(reachCalls).toEqual([]);
  });
});
