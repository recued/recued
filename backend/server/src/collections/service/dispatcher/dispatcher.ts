/** D-118 Phase 6 — service dispatcher.
 *
 *  Six handlers that back the `service-*` kernel ingredients.
 *  Every handler:
 *    1. Resolves the instance bundle via the seam.
 *    2. Enforces caps — OP_NOT_SUPPORTED for disallowed actions.
 *    3. Does the work (supervisor / state store / spawn / audit).
 *    4. Emits an `invoked` audit event for invoke calls.
 *    5. Returns the kernel-layer output shape.
 *
 *  Typed rpc errors are thrown as `ServiceDispatcherError`; Phase 8
 *  composition maps them to the `RpcError { code }` envelope.
 */
import {
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  type ServiceAuditEvent,
  type ServiceEventName,
} from '@recued/contracts';

import { deriveServiceState } from '../service-state-table.js';
import type { ServiceInstanceSpec } from '../supervisor/types.js';
import { resolveArgv } from '../supervisor/refs.js';
import {
  InvokeInputInvalidError,
  resolveInvokeArgv,
  resolveInvokeEnv,
  validateInvokeInputs,
} from './invoke-refs.js';
import {
  isPrototypeSensitiveKey,
  setSafeKey,
} from '../key-safety.js';
import type {
  ConfigFieldSchema,
  DispatcherServiceStatus,
  InvokeOpSpec,
  ServiceBundleResolver,
  ServiceDispatcher,
  ServiceDispatcherDeps,
  ServiceInstanceBundle,
} from './types.js';

/** Typed error surface the dispatcher throws for handler-level
 *  failures. `code` maps directly to the `SERVICE_*` error codes in
 *  `@recued/contracts/errors.ts`. */
export class ServiceDispatcherError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ServiceDispatcherError';
    this.code = code;
    this.detail = detail;
  }
}

const MAX_LOGS_LIMIT = 1_000;
const DEFAULT_LOGS_LIMIT = 100;
const LOGS_DEFAULT_SINCE_WINDOW_MS = 24 * 60 * 60 * 1000;

const requireBundle = async (
  resolver: ServiceBundleResolver,
  slug: string,
): Promise<ServiceInstanceBundle> => {
  const bundle = await resolver.get(slug);
  if (!bundle) {
    throw new ServiceDispatcherError(
      'SERVICE_NOT_FOUND',
      `service instance '${slug}' not enrolled`,
    );
  }
  return bundle;
};

const bundleToSupervisorSpec = (bundle: ServiceInstanceBundle): ServiceInstanceSpec => ({
  slug: bundle.slug,
  template_slug: bundle.template_slug,
  publisher_id: bundle.publisher_id,
  config: bundle.config,
  start: bundle.start,
  stop: bundle.stop,
  health_check: bundle.health_check,
  startup_check: bundle.startup_check,
  startup_grace_ms: bundle.startup_grace_ms,
  health_check_interval_ms: Math.max(
    bundle.health_check_interval_ms,
    SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  ),
});

/** Resolve one `exposes` entry to a string. Pure `template` refs
 *  interpolate `{{config.*}}`; `source` refs are Phase 6 stubs
 *  (last-health-response parsing is a later-spec concern) that
 *  render as empty strings. */
const resolveExpose = (
  entry: { template?: string; source?: string },
  config: Record<string, unknown>,
): string => {
  if (entry.template !== undefined) {
    // resolveArgv handles `{{config.*}}` interpolation via the same
    // substitution rules the argv resolver uses.
    return resolveArgv([entry.template], config)[0];
  }
  return '';
};

const stripVaultConfig = (
  config: Record<string, unknown>,
  schema: Record<string, ConfigFieldSchema>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isPrototypeSensitiveKey(key)) continue;
    const entry = schema[key];
    if (entry?.type === 'vault_ref') continue;
    if (entry?.public === false) continue;
    setSafeKey(out, key, value);
  }
  return out;
};

