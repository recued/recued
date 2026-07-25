/** source_mirror — the neutral gated fetch core (D-192 P1.5 extraction).
 *
 *  The source-family-agnostic half of `runCanonicalWatchPoll` (Codex H4:
 *  extract LOWER than the poll driver): gateway invocation with a scoped
 *  minimal ExecutionContext + audit capture, result-envelope extraction,
 *  optional declarative projection, id-keying, and the
 *  truncated/complete computation. What stays in the caller is
 *  everything family-specific: op-key naming (`${entity}.search` for
 *  CRM, a declared `list` op for D-192 work-entity Sources), projection
 *  derivation (the CRM vendor registry vs a declared projection), and
 *  search-arg derivation.
 *
 *  Invocation is DIRECT (`runCatalogOperation`) with a scoped minimal
 *  ExecutionContext, not a synthetic recipe run:
 *
 *  - a mirror fetch is not a run — no run anchors / run history /
 *    `reactive_fire` noise every N minutes;
 *  - the caller needs the pagination `truncated` flag (gates `deleted`
 *    emission — an absent record on a TRUNCATED walk is unproven), and
 *    the gateway reports it only on its audit event, so this module
 *    captures its own `onGatewayCall` (and forwards to the production
 *    audit sink — every fetch stays audited);
 *  - `createBoundExecutor` WITHOUT a `recipeContext` skips the L1
 *    ingredient-cache wrap: the detection fetch must never read from
 *    cache (a fetch serving stale cache sees no diff and the watcher
 *    silently never fires).
 *
 *  Policy verdicts: `admit` proceeds; `deny` / `ask` surface as
 *  outcomes (`ask` → kind `'policy'` via `PreflightRequiredSignal` —
 *  there is no approval queue for a background poll). */

import type {
  ExecutionSource,
  GatewayCallAudit,
  IngredientManifest,
  RecipeDefinition,
  ScanFn,
} from '@recued/contracts';
import {
  executionSourceContractId,
  isPreflightRequiredSignal,
} from '@recued/contracts';
import type { ExecutionContext } from '@recued/engine';
import { createTransformContext, runCatalogOperation } from '@recued/engine';
import { getTransform } from '@recued/transforms';
import type { ServerExecutorConfig } from '../server-executor.js';
import { createBoundExecutor, createNamespaceStores } from '../server-executor.js';
import type { ConnectionOperationProfileStore } from '../connection-operation-profile.js';

/** The source-family-agnostic dependency set — `CanonicalPollDeps`
 *  minus the CRM vendor-registry seam (which belongs to the CRM
 *  caller). */
export interface SourceMirrorFetchDeps {
  executorConfig: ServerExecutorConfig;
  /** Per-connection operation profile (grants + catalog binding). The
   *  gateway fails closed without one — so does this module. */
  profiles: Pick<ConnectionOperationProfileStore, 'get'>;
  /** Connection's stored `subresource_path` for `path_scope`
   *  enforcement at the gate. Absent resolver ⇒ whole-account. */
  getSubresourcePath?: (connection_name: string) => string | undefined;
  /** D-192 H4 — the connection's stored per-tenant API base URL (from
   *  `config_json.base_url`). The gateway's origin-pin uses it to accept a
   *  vendor's ABSOLUTE `links.next` / `Link:` continuation as same-origin.
   *  Absent (or `undefined` for a fixed-base vendor) ⇒ the pin falls back to the
   *  pack's placeholder `default_base_url`, which for a multi-tenant vendor
   *  (Zendesk `<subdomain>.zendesk.com`, self-hosted GitLab) does NOT match the
   *  real origin, so every next-page URL is rejected cross-origin and the walk
   *  truncates at page 1. The recipe + raw-op dispatch paths already wire this;
   *  the background sync path must too. */
  getBaseUrl?: (connection_name: string) => string | undefined;
  /** Production audit sink (`createGatewayAuditEmitter(auditLog)`).
   *  The module captures pagination meta from the same event and
   *  forwards it here so fetches are first-class `connection_gateway`
   *  audit rows. */
  onGatewayAudit?: (event: GatewayCallAudit) => void;
  /** D-166 contract-override scan — threaded so owner overrides
   *  TIGHTEN mirror reads exactly as they tighten recipe reads. */
  contractScan?: ScanFn;
  /** Test seam — substitute the IO executor under the gateway.
   *  Production omits it (the bound executor over `executorConfig`,
   *  WITHOUT a recipeContext, so no L1 cache wrap); tests script wire
   *  responses while the REAL gateway still resolves policy, translates
   *  the binding, walks pagination, and emits the audit. */
  buildExecutor?: (
    config: ServerExecutorConfig,
    stores: ReturnType<typeof createNamespaceStores>,
  ) => ReturnType<typeof createBoundExecutor>;
  /** Test seam — substitute `runCatalogOperation` itself so a test can
   *  pin the SCOPED CTX this module derives (actor / contract_id /
   *  execution_source / trigger_source / correlation_id — the D-153
   *  threading semantics) without standing up the whole gateway.
   *  Production omits it ⇒ the real engine entry. Distinct from
   *  `buildExecutor` (which substitutes the IO layer UNDER the real
   *  gateway); this one replaces the gateway call itself, so use it
   *  ONLY to observe the ctx derivation. */
  invokeCatalogOperation?: typeof runCatalogOperation;
}

