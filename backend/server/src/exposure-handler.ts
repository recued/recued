/** D-148 W3.FU — `exposure.{apply_preset,set_path_resolution,
 *  set_public_mcp_acknowledgement}` rpc handlers.
 *
 *  Wire-A entry point for the webclient's Settings → Server → Exposure
 *  page. Each rpc routes into the in-process `ExposureStateMachine`
 *  composed at boot in bin.ts (W3.5 state machine + W3.9 SQLite persistence
 *  + W3.10 `--reset-exposure` failsafe + FU6 signed audit emission). The
 *  state machine is the sole authority over per-path resolution
 *  transitions — every gate (DDNS / `/ws` lockout phrase / public-MCP
 *  acknowledgement) lives there + every mutation emits a
 *  HIGH_ASSURANCE_AUDIT_KINDS row before the listener-set rebind.
 *
 *  The handler is a thin adapter:
 *
 *    1. Reject calls from unregistered (non-paired) WS clients — the
 *       state machine's `changed_by_client_id` MUST identify a real
 *       paired instance so the signed audit row carries provenance.
 *       Mirrors `mcp.visibility.write`'s posture per § A.13.5 P7.G.
 *    2. Validate the wire-shaped args against the substrate's closed
 *       lists (`EXPOSURE_PRESETS`, `PATH_ROLES`, `PathResolution`).
 *    3. Call the state machine's `applyPreset` / `setPathResolution` /
 *       `setPublicMcpAcknowledgement`.
 *    4. Convert the `ExposureMutationResult` tagged union:
 *         - `ok: true`  → `{ state }` (the post-state).
 *         - `ok: false` → throw `RpcError(error_code, ...)`; the `/ws`
 *           lockout flavor carries the required phrase + active-client
 *           count in the error message so the modal renderer can parse
 *           and surface the right copy without a second round-trip.
 *
 *  Spec: D-148 § A.7 + Amendment 2026-05-11. */

