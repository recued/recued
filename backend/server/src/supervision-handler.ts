/** Supervision feature — rpc handlers for the owner-only `supervision.*` family.
 *
 *  The seam the pack-detail manual/auto flip UI builds against:
 *
 *    - `supervision.set`    — enrol / flip (manual|auto|off) / start / stop one
 *      daemon op, keyed `(ingredient_slug, op)`. `manual` → `restart_policy:
 *      'never'` + no boot-persist; `auto` → the pack op's declared
 *      `restart_policy` + `restart_on_server_start`; `off` → stop + drop the row.
 *    - `supervision.list`   — DISCOVERY + merge: every supervisable daemon op
 *      across installed manifests (`detached.supervision`-bearing), merged with
 *      enrollment + live runtime state. An un-enrolled op comes back `mode:'off'`
 *      so the UI can render the enrol control (an enrolled-only list could never
 *      surface a daemon to enrol — chicken/egg).
 *    - `supervision.status` — one daemon's row (enrolled, else its discovered
 *      `off` row, else null).
 *
 *  Owner-only by construction: `supervision.` is in `MCP_RESERVED_RPC_PREFIXES`,
 *  so an MCP-channel agent can never enrol a daemon nor take a tunnel offline.
 *  Absent `deps` (db-less harness / pre-compose boot) ⇒ the methods fall through
 *  to `not_configured`, exactly like `ddns.*` / `cli.reachability.*`.
 */
import {
  RpcError,
  type CliMethodBinding,
  type HandlerSlice,
  type IngredientManifest,
  type ServerRpcRegistry,
  type ServiceRestartPolicy,
  type SupervisionDaemonRow,
  type SupervisionListResponse,
  type SupervisionMode,
  type SupervisionSetRequest,
  type SupervisionStatusRequest,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { CliDaemonSupervisor } from './supervision/cli-daemon-supervisor.js';
import type {
  SupervisedDaemonConfig,
  SupervisedDaemonStore,
} from './supervision/supervised-daemon-store.js';
import type { WsClient } from './ws-server.js';

export interface SupervisionRpcDeps {
  /** Durable enrolled-daemon config store. */
  store: SupervisedDaemonStore;
  /** The keep-alive supervisor (launch / stop / live status). */
  supervisor: CliDaemonSupervisor;
  /** Resolve ONE installed ingredient manifest by slug — the daemon op's
   *  `CliMethodBinding` + its `detached.supervision` spec live at
   *  `manifest.surfaces.connector.executes[op]`. Wired from
   *  `executorConfig.manifests.get`. */
  getManifest: (slug: string) => IngredientManifest | undefined;
  /** Enumerate ALL installed manifests — the discovery source for
   *  `supervision.list` (every `detached.supervision` op). Wired from
   *  `executorConfig.manifests`. Absent (db-less harness) ⇒ `list` degrades to
   *  enrolled-only. */
  getManifests?: () => Iterable<IngredientManifest>;
  /** D-120 activity log — when present, `supervision.set` audits the owner's
   *  enrollment decision (enrol / reconfigure / un-enrol) as a reserve-class row,
   *  symmetric with `cli.reachability.set`. Absent (db-less harness) ⇒ the set
   *  still lands, only the audit breadcrumb is skipped. */
  auditLog?: AuditLogStore;
}

export type SupervisionMethods =
  | 'supervision.set'
  | 'supervision.list'
  | 'supervision.status';

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'supervision control requires a registered paired client',
      401,
    );
  }
};

