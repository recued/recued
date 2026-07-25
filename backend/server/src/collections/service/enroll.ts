/** D-118 Phase 7 — `collection.service.*` enroll rpc handlers.
 *
 *  Eight handlers wire into `collection-handler.ts`, mirroring the
 *  calendar enrollment shape:
 *
 *    - list           → enumerate `data.service.*` instances joined
 *                       with their runtime state.
 *    - enroll         → validate config against the template's
 *                       `config_schema`, run `install_check`
 *                       synchronously, write the durable instance
 *                       row. Does NOT run install — that's a
 *                       separate button-driven rpc.
 *    - install        → button-driven; dispatch every entry in
 *                       `template.install[]` through the Phase 3
 *                       installer registry; re-probe `install_check`
 *                       on completion.
 *    - upgrade        → same as install against `template.upgrade[]`.
 *                       Failure preserves the prior binary (download
 *                       kind via `.bak`; PMs via their own rollback).
 *    - uninstall      → button-driven; default drops the row only,
 *                       `remove_binary: true` ALSO runs every entry
 *                       in `template.uninstall[]`. Always returns the
 *                       installer-output shape.
 *    - update         → patch config_patch onto the durable row.
 *                       Caps don't change — they derive from the
 *                       template's structural shape, not config.
 *                       Composition root may restart the supervisor
 *                       via `onUpdated`.
 *    - delete         → drop the instance row + cascade
 *                       `service_instance_state`. `uninstall_binary:
 *                       true` ALSO runs `template.uninstall[]` first.
 *    - clear_crash    → reset `consecutive_crashes`/`last_crash_at`,
 *                       flip auth_state to healthy, run the
 *                       supervisor's `clearCrash` (which respawns).
 *                       Returns the post-reset `ServiceStatus`.
 *
 *  Audit emission goes through the same `ServiceEventEmitter` seam
 *  the supervisor + dispatcher already use — composition root wires
 *  it to the AuditLogStore. Each handler emits the event names per
 *  the spec table:
 *
 *    enrolled       — successful enroll (binary ← install_check.binary
 *                     when kind=binary_in_path).
 *    installed      — successful install rpc.
 *    install_failed — non-zero installer exit during install.
 *    upgraded       — successful upgrade rpc.
 *    upgrade_failed — non-zero installer exit during upgrade.
 *    uninstalled    — successful uninstall rpc OR delete with
 *                     uninstall_binary: true.
 *
 *  `clear_crash` doesn't emit a dedicated audit — the supervisor's
 *  re-`start()` already emits a `started` event. Same for `update`
 *  (config-only change; composition root may emit a domain event
 *  through the supervisor when it restarts).
 *
 *  Handlers stay free of supervisor / state-table / audit-store
 *  wiring — those are pure deps. Phase 8 composition assembles the
 *  ServiceEnrollDeps once at boot.
 */

import { RpcError } from '@recued/contracts';
import type {
  ServiceAuditEvent,
  ServiceCheckResult,
  ServiceCollectionCaps,
  ServiceEnrollInput,
  ServiceEnrollOutput,
  ServiceHealthState,
  ServiceInstallKind,
  ServiceInstallOutput,
  ServiceInstanceList,
  ServiceInstanceListRow,
  ServiceRestartPolicy,
  ServiceState,
  ServiceStatus,
  ServiceTemplateConfigField,
  ServiceTemplateList,
  ServiceTemplateListInput,
  ServiceTemplateListRow,
  ServiceTemplateOS as ContractsServiceTemplateOS,
  ServiceUninstallOutput,
  ServiceUpgradeOutput,
} from '@recued/contracts';
import {
  SERVICE_INSTALL_KINDS,
} from '@recued/contracts';

import type { CollectionInstanceStore } from '../instance-store.js';
import { deriveServiceState, type ServiceInstanceStateStore } from './service-state-table.js';
import {
  type InstallerAction,
  type InstallerContext,
  type InstallerOutcome,
} from './installers/types.js';
import { runInstaller } from './installers/dispatcher.js';
import type {
  BundleStartSpec,
  BundleStopSpec,
  ConfigFieldSchema,
  ExposeSpec,
  InvokeOpSpec,
} from './dispatcher/types.js';
import type {
  RunCheckFn,
  ServiceEventEmitter,
  ServiceInstanceSpec,
} from './supervisor/types.js';
import type { Supervisor } from './supervisor/supervisor.js';
import { resolveArgv } from './supervisor/refs.js';
import {
  hasOwnSafe,
  isPrototypeSensitiveKey,
  setSafeKey,
} from './key-safety.js';

