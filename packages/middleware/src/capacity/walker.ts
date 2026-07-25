/** D-145 PB1.2 — halt-on-first-gap walker.
 *
 *  Pure traversal: takes a `CapacitySpec` + a `CapacityProbeRegistry`
 *  + a `CapacityCache` + a `CapacityWalkContext` → returns a
 *  `CapacityCheckResult`. Audit + transparency emit are best-effort
 *  (failures land in counters, never block the walk result).
 *
 *  Spec: § B.4 + § B.17.3 step 5. Design: § PB1.2. */

import {
  CAPACITY_CACHE_POLICIES,
  CAPACITY_KINDS,
  assertValidCapacitySpec,
  capacityKey,
  capacityKeyForAudit,
  capacityParamsForAudit,
  isCapacityProbeFailure,
  resolveRemediationEntry,
  type CapacityCheck,
  type CapacityCheckAuditDetail,
  type CapacityCheckResult,
  type CapacityRemediation,
  type CapacityRemediationVisibility,
  type CapacityRequirement,
  type CapacitySpec,
  type CapacityWalkCorrelation,
} from '@recued/contracts';

import {
  CAPACITY_REMEDIATION_DEFAULT_VISIBILITY,
  CAPACITY_REMEDIATION_FALLBACK_COPY,
} from './remediations.js';
import type {
  CapacityCache,
  CapacityCounters,
  CapacityProbeRegistry,
  CapacityWalkContext,
} from './types.js';

const defaultNow = (): number => Date.now();

/** Mint a `walk_id` UUID. Same fallback shape as
 *  `packages/scheduler/src/auto-run.ts` so it works in browsers
 *  without web crypto. */
const mintWalkId = (): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Per-§ N.3 precedence: exact key → kind-only → null. */
const lookupRemediation = (
  spec: CapacitySpec,
  req: CapacityRequirement,
): CapacityRemediation | null => resolveRemediationEntry(spec, req);

/** Apply default visibility + fallback copy when the entry omits
 *  them. Pure projection — the walker never mutates spec input. */
const fillRemediation = (entry: CapacityRemediation): CapacityRemediation => {
  const visibility: CapacityRemediationVisibility =
    entry.visibility ?? CAPACITY_REMEDIATION_DEFAULT_VISIBILITY[entry.action];
  const user_facing_copy =
    entry.user_facing_copy && entry.user_facing_copy.length > 0
      ? entry.user_facing_copy
      : CAPACITY_REMEDIATION_FALLBACK_COPY[entry.action];
  return {
    action: entry.action,
    user_facing_copy,
    ...(entry.cta_path !== undefined ? { cta_path: entry.cta_path } : {}),
    visibility,
  };
};

/** Probe-failure remediation: the synthetic `repair_capacity_probe`
 *  entry the walker substitutes when a probe fails (Pass-2 fold). */
const PROBE_FAILURE_REMEDIATION: CapacityRemediation = {
  action: 'repair_capacity_probe',
  user_facing_copy: CAPACITY_REMEDIATION_FALLBACK_COPY.repair_capacity_probe,
  visibility: CAPACITY_REMEDIATION_DEFAULT_VISIBILITY.repair_capacity_probe,
};

const incCounter = (
  c: Record<string, number> | undefined,
  key: string,
): void => {
  if (!c) return;
  c[key] = (c[key] ?? 0) + 1;
};

const recordWalkDuration = (
  counters: CapacityCounters | undefined,
  key: string,
  duration_ms: number,
): void => {
  if (!counters) return;
  const list = counters.walk_durations_ms.get(key) ?? [];
  list.push(duration_ms);
  if (list.length > 1000) list.shift();
  counters.walk_durations_ms.set(key, list);
};

/** Audit-projected check rows. Replaces every `capacity_key` with
 *  `capacityKeyForAudit(req)` so identity-bearing segments
 *  (annotation contact_id, connection_active connection_id) never
 *  cross the audit / transparency boundary. The walker tracks the
 *  underlying req per check via index lookup back into the spec. */
const auditProjectedKeys = (
  reqs: CapacityRequirement[],
  checks: CapacityCheck[],
): string[] => checks.map((_c, i) => capacityKeyForAudit(reqs[i]!));

