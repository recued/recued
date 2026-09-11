// D-181 slice 4 — the `execution.*` live-control rpc handlers.
//
// Owner-only methods over the in-flight registry and saved chat calls:
//   - `execution.active`  — the live active-list snapshot (runs + queued calls
//     + per-lane status). A `view`-capable surface (read).
//   - `execution.kill`    — kill a running run (SIGKILL a subprocess / abandon
//     an external-io await). A `control` mutator.
//   - `execution.cancel`  — drop a queued call before it dispatches. `control`.
//   - `execution.promote` — move a queued call to its lane's head. `control`.
//   - `execution.tool_call.dismiss` — mark an interrupted call reviewed.
//
// Auth (D-181 §7b/§8/§13): every method requires an authenticated paired
// caller (the owner's webclient / bridge — anonymous / MCP never reach here,
// `execution.` is reserved out of MCP). The mutators additionally
// fail-closed on the **bridge-approval gate**: when the caller is a Browser
// Bridge, it may mutate the queue ONLY when it holds `bridge_mode.approval`
// (the same gate the interactive approval card rides). A non-approval bridge
// keeps `view` (it can call `execution.active`) but is denied control.

import {
  RpcError,
  type ExecutionActiveRequest,
  type ExecutionActiveResponse,
  type ExecutionCancelRequest,
  type ExecutionCancelResponse,
  type ExecutionKillRequest,
  type ExecutionKillResponse,
  type ExecutionPromoteRequest,
  type ExecutionPromoteResponse,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { InFlightRegistry } from './execution/in-flight-registry.js';
import type { ChatToolCallStore } from './storage/chat-tool-call-store.js';

export interface ExecutionControlDeps {
  /** The live in-flight registry (the SAME instance the execute-handler + cli
   *  executor feed). */
  registry: InFlightRegistry;
  toolCalls?: ChatToolCallStore;
  onToolCallReviewed?: (session_id: string) => void;
  /** Resolve a bridge's `approval` mode by its durable `client_token_id`. Wired
   *  from the notification block's bridge roster. Absent ⇒ no bridge can hold
   *  approval (fail-closed): a bridge caller is denied control, the owner's
   *  webclient is unaffected. */
  bridgeApprovalLookup?: (client_token_id: string) => Promise<boolean>;
}

/** A caller is an authenticated paired client iff it carries an owner id or a
 *  paired client-token (a bridge). An un-bearer-verified / anonymous WS has
 *  neither. */
const isAuthenticated = (ctx: WsClient): boolean =>
  (typeof ctx.user_id === 'string' && ctx.user_id.length > 0)
  || (typeof ctx.client_token_id === 'string' && ctx.client_token_id.length > 0);

const assertViewer = (ctx: WsClient): void => {
  if (!isAuthenticated(ctx)) {
    throw new RpcError('unauthorized', 'must be a paired client to view executions', 401);
  }
};

/** The control gate for mutators: an authenticated caller, and — when
 *  it is a Browser Bridge — its `bridge_mode.approval` must be ON (fail-closed). */
const assertController = async (ctx: WsClient, deps: ExecutionControlDeps): Promise<void> => {
  assertViewer(ctx);
  if (ctx.client_kind !== 'bridge') return; // webclient owner — full control.
  const id = ctx.client_token_id;
  const approved =
    typeof id === 'string' && id.length > 0 && deps.bridgeApprovalLookup !== undefined
      ? await deps.bridgeApprovalLookup(id)
      : false;
  if (!approved) {
    throw new RpcError(
      'forbidden',
      'bridge live-control requires approval mode (Settings → Notifications → this bridge → Approval)',
      403,
    );
  }
};

export const handleExecutionActive = (
  deps: ExecutionControlDeps,
  ctx: WsClient,
  args: ExecutionActiveRequest,
): ExecutionActiveResponse => {
  assertViewer(ctx);
  // The caller-supplied `session_id` narrows the owner view; omitting it returns
  // the full owner active-list. A paired bridge (the owner's own device, `view`
  // capability per §8) currently sees the same — server-side derivation of a
  // bridge's allowed session scope is a slice-6 (cross-channel renderer) concern,
  // not a tenant boundary (every caller here is the authenticated owner).
  const snapshot = deps.registry.snapshot(args.session_id);
  return {
    ...snapshot,
    ...(deps.toolCalls ? { tool_calls: deps.toolCalls.list(
      args.session_id?.startsWith('chat:') ? args.session_id.slice(5) : args.session_id,
    ) } : {}),
  };
};

export const handleToolCallDismiss = async (
  deps: ExecutionControlDeps,
  ctx: WsClient,
  args: { session_id: string; message_id: string },
): Promise<{ dismissed: boolean }> => {
  await assertController(ctx, deps);
  if (!args || typeof args.session_id !== 'string' || !args.session_id
    || typeof args.message_id !== 'string' || !args.message_id) {
    throw new RpcError('bad_request', 'A tool call is required', 400);
  }
  const dismissed = deps.toolCalls?.dismiss(args.session_id, args.message_id) ?? false;
  if (dismissed) {
    try { deps.onToolCallReviewed?.(args.session_id); }
    catch (error) { console.error('[execution] tool-call review notification failed', error); }
  }
  return { dismissed };
};

export const handleExecutionKill = async (
  deps: ExecutionControlDeps,
  ctx: WsClient,
  args: ExecutionKillRequest,
): Promise<ExecutionKillResponse> => {
  await assertController(ctx, deps);
  if (!args.run_id) throw new RpcError('bad_request', 'run_id is required', 400);
  return { status: deps.registry.kill(args.run_id) };
};

export const handleExecutionCancel = async (
  deps: ExecutionControlDeps,
  ctx: WsClient,
  args: ExecutionCancelRequest,
): Promise<ExecutionCancelResponse> => {
  await assertController(ctx, deps);
  if (!args.queued_call_id) throw new RpcError('bad_request', 'queued_call_id is required', 400);
  return { status: deps.registry.cancel(args.queued_call_id) };
};

export const handleExecutionPromote = async (
  deps: ExecutionControlDeps,
  ctx: WsClient,
  args: ExecutionPromoteRequest,
): Promise<ExecutionPromoteResponse> => {
  await assertController(ctx, deps);
  if (!args.queued_call_id) throw new RpcError('bad_request', 'queued_call_id is required', 400);
  return { status: deps.registry.promote(args.queued_call_id) };
};

type ExecutionControlMethods =
  | 'execution.active'
  | 'execution.kill'
  | 'execution.cancel'
  | 'execution.promote'
  | 'execution.tool_call.dismiss';

export const makeExecutionControlHandlers = (
  deps: ExecutionControlDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ExecutionControlMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['execution.active', 'execution.kill', 'execution.cancel', 'execution.promote', 'execution.tool_call.dismiss'],
    handlers: {
      'execution.tool_call.dismiss': async (args, ctx) =>
        handleToolCallDismiss(deps, ctx, args as { session_id: string; message_id: string }),
      'execution.active': async (args, ctx) =>
        handleExecutionActive(deps, ctx, args as ExecutionActiveRequest),
      'execution.kill': async (args, ctx) =>
        handleExecutionKill(deps, ctx, args as ExecutionKillRequest),
      'execution.cancel': async (args, ctx) =>
        handleExecutionCancel(deps, ctx, args as ExecutionCancelRequest),
      'execution.promote': async (args, ctx) =>
        handleExecutionPromote(deps, ctx, args as ExecutionPromoteRequest),
    },
  };
};