import {
  EXPOSURE_PRESETS,
  PATH_ROLES,
  RpcError,
  isRootApexMode,
  type ExposurePreset,
  type ExposureState,
  type HandlerSlice,
  type PathResolution,
  type PathRole,
  type RootApexMode,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { ExposureStateMachine, ExposureMutationResult } from './exposure/index.js';
import type { WsClient } from './ws-server.js';

/** `getMachine` is lazy because the `ExposureStateMachine` is composed
 *  in bin.ts AFTER `createServerHandlerSet` (the state machine needs
 *  the WS handle's `clientCount()` for the `/ws` lockout active-clients
 *  probe, so the listener coordinator + state machine are built
 *  downstream of the handler set). A `() => machine` accessor mirrors
 *  the `makePairHandlers` thunk pattern — the rpc handlers invoke it at
 *  call time, by which point the boot path has completed
 *  `exposureMachine.reapply()` and the machine is fully wired.
 *
 *  `closeWsClientsForLockout` makes good on the spec § A.6.6 promise
 *  that `disconnect webclients` / `disable ws` phrase gates actually
 *  drain existing WS clients. After a successful mutation that lands
 *  `/ws` in `{ lan: false, public: false }`, the handler calls this
 *  callback + returns the count as `clients_disconnected`. Optional —
 *  test compositions that don't surface a WS handle pass undefined and
 *  the count surfaces as 0. Codex W3.FU P1 fold. */
export interface ExposureRpcDeps {
  getMachine: () => ExposureStateMachine;
  closeWsClientsForLockout?: (reason: string) => number;
  /** R26.2 Delta 2 — the server-global apex (`GET /`) serving mode. `get`
   *  + `set` wrap the `network.apex_mode` runtime-config field; the same
   *  `RuntimeConfigStore` instance the root handler reads per request, so a
   *  set here is hot. Absent → the apex rpcs surface `not_configured`
   *  (db-less / pre-Delta-2 boot). The `serve_webclient` consistency gate
   *  reads `resolution.webclient.public` from `getMachine()` directly (R26.2
   *  Delta 3 — webclient is a grid path role), parallel to serve_reception,
   *  AND `isWebclientBundlePresent` (the boot-time verified-bundle probe) so
   *  the setter applies the SAME servability predicate as the live root
   *  handler — it never reports success for an apex that would 404. */
  apex?: {
    get: () => RootApexMode;
    set: (mode: RootApexMode) => void;
    isWebclientBundlePresent?: () => boolean;
  };
}

type ExposureMethods =
  | 'exposure.apply_preset'
  | 'exposure.set_path_resolution'
  | 'exposure.set_public_mcp_acknowledgement'
  | 'exposure.get'
  | 'exposure.set_apex';

// ────────────────────────────────────────────────────────────────
// Input validation — closed lists from the contracts side
// ────────────────────────────────────────────────────────────────

const EXPOSURE_PRESET_SET: ReadonlySet<string> = new Set(EXPOSURE_PRESETS);
const PATH_ROLE_SET: ReadonlySet<string> = new Set(PATH_ROLES);

const isExposurePreset = (value: unknown): value is ExposurePreset =>
  typeof value === 'string' && EXPOSURE_PRESET_SET.has(value);

const isPathRole = (value: unknown): value is PathRole =>
  typeof value === 'string' && PATH_ROLE_SET.has(value);

const isPathResolution = (value: unknown): value is PathResolution => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.lan === 'boolean' && typeof v.public === 'boolean';
};

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): string => {
  if (!caller?.instance_id) {
    // Codex W3.FU P3 fold — explicit 403 so the dispatcher surfaces the
    // permission failure with the right HTTP-class status instead of
    // defaulting to 500.
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
  return caller.instance_id;
};

// Codex W3.FU P3 fold — every handler-edge `bad_request` carries an
// explicit 400 status. Without it the dispatcher's `thrownToResult`
// falls through to `status: 500`, which misrepresents argument-shape
// failures as server faults.
const badRequest = (message: string): RpcError =>
  new RpcError('bad_request', message, 400);

// ────────────────────────────────────────────────────────────────
// Result mapping — `ExposureMutationResult` → wire response / RpcError
// ────────────────────────────────────────────────────────────────
//
// Substrate-defined gate failures surface with stable codes the
// `NetworkErrorCode` closed list already pins; the dispatcher carries
// `RpcError.code` + `RpcError.details` through to the wire so the
// webclient modal can switch on the code AND read typed fields without
// parsing the message text (Codex W3.FU P2 fold).
//
// Spec § A.7 `SetResolutionResult` error envelope:
//   { ok: false; error: 'ws_lockout_unconfirmed';
//     required_phrase: string; affected_clients: number }
// We surface `required_phrase` + `active_ws_connections` (substrate's
// naming) on `RpcError.details` so the renderer reads structured
// fields. The message remains human-readable for logs.

const lockoutDetails = (
  result: Extract<ExposureMutationResult, { ok: false }>,
): Readonly<Record<string, unknown>> => ({
  required_phrase: result.ws_lockout_required_phrase ?? '<unknown>',
  active_ws_connections: result.ws_lockout_active_clients ?? 0,
});

const lockoutMessage = (
  method: string,
  result: Extract<ExposureMutationResult, { ok: false }>,
): string => {
  const phrase = result.ws_lockout_required_phrase ?? '<unknown>';
  const clients = result.ws_lockout_active_clients ?? 0;
  return (
    `${method}: ${result.error} (required_phrase="${phrase}", `
    + `active_ws_connections=${clients})`
  );
};

const throwResultError = (
  method: string,
  result: Extract<ExposureMutationResult, { ok: false }>,
): never => {
  const code = result.error;
  if (code === 'ws_lockout_unconfirmed' || code === 'ws_lockout_phrase_mismatch') {
    throw new RpcError(
      code,
      lockoutMessage(method, result),
      400,
      undefined,
      lockoutDetails(result),
    );
  }
  // Every other code in the closed `NetworkErrorCode` list maps cleanly
  // to a 400-class rpc error — the substrate refuses the transition,
  // never an internal server fault. No structured details — these
  // codes are self-describing.
  throw new RpcError(code, `${method}: ${code}`, 400);
};

// ────────────────────────────────────────────────────────────────
// Post-success WS drain — Codex W3.FU P1 fold
// ────────────────────────────────────────────────────────────────
//
// Spec § A.6.6 + W3.5 fold: a successful mutation that lands `/ws` in
// `{ lan: false, public: false }` MUST drain existing WS clients —
// otherwise the `disconnect webclients` phrase is a lie (the renderer
// stays connected; the gate's threshold count was meaningless). The
// listener-set rebind alone is insufficient — already-upgraded WS
// sockets aren't bound to the listener anymore, so closing the listener
// doesn't reach them.
//
// We compute the drain BEFORE returning the post-state so the response's
// `clients_disconnected` field matches the actual close count. The
// callback is optional — test compositions that don't supply a WS handle
// surface `clients_disconnected: 0`.

const drainOnLockoutIfNeeded = (
  deps: ExposureRpcDeps,
  state: ExposureState,
  reason: string,
): number => {
  const wsOff = !state.resolution.ws.lan && !state.resolution.ws.public;
  if (!wsOff) return 0;
  if (!deps.closeWsClientsForLockout) return 0;
  try {
    return deps.closeWsClientsForLockout(reason);
  } catch {
    // Drain failure mustn't fail the rpc — the state is already
    // persisted + broadcast. The render side observes 0; operator can
    // still see active clients via server logs / Reachability Doctor.
    return 0;
  }
};

export interface ExposureRpcResponse {
  state: ExposureState;
  /** D-148 spec § A.6.6 — number of WS clients closed by the
   *  `closeWsClientsForLockout` drain after this mutation. 0 when the
   *  mutation didn't land `/ws` fully off, OR when no WS handle was
   *  wired into the deps (test compositions). */
  clients_disconnected: number;
}

const unwrap = (
  method: string,
  deps: ExposureRpcDeps,
  result: ExposureMutationResult,
  drainReason: string,
): ExposureRpcResponse => {
  if (result.ok) {
    const clients_disconnected = drainOnLockoutIfNeeded(deps, result.state, drainReason);
    return { state: result.state, clients_disconnected };
  }
  return throwResultError(method, result);
};

// ────────────────────────────────────────────────────────────────
// Handler functions
// ────────────────────────────────────────────────────────────────

export const handleExposureApplyPreset = async (
  deps: ExposureRpcDeps,
  args: { preset?: unknown; lockout_confirmation_phrase?: unknown; reason?: unknown },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ExposureRpcResponse> => {
  const method = 'exposure.apply_preset';
  const changed_by_client_id = requireCallerInstance(caller, method);

  if (!isExposurePreset(args.preset)) {
    throw badRequest(
      `${method}: preset must be one of ${EXPOSURE_PRESETS.join(', ')}; got ${JSON.stringify(args.preset)}`,
    );
  }
  if (
    args.lockout_confirmation_phrase !== undefined
    && typeof args.lockout_confirmation_phrase !== 'string'
  ) {
    throw badRequest(
      `${method}: lockout_confirmation_phrase must be a string when present`,
    );
  }
  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw badRequest(`${method}: reason must be a string when present`);
  }

  const result = await deps.getMachine().applyPreset({
    preset: args.preset,
    ...(typeof args.lockout_confirmation_phrase === 'string'
      ? { lockout_confirmation_phrase: args.lockout_confirmation_phrase }
      : {}),
    changed_by_client_id,
    ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
  });
  return unwrap(method, deps, result, `preset:${args.preset}`);
};

export const handleExposureSetPathResolution = async (
  deps: ExposureRpcDeps,
  args: {
    path?: unknown;
    resolution?: unknown;
    lockout_confirmation_phrase?: unknown;
    reason?: unknown;
  },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ExposureRpcResponse> => {
  const method = 'exposure.set_path_resolution';
  const changed_by_client_id = requireCallerInstance(caller, method);

  if (!isPathRole(args.path)) {
    throw badRequest(
      `${method}: path must be one of ${PATH_ROLES.join(', ')}; got ${JSON.stringify(args.path)}`,
    );
  }
  if (!isPathResolution(args.resolution)) {
    throw badRequest(
      `${method}: resolution must be { lan: boolean; public: boolean }; got ${JSON.stringify(args.resolution)}`,
    );
  }
  if (
    args.lockout_confirmation_phrase !== undefined
    && typeof args.lockout_confirmation_phrase !== 'string'
  ) {
    throw badRequest(
      `${method}: lockout_confirmation_phrase must be a string when present`,
    );
  }
  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw badRequest(`${method}: reason must be a string when present`);
  }

  const result = await deps.getMachine().setPathResolution({
    path: args.path,
    resolution: { lan: args.resolution.lan, public: args.resolution.public },
    ...(typeof args.lockout_confirmation_phrase === 'string'
      ? { lockout_confirmation_phrase: args.lockout_confirmation_phrase }
      : {}),
    changed_by_client_id,
    ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
  });
  return unwrap(method, deps, result, `path:${args.path}`);
};

export const handleExposureSetPublicMcpAcknowledgement = async (
  deps: ExposureRpcDeps,
  args: {
    acknowledge?: unknown;
    free_text_confirmation?: unknown;
    reason?: unknown;
  },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ExposureRpcResponse> => {
  const method = 'exposure.set_public_mcp_acknowledgement';
  const changed_by_client_id = requireCallerInstance(caller, method);

  if (typeof args.acknowledge !== 'boolean') {
    throw badRequest(
      `${method}: acknowledge must be a boolean; got ${JSON.stringify(args.acknowledge)}`,
    );
  }
  if (
    args.free_text_confirmation !== undefined
    && typeof args.free_text_confirmation !== 'string'
  ) {
    throw badRequest(
      `${method}: free_text_confirmation must be a string when present`,
    );
  }
  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw badRequest(`${method}: reason must be a string when present`);
  }

  const result = await deps.getMachine().setPublicMcpAcknowledgement({
    acknowledge: args.acknowledge,
    ...(typeof args.free_text_confirmation === 'string'
      ? { free_text_confirmation: args.free_text_confirmation }
      : {}),
    changed_by_client_id,
    ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
  });
  // public-MCP ack revoke can drop `/mcp.public` but doesn't touch `/ws`
  // — `drainOnLockoutIfNeeded` no-ops since /ws stays in its current
  // state. Threading the helper anyway keeps the success path uniform.
  return unwrap(method, deps, result, 'public_mcp_acknowledgement');
};

// R26.2 Delta 1 — exposure read. The Settings → Server → Exposure grid
// hydrates its initial `ExposureState` from this on cold load. Pure read
// over the state machine's `current()` accessor (which lazy-loads +
// initialises from the persisted/default state) — no audit row, no
// broadcast, no listener rebind. Requires a paired caller for parity
// with the mutators: the surface is operator-only + reserved out of MCP.
export const handleExposureGet = async (
  deps: ExposureRpcDeps,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ state: ExposureState; apex_mode: RootApexMode }> => {
  requireCallerInstance(caller, 'exposure.get');
  const state = await deps.getMachine().current();
  // R26.2 Delta 2 — hydrate the apex mode alongside the grid so the panel
  // reads both in one call. `redirect` is the privacy-safe fallback when the
  // apex config isn't wired (db-less / pre-Delta-2 boot).
  const apex_mode = deps.apex?.get() ?? 'redirect';
  return { state, apex_mode };
};

// R26.2 Delta 2 — set the apex (`GET /`) serving mode. Cross-validated
// against the LIVE exposure resolution so the picker can't persist an apex
// that would 404: `serve_reception` requires `/reception` public,
// `serve_webclient` requires the embedded bundle served (Delta 3). The
// write lands in the runtime-config field the root handler re-reads per
// request, so it takes effect without a restart.
export const handleExposureSetApex = async (
  deps: ExposureRpcDeps,
  args: { apex_mode?: unknown },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ apex_mode: RootApexMode }> => {
  const method = 'exposure.set_apex';
  requireCallerInstance(caller, method);

  if (!deps.apex) {
    throw new RpcError(
      'not_configured',
      `${method}: apex config is not wired on this server`,
      503,
    );
  }
  if (!isRootApexMode(args.apex_mode)) {
    throw new RpcError(
      'apex_mode_unknown',
      `${method}: apex_mode must be one of redirect, serve_webclient, serve_reception, not_found; got ${JSON.stringify(args.apex_mode)}`,
      400,
    );
  }
  const mode = args.apex_mode;

  if (mode === 'serve_reception') {
    const state = await deps.getMachine().current();
    if (state.resolution.reception.public !== true) {
      throw new RpcError(
        'apex_reception_not_public',
        `${method}: serve_reception requires /reception public on the public listener`,
        400,
      );
    }
  }
  if (mode === 'serve_webclient') {
    // R26.2 Delta 3 — serve_webclient is valid only when the embedded webclient
    // would actually serve at the root: `/webclient` public on the grid AND a
    // verified bundle deployed. Both mirror the root handler's
    // `getWebclientServable`, so the setter never reports success for an apex
    // that 404s (the Delta-2 `isWebclientServable` placeholder rejected ALL
    // serve_webclient; this is the real gate).
    const state = await deps.getMachine().current();
    const publicOn = state.resolution.webclient.public === true;
    const bundlePresent = deps.apex.isWebclientBundlePresent?.() === true;
    if (!publicOn || !bundlePresent) {
      throw new RpcError(
        'apex_webclient_unavailable',
        `${method}: serve_webclient requires /webclient public on the public listener + a verified webclient bundle deployed`,
        400,
      );
    }
  }

  deps.apex.set(mode);
  return { apex_mode: mode };
};

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

export const makeExposureHandlers = (
  deps: ExposureRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ExposureMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'exposure.apply_preset',
      'exposure.set_path_resolution',
      'exposure.set_public_mcp_acknowledgement',
      'exposure.get',
      'exposure.set_apex',
    ],
    handlers: {
      'exposure.get': async (_args, client) =>
        handleExposureGet(
          deps,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'exposure.set_apex': async (args, client) =>
        handleExposureSetApex(
          deps,
          args as { apex_mode?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'exposure.apply_preset': async (args, client) =>
        handleExposureApplyPreset(
          deps,
          args as { preset?: unknown; lockout_confirmation_phrase?: unknown; reason?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'exposure.set_path_resolution': async (args, client) =>
        handleExposureSetPathResolution(
          deps,
          args as {
            path?: unknown;
            resolution?: unknown;
            lockout_confirmation_phrase?: unknown;
            reason?: unknown;
          },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'exposure.set_public_mcp_acknowledgement': async (args, client) =>
        handleExposureSetPublicMcpAcknowledgement(
          deps,
          args as {
            acknowledge?: unknown;
            free_text_confirmation?: unknown;
            reason?: unknown;
          },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