const buildAuditDetail = (
  ctx: CapacityWalkContext,
  walk_id: string,
  reqs: CapacityRequirement[],
  checks: CapacityCheck[],
  gap?: { req: CapacityRequirement; remediation: CapacityRemediation; failure_kind: 'gap' | 'probe_error' },
): CapacityCheckAuditDetail => {
  const detail: CapacityCheckAuditDetail = {
    walk_id,
    capacity_keys: auditProjectedKeys(reqs, checks),
    cache_hits: checks.filter((c) => c.cached).length,
    cache_misses: checks.filter((c) => !c.cached).length,
  };
  if (ctx.run_id !== undefined) detail.run_id = ctx.run_id;
  if (ctx.intent_id !== undefined) detail.intent_id = ctx.intent_id;
  if (ctx.primitive !== undefined) detail.primitive = ctx.primitive;
  if (ctx.recipe_id !== undefined) detail.recipe_id = ctx.recipe_id;
  if (gap) {
    detail.gap_kind = gap.req.kind;
    detail.gap_key = capacityKeyForAudit(gap.req);
    detail.gap_params = capacityParamsForAudit(gap.req);
    detail.remediation_action = gap.remediation.action;
    detail.remediation_visibility = gap.remediation.visibility;
    detail.failure_kind = gap.failure_kind;
  }
  return detail;
};

/** Best-effort emit — failures land in counters; never bubble up to
 *  the caller. The walk result returns either way. */
const safeEmitOk = async (
  ctx: CapacityWalkContext,
  detail: CapacityCheckAuditDetail,
): Promise<void> => {
  try {
    await ctx.audit_emitter.emitOk(detail, ctx);
  } catch {
    if (ctx.counters) ctx.counters.audit_emit_failures += 1;
  }
};

const safeEmitGap = async (
  ctx: CapacityWalkContext,
  detail: CapacityCheckAuditDetail,
  remediation: CapacityRemediation,
  req: CapacityRequirement,
  walk_id: string,
): Promise<void> => {
  try {
    await ctx.audit_emitter.emitGap(detail, ctx);
  } catch {
    if (ctx.counters) ctx.counters.audit_emit_failures += 1;
  }
  if (remediation.visibility === 'user_visible') {
    try {
      await ctx.transparency_emitter.emit({
        kind: 'capacity_check.gap',
        walk_id,
        ...(ctx.primitive !== undefined ? { primitive: ctx.primitive } : {}),
        gap_kind: req.kind,
        gap_key: capacityKeyForAudit(req),
        gap_params: capacityParamsForAudit(req),
        remediation: {
          action: remediation.action,
          user_facing_copy: remediation.user_facing_copy,
          ...(remediation.cta_path !== undefined ? { cta_path: remediation.cta_path } : {}),
        },
      });
    } catch {
      if (ctx.counters) ctx.counters.transparency_emit_failures += 1;
    }
  }
};

export interface WalkCapacitiesArgs {
  spec: CapacitySpec;
  registry: CapacityProbeRegistry;
  cache: CapacityCache;
  ctx: CapacityWalkContext;
}

export const walkCapacities = async (
  args: WalkCapacitiesArgs,
): Promise<CapacityCheckResult> => {
  const { spec, registry, cache, ctx } = args;

  // Defensive validation — raises CapacitySpecValidationError on issue.
  assertValidCapacitySpec(spec);

  const walk_id = ctx.walk_id ?? mintWalkId();
  const correlation: CapacityWalkCorrelation = {
    walk_id,
    ...(ctx.run_id !== undefined ? { run_id: ctx.run_id } : {}),
    ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
    ...(ctx.recipe_id !== undefined ? { recipe_id: ctx.recipe_id } : {}),
    ...(ctx.primitive !== undefined ? { primitive: ctx.primitive } : {}),
  };

  const now = ctx.now ?? defaultNow;
  const start = now();
  const checks: CapacityCheck[] = [];

  for (const req of spec.capacities) {
    const key = capacityKey(req);
    const policy = CAPACITY_CACHE_POLICIES[req.kind];

    let result;
    let cachedRow = null;
    if (policy.cacheable) {
      cachedRow = cache.read(key, ctx);
      if (cachedRow !== null && now() - cachedRow.checked_at < policy.ttl_ms) {
        result = cachedRow.result;
        incCounter(ctx.counters?.cache_hits, req.kind);
      } else {
        cachedRow = null;
      }
    }

    if (cachedRow === null) {
      result = await registry.probe(req, ctx);
      if (policy.cacheable && result.ok !== false) {
        cache.write(key, ctx, {
          capacity_kind: req.kind,
          capacity_key: key,
          ...(ctx.bridge_instance_id !== undefined
            ? { bridge_instance_id: ctx.bridge_instance_id }
            : {}),
          ...keyPartsFromReq(req),
          result,
          checked_at: now(),
        });
      }
      incCounter(ctx.counters?.cache_misses, req.kind);
    }

    const checked_at = cachedRow?.checked_at ?? now();
    const probeFailure = isCapacityProbeFailure(result!);
    if (probeFailure) {
      incCounter(ctx.counters?.probe_errors, req.kind);
    }

    const check: CapacityCheck = {
      kind: req.kind,
      capacity_key: key,
      ok: result!.ok,
      cached: cachedRow !== null,
      checked_at,
      ...(cachedRow !== null ? { cache_age_ms: now() - cachedRow.checked_at } : {}),
      ...(result!.detail !== undefined ? { detail: result!.detail } : {}),
    };
    checks.push(check);

    if (!result!.ok) {
      let remediation: CapacityRemediation;
      let failure_kind: 'gap' | 'probe_error';
      if (probeFailure) {
        remediation = PROBE_FAILURE_REMEDIATION;
        failure_kind = 'probe_error';
      } else {
        const entry = lookupRemediation(spec, req);
        // Validator already gates missing entries; defensive fallback
        // synthesizes a noop so the walker never throws past the
        // walker boundary (the validator is the right place to error).
        remediation = fillRemediation(
          entry ?? {
            action: 'noop',
            user_facing_copy: '',
          },
        );
        failure_kind = 'gap';
      }

      incCounter(ctx.counters?.gaps, req.kind);
      const reqsSoFar = spec.capacities.slice(0, checks.length);
      const detail = buildAuditDetail(ctx, walk_id, reqsSoFar, checks, {
        req,
        remediation,
        failure_kind,
      });
      await safeEmitGap(ctx, detail, remediation, req, walk_id);
      recordWalkDuration(
        ctx.counters,
        ctx.primitive ?? '_default',
        now() - start,
      );

      return {
        ok: false,
        gap: req,
        gap_key: key,
        remediation,
        checks,
        correlation,
      };
    }
  }

  // ok branch: emit audit only (no transparency on success per § B.4.4).
  const detail = buildAuditDetail(ctx, walk_id, spec.capacities, checks);
  await safeEmitOk(ctx, detail);
  recordWalkDuration(
    ctx.counters,
    ctx.primitive ?? '_default',
    now() - start,
  );
  return { ok: true, checks, correlation };
};

