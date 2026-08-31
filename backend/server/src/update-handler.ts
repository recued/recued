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
  type UpdateOperationClosureResponse,
  type UpdateOperationStatusResponse,
  type UpdateRollbackResponse,
} from '@recued/contracts';
import { runReleaseCheck, type ReleaseCheckDeps, type ResolveForApplyResult } from './update/release-check.js';
import {
  runApply,
  runRollback,
  closeUnresolvedUpdateOperation,
  resolveUpdateOperationOutcome,
  type ApplyOrchestratorPorts,
  type RollbackContext,
} from './update/apply-orchestrator.js';
import {
  resolveUpdateMode,
  type DistributionChannel,
  type UpdateModeStore,
} from './update/update-mode-store.js';
import type { ServerEvent } from '@recued/contracts';
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

/** D-257 — the update-progress variant minus the bus-assigned `cursor`, the
 *  same shape `pair-handler` and `contract-handler` use. The bus stamps the
 *  cursor; the handler supplies the phase. */
export type UpdateProgressEvent = Omit<
  Extract<ServerEvent, { kind: 'update.progress' }>,
  'cursor'
>;

export interface UpdateHandlerDeps {
  /** D-257 — broadcast bus emit seam for `update.progress`.
   *
   *  The apply no longer completes inside the rpc, so this is how the caller
   *  learns what happened. Optional and swallowed on failure, mirroring
   *  `pair-handler`'s discipline: a no-bus harness still applies correctly, it
   *  just has nobody to tell. */
  broadcast?: (event: UpdateProgressEvent) => void;
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
  | 'update.rollback'
  | 'update.operation_status'
  | 'update.operation_close';

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
const UPDATE_OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
    methods: [
      'update.check',
      'update.mode',
      'update.set_mode',
      'update.apply',
      'update.rollback',
      'update.operation_status',
      'update.operation_close',
    ],
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
        const base = { release_identity: resolved.releaseIdentity, to_version: resolved.toVersion };
        const emit = (event: UpdateProgressEvent): void => {
          // Observability only — never abort an apply because nobody listened.
          try { deps.broadcast?.(event); } catch { /* no bus wired */ }
        };

        // ⛔⛔ DO NOT AWAIT THIS. The apply downloads ~144 MB and takes minutes;
        // awaiting it inside the rpc is what made Settings -> Updates report a
        // failure on every real update, because the webclient's per-call timeout
        // is 30s while the server went on to finish the work it had been told to
        // do. The outcome arrives on `update.progress` instead.
        //
        // 🔑 The cheap refusals stay SYNCHRONOUS above (not-applicable,
        // not-available, major-blocked) — those are answers, not work. And
        // `runApply`'s own preconditions (`busy`, `deferred`,
        // `insufficient-storage`) return WITHOUT writing a ledger entry, which is
        // exactly why the terminal emit carries a `status` rather than the bus
        // mirroring ledger transitions alone.
        const ports: ApplyOrchestratorPorts = {
          ...applyDeps.ports,
          notifyLedger: (entry) => emit({
            kind: 'update.progress',
            phase: entry.kind,
            release_identity: entry.release_identity,
            from_version: entry.from_version,
            to_version: entry.to_version,
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          }),
        };

        void runApply(ports, {
          releaseIdentity: resolved.releaseIdentity,
          fromVersion: resolved.fromVersion,
          toVersion: resolved.toVersion,
          channel: resolved.channel,
          migration: resolved.migration,
          artifact: resolved.artifact,
          libArtifact: resolved.libArtifact,
          webclientArtifact: resolved.webclientArtifact,
          // Owner-initiated UI/CLI apply — proceeds without the quiesce wait
          // (the caller forces quiesce); auto/housekeeping defers separately.
          trigger: 'manual',
        }).then(
          (result) => {
            const detail = 'detail' in result && typeof result.detail === 'string'
              ? result.detail
              : 'reason' in result && typeof result.reason === 'string'
                ? result.reason
                : undefined;
            emit({
              kind: 'update.progress',
              phase: 'result',
              ...base,
              status: result.status,
              ...(detail === undefined ? {} : { detail }),
              ...('operationId' in result && typeof result.operationId === 'string'
                ? { operation_id: result.operationId }
                : {}),
            });
          },
          (err: unknown) => {
            // A throw is not a status `runApply` models, and silence would leave
            // the UI applying forever. Report the closest terminal shape rather
            // than inventing a new one.
            emit({
              kind: 'update.progress',
              phase: 'result',
              ...base,
              status: 'stage-failed',
              detail: err instanceof Error ? err.message : String(err),
            });
          },
        );

        return { status: 'applying', ...base };
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
            return {
              status: 'rolled-back',
              operation_id: result.operationId,
              restored_snapshot: result.restored_snapshot,
            };
          case 'refused':
            return { status: 'refused', detail: result.reason };
          case 'busy':
            return { status: 'busy' };
        }
      },
      'update.operation_status': async (
        args,
        client,
      ): Promise<UpdateOperationStatusResponse> => {
        requireRegisteredClient(client);
        if (
          !args
          || typeof args.operation_id !== 'string'
          || !UPDATE_OPERATION_ID.test(args.operation_id)
          || (
            args.include_closed !== undefined
            && typeof args.include_closed !== 'boolean'
          )
        ) {
          throw new RpcError(
            'invalid_args',
            'operation_id must be an opaque update receipt; include_closed must be boolean when provided',
            400,
          );
        }
        if (!applyDeps) return { status: 'unknown' };
        const outcome = resolveUpdateOperationOutcome(
          applyDeps.ports.ledger,
          args.operation_id,
          deps.releaseCheckDeps.currentVersion,
        );
        // Backward-compatible fail-closed projection: pre-closure clients treat
        // every unfamiliar non-waiting status as terminal. They must keep
        // seeing `unknown`; only an explicitly closure-aware client may receive
        // the durable `closed_unresolved` state and expose Finish recovery.
        return outcome.status === 'closed_unresolved'
          && args.include_closed !== true
          ? { status: 'unknown' }
          : outcome;
      },
      'update.operation_close': async (
        args,
        client,
      ): Promise<UpdateOperationClosureResponse> => {
        requireRegisteredClient(client);
        if (
          !args
          || typeof args.operation_id !== 'string'
          || !UPDATE_OPERATION_ID.test(args.operation_id)
          || (
            args.expected_operation !== 'update'
            && args.expected_operation !== 'rollback'
          )
        ) {
          throw new RpcError(
            'invalid_args',
            'operation_id and expected_operation must identify an opaque update receipt',
            400,
          );
        }
        if (!applyDeps) {
          return { status: 'refused', reason: 'not_supported' };
        }
        return closeUnresolvedUpdateOperation(
          applyDeps.ports,
          args.operation_id,
          args.expected_operation,
          deps.releaseCheckDeps.currentVersion,
          deps.releaseCheckDeps.channel,
        );
      },
    },
  };
};
