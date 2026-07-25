/** D-118 Phase 8 — service-stack composition.
 *
 *  Parallel to `composeFileStack` / `composeCalendarStack`: wires the
 *  six service subsystems (state store, quota tracker, installer
 *  registry, checker registry, supervisor, dispatcher) + the Phase 7
 *  enroll handlers into a single `ServiceStack` object that bin.ts
 *  threads through executor config + collectionDeps + heartbeat
 *  enrichment.
 *
 *  Ownership:
 *    - Supervisor + health-loop registry live inside the stack.
 *      `onEnrolled` fires up the supervisor for any instance whose
 *      template declares `restart_on_server_start: true`; `onDeleting`
 *      stops it cleanly. `onUpdated` restarts the process when the
 *      patched config would affect a running spec.
 *    - Audit emitter adapts `ServiceAuditEvent` → `ActivityEntry`
 *      for collection UI/RPC lifecycle history. Recipe-facing
 *      `service-*` kernel ingredients are retired; recipes use cli
 *      pack ops for one-shot and user-space detached work.
 *
 *  Boundaries: the stack doesn't start the supervisor itself — bin.ts
 *  calls `startAll()` once the lifecycle manager is ready (so the
 *  reconcile pass runs inside the server_boot activity window, same
 *  as file/calendar).
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type {
  IngredientManifest,
  ServiceAuditEvent,
  ServiceCollectionHealth,
  ServiceEventName,
} from '@recued/contracts';
import type { AuditLogStore, ActivityEntry } from '@recued/storage';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../instance-store.js';
import {
  createServiceStateStore,
  deriveServiceState,
  type ServiceInstanceStateStore,
} from './service-state-table.js';
import {
  createServiceQuotaTracker,
  type ServiceQuotaConfig,
  type ServiceQuotaTracker,
} from './quota-tracker.js';
import { createSupervisor, type Supervisor } from './supervisor/supervisor.js';
import {
  createHealthLoopRegistry,
  type HealthLoopRegistry,
} from './supervisor/health-loop.js';
import { defaultSpawnProcess } from './supervisor/process.js';
import {
  runCheck as defaultRunCheck,
  type CheckerContext,
} from './checkers/dispatcher.js';
import { createServiceDispatcher } from './dispatcher/dispatcher.js';
import type { ServiceDispatcher } from './dispatcher/types.js';
import { defaultSpawnInvoke } from './dispatcher/spawn-invoke.js';
import type {
  InvokeOpSpec,
  ServiceBundleResolver,
  ServiceInstanceBundle,
  ServiceLogReader,
} from './dispatcher/types.js';
import {
  handleServiceClearCrash,
  handleServiceDelete,
  handleServiceEnroll,
  handleServiceInstall,
  handleServiceList,
  handleServiceUninstall,
  handleServiceUpdate,
  handleServiceUpgrade,
  type ServiceEnrollDeps,
  type ServiceTemplate,
  type ServiceTemplateResolver,
} from './enroll.js';
import { buildServiceTemplateResolver } from './template-loader.js';
import type { ServiceInstanceSpec, VaultResolveFn } from './supervisor/types.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type ServiceStackLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: unknown,
) => void;

export interface ServiceStackRuntimeConfig {
  /** Per-instance quota default (bytes). Default
   *  `runtime.collection.service.default.quota_bytes`. */
  defaultQuotaBytes: number;
  /** OS free-space floor. Default
   *  `runtime.collection.service.min_disk_free_bytes`. */
  minDiskFreeBytes: number;
  /** Per-invoke slack. Default
   *  `runtime.collection.service.invoke_slack_bytes`. */
  invokeSlackBytes: number;
  /** du sampler interval (seconds). Default
   *  `runtime.collection.service.du_sample_interval_s`. */
  duSampleIntervalS: number;
  /** D-179 P5 — invoke timeout ceiling (ms). Default
   *  `runtime.collection.service.invoke_timeout_ceiling_ms`. */
  invokeTimeoutCeilingMs: number;
  /** D-179 P5 — global max concurrent invokes. Default
   *  `runtime.collection.service.max_concurrent_invokes`. */
  maxConcurrentInvokes: number;
  /** D-179 P5 — per-instance max concurrent invokes. Default
   *  `runtime.collection.service.max_concurrent_invokes_per_instance`. */
  maxConcurrentInvokesPerInstance: number;
}

