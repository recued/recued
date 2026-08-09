/** D-225 Slice 1 — MCP as an api TRANSPORT.
 *
 *  The claim under test is that an mcp-bound catalog operation dispatches
 *  through the SAME gateway path as a REST one — same registry lookup, same
 *  authorization discriminator, same audit — differing only in the wire params
 *  its protocol executor builds.
 *
 *  🔑 The load-bearing test in this file is the one that proves a caller CANNOT
 *  redirect the tool. On the raw `connection-mcp-read` / `-write` path the tool
 *  name is recipe input, which is why that path needs a runtime anti-spoof
 *  gate; here the binding owns it and caller args are quarantined a level down.
 *  That is a STRUCTURAL property, and the way to test a structural guard is to
 *  feed it the input that would exploit it if the structure were gone — not to
 *  assert that a well-behaved call behaves.
 */
import { describe, it, expect } from 'vitest';
import { isPreflightRequiredSignal, PreflightRequiredSignal } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  McpExecutionBinding,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

type ExecutorCall = { slug: string; input: Record<string, unknown> };

const allowedProfile = (): ConnectionOperationProfile => ({ allowed_operations: ['x'] });

const operation = (risk_tier: OperationRiskTier): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
});

const mcpBinding = (extras: Partial<McpExecutionBinding> = {}): McpExecutionBinding => ({
  kind: 'mcp',
  tool: 'project.list',
  ...extras,
});

/** An mcp surface carries NO base URL — the server address is the connection
 *  record's. The fixture says `''` because that is what the catalog validator
 *  requires of a real one. */
const mcpSurfaces = (binding: ApiExecutionBinding): ProviderSurfaces => ({
  api: {
    transport: 'mcp',
    default_base_url: '',
    auth: { kind: 'none' },
    executes: { x: binding },
  },
});

const manifestFor = (
  op: OperationSpec,
  binding: ApiExecutionBinding = mcpBinding(),
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
  surfaces: mcpSurfaces(binding),
});

const makeHarness = (opts: { result?: unknown } = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = opts.result ?? { status: 'ok', result: { rows: [] }, headers: undefined };
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input: input as Record<string, unknown> });
    return fallbackResult;
  };
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor,
    connectionProfileResolver: () => allowedProfile(),
    cliReachabilityResolver: () => true,
    onGatewayCall: (event: GatewayCallAudit) => { auditCalls.push(event); },
  } as unknown as ExecutionContext;
  return { ctx, executorCalls, auditCalls, fallbackResult };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  args?: Record<string, unknown>,
) => runCatalogOperation(
  ctx,
  manifest,
  'pub/cat',
  { operation: 'x', connection: 'raw-connection', ...(args ? { args } : {}) },
  'primary-connection',
  undefined,
  undefined,
  undefined as any,
);