export interface SourceMirrorFetchRequest {
  connection_name: string;
  /** The bound catalog manifest + slug (resolved by the caller — the
   *  resolution stage carries the family-specific error wording). */
  manifest: IngredientManifest;
  catalogSlug: string;
  /** The catalog operation key to invoke (`deal.search`, `task.list`). */
  operationKey: string;
  args: Record<string, unknown>;
  /** Where the record array sits in the vendor response envelope
   *  (under the adapter's `result.` wrapper). */
  resultPath: string;
  /** Declarative projection template applied per record via the `map`
   *  transform (the exact resolver template through the exact engine
   *  evaluator) — `null` keys the RAW rows instead. */
  projectionTemplate: Record<string, unknown> | null;
  /** Dot-path of the record-id field the outcome map is keyed by.
   *  Defaults to `'id'` (the CRM projection emits a canonical `id`);
   *  raw-mode callers (D-192 P3b — `projectionTemplate: null`) pass
   *  their declaration's `remote.id` so vendor rows key by their
   *  native id field (`Id`, `properties.id`, …). */
  idField?: string;
  /** Synthetic recipe identity for the scoped gateway ctx — audit rows
   *  attribute the call to it. Never installed, never executed. */
  auditRecipe: RecipeDefinition;
  /** Audit step id (`watch_poll`, `source_sync`). */
  stepId: string;
  /** D-153/D-182 — the dispatching caller's source + honest trigger
   *  origin + intent-burst correlation id for CALLER-TRIGGERED fetches
   *  (the CRM S3 live escalation); pass-through to the gated invoke
   *  core (see `GatedCatalogOperationRequest`). Absent (the sync poll /
   *  reconciler cycle) → the background posture stands byte-identical:
   *  `actor: 'system'`, `trigger_source: 'reactive'`, no source on the
   *  audit. */
  execution_source?: ExecutionSource;
  trigger_source?: string;
  correlation_id?: string;
}

export type SourceMirrorFetchOutcome =
  | {
      ok: true;
      /** Projection per record, keyed by the record's `id`. */
      records: Map<string, Record<string, unknown>>;
      /** True when the gateway's cursor walk stopped with more data
       *  available — the record set is INCOMPLETE and absence proves
       *  nothing (callers suppress `deleted` emission). */
      truncated: boolean;
      /** S2 — True ONLY when the gateway PROVABLY walked the ENTIRE set: the
       *  pagination follower RAN (`pages_fetched` present on the audit) AND did not
       *  truncate. False when the bound catalog declares NO pagination (a
       *  `search_style` without `pagination_style`): the gateway returns the FIRST
       *  page with `truncated:false`, which `!truncated` alone cannot distinguish from
       *  a complete walk. Delete detection (full-walk diff) MUST gate on `complete`,
       *  NOT on `!truncated` — a non-paginating catalog's single page is
       *  completeness-UNKNOWN, so absence from it must never be read as a delete
       *  (fail-closed: no `complete` ⇒ no deletes). */
      complete: boolean;
      /** Raw rows dropped for lacking an `id` (observability — a
       *  registry/vendor drift signal, not an error). */
      skipped_no_id: number;
    }
  | {
      ok: false;
      /** `'config'` — the substrate can't fetch this key: stable until
       *  the user changes enrollment, counts toward the error cap.
       *  `'policy'` — the gate said `ask` (no background approval
       *  path) or `deny`. `'error'` — the call itself failed.
       *  `'unavailable'` — a TRANSIENT "nothing to fetch right now"
       *  (reserved for callers whose source can vanish, e.g. dom). */
      kind: 'config' | 'policy' | 'error' | 'unavailable';
      reason: string;
    };

