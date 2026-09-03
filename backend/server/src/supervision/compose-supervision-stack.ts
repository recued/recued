/** Supervision feature — composition root for the cli-daemon keep-alive stack.
 *
 *  Bundles the durable store + the supervisor + the rpc deps, and rides the
 *  D-118 `serviceStack` lifecycle threading: built in `compose-collection-
 *  context` (which has db / dataPath / manifests), `startAll`'d at boot in
 *  `startCollectionAdapters`, `disposeAll`'d at shutdown via `install-shutdown`,
 *  and its `rpcDeps` registered on the ws-server handler set.
 *
 *  The one dep `compose-collection-context` lacks is the cli executor (built
 *  later, in `compose-execution-context`), so it's LATE-BOUND: the supervisor
 *  receives a resolver that reads the bound executor at launch time (the
 *  per-use-resolver pattern). `bindExecutor` is called once execution is
 *  composed, before boot's `startAll` runs. A launch before the bind (a misuse)
 *  throws rather than silently dropping the daemon.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type Database from 'better-sqlite3';
import type { IngredientManifest, ServiceState } from '@recued/contracts';
import type { CliInvocationCall, CliInvocationExecutor } from '@recued/engine';
import type { ActivityAction, ActivityEntry, AuditLogStore } from '@recued/storage';

import {
  createCliDaemonSupervisor,
  type CliDaemonSupervisor,
  type DaemonAuditEvent,
} from './cli-daemon-supervisor.js';
import {
  createSupervisedDaemonStore,
  type SupervisedDaemonStore,
} from './supervised-daemon-store.js';
import type { SupervisionRpcDeps } from '../supervision-handler.js';
import { runCheck } from '../collections/service/checkers/dispatcher.js';

export interface SupervisionStack {
  store: SupervisedDaemonStore;
  supervisor: CliDaemonSupervisor;
  /** Deps for `makeSupervisionHandlers` — the owner-only `supervision.*` rpc. */
  rpcDeps: SupervisionRpcDeps;
  /** Bind the cli executor once `compose-execution-context` has built it. */
  bindExecutor: (exec: CliInvocationExecutor) => void;
  /** Recipe/catalog entry point for a migrated service declaration. Persists
   *  the declared supervisor policy, awaits readiness, and returns the legacy
   *  launch receipt plus the new readiness/health state. */
  startFromInvocation: (call: CliInvocationCall) => Promise<unknown>;
  /** Boot reconcile — adopt survivors / relaunch each enabled daemon. */
  startAll: () => Promise<void>;
  /** Shutdown — close admission and drain async supervisor work before dropping
   *  tracking (detached daemons survive the bounce). */
  disposeAll: () => Promise<void>;
}

export interface ComposeSupervisionStackOptions {
  db: Database.Database;
  /** Base data dir — daemon markers live under `<dataPath>/daemons/`. */
  dataPath: string;
  getManifest: (slug: string) => IngredientManifest | undefined;
  /** Enumerate all installed manifests — the `supervision.list` discovery source
   *  (every `detached.supervision` op). */
  getManifests: () => Iterable<IngredientManifest>;
  /** Gate-byte hook for the durable store (same as the dish / schedule stores). */
  onBytesChanged?: (delta: number) => void;
  /** Live-state broadcast — fans a `supervision` event on a daemon state
   *  transition so paired clients re-list. Wired from `eventBus.emit`. */
  broadcast?: (change: { ingredient_slug: string; op: string }) => void;
  /** D-120 activity log — when present, the supervisor's `audit` seam writes one
   *  reserve-class row per daemon state transition (started / crashed / stopped /
   *  permanently_crashed). Wired from `compose-collection-context`'s `auditLog`;
   *  absent (db-less boot / tests) ⇒ no audit, only the broadcast fires. */
  auditLog?: AuditLogStore;
  /** Override seams (the supervisor's defaults — clock / timers / fs / poll
   *  cadence). Production leaves them unset; tests inject. */
  supervisorOverrides?: Partial<
    Pick<
      Parameters<typeof createCliDaemonSupervisor>[0],
      'now' | 'setTimeout' | 'clearTimeout' | 'killProcessGroup' | 'isPidAlive' | 'pollIntervalMs' | 'fs' | 'log'
    >
  >;
}

/** Map each audit-worthy daemon state to its `ActivityAction`. `unknown` is
 *  never a transition target via `setState` (it's the initial record state set
 *  outside the seam), so it carries no action — the emitter silently skips any
 *  unmapped state, which also future-proofs a new `ServiceState`. */
export const STATE_TO_AUDIT_ACTION: Partial<Record<ServiceState, ActivityAction>> = {
  running: 'supervised_daemon_started',
  crashed: 'supervised_daemon_crashed',
  stopped: 'supervised_daemon_stopped',
  permanently_crashed: 'supervised_daemon_permanently_crashed',
};

/** Adapt a daemon state transition → one D-120 activity row. The supervisor's
 *  synchronous state-machine path does not await this Promise, but tracks it so
 *  `disposeAll()` drains the write before SQLite closes. `target` is
 *  `<ingredient_slug>/<op>`; the JSON `detail` carries the runtime facts the row
 *  is keyed by. A write failure only warns — the durable daemon state lives in
 *  the supervisor + store, not this breadcrumb. */
