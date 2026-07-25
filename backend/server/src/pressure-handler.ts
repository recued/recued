/** Phase B pressure admin rpc handlers.
 *
 *  Two methods under `server.*`:
 *    server.runPressureReclaim   — force a reclaim pass on a surface.
 *    server.setPressureOverride  — resume a manually-halted gate.
 *
 *  Reads piggyback on `server.getStatus` + heartbeat — no dedicated
 *  read rpc for pressure state. */

import { RpcError } from '@recued/contracts';
import type {
  HandlerSlice,
  ServerPressureReclaimResult,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { GateRegistry } from './storage-gates.js';
import type { EvictionCascade } from './eviction-cascade.js';
import type { WsClient } from './ws-server.js';

export interface PressureHandlerDeps {
  registry: GateRegistry;
  cascade: EvictionCascade;
}

export const handleRunPressureReclaim = async (
  deps: PressureHandlerDeps,
  args: { surface?: unknown; force?: unknown },
): Promise<ServerPressureReclaimResult> => {
  const surface = args.surface;
  if (typeof surface !== 'string' || surface.length === 0) {
    throw new RpcError('bad_request', 'surface is required', 400);
  }
  const force = typeof args.force === 'boolean' ? args.force : false;
  const summary = await deps.cascade.reclaim(surface, { force });
  const result: ServerPressureReclaimResult = {
    ran: summary.ran,
    bytes_freed: summary.bytes_freed,
    steps_run: summary.steps_run,
  };
  if (summary.reason_if_skipped) {
    result.reason_if_skipped = summary.reason_if_skipped;
  }
  return result;
};

export const handleSetPressureOverride = async (
  deps: PressureHandlerDeps,
  args: { surface?: unknown; resume?: unknown },
): Promise<{ ok: true }> => {
  const surface = args.surface;
  if (typeof surface !== 'string' || surface.length === 0) {
    throw new RpcError('bad_request', 'surface is required', 400);
  }
  const resume = typeof args.resume === 'boolean' ? args.resume : false;
  const gate = deps.registry.get(surface);
  if (!gate) {
    throw new RpcError('bad_request', `no such surface: ${surface}`, 404);
  }
  if (resume) {
    gate.resume();
  } else {
    gate.halt('admin_override');
  }
  return { ok: true };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type PressureMethods =
  | 'server.runPressureReclaim'
  | 'server.setPressureOverride';

export const makePressureHandlers = (
  deps: PressureHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PressureMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['server.runPressureReclaim', 'server.setPressureOverride'],
    handlers: {
      'server.runPressureReclaim': async (args) =>
        handleRunPressureReclaim(deps, args),
      'server.setPressureOverride': async (args) =>
        handleSetPressureOverride(deps, args),
    },
  };
};