export const createServiceDispatcher = (
  deps: ServiceDispatcherDeps,
): ServiceDispatcher => {
  // D-179 P5 — in-flight invoke accounting for the concurrency bounds.
  // In-process counters only (the dispatcher is the single invoke
  // path); decremented in the spawn's finally so a timeout / throw
  // never leaks a slot.
  let inflightGlobal = 0;
  const inflightBySlug = new Map<string, number>();

  const start: ServiceDispatcher['start'] = async (input) => {
    const bundle = await requireBundle(deps.bundleResolver, input.slug);
    if (bundle.caps.start !== 'yes' || bundle.start === null) {
      throw new ServiceDispatcherError(
        'SERVICE_OP_NOT_SUPPORTED',
        `service-start not supported for '${input.slug}' (tool-shaped template)`,
      );
    }
    const row = deps.stateStore.get(input.slug);
    if (
      row &&
      row.last_crash_at !== null &&
      row.consecutive_crashes >= SERVICE_CONSECUTIVE_CRASHES_MAX
    ) {
      throw new ServiceDispatcherError(
        'SERVICE_PERMANENTLY_CRASHED',
        `service '${input.slug}' is permanently crashed — click [Clear & retry] to reset`,
      );
    }
    const spec = bundleToSupervisorSpec(bundle);
    const outcome = await deps.supervisor.start(spec);
    if (outcome.state !== 'running') {
      return {
        state: outcome.state,
        pid: outcome.pid,
        started_at: outcome.started_at,
      };
    }
    if (!input.wait_until_healthy || !bundle.health_check) {
      return {
        state: 'running',
        pid: outcome.pid,
        started_at: outcome.started_at,
      };
    }
    // Poll the health_check until pass or timeout. Each tick has
    // the same shape as the Phase 5 health loop but we drive it
    // inline so the rpc caller sees a blocking wait.
    const deadline = deps.now() + input.wait_until_healthy.timeout_ms;
    const pollIntervalMs = 500;
    while (deps.now() < deadline) {
      const healthRes = await deps.runCheck(bundle.health_check, bundle.config);
      if (healthRes.passed) {
        deps.stateStore.upsert(input.slug, {
          last_health_at: deps.now(),
          last_health_state: 'healthy',
        });
        return {
          state: 'running',
          pid: outcome.pid,
          started_at: outcome.started_at,
        };
      }
      await new Promise<void>((resolve) => {
        deps.setTimeout(() => { resolve(); }, pollIntervalMs);
      });
    }
    return {
      state: 'unhealthy',
      pid: outcome.pid,
      started_at: outcome.started_at,
    };
  };

  const stop: ServiceDispatcher['stop'] = async (input) => {
    const bundle = await requireBundle(deps.bundleResolver, input.slug);
    if (bundle.caps.stop !== 'yes') {
      throw new ServiceDispatcherError(
        'SERVICE_OP_NOT_SUPPORTED',
        `service-stop not supported for '${input.slug}' (tool-shaped template)`,
      );
    }
    const outcome = await deps.supervisor.stop(input.slug);
    return { state: outcome.state };
  };

  const status: ServiceDispatcher['status'] = async (input) => {
    const bundle = await requireBundle(deps.bundleResolver, input.slug);
    const row = deps.stateStore.get(input.slug);
    const state = row ? deriveServiceState(row) : 'unknown';
    const health = row?.last_health_state ?? 'unknown';
    const pid = row?.pid ?? null;
    const started_at = row?.started_at ?? null;
    const uptime_s = started_at !== null
      ? Math.max(0, Math.floor((deps.now() - started_at) / 1000))
      : null;
    const exposes: Record<string, string> = {};
    for (const [key, entry] of Object.entries(bundle.exposes)) {
      setSafeKey(exposes, key, resolveExpose(entry, bundle.config));
    }
    const snapshot: DispatcherServiceStatus = {
      state,
      health,
      pid,
      started_at,
      uptime_s,
      last_crash_at: row?.last_crash_at ?? null,
      consecutive_crashes: row?.consecutive_crashes ?? 0,
      config: stripVaultConfig(bundle.config, bundle.config_schema),
      exposes,
    };
    return snapshot;
  };

  const invoke: ServiceDispatcher['invoke'] = async (input) => {
    const bundle = await requireBundle(deps.bundleResolver, input.slug);
    if (!bundle.caps.invoke.includes(input.op)) {
      throw new ServiceDispatcherError(
        'SERVICE_OP_NOT_SUPPORTED',
        `invoke op '${input.op}' not in caps.invoke for '${input.slug}'`,
      );
    }
    const op: InvokeOpSpec | undefined = bundle.invoke[input.op];
    if (!op) {
      throw new ServiceDispatcherError(
        'SERVICE_OP_NOT_SUPPORTED',
        `invoke op '${input.op}' not declared in template`,
      );
    }

    // Quota + OS-free-space pre-gate.
    const quotaOutcome = deps.quotaTracker.checkInvokeQuota({
      slug: input.slug,
      config: deps.resolveQuotaConfig(input.slug),
    });
    if (quotaOutcome.ok === false) {
      throw new ServiceDispatcherError(
        'SERVICE_STORAGE_PRESSURE',
        `storage gate (${quotaOutcome.tripped}): ${quotaOutcome.detail}`,
      );
    }

    // Validate + coerce inputs.
    let validated;
    try {
      validated = validateInvokeInputs(op, input.inputs);
    } catch (err) {
      if (err instanceof InvokeInputInvalidError) {
        throw new ServiceDispatcherError('SERVICE_INPUT_INVALID', err.message);
      }
      throw err;
    }

    const argv = resolveInvokeArgv(op.argv, validated, bundle.config);
    const env = resolveInvokeEnv(
      op.env,
      validated,
      bundle.config,
      bundle.publisher_id,
      deps.resolveVault,
    );

    // D-179 P5 — invoke guards (§ 5: knobs, not designs). Concurrency
    // is reject-not-queue (re-run over resume); the timeout ceiling
    // clamps the authored deadline — hours-long work belongs in
    // user-space detached jobs, never a long blocking invoke.
    const limits = deps.resolveInvokeLimits?.();
    if (limits) {
      const perInstance = inflightBySlug.get(input.slug) ?? 0;
      if (inflightGlobal >= limits.max_concurrent_invokes) {
        throw new ServiceDispatcherError(
          'SERVICE_INVOKE_CONCURRENCY',
          `global invoke bound reached (${limits.max_concurrent_invokes} running)`,
        );
      }
      if (perInstance >= limits.max_concurrent_invokes_per_instance) {
        throw new ServiceDispatcherError(
          'SERVICE_INVOKE_CONCURRENCY',
          `instance '${input.slug}' invoke bound reached (${limits.max_concurrent_invokes_per_instance} running)`,
        );
      }
    }
    const timeout_ms = limits
      ? Math.min(op.timeout_ms, limits.invoke_timeout_ceiling_ms)
      : op.timeout_ms;

    let result;
    try {
      // Increments inside the try so the finally unwinds them on ANY
      // throw path (codex fold) — a slot can never leak.
      inflightGlobal += 1;
      inflightBySlug.set(input.slug, (inflightBySlug.get(input.slug) ?? 0) + 1);
      result = await deps.spawnInvoke(argv, {
        cwd: op.cwd,
        env,
        timeout_ms,
      });
    } finally {
      inflightGlobal -= 1;
      const remaining = (inflightBySlug.get(input.slug) ?? 1) - 1;
      if (remaining <= 0) inflightBySlug.delete(input.slug);
      else inflightBySlug.set(input.slug, remaining);
    }

    const okSet = op.exit_codes_ok ?? [0];
    const success = okSet.includes(result.exit_code);

    const evt: ServiceAuditEvent = {
      type: 'service_event',
      slug: input.slug,
      binary: argv[0] ?? null,
      event_name: 'invoked',
      argv,
      error: success ? null : `exit ${result.exit_code}`,
      timestamp: deps.now(),
    };
    deps.emitEvent(evt);

    return {
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      log_lines: result.log_lines,
      stdout_truncated: result.stdout_truncated,
    };
  };

  const logs: ServiceDispatcher['logs'] = async (input) => {
    // Presence is enough — we don't fault on slug-exists checks for
    // historical logs (an uninstall shouldn't blank the audit
    // trail). But we still validate the slug syntactically via the
    // resolver list + fail loud when fully unknown to catch typos.
    const bundle = await deps.bundleResolver.get(input.slug);
    if (!bundle) {
      throw new ServiceDispatcherError(
        'SERVICE_NOT_FOUND',
        `service instance '${input.slug}' not enrolled`,
      );
    }
    const limit = Math.min(
      Math.max(1, input.limit ?? DEFAULT_LOGS_LIMIT),
      MAX_LOGS_LIMIT,
    );
    const since = input.since ?? (deps.now() - LOGS_DEFAULT_SINCE_WINDOW_MS);
    const events = await deps.logReader.listEvents({
      slug: input.slug,
      since,
      event_names: input.event_names as ServiceEventName[] | undefined,
      limit,
    });
    return { events };
  };

  const list: ServiceDispatcher['list'] = async () => {
    const bundles = await deps.bundleResolver.list();
    const instances = bundles.map((bundle) => {
      const row = deps.stateStore.get(bundle.slug);
      return {
        slug: bundle.slug,
        template: bundle.template_slug,
        state: row ? deriveServiceState(row) : 'unknown',
        health: row?.last_health_state ?? 'unknown',
      };
    });
    return { instances };
  };

  return { start, stop, status, invoke, logs, list };
};