export const buildDaemonAuditEmitter =
  (auditLog: AuditLogStore) =>
    (event: DaemonAuditEvent): Promise<void> => {
      const action = STATE_TO_AUDIT_ACTION[event.state];
      if (!action) return Promise.resolve();
      const entry: ActivityEntry = {
        activity_id: `daemon_${event.ingredient_slug}_${event.op}_${event.at}_${randomUUID().slice(0, 8)}`,
        timestamp: event.at,
        action,
        target: `${event.ingredient_slug}/${event.op}`,
        detail: JSON.stringify({
          op: event.op,
          state: event.state,
          pid: event.pid,
          last_exit_code: event.last_exit_code,
          consecutive_crashes: event.consecutive_crashes,
        }),
      };
      return auditLog.logActivity(entry).catch((err) => {
        const where = `${event.ingredient_slug}/${event.op}`;
        // eslint-disable-next-line no-console
        console.warn(
          `[cli-daemon-supervisor] audit write failed for '${where}' (${event.state}): `
            + (err instanceof Error ? err.message : String(err)),
        );
      });
    };

export const composeSupervisionStack = (
  options: ComposeSupervisionStackOptions,
): SupervisionStack => {
  let boundExecutor: CliInvocationExecutor | undefined;

  const store = createSupervisedDaemonStore(
    options.db,
    options.onBytesChanged ? { onBytesChanged: options.onBytesChanged } : {},
  );

  const supervisor = createCliDaemonSupervisor({
    // Late-bound: resolve the executor at launch time, not at compose time.
    cliInvocationExecutor: (call) => {
      if (!boundExecutor) {
        return Promise.reject(
          new Error('cli-daemon-supervisor: cli executor not yet bound'),
        );
      }
      return boundExecutor(call);
    },
    getManifest: options.getManifest,
    dataPath: options.dataPath,
    ...(options.broadcast ? { broadcast: options.broadcast } : {}),
    ...(options.auditLog ? { audit: buildDaemonAuditEmitter(options.auditLog) } : {}),
    runCheck: (spec, config) => runCheck(spec, {}, config),
    ...options.supervisorOverrides,
  });

  return {
    store,
    supervisor,
    rpcDeps: {
      store,
      supervisor,
      getManifest: options.getManifest,
      getManifests: options.getManifests,
      // Same auditLog the supervisor's lifecycle emitter uses — here it audits
      // the owner's enrollment decision (`supervision.set`).
      ...(options.auditLog ? { auditLog: options.auditLog } : {}),
    },
    bindExecutor: (exec) => { boundExecutor = exec; },
    startFromInvocation: async (call) => {
      if (call.signal?.aborted) {
        throw new Error(`supervised daemon '${call.operation_id}' start cancelled before launch`);
      }
      const supervision = call.binding.detached?.supervision;
      if (!supervision) {
        throw new Error(`cli daemon '${call.operation_id}' has no supervision declaration`);
      }
      const { result_dir: _resultDir, key: _key, code: _code, ...args } = call.args;
      void _resultDir;
      void _key;
      void _code;
      const config = {
        ingredient_slug: call.slug,
        op: call.operation_key,
        restart_policy: supervision.restart_policy,
        restart_on_server_start: supervision.restart_on_server_start ?? false,
        enabled: true,
        args,
      };
      const priorStatus = supervisor.status(call.slug, call.operation_key);
      const priorActive = priorStatus !== null
        && priorStatus.state !== 'stopped'
        && priorStatus.state !== 'crashed'
        && priorStatus.state !== 'permanently_crashed';
      if (priorActive) {
        const priorConfig = store.get(call.slug, call.operation_key);
        if (!priorConfig || !isDeepStrictEqual(priorConfig, config)) {
          throw new Error(
            `supervised daemon '${call.operation_id}' is already active with different configuration; stop it before reconfiguring`,
          );
        }
      } else {
        store.upsert(config);
      }

      // The call that established an inactive singleton owns launch cleanup.
      // A same-config follower only joins readiness; cancelling that follower
      // must not stop the original caller's service.
      const ownsLaunch = !priorActive;
      let aborted = false;
      let abortStop: Promise<unknown> | undefined;
      let signalAbort!: () => void;
      const abortGate = new Promise<{ kind: 'aborted' }>((resolve) => {
        signalAbort = () => { resolve({ kind: 'aborted' }); };
      });
      const onAbort = (): void => {
        aborted = true;
        if (ownsLaunch) {
          abortStop ??= supervisor.stop(call.slug, call.operation_key);
        }
        signalAbort();
      };
      call.signal?.addEventListener('abort', onAbort, { once: true });
      if (call.signal?.aborted) onAbort();
      let outcome:
        | { kind: 'status'; status: Awaited<ReturnType<CliDaemonSupervisor['start']>> }
        | { kind: 'error'; error: unknown }
        | { kind: 'aborted' };
      try {
        const starting = supervisor.start(config).then(
          (status) => ({ kind: 'status' as const, status }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        );
        outcome = await Promise.race([starting, abortGate]);
        if (aborted) {
          if (abortStop) await abortStop;
          throw new Error(`supervised daemon '${call.operation_id}' start cancelled`);
        }
      } finally {
        call.signal?.removeEventListener('abort', onAbort);
      }
      if (outcome.kind === 'aborted') {
        if (abortStop) await abortStop;
        throw new Error(`supervised daemon '${call.operation_id}' start cancelled`);
      }
      if (outcome.kind === 'error') throw outcome.error;
      const { status } = outcome;
      if (status.state !== 'running'
        || (status.readiness !== 'ready' && status.readiness !== 'legacy')) {
        throw new Error(
          `supervised daemon '${call.operation_id}' failed readiness: `
            + (status.readiness_detail ?? status.state),
        );
      }
      return {
        ...(status.launch_receipt ?? { mode: 'detached', launched: true, pid: status.pid }),
        readiness: status.readiness,
        readiness_detail: status.readiness_detail,
        ready_at: status.ready_at,
        health: status.health,
      };
    },
    startAll: () => supervisor.startAll(store.list()),
    disposeAll: () => supervisor.disposeAll(),
  };
};
