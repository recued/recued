/** D-178 slice 2 — RPC handler for the `update.*` namespace.
 *
 *  `update.check` — fetch + verify + locally resolve the signed release
 *  manifest for this install (the orchestrator lives in
 *  `update/release-check.ts`). Read-only beyond persisting the anti-replay
 *  floor + rollout salt. The `update.{apply,rollback,set_mode}` verbs land in
 *  later slices.
 *
 *  Auth model (mirrors `pro-convenience-handler.ts`):
 *    1. **Registered client** — a pre-register / raw-bearer WS connection must
 *       not enumerate the update posture.
 *    2. **Channel isolation** — `update.` is in `MCP_RESERVED_RPC_PREFIXES`,
 *       so no MCP-channel agent ever reaches it (the catalog ratchet asserts
 *       the prefix stays reserved). Owner device surfaces only.
 *
 *  Composer-side absence (no `deps`) returns `undefined`; the dispatcher then
 *  yields `not_configured` for `update.*` (db-less harness / pre-boot). A
 *  WIRED-but-keyless server (no trusted release key yet — pre-GA) instead
 *  resolves `update.check` to `status: 'not-configured'` so the UI can render
 *  "updates not yet available on this build" rather than a transport error.
 */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type UpdateApplyResponse,
  type UpdateMode,
  type UpdateRollbackResponse,
} from '@recued/contracts';
import { runReleaseCheck, type ReleaseCheckDeps, type ResolveForApplyResult } from './update/release-check.js';
import {
  runApply,
  runRollback,
  type ApplyOrchestratorPorts,
  type RollbackContext,
} from './update/apply-orchestrator.js';
import {
  resolveUpdateMode,
  type DistributionChannel,
  type UpdateModeStore,
} from './update/update-mode-store.js';
import type { WsClient } from './ws-server.js';

/** Apply-policy deps: the persisted user override + the build-stamped channel +
 *  the raw `RECUED_SELF_UPDATE` env value (env wins). */
export interface UpdateModeDeps {
  store: UpdateModeStore;
  channel: DistributionChannel;
  envMode?: string;
}

/** Apply / rollback execution deps. Absent on a delegated channel (docker /
 *  source — the host updates the image, so the binary self-apply path is
 *  `not-applicable`) or a platform with no orchestrator (dbless harness). */
export interface UpdateApplyDeps {
  ports: ApplyOrchestratorPorts;
  /** Fetch + verify + resolve the apply target (the artifact-bearing twin of
   *  `runReleaseCheck`). */
  resolveForApply: () => Promise<ResolveForApplyResult>;
  /** The current-release rollback context derived from the ledger (the last
   *  committed apply), or null when there is no prior committed apply. */
  rollbackContext: () => RollbackContext | null;
}

export interface UpdateHandlerDeps {
  /** Build the per-call orchestrator deps (clock / fetch / state / config). */
  releaseCheckDeps: ReleaseCheckDeps;
  /** Apply-policy read/write deps. */
  modeDeps: UpdateModeDeps;
  /** Apply / rollback execution. Absent → `update.apply`/`update.rollback`
   *  resolve to `not-applicable` (delegated channel) without touching disk. */
  applyDeps?: UpdateApplyDeps;
}

export type UpdateMethods =
  | 'update.check'
  | 'update.mode'
  | 'update.set_mode'
  | 'update.apply'
  | 'update.rollback';

/** Map a non-applyable resolve outcome to the apply wire status. */
const NOT_APPLYABLE: Record<Exclude<ResolveForApplyResult['status'], 'applyable'>, UpdateApplyResponse['status']> = {
  'not-configured': 'not-configured',
  'fetch-failed': 'download-failed',
  'bad-signature': 'verify-failed',
  'up-to-date': 'not-available',
  'stale-feed': 'not-available',
  'launcher-outdated': 'not-available',
  replay: 'not-available',
  'no-artifact': 'not-available',
};

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError('unauthorized', 'update rpc requires a registered paired client', 401);
  }
};

const VALID_MODES: readonly UpdateMode[] = ['auto', 'notify', 'off'];