export interface ComposeServiceStackOptions {
  /** data_path — quota tracker + supervisor CWDs resolve under
   *  `<data_path>/services/<slug>/`. */
  dataPath: string;
  /** Live manifest registry. Service templates parsed at compose
   *  time; re-composition is needed to pick up new templates
   *  (bin.ts runs composition once at boot). */
  manifests: { slugs(): string[]; get(slug: string): IngredientManifest | null };
  /** Runtime config snapshot (captured at compose time; bin.ts may
   *  re-read on `onChange` and re-compose in the future). */
  runtime: ServiceStackRuntimeConfig;
  /** Vault resolver used to inject `{{vault.*}}` into lifecycle env.
   *  Publisher-scoped per D-003. Optional in tests — missing values
   *  surface via the binary's own "credential missing" error. */
  resolveVault?: VaultResolveFn;
  /** Audit log store — the emitter adapter writes one ActivityEntry
   *  per ServiceAuditEvent; the logReader reads back filtered by
   *  `target = slug`. Optional in tests that don't want a DB-backed
   *  audit trail — the emitter falls back to a console log. */
  auditLog?: AuditLogStore;
  log?: ServiceStackLogger;
}

export interface ServiceStack {
  instances: CollectionInstanceStore;
  state: ServiceInstanceStateStore;
  quota: ServiceQuotaTracker;
  supervisor: Supervisor;
  dispatcher: ServiceDispatcher;
  templates: ServiceTemplateResolver;
  enrollDeps: ServiceEnrollDeps;
  /** Snapshot every enrolled instance as a `ServiceCollectionHealth`
   *  row for the heartbeat envelope. Pure read — no DB mutation. */
  healthSnapshot(): ServiceCollectionHealth[];
  /** Boot reconcile pass — start every instance whose template
   *  declares `restart_on_server_start: true` under the supervisor.
   *  Idempotent: safe to call multiple times, although bin.ts only
   *  calls it once. */
  startAll(): Promise<void>;
  /** Drain helper — stops every running process + pending restart
   *  timer + health loop. Called from the lifecycle drain's
   *  `pause_collections` step. */
  disposeAll(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// Composition
// ────────────────────────────────────────────────────────────────

export const composeServiceStack = (
  db: Database.Database,
  opts: ComposeServiceStackOptions,
): ServiceStack => {
  const log: ServiceStackLogger = opts.log ?? (() => {});
  const now = (): number => Date.now();

  const instances = createInstanceStore({ db });
  const state = createServiceStateStore({ db });
  const quota = createServiceQuotaTracker({
    dataPath: opts.dataPath,
    store: state,
  });
  const templates = buildServiceTemplateResolver(opts.manifests);

  // Audit adapter — one ActivityEntry per ServiceAuditEvent.
  const emitAudit = (evt: ServiceAuditEvent): void => {
    if (!opts.auditLog) {
      log('info', `service_event ${evt.event_name} ${evt.slug}`, evt);
      return;
    }
    const entry: ActivityEntry = {
      activity_id: `service_${evt.slug}_${evt.timestamp}_${randomUUID().slice(0, 8)}`,
      timestamp: evt.timestamp,
      action: 'service_event',
      target: evt.slug,
      detail: JSON.stringify({
        binary: evt.binary,
        event_name: evt.event_name,
        argv: evt.argv,
        error: evt.error,
      }),
    };
    // Fire-and-forget — audit writes never block supervisor /
    // dispatcher hot paths.
    void opts.auditLog.logActivity(entry).catch((err) => {
      log('warn', 'service audit write failed', {
        slug: evt.slug,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Checker context — Phase 4 dispatcher defaults are real-Node
  // implementations (fs, spawn, fetch, tcp connect). Tests that stub
  // the stack don't construct this adapter; they pass their own
  // runCheck via test-specific deps.
  const checkerCtx: CheckerContext = {};
  const runCheck = async (
    spec: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<{ passed: boolean; detail?: string }> =>
    defaultRunCheck(spec, checkerCtx, config);

  // Supervisor — subprocess + timer seams default to real Node APIs.
  const supervisor = createSupervisor({
    stateStore: state,
    spawn: defaultSpawnProcess,
    emitEvent: emitAudit,
    runCheck,
    ...(opts.resolveVault ? { resolveVault: opts.resolveVault } : {}),
    checkerCtx,
    now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  });

  const healthLoops: HealthLoopRegistry = createHealthLoopRegistry({
    stateStore: state,
    runCheck,
    emitEvent: emitAudit,
    now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  });

  // Bundle resolver — fuses the DB instance row with the parsed
  // template. The dispatcher reads bundles per-call so config edits
  // via `collection.service.update` are picked up without a
  // re-compose.
  const bundleFor = (slug: string): ServiceInstanceBundle | null => {
    const row = instances.get('service', slug);
    if (!row) return null;
    const template = templates.get(row.adapter_type);
    if (!template) return null;
    return {
      slug,
      template_slug: template.template_slug,
      publisher_id: template.publisher_id,
      config: row.config,
      config_schema: template.config_schema,
      caps: template.caps,
      health_check: template.health_check,
      startup_check: template.startup_check,
      start: template.start,
      stop: template.stop,
      invoke: template.invoke,
      exposes: template.exposes,
      startup_grace_ms: template.startup_grace_ms,
      health_check_interval_ms: template.health_check_interval_ms,
    };
  };

  const bundleResolver: ServiceBundleResolver = {
    get: async (slug) => bundleFor(slug),
    list: async () => {
      const rows = instances.list('service');
      const out: ServiceInstanceBundle[] = [];
      for (const row of rows) {
        const bundle = bundleFor(row.slug);
        if (bundle) out.push(bundle);
      }
      return out;
    },
  };

  // Log reader — filter AuditLogStore activities to service_event
  // rows for the requested slug. Phase 8 implementation fetches up
  // to a generous cap and filters in memory; the service-logs
  // ingredient is user-driven so hot-path performance isn't a
  // concern.
  const logReader: ServiceLogReader = {
    listEvents: async (input) => {
      if (!opts.auditLog) return [];
      const { slug, since, event_names, limit } = input;
      const fetch = Math.min(Math.max(limit * 10, 500), 5000);
      let activities: ActivityEntry[];
      try {
        activities = await opts.auditLog.listActivities(fetch);
      } catch (err) {
        log('warn', 'service audit read failed', {
          slug,
          err: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      const events: ServiceAuditEvent[] = [];
      for (const entry of activities) {
        if (entry.action !== 'service_event') continue;
        if (entry.target !== slug) continue;
        if (since !== undefined && entry.timestamp < since) continue;
        let detail: Record<string, unknown>;
        try {
          detail = entry.detail ? JSON.parse(entry.detail) : {};
        } catch {
          continue;
        }
        const eventName = detail.event_name as ServiceEventName | undefined;
        if (!eventName) continue;
        if (event_names && !event_names.includes(eventName)) continue;
        events.push({
          type: 'service_event',
          slug,
          binary: (detail.binary as string | null) ?? null,
          event_name: eventName,
          argv: (detail.argv as string[] | null) ?? null,
          error: (detail.error as string | null) ?? null,
          timestamp: entry.timestamp,
        });
        if (events.length >= limit) break;
      }
      return events;
    },
  };

  const resolveQuotaConfig = (slug: string): ServiceQuotaConfig => {
    const row = instances.get('service', slug);
    const override =
      row && typeof row.config.quota_bytes === 'number'
        ? (row.config.quota_bytes as number)
        : undefined;
    return {
      quota_bytes: override ?? opts.runtime.defaultQuotaBytes,
      invoke_slack_bytes: opts.runtime.invokeSlackBytes,
      min_disk_free_bytes: opts.runtime.minDiskFreeBytes,
    };
  };

  const dispatcher = createServiceDispatcher({
    supervisor,
    stateStore: state,
    bundleResolver,
    quotaTracker: quota,
    spawnInvoke: defaultSpawnInvoke,
    runCheck,
    logReader,
    emitEvent: emitAudit,
    ...(opts.resolveVault ? { resolveVault: opts.resolveVault } : {}),
    resolveQuotaConfig,
    // D-179 P5 — invoke guard knobs, snapshotted from the runtime
    // config the caller composed (Settings changes re-compose).
    resolveInvokeLimits: () => ({
      invoke_timeout_ceiling_ms: opts.runtime.invokeTimeoutCeilingMs,
      max_concurrent_invokes: opts.runtime.maxConcurrentInvokes,
      max_concurrent_invokes_per_instance: opts.runtime.maxConcurrentInvokesPerInstance,
    }),
    now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  });

  // Lifecycle hooks — enroll runs the health loop when the instance
  // has a health check; delete stops both the process + the loop.
  // onUpdated restarts a running service so the new env / argv takes
  // effect.
  const specFor = (slug: string): ServiceInstanceSpec | null => {
    const bundle = bundleFor(slug);
    if (!bundle) return null;
    return {
      slug: bundle.slug,
      template_slug: bundle.template_slug,
      publisher_id: bundle.publisher_id,
      config: bundle.config,
      start: bundle.start,
      stop: bundle.stop,
      health_check: bundle.health_check,
      startup_check: bundle.startup_check,
      startup_grace_ms: bundle.startup_grace_ms,
      health_check_interval_ms: bundle.health_check_interval_ms,
    };
  };

  const installerCtx = {
    dataPath: opts.dataPath,
    slug: '',
  };

  const enrollDeps: ServiceEnrollDeps = {
    instances,
    state,
    templates,
    supervisor,
    runCheck,
    installerCtx,
    emitAudit,
    now,
    onEnrolled: async (slug) => {
      const spec = specFor(slug);
      if (!spec) return;
      if (spec.health_check) healthLoops.add(spec);
      if (spec.start?.restart_on_server_start) {
        try { await supervisor.start(spec); }
        catch (err) {
          log('warn', `service supervisor.start failed for '${slug}'`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    onUpdated: async (slug) => {
      const spec = specFor(slug);
      if (!spec) return;
      // If the service is currently running, cycle it so the new
      // config takes effect. Non-running services pick up the new
      // config on their next manual start.
      if (supervisor.isTracked(slug)) {
        try {
          await supervisor.stop(slug);
          if (spec.start) await supervisor.start(spec);
        } catch (err) {
          log('warn', `service restart after update failed for '${slug}'`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Re-register the health loop in case the interval or check
      // spec changed.
      if (spec.health_check) {
        healthLoops.remove(slug);
        healthLoops.add(spec);
      }
    },
    onDeleting: async (slug) => {
      healthLoops.remove(slug);
      if (supervisor.isTracked(slug)) {
        try { await supervisor.stop(slug); }
        catch (err) {
          log('warn', `service supervisor.stop failed for '${slug}'`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };

  // Quota sampler — starts immediately. Stop on disposeAll.
  const samplerStop = quota.startSampler({
    intervalMs: Math.max(opts.runtime.duSampleIntervalS, 5) * 1000,
    enrolledSlugs: () => instances.list('service').map((r) => r.slug),
  });

  const healthSnapshot = (): ServiceCollectionHealth[] => {
    const out: ServiceCollectionHealth[] = [];
    const nowMs = now();
    const rows = instances.list('service');
    for (const row of rows) {
      const stateRow = state.get(row.slug);
      const service_state = stateRow ? deriveServiceState(stateRow) : 'unknown';
      const pid = stateRow?.pid ?? null;
      const started_at = stateRow?.started_at ?? null;
      const uptime_s =
        started_at !== null ? Math.max(0, Math.floor((nowMs - started_at) / 1000)) : null;
      // Map service_state → collection state for dashboard rendering.
      const collectionState: ServiceCollectionHealth['state'] =
        service_state === 'running' ? 'connected'
        : service_state === 'stopped' ? 'idle'
        : service_state === 'crashed' || service_state === 'permanently_crashed' ? 'error'
        : 'disconnected';
      out.push({
        platform: 'service',
        slug: row.slug,
        last_indexed_at: stateRow?.last_health_at ?? 0,
        pending_queue_size: 0,
        error_count_24h: stateRow?.consecutive_crashes ?? 0,
        state: collectionState,
        auth_state: row.auth_state,
        service_state,
        pid,
        uptime_s,
        last_crash_at: stateRow?.last_crash_at ?? null,
        consecutive_crashes: stateRow?.consecutive_crashes ?? 0,
      });
    }
    return out;
  };

  const startAll = async (): Promise<void> => {
    // Clear any stale runtime state from a prior process lifetime.
    state.clearAll();
    const rows = instances.list('service');
    for (const row of rows) {
      const spec = specFor(row.slug);
      if (!spec) continue;
      if (spec.health_check) healthLoops.add(spec);
      if (spec.start?.restart_on_server_start) {
        try { await supervisor.start(spec); }
        catch (err) {
          log('warn', `service supervisor.start failed on reconcile for '${row.slug}'`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };

  const disposeAll = async (): Promise<void> => {
    try { samplerStop(); } catch { /* ignore */ }
    try { healthLoops.stopAll(); } catch { /* ignore */ }
    try { await supervisor.shutdown(); } catch (err) {
      log('warn', 'service supervisor.shutdown failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    instances,
    state,
    quota,
    supervisor,
    dispatcher,
    templates,
    enrollDeps,
    healthSnapshot,
    startAll,
    disposeAll,
  };
};