// ────────────────────────────────────────────────────────────────
// Template registry seam
// ────────────────────────────────────────────────────────────────

/** Server OS as the template manifest declares it. Re-exported from
 *  contracts so backend callers keep the single-import convenience;
 *  the canonical definition lives in `@recued/contracts`. */
export type ServiceTemplateOS = ContractsServiceTemplateOS;

/** One entry inside `template.install[] / upgrade[] / uninstall[]`.
 *  `kind` selects the installer module; the rest of the object are
 *  per-kind params validated by that module's `validate*Params`. */
export interface ServiceInstallStep {
  kind: ServiceInstallKind;
  /** Optional — informational metadata; the per-array action
   *  (install / upgrade / uninstall) is what reaches the dispatcher. */
  action?: InstallerAction;
  /** Per-kind params (`package`, `url`, `sha256`, `target`, …). */
  [param: string]: unknown;
}

/** Shape of one `kind: service` template manifest after the boot-
 *  time parser has flattened it. Phase 8 composition is responsible
 *  for parsing the raw IngredientManifest into this shape — Phase 7
 *  only needs to consume it.
 *
 *  `template_slug` carries the full pin (e.g. `ollama-macos@1`,
 *  using the integer manifest schema version), the same string the
 *  recipe author writes and that lands in
 *  `collection_instances.adapter_type` per spec line 372.
 *
 *  `binary_version` is informational metadata — the publisher's
 *  declaration of which underlying binary release the manifest was
 *  authored against (e.g. `"1.0.0"`). Surfaces in install/upgrade
 *  UI so users can see "this template targets ffmpeg 6.x." Never
 *  enforced by the runtime. */
export interface ServiceTemplate {
  template_slug: string;
  binary_version: string | null;
  publisher_id: string;
  platform: ServiceTemplateOS;
  variant_group: string;
  caps: ServiceCollectionCaps;
  install_check: Record<string, unknown>;
  install_hint: string | null;
  install: ServiceInstallStep[] | null;
  upgrade: ServiceInstallStep[] | null;
  uninstall: ServiceInstallStep[] | null;
  health_check: Record<string, unknown> | null;
  startup_check: Record<string, unknown>[] | null;
  startup_grace_ms: number;
  health_check_interval_ms: number;
  config_schema: Record<string, ConfigFieldSchema>;
  exposes: Record<string, ExposeSpec>;
  start: BundleStartSpec | null;
  stop: BundleStopSpec | null;
  invoke: Record<string, InvokeOpSpec>;
}

/** Slug → template lookup. Composition root populates from the
 *  marketplace template registry at boot; tests inject a stub. */
export interface ServiceTemplateResolver {
  get(template_slug: string): ServiceTemplate | null;
  /** Enumerate every cached template. Phase 10 follow-up — drives the
   *  `collection.service.listTemplates` rpc that feeds the enrollment
   *  picker. Tests inject a stub returning the subset under test. */
  list?(): ServiceTemplate[];
}

// ────────────────────────────────────────────────────────────────
// Deps
// ────────────────────────────────────────────────────────────────