describe('D-225 Slice 1 — mcp api transport', () => {
  it('dispatches an mcp binding as connection_kind mcp with the BINDING tool and the caller args nested', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await run(ctx, manifest, { limit: 50, since: '2026-01-01' });

    expect(executorCalls).toHaveLength(1);
    // Under the CATALOG's own slug, exactly like a REST dispatch — no wrapper
    // hop and no second code path.
    expect(executorCalls[0].slug).toBe('pub/cat');
    // The wire keys the `connection.mcp` handler actually reads — `tool` /
    // `args`, NOT `mcp.tool` / `mcp.arguments` (those belong to the standalone
    // `kind: 'mcp'` adapter, a different executor entirely).
    expect({ ...executorCalls[0].input }).toEqual({
      connection_kind: 'mcp',
      connection: 'primary-connection',
      tool: 'project.list',
      args: { limit: 50, since: '2026-01-01' },
    });
    // Audited on the same path as every other transport.
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      connection_name: 'primary-connection',
    });
  });

  it('an arg-less mcp op dispatches with an empty args object, not a missing one', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls } = makeHarness();

    await run(ctx, manifest);

    expect({ ...(executorCalls[0].input.args as object) }).toEqual({});
  });

  // ── the security property ──────────────────────────────────────────────
  it('REFUSES to let a caller arg redirect the tool — the binding owns the call target', async () => {
    // The exploit input: a recipe naming a DIFFERENT, more powerful tool in the
    // same arg keys the raw path reads from. If caller args were spread onto the
    // dispatch input (the raw path's shape), `tool` here would win and a
    // read-tier op would invoke a delete. This is the case that separates a real
    // structural guard from a validator that happens to reject everything — the
    // call still SUCCEEDS, it just goes to the declared tool.
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls } = makeHarness();

    await run(ctx, manifest, {
      tool: 'project.delete',
      connection_kind: 'api',
      connection: 'attacker-connection',
      limit: 1,
    });

    const input = executorCalls[0].input;
    expect(input.tool).toBe('project.list');
    expect(input.connection_kind).toBe('mcp');
    expect(input.connection).toBe('primary-connection');
    // Not dropped — quarantined. The values are still delivered to the tool as
    // ordinary arguments, which is correct: they are only dangerous where they
    // could be mistaken for dispatch keys.
    expect(executorCalls[0].input.args).toMatchObject({
      tool: 'project.delete',
      connection_kind: 'api',
      connection: 'attacker-connection',
      limit: 1,
    });
  });

  it('drops prototype-sensitive arg keys from the tool arguments', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls } = makeHarness();

    const hostile: Record<string, unknown> = { keep: 1 };
    Object.defineProperty(hostile, '__proto__', {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    });
    (hostile as { constructor: unknown }).constructor = 'nope';
    await run(ctx, manifest, hostile);

    const args = executorCalls[0].input.args as Record<string, unknown>;
    expect({ ...args }).toEqual({ keep: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // ── a tool that RAN and RAISED is not a success ────────────────────────
  it('fails the step when the server returns a tool_error envelope', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({
      result: {
        status: 'tool_error',
        result: { code: -32602, message: 'unknown project' },
        headers: undefined,
      },
    });

    // The whole point: the transport returned a 200-equivalent, so nothing
    // downstream of the status classifier can see this failure. Without the
    // adaptResponse arm the step resolves with the error object as its result.
    await expect(run(ctx, manifest)).rejects.toThrow(/mcp operation 'pub\/cat\.x'/);
    await expect(run(ctx, manifest)).rejects.toThrow(/project\.list/);
    await expect(run(ctx, manifest)).rejects.toThrow(/unknown project/);

    expect(auditCalls.every((a) => a.outcome === 'failed')).toBe(true);
    expect(auditCalls[0]).toMatchObject({ failure_mode: 'mcp_tool_error' });
  });

  it("⛔⛔ carries the peer's REASON when the failure is MCP's own isError shape", async () => {
    /** D-232 § 21 — THE SHAPE THAT WAS BEING DROPPED, AND IT IS THE COMMON ONE.
     *
     *  The sibling above covers a JSON-RPC ERROR ENVELOPE (`{message, code}`).
     *  But a tool that RAN and FAILED reports it, per the MCP spec, as a
     *  SUCCESSFUL result carrying `{ isError: true, content: [{ text }] }` — and
     *  the detail extractor read only the first shape, so every failure of this
     *  kind arrived as:
     *
     *    "…invoked tool 'X' and the server returned an error."
     *
     *  with the reason gone. The two-server drive burned three rounds on that one
     *  sentence — a missing pack dependency, a Records exposure fence about step
     *  ORDER, then the guard that was meant to fire — each legible at the peer's
     *  door and discarded one hop later. Diagnosing them required bypassing the
     *  gateway and knocking on the peer directly.
     *
     *  🔑 Asserted on the REASON TEXT, not on the failure_mode: the mode was
     *  already correct while the message said nothing, which is exactly how this
     *  survived. */
    const manifest = manifestFor(operation('read'));
    const { ctx, auditCalls } = makeHarness({
      result: {
        status: 'tool_error',
        result: {
          isError: true,
          content: [{ type: 'text', text: "Recipe 'x' needs a pack that is not installed: pub.dep" }],
        },
        headers: undefined,
      },
    });

    await expect(run(ctx, manifest)).rejects.toThrow(/needs a pack that is not installed/);
    await expect(run(ctx, manifest)).rejects.toThrow(/pub\.dep/);
    expect(auditCalls[0]).toMatchObject({ failure_mode: 'mcp_tool_error' });

    // ⛔⛔ THE THROWN ERROR MUST CARRY `MCP_TOOL_ERROR`, AND ASSERTING IT HERE IS
    // NOT BELT-AND-BRACES. `failure_mode` goes to the AUDIT ROW only; the step
    // runner builds the caller-visible error from the throw, and with no `code`
    // on it defaults to `NETWORK_ERROR` — the same code an UNREACHABLE peer
    // gets. That collapse is the whole bug. Proven necessary: deleting the
    // gateway's `error_code` line left all ten tests in this file GREEN, so
    // without this assertion the stamp is unbacked and can silently rot away.
    const thrown = await run(ctx, manifest).then(() => null, (e: unknown) => e);
    expect((thrown as { code?: string } | null)?.code,
      'reached-and-refused must not report as a network failure').toBe('MCP_TOOL_ERROR');
  });

  it('tolerates a tool_error whose envelope is not the documented shape', async () => {
    // A server free to return anything must not turn a step failure into a
    // crash inside the failure path.
    const manifest = manifestFor(operation('read'));
    const { ctx } = makeHarness({
      result: { status: 'tool_error', result: null, headers: undefined },
    });

    await expect(run(ctx, manifest)).rejects.toThrow(/returned an error\.$/);
  });

  it('passes a successful envelope through unchanged', async () => {
    const envelope = { status: 'ok', result: { rows: [{ id: 'p1' }] }, headers: undefined };
    const manifest = manifestFor(operation('read'));
    const { ctx } = makeHarness({ result: envelope });

    await expect(run(ctx, manifest)).resolves.toBe(envelope);
  });

  it('holds a write-tier mcp op for approval — the transport grants no exemption', async () => {
    // Risk lives on the OPERATION, not the transport. A write-tier mcp op is
    // held at the same gate a write-tier REST op is, and dispatches NOTHING
    // while it is held. This is the assertion that would catch a Slice-2
    // generated pack quietly becoming a way to reach write tools without the
    // approval an authored pack's write ops require.
    const manifest = manifestFor(operation('write'), mcpBinding({ tool: 'project.create' }));
    const { ctx, executorCalls, auditCalls } = makeHarness();
    const contractedCtx: ExecutionContext = {
      ...ctx,
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    } as unknown as ExecutionContext;

    let caught: unknown;
    try {
      await run(contractedCtx, manifest, { name: 'Q3' });
    } catch (e) {
      caught = e;
    }

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('write');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('dispatches a write-tier mcp op once approval is resumed', async () => {
    // The permitting half — a gate that only ever refuses is indistinguishable
    // from a blanket refusal. Approved, the same op reaches the tool.
    const manifest = manifestFor(operation('write'), mcpBinding({ tool: 'project.create' }));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await runCatalogOperation(
      ctx,
      manifest,
      'pub/cat',
      { operation: 'x', connection: 'raw-connection', args: { name: 'Q3' } },
      'primary-connection',
      undefined,
      undefined,
      // The resume verdict rides stepMeta, and its target must match the
      // re-resolved (slug, operation, connection) triple.
      {
        preflight_admitted: true,
        preflight_approved_target: {
          ingredient_slug: 'pub/cat',
          operation_id: 'pub/cat.x',
          connection_name: 'primary-connection',
        },
      } as any,
    );

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input.tool).toBe('project.create');
    expect(executorCalls[0].input.args).toMatchObject({ name: 'Q3' });
    expect(auditCalls[0]).toMatchObject({ outcome: 'success', risk_tier: 'write' });
  });
});