const asRecordArray = (value: unknown): Array<Record<string, unknown>> | null => {
  if (!Array.isArray(value)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    out.push(item as Record<string, unknown>);
  }
  return out;
};

/** Dot-path field extraction over a (possibly nested) response object.
 *  Exported for the family-specific callers that share the convention
 *  (the D-192 work-entity projector extracts declared canonical /
 *  preview / extension paths with the exact semantics the fetch uses
 *  for `resultPath` / `idField`).
 *
 *  A declared field path may name a key that LITERALLY contains a dot —
 *  Microsoft Graph annotates each record with `@odata.etag` (ONE key,
 *  not a `@odata` → `etag` nesting), and Azure DevOps work items nest
 *  their whole payload under literal-dot keys (`fields` →
 *  `'System.Title'`, so a declared `fields.System.Title` — the D-192
 *  CORE #8b hydration consumer). At EVERY level the LONGEST dotted
 *  prefix of the remaining path is tried as a literal key first
 *  (backtracking to shorter prefixes, then the plain segment, when the
 *  subtree under a hit resolves to undefined) — a superset of the old
 *  root-only literal read that `workEntitySourceVersionToken`'s etag
 *  capture depends on. No curated field path collides a literal-dot
 *  key with a real nested path (the collision would be resolved
 *  literal-first), so ordinary nested resolution (and the
 *  `result.<x>` envelope idiom) is unaffected. */