const ensureNonEmpty = (method: string, field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ${field} is required`);
  }
  return value;
};

/** Non-empty AND free of path-traversal: `ingredient_slug` / `op` is
 *  concatenated into the server-owned daemon marker dir (`<dataPath>/daemons/
 *  <ingredient>/<op>/`), so a `/`, `\`, or pure-dot (`.` / `..`) segment — which
 *  `path.join` normalizes away — would escape the boundary. Reject at the rpc
 *  edge (the supervisor's `segment()` is a second defensive layer). */
const ensureSafeSegment = (method: string, field: string, value: unknown): string => {
  const s = ensureNonEmpty(method, field, value);
  if (/[/\\]/.test(s) || /(^|\/)\.\.?($|\/)/.test(s) || /^\.+$/.test(s)) {
    throw new RpcError('bad_request', `${method}: ${field} must not contain path separators or '.' / '..' segments`);
  }
  return s;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The pack op's `CliMethodBinding`, or null when `(ingredient_slug, op)` is not
 *  a supervised daemon op (no `cli_invocation` binding, no `detached`, or no
 *  `detached.supervision`). */
const resolveDaemonBinding = (
  getManifest: (slug: string) => IngredientManifest | undefined,
  ingredient_slug: string,
  op: string,
): CliMethodBinding | null => {
  const binding = getManifest(ingredient_slug)?.surfaces?.connector?.executes?.[op];
  if (!binding || binding.kind !== 'cli_invocation' || !binding.detached?.supervision) return null;
  return binding;
};

/** Argv tokens the supervisor injects at launch (server-owned) — never required
 *  from the enrol `args`. `{code}` is the exit-marker placeholder. */
const SUPERVISOR_INJECTED_ARGS = new Set(['result_dir', 'key', 'code']);
const ARGV_TEMPLATE_REF = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** The op's required `argv_template` `{token}` refs (minus the supervisor-
 *  injected ones) — the keys the enrol form must collect. */
const requiredArgvRefs = (binding: CliMethodBinding): string[] => {
  const refs = new Set<string>();
  for (const entry of binding.argv_template) {
    if (typeof entry !== 'string') continue; // `{ expand_arg }` array entries — not scalar refs
    for (const m of entry.matchAll(ARGV_TEMPLATE_REF)) {
      if (!SUPERVISOR_INJECTED_ARGS.has(m[1])) refs.add(m[1]);
    }
  }
  return [...refs];
};

/** Required refs the provided `args` don't satisfy — rejected at enrol so a
 *  missing `tunnel_name` becomes a clean rpc error, not a launch that throws at
 *  template resolution and burns the restart counter to `permanently_crashed`. */
const missingArgvRefs = (
  binding: CliMethodBinding,
  args: Record<string, unknown>,
): string[] =>
  requiredArgvRefs(binding).filter((ref) => {
    const v = args[ref];
    return v === undefined || v === null || v === '';
  });

/** A discovered supervisable daemon op (its catalog ingredient + op + binding). */
interface DiscoveredDaemon {
  ingredient_slug: string;
  op: string;
  binding: CliMethodBinding;
}

/** Every `detached.supervision`-bearing op across the installed manifests. */
const discoverDaemonOps = (
  getManifests: (() => Iterable<IngredientManifest>) | undefined,
): DiscoveredDaemon[] => {
  if (!getManifests) return [];
  const out: DiscoveredDaemon[] = [];
  for (const manifest of getManifests()) {
    const executes = manifest.surfaces?.connector?.executes;
    if (!executes) continue;
    for (const [op, binding] of Object.entries(executes)) {
      if (binding.kind === 'cli_invocation' && binding.detached?.supervision) {
        out.push({ ingredient_slug: manifest.slug, op, binding });
      }
    }
  }
  return out;
};

/** The UI/contract mode a stored config represents (mirrors `enrolledRow`'s
 *  derivation): absent row ⇒ 'off'; `restart_policy: 'never'` ⇒ 'manual'; else
 *  'auto'. The audit compares prior vs new mode to fire only on an enrollment
 *  TRANSITION — never on a pure start/stop or args re-toggle (same mode). */
const modeOf = (config: SupervisedDaemonConfig | null | undefined): SupervisionMode =>
  !config ? 'off' : config.restart_policy === 'never' ? 'manual' : 'auto';

/** Best-effort reserve-class audit of the owner's enrollment decision. Awaited
 *  (human-paced rpc — the row lands before the response, so a process exit right
 *  after can't lose it), but a failure never unwinds the set: the durable store
 *  row is the authority, the audit is the breadcrumb. Mirrors
 *  `cli-reachability-handler`'s `auditCell`. */
const auditEnrollment = async (
  auditLog: AuditLogStore | undefined,
  action: 'supervised_daemon_enrolled' | 'supervised_daemon_unenrolled',
  ingredient_slug: string,
  op: string,
  detail: Record<string, unknown>,
): Promise<void> => {
  if (auditLog === undefined) return;
  try {
    await auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action,
      target: `${ingredient_slug}/${op}`,
      detail: JSON.stringify(detail),
    });
  } catch (err) {
    console.warn(
      `[supervision-handler] ${action} audit failed for '${ingredient_slug}/${op}': `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
};

export const makeSupervisionHandlers = (
  deps: SupervisionRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, SupervisionMethods, WsClient> | undefined => {
  if (!deps) return undefined;

  /** An enrolled daemon's wire row — durable config + live runtime + the op's
   *  required args (binding resolved live; empty when the ingredient is gone). */
  const enrolledRow = (config: SupervisedDaemonConfig): SupervisionDaemonRow => {
    const st = deps.supervisor.status(config.ingredient_slug, config.op);
    const binding = resolveDaemonBinding(deps.getManifest, config.ingredient_slug, config.op);
    return {
      ingredient_slug: config.ingredient_slug,
      op: config.op,
      mode: config.restart_policy === 'never' ? 'manual' : 'auto',
      enabled: config.enabled,
      restart_policy: config.restart_policy,
      restart_on_server_start: config.restart_on_server_start,
      state: st?.state ?? (config.enabled ? 'unknown' : 'stopped'),
      readiness: st?.readiness ?? 'legacy',
      readiness_detail: st?.readiness_detail ?? null,
      ready_at: st?.ready_at ?? null,
      health: st?.health ?? 'unknown',
      health_detail: st?.health_detail ?? null,
      last_health_at: st?.last_health_at ?? null,
      pid: st?.pid ?? null,
      started_at: st?.started_at ?? null,
      consecutive_crashes: st?.consecutive_crashes ?? 0,
      last_crash_at: st?.last_crash_at ?? null,
      last_exit_code: st?.last_exit_code ?? null,
      required_args: binding ? requiredArgvRefs(binding) : [],
    };
  };

  /** A discovered-but-not-enrolled op's wire row — `mode:'off'`, carrying the
   *  op's DECLARED default policy (so the UI can preview `auto`) + required args. */
  const discoveredRow = (d: DiscoveredDaemon): SupervisionDaemonRow => {
    const supervision = d.binding.detached!.supervision!;
    return {
      ingredient_slug: d.ingredient_slug,
      op: d.op,
      mode: 'off',
      enabled: false,
      restart_policy: supervision.restart_policy,
      restart_on_server_start: supervision.restart_on_server_start ?? false,
      state: 'unknown',
      readiness: 'legacy',
      readiness_detail: null,
      ready_at: null,
      health: 'unknown',
      health_detail: null,
      last_health_at: null,
      pid: null,
      started_at: null,
      consecutive_crashes: 0,
      last_crash_at: null,
      last_exit_code: null,
      required_args: requiredArgvRefs(d.binding),
    };
  };

  const daemonKey = (ingredient_slug: string, op: string): string => [ingredient_slug, op].join(String.fromCharCode(0x1f));

  return {
    methods: ['supervision.set', 'supervision.list', 'supervision.status'],
    handlers: {
      'supervision.list': async (_args, client): Promise<SupervisionListResponse> => {
        requireRegisteredClient(client);
        const enrolled = new Map(deps.store.list().map((c) => [daemonKey(c.ingredient_slug, c.op), c] as const));
        const rows: SupervisionDaemonRow[] = [];
        const seen = new Set<string>();
        // The discovered universe (every supervisable op), enrolled-merged.
        for (const d of discoverDaemonOps(deps.getManifests)) {
          const k = daemonKey(d.ingredient_slug, d.op);
          seen.add(k);
          const config = enrolled.get(k);
          rows.push(config ? enrolledRow(config) : discoveredRow(d));
        }
        // Enrolled ops whose ingredient is no longer installed (binding gone) —
        // still surfaced so the owner can un-enrol / see the orphaned state.
        for (const config of deps.store.list()) {
          if (!seen.has(daemonKey(config.ingredient_slug, config.op))) rows.push(enrolledRow(config));
        }
        return { daemons: rows };
      },

      'supervision.status': async (
        args: SupervisionStatusRequest,
        client,
      ): Promise<SupervisionDaemonRow | null> => {
        requireRegisteredClient(client);
        const method = 'supervision.status';
        const ingredient_slug = ensureSafeSegment(method, 'ingredient_slug', args?.ingredient_slug);
        const op = ensureSafeSegment(method, 'op', args?.op);
        const config = deps.store.get(ingredient_slug, op);
        if (config) return enrolledRow(config);
        // Not enrolled — return its discovered `off` row when it IS a daemon op.
        const binding = resolveDaemonBinding(deps.getManifest, ingredient_slug, op);
        return binding ? discoveredRow({ ingredient_slug, op, binding }) : null;
      },

      'supervision.set': async (
        args: SupervisionSetRequest,
        client,
      ): Promise<SupervisionDaemonRow | null> => {
        requireRegisteredClient(client);
        const method = 'supervision.set';
        const a: Record<string, unknown> = isRecord(args) ? args : {};
        const ingredient_slug = ensureSafeSegment(method, 'ingredient_slug', args?.ingredient_slug);
        const op = ensureSafeSegment(method, 'op', args?.op);
        const mode = args?.mode;
        if (mode !== 'off' && mode !== 'manual' && mode !== 'auto') {
          throw new RpcError('bad_request', `${method}: mode must be 'off' | 'manual' | 'auto'`);
        }

        // `off` — un-enrol: stop the daemon and drop the durable row. Returns null.
        if (mode === 'off') {
          const priorMode = modeOf(deps.store.get(ingredient_slug, op));
          await deps.supervisor.stop(ingredient_slug, op);
          deps.store.delete(ingredient_slug, op);
          // Audit only a real un-enrol (prior was enrolled). Dropping an already-
          // absent row is a no-op — like revoking an absent reachability grant.
          if (priorMode !== 'off') {
            await auditEnrollment(deps.auditLog, 'supervised_daemon_unenrolled', ingredient_slug, op, {
              mode: 'off',
              prior_mode: priorMode,
            });
          }
          return null;
        }

        // `manual` / `auto` — resolve the op's binding + its declared supervision.
        const binding = resolveDaemonBinding(deps.getManifest, ingredient_slug, op);
        if (!binding) {
          throw new RpcError(
            'bad_request',
            `${method}: '${ingredient_slug}/${op}' is not a supervised daemon op `
              + `(no detached.supervision binding)`,
          );
        }
        const declared = binding.detached!.supervision!;

        const existing = deps.store.get(ingredient_slug, op);
        const priorMode = modeOf(existing);
        const enabled = typeof a.enabled === 'boolean' ? a.enabled : true;
        const argsRecord = isRecord(a.args) ? a.args : existing?.args ?? {};

        // Reject a missing required argv arg (e.g. cloudflared `tunnel_name`) at
        // the rpc edge — otherwise the launch throws at template resolution and
        // the supervisor mistakes it for a crash, backing off to
        // `permanently_crashed`. Only enforced when the daemon will actually run.
        if (enabled) {
          const missing = missingArgvRefs(binding, argsRecord);
          if (missing.length > 0) {
            throw new RpcError(
              'bad_request',
              `${method}: missing required arg(s) for '${op}': ${missing.join(', ')}`,
            );
          }
        }

        // manual → no-auto-restart, no-boot-persist; auto → the pack's declared policy.
        const restart_policy: ServiceRestartPolicy = mode === 'manual' ? 'never' : declared.restart_policy;
        const restart_on_server_start = mode === 'manual' ? false : (declared.restart_on_server_start ?? false);

        const config: SupervisedDaemonConfig = {
          ingredient_slug,
          op,
          restart_policy,
          restart_on_server_start,
          enabled,
          args: argsRecord,
        };
        deps.store.upsert(config);

        // Apply the run-intent. A re-toggle of args/mode while running is a
        // stop-then-start so the new config takes effect immediately.
        if (enabled) {
          if (deps.supervisor.isTracked(ingredient_slug, op)) await deps.supervisor.stop(ingredient_slug, op);
          await deps.supervisor.start(config);
        } else {
          await deps.supervisor.stop(ingredient_slug, op);
        }

        // Audit the enrollment/mode TRANSITION (off -> manual|auto, or manual <->
        // auto). A re-set with the SAME mode is a start/stop or args re-toggle —
        // the start/stop surfaces as the autonomous lifecycle row, not enrollment.
        if (priorMode !== mode) {
          await auditEnrollment(deps.auditLog, 'supervised_daemon_enrolled', ingredient_slug, op, {
            mode,
            prior_mode: priorMode,
            enabled,
            restart_policy,
            restart_on_server_start,
          });
        }

        return enrolledRow(config);
      },
    },
  };
};