/** Project a `CapacityRequirement` into the closed-list cache-row
 *  param fields. The cache layer uses these for invalidation
 *  matching (e.g. `source.enabled_changed` drops every
 *  `connection_active` row whose `vendor` matches). */
const keyPartsFromReq = (
  req: CapacityRequirement,
): Pick<
  import('./types.js').CapacityCacheRow,
  'vendor' | 'entity' | 'connection_id' | 'slug' | 'pool' | 'permission' | 'site'
> => {
  switch (req.kind) {
    case 'bridge_online':
    case 'annotation_not_required':
    case 'annotation':
      return {};
    case 'ingredient_installed':
    case 'selector_freshness':
      return { slug: req.slug };
    case 'logged_in':
      return { site: req.site };
    case 'permission_grant':
      return { permission: req.permission };
    case 'connection_active':
      return {
        vendor: req.vendor,
        ...(req.entity !== undefined ? { entity: req.entity } : {}),
        ...(req.connection_id !== undefined ? { connection_id: req.connection_id } : {}),
      };
    case 'pool_quota_available':
      return { pool: req.pool };
  }
};

/** Construct an empty counters snapshot — convenience for tests. */
export const createEmptyCounters = (): CapacityCounters => {
  const init = (): Record<string, number> =>
    Object.fromEntries(CAPACITY_KINDS.map((k) => [k, 0])) as Record<string, number>;
  const counters: CapacityCounters = {
    cache_hits: init() as unknown as CapacityCounters['cache_hits'],
    cache_misses: init() as unknown as CapacityCounters['cache_misses'],
    invalidations: {},
    gaps: init() as unknown as CapacityCounters['gaps'],
    probe_errors: init() as unknown as CapacityCounters['probe_errors'],
    walk_durations_ms: new Map<string, number[]>(),
    audit_emit_failures: 0,
    transparency_emit_failures: 0,
    snapshot() {
      const p = (arr: number[], q: number): number => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
        return sorted[i]!;
      };
      const p50: Record<string, number> = {};
      const p95: Record<string, number> = {};
      for (const [k, v] of counters.walk_durations_ms.entries()) {
        p50[k] = p(v, 0.5);
        p95[k] = p(v, 0.95);
      }
      return {
        cache_hits: { ...counters.cache_hits },
        cache_misses: { ...counters.cache_misses },
        invalidations: { ...counters.invalidations },
        gaps: { ...counters.gaps },
        probe_errors: { ...counters.probe_errors },
        walk_duration_ms_p50: p50,
        walk_duration_ms_p95: p95,
        audit_emit_failures: counters.audit_emit_failures,
        transparency_emit_failures: counters.transparency_emit_failures,
      };
    },
  };
  return counters;
};