export interface ServiceEnrollDeps {
  instances: CollectionInstanceStore;
  state: ServiceInstanceStateStore;
  templates: ServiceTemplateResolver;
  supervisor: Supervisor;
  /** Phase 4 `runCheck` — used to evaluate `install_check` at
   *  enroll + after every install/upgrade rpc. */
  runCheck: RunCheckFn;
  /** Per-call installer context. The handler clones it and overrides
   *  `slug` per call so the same composition wiring serves every
   *  instance. */
  installerCtx: InstallerContext;
  /** Audit emitter — same shape supervisor + dispatcher use. */
  emitAudit: ServiceEventEmitter;
  /** Detect server OS for the platform-mismatch guard. Defaults to
   *  `process.platform`-based mapping; tests override. */
  detectOS?: () => ServiceTemplateOS;
  /** Called after a successful enroll. Composition root spins up the
   *  supervisor for templates with `restart_on_server_start: true`. */
  onEnrolled?: (slug: string) => Promise<void> | void;
  /** Called before a delete drops the row. Composition root stops the
   *  supervisor cleanly so children don't outlive the row. */
  onDeleting?: (slug: string) => Promise<void> | void;
  /** Called after `update` writes the patched config. Composition
   *  root may restart the supervisor when the patched config touches
   *  fields the running process reads at start. */
  onUpdated?: (slug: string) => Promise<void> | void;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────

/** Slug grammar — matches the file/calendar enrollers. */
const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{0,63}$/;

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${field} must be a non-empty string`, 400);
  }
  return value;
};

const requireSlug = (value: unknown): string => {
  const slug = requireString(value, 'slug');
  if (!SLUG_RE.test(slug)) {
    throw new RpcError(
      'bad_request',
      `slug must match ${SLUG_RE.source} — lowercase letters, digits, - and _`,
      400,
    );
  }
  return slug;
};

const ensureConfigObject = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('bad_request', 'config must be an object', 400);
  }
  return value as Record<string, unknown>;
};

const ensurePatchObject = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('bad_request', `${field} must be an object`, 400);
  }
  return value as Record<string, unknown>;
};

/** Lightweight type-coercion against the template's `config_schema`.
 *  Rich validation (enum membership, nested shape) lives on the
 *  template-loader side — this layer just rejects obviously wrong
 *  types so `runCheck` interpolation doesn't blow up later. */
const validateConfig = (
  config: Record<string, unknown>,
  schema: Record<string, ConfigFieldSchema>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(schema)) {
    if (isPrototypeSensitiveKey(field)) continue;
    const value = hasOwnSafe(config, field) ? config[field] : undefined;
    if (value === undefined) {
      if (entry.optional !== true && entry.default === undefined) {
        throw new RpcError(
          'bad_request',
          `config.${field} is required (type: ${entry.type})`,
          400,
        );
      }
      if (entry.default !== undefined) setSafeKey(out, field, entry.default);
      continue;
    }
    switch (entry.type) {
      case 'string':
      case 'enum':
      case 'file_ref':
      case 'vault_ref':
        if (typeof value !== 'string') {
          throw new RpcError('bad_request', `config.${field} must be a string`, 400);
        }
        if (entry.type === 'enum' && entry.values && !entry.values.includes(value)) {
          throw new RpcError(
            'bad_request',
            `config.${field} must be one of: ${entry.values.join(', ')}`,
            400,
          );
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new RpcError('bad_request', `config.${field} must be a finite number`, 400);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new RpcError('bad_request', `config.${field} must be a boolean`, 400);
        }
        break;
    }
    setSafeKey(out, field, value);
  }
  // Preserve any extra fields the manifest didn't declare —
  // marketplace-validation already vets unknown-field policy at
  // review; here we don't second-guess.
  for (const [key, value] of Object.entries(config)) {
    if (!hasOwnSafe(out, key)) setSafeKey(out, key, value);
  }
  return out;
};

const requireTemplate = (
  templates: ServiceTemplateResolver,
  template_slug: string,
): ServiceTemplate => {
  const tpl = templates.get(template_slug);
  if (!tpl) {
    throw new RpcError(
      'SERVICE_TEMPLATE_UNAVAILABLE',
      `template '${template_slug}' is not registered on this server`,
      404,
    );
  }
  return tpl;
};

const requireInstance = (
  instances: CollectionInstanceStore,
  slug: string,
): { adapter_type: string; config: Record<string, unknown>; caps: ServiceCollectionCaps } => {
  const row = instances.get('service', slug);
  if (!row) {
    throw new RpcError(
      'SERVICE_NOT_FOUND',
      `service instance '${slug}' is not enrolled`,
      404,
    );
  }
  return {
    adapter_type: row.adapter_type,
    config: row.config,
    caps: row.caps as ServiceCollectionCaps,
  };
};

const detectDefaultOS = (): ServiceTemplateOS => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
};

// ────────────────────────────────────────────────────────────────
// Audit helpers
// ────────────────────────────────────────────────────────────────

/** install_check.binary if the check is binary_in_path; else null.
 *  Used as the audit `binary` field for the `enrolled` event per
 *  the spec note on `ServiceAuditEvent.binary`. */
const installCheckBinary = (check: Record<string, unknown>): string | null => {
  if (check.kind === 'binary_in_path' && typeof check.binary === 'string') {
    return check.binary;
  }
  return null;
};

/** Synthetic argv for installer-step audit rows: `[kind, target]`
 *  per spec line 455. `target` is the package / image / url — first
 *  string field present in the step. */
const installStepArgv = (step: ServiceInstallStep): string[] => {
  const target =
    typeof step.package === 'string' ? step.package
    : typeof step.image === 'string' ? step.image
    : typeof step.url === 'string' ? step.url
    : typeof step.target === 'string' ? step.target
    : '';
  return target ? [step.kind, target] : [step.kind];
};

// ────────────────────────────────────────────────────────────────
// Installer driver
// ────────────────────────────────────────────────────────────────

/** Run every step in `steps` against the dispatcher; collect output
 *  + exit code; emit one audit event per step. Stops at the first
 *  non-zero exit and emits the failure-event name; successful runs
 *  emit the success-event name.
 *
 *  Per spec line 793 ("the final response carries the installer
 *  exit code + re-probed install_check"), this returns rather than
 *  throws on a non-zero installer exit — the UI renders the captured
 *  output and the user clicks retry. The only path that throws is a
 *  dispatcher-rejected step (unknown kind / invalid params), which
 *  is a systemic failure rather than an installer outcome. */
const runInstallSteps = async (
  deps: ServiceEnrollDeps,
  slug: string,
  steps: ServiceInstallStep[],
  action: InstallerAction,
  successEvent: 'installed' | 'upgraded' | 'uninstalled',
  failureEvent: 'install_failed' | 'upgrade_failed' | null,
): Promise<{ exit_code: number; log_lines: string[]; failed_step: ServiceInstallStep | null }> => {
  const ctx: InstallerContext = { ...deps.installerCtx, slug };
  const collected: string[] = [];
  let lastExit = 0;
  const now = deps.now ?? Date.now;
  for (const step of steps) {
    let outcome: InstallerOutcome;
    try {
      const { kind, action: _ignored, ...params } = step;
      void _ignored;
      outcome = await runInstaller(kind, action, params, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const argv = installStepArgv(step);
      deps.emitAudit({
        type: 'service_event',
        slug,
        binary: argv[0] ?? null,
        event_name: failureEvent ?? successEvent,
        argv,
        error: detail,
        timestamp: now(),
      });
      throw new RpcError(
        action === 'install'
          ? 'SERVICE_INSTALL_FAILED'
          : action === 'upgrade'
            ? 'SERVICE_UPGRADE_FAILED'
            : 'SERVICE_UNINSTALL_FAILED',
        `${action} step '${step.kind}' rejected: ${detail}`,
        500,
      );
    }
    collected.push(...outcome.log_lines);
    lastExit = outcome.exit_code;
    const argv = installStepArgv(step);
    if (outcome.exit_code !== 0) {
      deps.emitAudit({
        type: 'service_event',
        slug,
        binary: argv[0] ?? null,
        event_name: failureEvent ?? successEvent,
        argv,
        error: `exit ${outcome.exit_code}`,
        timestamp: now(),
      });
      return { exit_code: outcome.exit_code, log_lines: collected, failed_step: step };
    }
    deps.emitAudit({
      type: 'service_event',
      slug,
      binary: argv[0] ?? null,
      event_name: successEvent,
      argv,
      error: null,
      timestamp: now(),
    });
  }
  return { exit_code: lastExit, log_lines: collected, failed_step: null };
};

const reprobeInstallCheck = async (
  deps: ServiceEnrollDeps,
  template: ServiceTemplate,
  config: Record<string, unknown>,
): Promise<ServiceCheckResult> => {
  try {
    return await deps.runCheck(template.install_check, config);
  } catch (err) {
    return {
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

// ────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────

export const handleServiceList = async (
  deps: ServiceEnrollDeps,
): Promise<ServiceInstanceList> => {
  const rows = deps.instances.list('service');
  const instances: ServiceInstanceListRow[] = rows.map((row) => {
    const stateRow = deps.state.get(row.slug);
    const state: ServiceState = stateRow ? deriveServiceState(stateRow) : 'unknown';
    const health: ServiceHealthState = stateRow?.last_health_state ?? 'unknown';
    return {
      slug: row.slug,
      template_slug: row.adapter_type,
      state,
      health,
      caps: row.caps as ServiceCollectionCaps,
    };
  });
  return { instances };
};

// ────────────────────────────────────────────────────────────────
// listTemplates (D-118 Phase 10 follow-up)
// ────────────────────────────────────────────────────────────────

/** Project a template's internal `ConfigFieldSchema` onto the
 *  UI-facing `ServiceTemplateConfigField`. Keeps internal-only
 *  fields (e.g. computed label when absent) out of the wire shape. */
const projectConfigField = (
  name: string,
  field: ConfigFieldSchema,
): ServiceTemplateConfigField => {
  const out: ServiceTemplateConfigField = { type: field.type };
  if (field.public !== undefined) out.public = field.public;
  if (field.optional !== undefined) out.optional = field.optional;
  if (field.default !== undefined) out.default = field.default;
  if (field.values) out.values = field.values;
  // A reasonable default label for UI picker rendering. Publishers
  // that care override via future `label` support on the manifest.
  out.label = name;
  return out;
};

export const handleServiceListTemplates = async (
  deps: ServiceEnrollDeps,
  args: ServiceTemplateListInput | void,
): Promise<ServiceTemplateList> => {
  const listFn = deps.templates.list;
  if (!listFn) {
    // Resolver stubs in unit tests omit `.list` — return empty
    // rather than throwing so the rpc remains tolerant.
    return { templates: [], applied_platform: null };
  }

  const input: ServiceTemplateListInput = args ?? {};
  const detectOS = deps.detectOS ?? defaultDetectOS;

  // Platform filter: explicit null → every OS; omitted → detected OS.
  let appliedPlatform: ServiceTemplateOS | null;
  if (input.platform === null) {
    appliedPlatform = null;
  } else if (input.platform === undefined) {
    appliedPlatform = detectOS();
  } else {
    appliedPlatform = input.platform;
  }

  const variantGroup =
    typeof input.variant_group === 'string' && input.variant_group.length > 0
      ? input.variant_group
      : null;

  const rows: ServiceTemplateListRow[] = [];
  for (const template of listFn()) {
    if (appliedPlatform !== null && template.platform !== appliedPlatform) continue;
    if (variantGroup !== null && template.variant_group !== variantGroup) continue;

    const config_schema: Record<string, ServiceTemplateConfigField> = {};
    for (const [name, field] of Object.entries(template.config_schema)) {
      setSafeKey(config_schema, name, projectConfigField(name, field));
    }

    // Derive the base slug from `template_slug` (strip `@version`).
    const atIdx = template.template_slug.indexOf('@');
    const baseSlug = atIdx >= 0
      ? template.template_slug.slice(0, atIdx)
      : template.template_slug;

    rows.push({
      template_slug: template.template_slug,
      slug: baseSlug,
      label: baseSlug,
      platform: template.platform,
      variant_group: template.variant_group,
      caps: template.caps,
      config_schema,
      install_hint: template.install_hint,
    });
  }

  // Stable sort: variant_group → platform → template_slug. Makes
  // picker diffs clean across refreshes.
  rows.sort((a, b) => {
    if (a.variant_group !== b.variant_group) {
      return a.variant_group.localeCompare(b.variant_group);
    }
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    return a.template_slug.localeCompare(b.template_slug);
  });

  return { templates: rows, applied_platform: appliedPlatform };
};

/** Default OS detector — same shape the enroll handlers use. Exported
 *  so composition can share the logic. */
const defaultDetectOS = (): ServiceTemplateOS => {
  const p = typeof process !== 'undefined' ? process.platform : 'linux';
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
};

// ────────────────────────────────────────────────────────────────
// enroll
// ────────────────────────────────────────────────────────────────

export const handleServiceEnroll = async (
  deps: ServiceEnrollDeps,
  args: ServiceEnrollInput,
): Promise<ServiceEnrollOutput> => {
  const slug = requireSlug(args.slug);
  const template_slug = requireString(args.template_slug, 'template_slug');
  const rawConfig = ensureConfigObject(args.config);

  if (deps.instances.get('service', slug)) {
    throw new RpcError(
      'conflict',
      `service instance '${slug}' already enrolled — use collection.service.update to change config`,
      409,
    );
  }

  const template = requireTemplate(deps.templates, template_slug);

  const os = (deps.detectOS ?? detectDefaultOS)();
  if (template.platform !== os) {
    throw new RpcError(
      'SERVICE_PLATFORM_MISMATCH',
      `template '${template_slug}' targets ${template.platform}; this server is ${os}`,
      400,
    );
  }

  const config = validateConfig(rawConfig, template.config_schema);

  const installCheck = await reprobeInstallCheck(deps, template, config);

  deps.instances.upsert({
    platform: 'service',
    slug,
    adapter_type: template_slug,
    config,
    caps: template.caps,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const now = (deps.now ?? Date.now)();
  deps.emitAudit({
    type: 'service_event',
    slug,
    binary: installCheckBinary(template.install_check),
    event_name: 'enrolled',
    argv: null,
    error: null,
    timestamp: now,
  });

  try {
    await deps.onEnrolled?.(slug);
  } catch (err) {
    throw new RpcError(
      'INTERNAL',
      `enroll committed but composition root failed to start supervisor: ${(err as Error).message}`,
      500,
    );
  }

  return {
    slug,
    install_check: installCheck,
    install_available: Array.isArray(template.install) && template.install.length > 0,
    caps: template.caps,
  };
};

// ────────────────────────────────────────────────────────────────
// install / upgrade / uninstall (button-driven)
// ────────────────────────────────────────────────────────────────

export const handleServiceInstall = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<ServiceInstallOutput> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);

  if (!Array.isArray(template.install) || template.install.length === 0) {
    throw new RpcError(
      'SERVICE_INSTALL_UNAVAILABLE',
      template.install_hint
        ? `template has no install[] — install_hint: ${template.install_hint}`
        : `template has neither install[] nor install_hint`,
      400,
    );
  }

  const result = await runInstallSteps(
    deps,
    slug,
    template.install,
    'install',
    'installed',
    'install_failed',
  );
  const installCheck = await reprobeInstallCheck(deps, template, instance.config);

  return {
    slug,
    exit_code: result.exit_code,
    install_check: installCheck,
    log_lines: result.log_lines,
  };
};

export const handleServiceUpgrade = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<ServiceUpgradeOutput> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);

  if (!Array.isArray(template.upgrade) || template.upgrade.length === 0) {
    throw new RpcError(
      'SERVICE_INSTALL_UNAVAILABLE',
      `template '${instance.adapter_type}' declares no upgrade[] path — reinstall to update`,
      400,
    );
  }

  const result = await runInstallSteps(
    deps,
    slug,
    template.upgrade,
    'upgrade',
    'upgraded',
    'upgrade_failed',
  );
  const installCheck = await reprobeInstallCheck(deps, template, instance.config);

  return {
    slug,
    exit_code: result.exit_code,
    install_check: installCheck,
    log_lines: result.log_lines,
  };
};

export const handleServiceUninstall = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown; remove_binary?: unknown },
): Promise<ServiceUninstallOutput> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);
  const removeBinary = args.remove_binary === true;

  let exit_code = 0;
  let log_lines: string[] = [];
  let installCheck: ServiceCheckResult = { passed: false, detail: 'binary left on disk' };

  if (removeBinary) {
    if (!Array.isArray(template.uninstall) || template.uninstall.length === 0) {
      throw new RpcError(
        'SERVICE_INSTALL_UNAVAILABLE',
        `template '${instance.adapter_type}' declares no uninstall[] — leave binary on disk or uninstall manually`,
        400,
      );
    }
    const result = await runInstallSteps(
      deps,
      slug,
      template.uninstall,
      'uninstall',
      'uninstalled',
      null,
    );
    exit_code = result.exit_code;
    log_lines = result.log_lines;
    installCheck = await reprobeInstallCheck(deps, template, instance.config);
  } else {
    // No binary touched — just record the row drop in audit.
    const now = (deps.now ?? Date.now)();
    deps.emitAudit({
      type: 'service_event',
      slug,
      binary: installCheckBinary(template.install_check),
      event_name: 'uninstalled',
      argv: null,
      error: null,
      timestamp: now,
    });
  }

  await tearDownInstance(deps, slug);

  return {
    slug,
    exit_code,
    install_check: installCheck,
    log_lines,
  };
};

// ────────────────────────────────────────────────────────────────
// update
// ────────────────────────────────────────────────────────────────

export const handleServiceUpdate = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown; config_patch?: unknown },
): Promise<{ slug: string; caps: ServiceCollectionCaps }> => {
  const slug = requireSlug(args.slug);
  const patch = ensurePatchObject(args.config_patch, 'config_patch');
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);

  const merged = validateConfig({ ...instance.config, ...patch }, template.config_schema);

  deps.instances.upsert({
    platform: 'service',
    slug,
    adapter_type: instance.adapter_type,
    config: merged,
    caps: template.caps,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  try {
    await deps.onUpdated?.(slug);
  } catch (err) {
    // Restart failed — config is committed; surface so the UI can
    // show the partial outcome and offer a manual restart.
    throw new RpcError(
      'INTERNAL',
      `update committed but supervisor restart failed: ${(err as Error).message}`,
      500,
    );
  }

  return { slug, caps: template.caps };
};

// ────────────────────────────────────────────────────────────────
// delete
// ────────────────────────────────────────────────────────────────

export const handleServiceDelete = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown; uninstall_binary?: unknown },
): Promise<{ deleted: true }> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);
  const uninstallBinary = args.uninstall_binary === true;

  if (uninstallBinary) {
    if (!Array.isArray(template.uninstall) || template.uninstall.length === 0) {
      throw new RpcError(
        'SERVICE_INSTALL_UNAVAILABLE',
        `template '${instance.adapter_type}' declares no uninstall[] — call delete with uninstall_binary: false`,
        400,
      );
    }
    await runInstallSteps(
      deps,
      slug,
      template.uninstall,
      'uninstall',
      'uninstalled',
      null,
    );
  } else {
    const now = (deps.now ?? Date.now)();
    deps.emitAudit({
      type: 'service_event',
      slug,
      binary: installCheckBinary(template.install_check),
      event_name: 'uninstalled',
      argv: null,
      error: null,
      timestamp: now,
    });
  }

  await tearDownInstance(deps, slug);
  return { deleted: true };
};

// ────────────────────────────────────────────────────────────────
// clear_crash
// ────────────────────────────────────────────────────────────────

export const handleServiceClearCrash = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<ServiceStatus> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);

  const spec = templateToSupervisorSpec(template, slug, instance.config);
  await deps.supervisor.clearCrash(spec);

  return computeStatus(deps, slug, template, instance.config);
};

// ────────────────────────────────────────────────────────────────
// start / stop / restart — user-driven lifecycle
// ────────────────────────────────────────────────────────────────

/** Run `supervisor.start` for the instance. Tool-shape templates
 *  (no `start` spec) reject with `SERVICE_OP_NOT_SUPPORTED` — the
 *  same code the dispatcher uses inside the kernel ingredient
 *  `service-start`. */
export const handleServiceStart = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<{
  state: 'running' | 'unhealthy' | 'failed';
  pid: number | null;
  started_at: number | null;
}> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);
  if (!template.start) {
    throw new RpcError(
      'SERVICE_OP_NOT_SUPPORTED',
      `service-start not supported for '${slug}' (tool-shaped template)`,
      400,
    );
  }
  const spec = templateToSupervisorSpec(template, slug, instance.config);
  const outcome = await deps.supervisor.start(spec);
  return {
    state: outcome.state === 'running' ? 'running'
      : outcome.state === 'failed' ? 'failed'
      : 'unhealthy',
    pid: outcome.pid,
    started_at: outcome.started_at,
  };
};

/** Run `supervisor.stop` for the instance. Tool-shape templates
 *  reject with `SERVICE_OP_NOT_SUPPORTED`. */
export const handleServiceStop = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<{ state: 'stopped' | 'failed' }> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);
  if (!template.stop && !template.start) {
    throw new RpcError(
      'SERVICE_OP_NOT_SUPPORTED',
      `service-stop not supported for '${slug}' (tool-shaped template)`,
      400,
    );
  }
  const outcome = await deps.supervisor.stop(slug);
  return { state: outcome.state === 'stopped' ? 'stopped' : 'failed' };
};

/** Stop then start. Composed in the handler so the UI fires a single
 *  rpc per click; the supervisor's restart-policy stays untouched. */
export const handleServiceRestart = async (
  deps: ServiceEnrollDeps,
  args: { slug?: unknown },
): Promise<{
  state: 'running' | 'unhealthy' | 'failed';
  pid: number | null;
  started_at: number | null;
}> => {
  const slug = requireSlug(args.slug);
  const instance = requireInstance(deps.instances, slug);
  const template = requireTemplate(deps.templates, instance.adapter_type);
  if (!template.start) {
    throw new RpcError(
      'SERVICE_OP_NOT_SUPPORTED',
      `service-restart not supported for '${slug}' (tool-shaped template)`,
      400,
    );
  }
  await deps.supervisor.stop(slug);
  const spec = templateToSupervisorSpec(template, slug, instance.config);
  const outcome = await deps.supervisor.start(spec);
  return {
    state: outcome.state === 'running' ? 'running'
      : outcome.state === 'failed' ? 'failed'
      : 'unhealthy',
    pid: outcome.pid,
    started_at: outcome.started_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

const tearDownInstance = async (
  deps: ServiceEnrollDeps,
  slug: string,
): Promise<void> => {
  // Stop the supervisor first so no live process outlives the row
  // — composition root listens on `onDeleting` and calls
  // supervisor.stop synchronously.
  try {
    await deps.onDeleting?.(slug);
  } catch (err) {
    throw new RpcError(
      'INTERNAL',
      `delete pre-cleanup failed: ${(err as Error).message}`,
      500,
    );
  }
  // Cascade is enforced app-side because collection_instances has a
  // composite PK (per service-state-table.ts header).
  deps.state.clear(slug);
  deps.instances.delete('service', slug);
};

/** Build a supervisor spec from the template + stored config.
 *  Used by `clear_crash`; install/update lean on `onUpdated` to let
 *  composition rebuild the spec when fields it cares about change. */
const templateToSupervisorSpec = (
  template: ServiceTemplate,
  slug: string,
  config: Record<string, unknown>,
): ServiceInstanceSpec => ({
  slug,
  template_slug: template.template_slug,
  publisher_id: template.publisher_id,
  config,
  start: template.start
    ? {
        argv: template.start.argv,
        ...(template.start.env ? { env: template.start.env } : {}),
        ...(template.start.cwd ? { cwd: template.start.cwd } : {}),
        ...(template.start.detach !== undefined ? { detach: template.start.detach } : {}),
        ...(template.start.restart_policy
          ? { restart_policy: template.start.restart_policy as ServiceRestartPolicy }
          : {}),
        ...(template.start.restart_on_server_start !== undefined
          ? { restart_on_server_start: template.start.restart_on_server_start }
          : {}),
      }
    : null,
  stop: template.stop
    ? {
        ...(template.stop.signal ? { signal: template.stop.signal } : {}),
        ...(template.stop.grace_ms !== undefined ? { grace_ms: template.stop.grace_ms } : {}),
        ...(template.stop.argv ? { argv: template.stop.argv } : {}),
      }
    : null,
  health_check: template.health_check,
  startup_check: template.startup_check,
  startup_grace_ms: template.startup_grace_ms,
  health_check_interval_ms: template.health_check_interval_ms,
});

/** Build a `ServiceStatus` snapshot from the durable row + state
 *  table + template manifest. Mirrors the dispatcher's status
 *  computation — vault refs stripped unconditionally per decision
 *  #18; non-public fields stripped too. */
const computeStatus = (
  deps: ServiceEnrollDeps,
  slug: string,
  template: ServiceTemplate,
  config: Record<string, unknown>,
): ServiceStatus => {
  const stateRow = deps.state.get(slug);
  const state: ServiceState = stateRow ? deriveServiceState(stateRow) : 'unknown';
  const health: ServiceHealthState = stateRow?.last_health_state ?? 'unknown';
  const pid = stateRow?.pid ?? null;
  const started_at = stateRow?.started_at ?? null;
  const now = (deps.now ?? Date.now)();
  const uptime_s =
    started_at !== null ? Math.max(0, Math.floor((now - started_at) / 1000)) : null;
  const exposes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(template.exposes)) {
    if (entry.template !== undefined) {
      setSafeKey(exposes, key, resolveArgv([entry.template], config)[0]);
    } else {
      setSafeKey(exposes, key, '');
    }
  }
  const publicConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isPrototypeSensitiveKey(key)) continue;
    const fieldSchema = template.config_schema[key];
    if (fieldSchema?.type === 'vault_ref') continue;
    if (fieldSchema?.public === false) continue;
    setSafeKey(publicConfig, key, value);
  }
  return {
    state,
    health,
    pid,
    started_at,
    uptime_s,
    last_crash_at: stateRow?.last_crash_at ?? null,
    consecutive_crashes: stateRow?.consecutive_crashes ?? 0,
    config: publicConfig,
    exposes,
  };
};

// ────────────────────────────────────────────────────────────────
// Re-exports
// ────────────────────────────────────────────────────────────────

export { SERVICE_INSTALL_KINDS };
export type { ServiceAuditEvent };