const resolveDotPathSegments = (obj: unknown, segs: readonly string[]): unknown => {
  if (segs.length === 0) return obj;
  if (obj === null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  // Dotted literal prefixes, longest (the whole remainder) down to two
  // segments — a literal-dot key is more specific than a nested walk.
  for (let take = segs.length; take >= 2; take -= 1) {
    const literal = rec[segs.slice(0, take).join('.')];
    if (literal === undefined) continue;
    const resolved = resolveDotPathSegments(literal, segs.slice(take));
    if (resolved !== undefined) return resolved;
  }
  const next = rec[segs[0] as string];
  if (segs.length === 1) return next;
  return resolveDotPathSegments(next, segs.slice(1));
};

export const getByDotPath = (obj: unknown, path: string): unknown =>
  resolveDotPathSegments(obj, path.split('.'));

/** One gated + audited catalog-operation invoke — the invocation core
 *  shared by the list fetch below and the D-192 P4b single-record
 *  read/write executor. Builds the scoped minimal engine ctx (no
 *  recipeContext ⇒ no L1 cache wrap), invokes through the REAL gateway
 *  (policy + binding translation + pagination + audit), and maps the
 *  failure taxonomy. What it does NOT do is envelope extraction — a
 *  list caller keys a record array, a single-record caller reads one
 *  record (possibly at the response root), a write caller may ignore
 *  the body entirely. */
export interface GatedCatalogOperationRequest {
  connection_name: string;
  manifest: IngredientManifest;
  catalogSlug: string;
  operationKey: string;
  args: Record<string, unknown>;
  auditRecipe: RecipeDefinition;
  stepId: string;
  /** Caller-flavored reason for a gateway `ask` verdict (there is no
   *  approval path on this spine, so `ask` surfaces as a `policy`
   *  outcome). Defaults to a generic background-invocation wording;
   *  the list fetch passes its poll/watch-specific phrasing. */
  askReason?: string;
  /** D-153/D-182 — the dispatching caller's `(channel × actor ×
   *  contract_id)` source, when the invocation is caller-triggered
   *  (the work-entity read tools' targeted reads) rather than a
   *  background cycle. Threads onto the scoped ctx VERBATIM (D-182
   *  audit attribution) plus its derived `actor` / `contract_id` (the
   *  catalog gateway's per-actor `contract.override` tightening +
   *  D-161 origin provenance) — the SAME evaluation a recipe's gateway
   *  call gets under that source. Absent (sync poll / write executor)
   *  → the background posture stands: `actor: 'system'`, no source on
   *  the audit. */
  execution_source?: ExecutionSource;
  /** Honest trigger origin for caller-triggered invocations (`'chat'` /
   *  `'mcp'`). Defaults to `'reactive'` — the background-cycle wording
   *  every pre-existing caller keeps. */
  trigger_source?: string;
  /** D-182 — intent-burst correlation id alongside `execution_source`
   *  (an mcp source's `tool_call_id`, mirroring raw-op dispatch), so
   *  `deriveOriginUnit` can stamp the audit's `origin_unit_id`. Absent
   *  ⇒ the origin unit falls back per the engine's own rules. */
  correlation_id?: string;
  /** D-192 Slice 6c — admit this invocation PAST a gateway `ask` verdict, when the
   *  human approval already happened OUTSIDE this spine (a create-plan confirm was
   *  answered). Threads `StepMeta.preflight_admitted` + a `preflight_approved_target`
   *  built from THIS call's `(catalogSlug, operationKey, connection_name)` — the
   *  same admission a resumed run / `RawOpCheckpoint` carries. `ask` → admit ONLY:
   *  it NEVER bypasses a policy `deny`. Absent ⇒ the standalone spine's degrade-on-
   *  ask posture stands (a background poll has no approval path). */
  preflight_admitted?: boolean;
}

export type GatedCatalogOperationOutcome =
  | {
      ok: true;
      /** The gateway's raw return (the adapter's `{ result: … }`
       *  envelope, pagination-merged). */
      raw: unknown;
      /** The captured gateway audit event (pagination meta rides it). */
      audit?: GatewayCallAudit;
    }
  | {
      ok: false;
      kind: 'config' | 'policy' | 'error' | 'unavailable';
      reason: string;
    };

export type RunGatedCatalogOperationFn = (
  deps: SourceMirrorFetchDeps,
  request: GatedCatalogOperationRequest,
) => Promise<GatedCatalogOperationOutcome>;

export const runGatedCatalogOperation: RunGatedCatalogOperationFn = async (
  deps,
  request,
) => {
  const { connection_name, manifest, catalogSlug, operationKey } = request;
  // Caller-triggered invocations carry their real dispatch identity;
  // background cycles keep the `system` posture.
  const source = request.execution_source;
  const actor = source?.actor ?? 'system';
  const contractId = source !== undefined ? executionSourceContractId(source) : undefined;

  // Scoped minimal engine ctx. No recipeContext on the bound executor ⇒
  // no L1 ingredient-cache wrap (the freshness-oracle pin, § 6).
  const stores = createNamespaceStores({}, {}, {});
  const ingredientExecutor = (deps.buildExecutor ?? createBoundExecutor)(
    deps.executorConfig,
    stores,
  );
  let captured: GatewayCallAudit | undefined;
  const ctx: ExecutionContext = {
    recipe: request.auditRecipe,
    stores,
    ingredientExecutor,
    manifestGetter: (slug, requestedVersion) =>
      deps.executorConfig.manifests.get(slug, requestedVersion),
    connectionProfileResolver: (name: string) => deps.profiles.get(name),
    ...(deps.getSubresourcePath
      ? {
          connectionSubresourcePathResolver: (name: string) => deps.getSubresourcePath!(name),
        }
      : {}),
    ...(deps.getBaseUrl
      ? {
          connectionBaseUrlResolver: (name: string) => deps.getBaseUrl!(name),
        }
      : {}),
    onGatewayCall: (event) => {
      captured = event;
      try {
        deps.onGatewayAudit?.(event);
      } catch {
        /* audit is best-effort — never break the fetch */
      }
    },
    actor,
    trigger_source: request.trigger_source ?? 'reactive',
    ...(source !== undefined ? { execution_source: source } : {}),
    ...(contractId !== undefined ? { contract_id: contractId } : {}),
    ...(request.correlation_id !== undefined
      ? { correlation_id: request.correlation_id }
      : {}),
    ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
  };

  try {
    const raw = await (deps.invokeCatalogOperation ?? runCatalogOperation)(
      ctx,
      manifest,
      catalogSlug,
      { operation: operationKey, args: request.args },
      connection_name,
      undefined,
      undefined,
      {
        step_id: request.stepId,
        recipe_id: request.auditRecipe.recipe_id,
        actor,
        // D-192 6c — admit past an `ask` when the human approval already happened
        // (a create-plan confirm). The target is THIS call's triple, which the
        // standalone invoke re-resolves to exactly (no `{{config.*}}` drift), so
        // `catalogTargetMatches` holds; `ask`→admit only, never bypasses `deny`.
        // The `operation_id` MUST be the RESOLVED op id the gate re-derives —
        // `manifest.operations[key].operation_id` (the slug-prefixed
        // `recued-core/asana.task.create`), NOT the bare `operationKey`
        // (`task.create`). `catalogTargetMatches` compares against
        // `resolution.operation_id` (the op ROW's id, `ingredient-catalog.ts`
        // `resolveOperationPolicyAgainstSource` → `op.operation_id`); the bare
        // key never matches, so admission silently degraded to a re-ask (the
        // real-gate gap the `runOperation`-mocked 6c tests could not see).
        ...(request.preflight_admitted === true
          ? {
              preflight_admitted: true,
              preflight_approved_target: {
                ingredient_slug: catalogSlug,
                operation_id: manifest.operations?.[operationKey]?.operation_id ?? operationKey,
                connection_name,
              },
            }
          : {}),
      },
    );
    return { ok: true, raw, ...(captured ? { audit: captured } : {}) };
  } catch (e) {
    if (isPreflightRequiredSignal(e)) {
      return {
        ok: false,
        kind: 'policy',
        reason:
          `'${operationKey}' on '${connection_name}' requires approval (policy: ask) — ` +
          (request.askReason
            ?? 'a background invocation has no approval path; grant the operation or pause it'),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const denied = captured?.outcome === 'failed' && captured.failure_mode !== 'error';
    return { ok: false, kind: denied ? 'policy' : 'error', reason: msg };
  }
};

/** Run one gated + audited mirror fetch: invoke the catalog operation,
 *  extract the record envelope, project (when a template is given), and
 *  key by `id`. */
export const runSourceMirrorFetch = async (
  deps: SourceMirrorFetchDeps,
  request: SourceMirrorFetchRequest,
): Promise<SourceMirrorFetchOutcome> => {
  const { connection_name, manifest, catalogSlug, operationKey, resultPath } = request;

  const invoked = await runGatedCatalogOperation(deps, {
    connection_name,
    manifest,
    catalogSlug,
    operationKey,
    args: request.args,
    auditRecipe: request.auditRecipe,
    stepId: request.stepId,
    // The pre-extraction wording, byte-identical for fetch callers.
    askReason: 'a background poll has no approval path; grant the read or pause the watch',
    ...(request.execution_source !== undefined
      ? { execution_source: request.execution_source }
      : {}),
    ...(request.trigger_source !== undefined
      ? { trigger_source: request.trigger_source }
      : {}),
    ...(request.correlation_id !== undefined
      ? { correlation_id: request.correlation_id }
      : {}),
  });
  if (!invoked.ok) return invoked;
  const raw = invoked.raw;
  const captured = invoked.audit;

  // The connection adapter returns a `{ result: <vendor body>, … }`
  // wrapper — the SAME envelope the install resolver's projection ref
  // reads (`{{step.<raw>.result.<result_path>}}`) and the gateway's
  // pagination follower merges at (`['result', ...resultPath]`).
  const recordsRaw = asRecordArray(getByDotPath(raw, `result.${resultPath}`));
  if (recordsRaw === null) {
    return {
      ok: false,
      kind: 'error',
      reason: `search result carries no record array at 'result.${resultPath}'`,
    };
  }

  // Projection — the exact resolver template through the exact engine
  // evaluator (`map` expression mode handles refs, `| number` coercion,
  // and the nested `$ternary` derivation).
  let projectedRows: Array<Record<string, unknown>>;
  if (request.projectionTemplate === null) {
    projectedRows = recordsRaw;
  } else {
    const mapTransform = getTransform('map');
    if (mapTransform === undefined) {
      return { ok: false, kind: 'error', reason: 'map transform unavailable' };
    }
    // A fresh empty store set — the projection template only resolves
    // `{{item.*}}` refs against each record, never namespace refs (the
    // invoke core's scoped stores are equally empty; this preserves the
    // pre-extraction behavior exactly).
    const projected = mapTransform(
      { array: recordsRaw, expression: request.projectionTemplate },
      createTransformContext(createNamespaceStores({}, {}, {})),
    );
    const rows = asRecordArray(projected);
    if (rows === null) {
      return { ok: false, kind: 'error', reason: 'projection did not yield a record array' };
    }
    projectedRows = rows;
  }

  const records = new Map<string, Record<string, unknown>>();
  const idField = request.idField ?? 'id';
  let skipped = 0;
  for (const record of projectedRows) {
    const id = getByDotPath(record, idField);
    const key =
      typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
    if (key.length === 0) {
      skipped += 1;
      continue;
    }
    records.set(key, record);
  }

  return {
    ok: true,
    records,
    truncated: captured?.truncated === true,
    // S2 — the gateway records `pages_fetched` on the audit ONLY when the pagination
    // follower ran (a catalog WITH `pagination_style`/legacy dialect). Its presence +
    // a non-truncated walk proves the set is COMPLETE. A non-paginating catalog's
    // first-page-only result has NO `pages_fetched` → `complete:false` → delete
    // detection fail-closes (never deletes from a possibly-partial single page).
    complete: captured?.pages_fetched !== undefined && captured?.truncated !== true,
    skipped_no_id: skipped,
  };
};