export const makeUpdateHandlers = (
  deps: UpdateHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, UpdateMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { modeDeps } = deps;
  const status = () =>
    resolveUpdateMode({
      channel: modeDeps.channel,
      userMode: modeDeps.store.readUserMode(),
      envMode: modeDeps.envMode,
    });
  const applyDeps = deps.applyDeps;
  return {
    methods: ['update.check', 'update.mode', 'update.set_mode', 'update.apply', 'update.rollback'],
    handlers: {
      'update.check': async (_args, client) => {
        requireRegisteredClient(client);
        return runReleaseCheck(deps.releaseCheckDeps);
      },
      'update.mode': async (_args, client) => {
        requireRegisteredClient(client);
        return status();
      },
      'update.set_mode': async (args, client) => {
        requireRegisteredClient(client);
        if (!args || !VALID_MODES.includes(args.mode)) {
          throw new RpcError('invalid_args', 'mode must be one of auto | notify | off', 400);
        }
        // Env pins the mode inside containers — refuse the override rather than
        // silently storing a value the resolver will ignore.
        if (status().env_locked) {
          throw new RpcError('forbidden', 'update mode is pinned by RECUED_SELF_UPDATE and cannot be overridden', 403);
        }
        modeDeps.store.setUserMode(args.mode);
        return status();
      },
      'update.apply': async (args, client): Promise<UpdateApplyResponse> => {
        requireRegisteredClient(client);
        // Delegated channel (docker / source) or unsupported platform — the
        // binary self-apply path doesn't exist; the host updates the image.
        if (!applyDeps) return { status: 'not-applicable' };
        const resolved = await applyDeps.resolveForApply();
        if (resolved.status !== 'applyable') {
          return { status: NOT_APPLYABLE[resolved.status] };
        }
        // I-4 — a major bump is notify-only; an owner can force it explicitly.
        // Strict `=== true` so only the literal boolean forces (a stray truthy
        // value off the wire must not bypass the major-block guard).
        const force = args?.force === true;
        if (resolved.isMajor && !force) {
          return { status: 'major-blocked', release_identity: resolved.releaseIdentity, to_version: resolved.toVersion };
        }
        const result = await runApply(applyDeps.ports, {
          releaseIdentity: resolved.releaseIdentity,
          fromVersion: resolved.fromVersion,
          toVersion: resolved.toVersion,
          channel: resolved.channel,
          migration: resolved.migration,
          artifact: resolved.artifact,
          webclientArtifact: resolved.webclientArtifact,
          // Owner-initiated UI/CLI apply — proceeds without the quiesce wait
          // (the caller forces quiesce); auto/housekeeping defers separately.
          trigger: 'manual',
        });
        const base = { release_identity: resolved.releaseIdentity, to_version: resolved.toVersion };
        switch (result.status) {
          case 'restarting':
            return { status: 'restarting', ...base };
          case 'deferred':
            return { status: 'deferred', ...base, detail: result.reason };
          case 'busy':
            return { status: 'busy', ...base };
          case 'not-configured':
            return { status: 'not-configured' };
          case 'insufficient-storage':
          case 'download-failed':
          case 'verify-failed':
          case 'stage-failed':
            return { status: result.status, ...base, detail: result.detail };
        }
      },
      'update.rollback': async (_args, client): Promise<UpdateRollbackResponse> => {
        requireRegisteredClient(client);
        if (!applyDeps) return { status: 'not-applicable' };
        const ctx = applyDeps.rollbackContext();
        // No prior committed apply → nothing to roll back to (the rollback
        // guard would refuse on the missing `recued.old` anyway).
        if (!ctx) return { status: 'refused', detail: 'no previous release to roll back to' };
        const result = runRollback(applyDeps.ports, ctx);
        switch (result.status) {
          case 'rolled-back':
            return { status: 'rolled-back', restored_snapshot: result.restored_snapshot };
          case 'refused':
            return { status: 'refused', detail: result.reason };
          case 'busy':
            return { status: 'busy' };
        }
      },
    },
  };
};
