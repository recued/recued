/** D-192 P3b — the declared work-entity Source sync runner.
 *
 *  The work-entity caller of the `source-mirror` fetch spine — the
 *  family-specific resolution stage `canonical-poll.ts` models for
 *  CRM, but DECLARATION-driven: the op key is the declaration's
 *  `ops.list` (not an `${entity}.search` convention), projection is
 *  the declared three-lane projector (not the CRM vendor registry),
 *  and the fetch runs in RAW mode keyed by the declaration's
 *  `remote.id` (`idField`).
 *
 *  One cycle, per `(source_id, declaration, connection)`:
 *
 *    1. `markStarted` on the sync-state row.
 *    2. Resolve catalog manifest + list op through the connection's
 *       operation profile (config failures are stable-until-enrollment
 *       outcomes, recorded on the sync-state row — the read resolver's
 *       `degraded` input — never thrown).
 *    3. `runSourceMirrorFetch` (raw mode) — gated + audited through
 *       the SAME gateway path a recipe read takes.
 *    3b. Hydration (D-192 CORE #8b, `sync.list_rows: 'reference'`) —
 *       a reference list's rows carry identity only (Azure DevOps
 *       WIQL → `WorkItemReference[]` of id+url), so each listed row
 *       is read through the declared read op (`ops.read` +
 *       `op_bindings.read.id_arg`, resolved ONCE per cycle via
 *       `prepareWorkEntitySourceTargetedRead` — the exact read-tool /
 *       write-preflight path, so scoping args can never drift) BEFORE
 *       the per-row pipeline. A policy/config read failure aborts the
 *       cycle (every row would fail identically — never N denied
 *       calls); a per-row error fails the ROW; rows beyond
 *       `WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE` fail closed.
 *       Hydration-failed rows still count as live for the delete diff
 *       (listed = present remotely).
 *    4. Per row: native-tombstone check (`sync.tombstone_field`
 *       truthy → tombstone the mirrored row; read off the HYDRATED
 *       row on a reference Source), hash-skip against
 *       `listSnapshotHashes` (unchanged rows never re-write — no
 *       warehouse-event churn; on a reference Source the read has
 *       already happened — a reference row carries no change signal
 *       to skip on), project + upsert through the Source-identity
 *       adapter (NEVER a raw local-id upsert).
 *    5. Deletes — `computeCompleteWalkDeletes`, gated on the walk's
 *       POSITIVE completeness proof (`outcome.complete`) AND
 *       `tombstones: 'missing_means_deleted'` with a declared
 *       `complete_authoritative` list scope AND zero unkeyable rows.
 *       Fail-closed everywhere else: absence proves nothing on a
 *       filtered/partial/unproven walk.
 *    6. `markCompleted` — ok resets error state; a fetch failure or
 *       any failed row degrades the Source for the cycle (spec § Sync
 *       depth: over-cap fails the ROW and degrades the SOURCE; the
 *       other rows still land).
 *
 *  v1 posture (CRM generic-reconciler precedent): full walk each
 *  cycle with hash-skip as the incremental seam; the declared cursor
 *  (`sync.cursor`) is deferred — `cursor_blob` stays null.
 *
 *  The housekeeping wire mirrors `wireCanonicalCrmReconciliation`:
 *  one `core` task per registered connection-Source with a
 *  declaration, enumerated through the boot's
 *  `desiredWorkEntitySourcesFor` (the same set registration uses, so
 *  sync and registration can never drift). A task never throws —
 *  sync-state is the health surface; the scheduler's error/disable
 *  machinery is reserved for programming errors. */

import {
  WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE,
  type ConnectionRow,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  connectionConfigOf,
  connectionVendorOf,
  desiredWorkEntitySourcesFor,
  workEntitySourceContractHash,
  type KernelWorkEntitySourceDeclaration,
} from './work-entity-source-boot.js';
import { resolveConfigArgBindings } from './work-entity-config-args.js';
import { resolvePersistDependencies } from './source-dependency-resolver.js';
import type { SourceDependencyEntityStore } from './storage/source-dependency-entity-store.js';
import {
  declaredLoadBearingPaths,
  mergeFieldHealth,
  tallyCycleFieldHealth,
  type WorkEntitySourceFieldHealth,
} from './work-entity-source-field-health.js';
import { getByDotPath, type RunGatedCatalogOperationFn } from './source-mirror/fetch.js';
import {
  prepareWorkEntitySourceTargetedRead,
  runWorkEntitySourceTargetedRead,
  type WorkEntityTargetedReadPrepared,
} from './work-entity-write-executor.js';
import {
  isSourceRowTombstoned,
  projectWorkEntitySourceRow,
} from './work-entity-source-projector.js';
import {
  desiredWorkEntityEdgesForRow,
  reResolveWorkEntityEdges,
  type WorkEntityEdgeResolutionDeps,
} from './work-entity-edge-resolution.js';
import type { WorkEntityEdgeStore } from './storage/work-entity-edge-store.js';
import {
  runSourceMirrorFetch,
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from './source-mirror/fetch.js';
import { computeCompleteWalkDeletes } from './source-mirror/diff.js';
import type {
  WorkEntitySourceMirrorStore,
  WorkEntitySourceSyncStateStore,
} from './storage/work-entity-source-mirror.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import {
  getHousekeepingTask,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
  type HousekeepingTaskInstance,
} from './housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────

/** Minimal, fully-typed recipe identity for the scoped gateway ctx —
 *  audit rows attribute sync fetches to `work-entity-source-sync`.
 *  Never installed, never executed as a recipe. */
const SOURCE_SYNC_RECIPE: RecipeDefinition = {
  recipe_id: 'work-entity-source-sync',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Work-entity Source sync',
    description:
      'Synthetic identity for declared work-entity Source sync fetches (D-192 P3b). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export type RunSourceMirrorFetchFn = (
  deps: SourceMirrorFetchDeps,
  request: SourceMirrorFetchRequest,
) => Promise<SourceMirrorFetchOutcome>;

export interface WorkEntitySourceSyncDeps {
  fetchDeps: SourceMirrorFetchDeps;
  mirror: WorkEntitySourceMirrorStore;
  syncState: WorkEntitySourceSyncStateStore;
  /** D-192 P5 — the work-graph edge substrate. Optional: absent, a
   *  declaration's `relationships` project as `rel_*` hints only (the
   *  H3 posture). Row folds reconcile edges; tombstones cascade; a
   *  per-cycle pass re-resolves lagging sibling-Source targets. */
  edges?: WorkEntityEdgeStore;
  /** Injected lookups for reference resolution (contact stack, mirror,
   *  local-row reads). Only consulted when `edges` is wired. */
  edgeResolution?: WorkEntityEdgeResolutionDeps;
  now?: () => number;
  /** D-192 — resolve the bound connection's non-secret config for a Source's
   *  `op_arg_bindings.list` scoping args (Asana `workspace`, Google Tasks
   *  `tasklist`). Read PER CYCLE (not captured in the task closure) so a config
   *  value set AFTER the Source registered — a same-declaration connection
   *  upsert that does not re-register the task — is picked up on the next walk.
   *  Absent = no config (a list op with a bound arg then config-fails the
   *  cycle); a Source with no `op_arg_bindings.list` never consults it. */
  resolveConnectionConfig?: (connection_name: string) => Record<string, unknown> | undefined;
  /** D-192 source dependencies — the container-entity selection store. When
   *  wired, `resolve: 'persist'` dependencies resolve their bound list args here
   *  (auto-selecting a lone option). Absent = a Source declaring no persist deps
   *  is unaffected; one that does config-fails until the store is wired. */
  dependencyStore?: SourceDependencyEntityStore;
  /** Test seam for the dependency LIST fetch (a separate op from the sync walk's
   *  `runFetch`). Production omits it (real gated gateway). */
  runDependencyOperation?: RunGatedCatalogOperationFn;
  /** Test seam for the D-192 CORE #8b per-row hydration reads
   *  (`sync.list_rows: 'reference'`). Production omits it — hydration
   *  rides `runWorkEntitySourceTargetedRead`'s real gated invoke, so a
   *  make-live test scripts the read wire responses through the SAME
   *  `fetchDeps.buildExecutor` the list walk uses. */
  runHydrationOperation?: RunGatedCatalogOperationFn;
  /** Test seam — substitute the gated fetch (like the CRM
   *  reconciler's `runPoll`). Production omits it. */
  runFetch?: RunSourceMirrorFetchFn;
}

export interface WorkEntitySourceSyncInput {
  source_id: string;
  connection_name: string;
  declaration: KernelWorkEntitySourceDeclaration;
  /** The connection's vendor — drives P5 edge resolution (platform
   *  links, `crm_alias` composition). Null/absent = unknown vendor:
   *  vendor-dependent references stay hints. */
  vendor?: string | null;
}

export type WorkEntitySourceSyncResult =
  | {
      ok: true;
      upserted: number;
      unchanged: number;
      tombstoned: number;
      deleted: number;
      /** Rows that did not land this cycle — projection/store failures
       *  + unkeyed rows + hydration failures (`failed_hydration` is the
       *  hydration subset, broken out for observability). */
      failed_rows: number;
      /** D-192 CORE #8b — reference-list rows whose hydration read
       *  failed (per-row error / identity drift / per-cycle cap).
       *  Always 0 on a `list_rows: 'record'` Source. Included in
       *  `failed_rows`. */
      failed_hydration: number;
      /** D-192 P4b — changed rows NOT folded because a `pending` local
       *  edit is staged on them (the dirty-row guard): the write
       *  executor owns their reconciliation; overwriting here would
       *  destroy the local edit's values before its vendor push. */
      skipped_dirty: number;
      /** D-192 P5 — folded rows whose edge reconciliation threw (the
       *  ROW landed; only its work-graph edges are stale). Degrades
       *  the Source for the cycle like a row failure. */
      edge_failures: number;
      /** The walk's positive completeness proof (delete-diff gate). */
      complete: boolean;
    }
  | { ok: false; kind: 'config' | 'policy' | 'error' | 'unavailable'; reason: string };

/** Run one sync cycle for a declared work-entity Source. Records the
 *  outcome on the sync-state row; never throws. */
export const runWorkEntitySourceSync = async (
  deps: WorkEntitySourceSyncDeps,
  input: WorkEntitySourceSyncInput,
): Promise<WorkEntitySourceSyncResult> => {
  const { fetchDeps, mirror, syncState, edges } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const runFetch = deps.runFetch ?? runSourceMirrorFetch;
  const { source_id, connection_name, declaration } = input;
  if (declaration.sync.posture === 'read_through') {
    return {
      ok: false,
      kind: 'config',
      reason:
        `source '${source_id}' is read_through — generic reads invoke it on demand; `
        + 'a mirror sync cycle must not run',
    };
  }
  const expectedContractHash = workEntitySourceContractHash(declaration);
  /** A scheduled task captures a declaration, but pack updates and connection
   *  teardown can reconcile while that task is awaiting provider I/O. The
   *  registry posture + sync-state contract hash are the live authority. Check
   *  both before the cycle starts and after every await; a superseded closure
   *  must return without touching the replacement state or materializing rows. */
  const supersededReason = (): string | null => {
    const currentPosture = mirror.getSourceSyncPosture(source_id);
    if (currentPosture !== 'records') {
      return currentPosture === null
        ? `source '${source_id}' is no longer registered for records sync`
        : `source '${source_id}' now has '${currentPosture}' posture, not 'records'`;
    }
    const currentState = syncState.get(source_id);
    if (currentState === null) {
      return `source '${source_id}' has no current records sync-state authority`;
    }
    if (currentState.contract_hash !== expectedContractHash) {
      return `source '${source_id}' declaration changed while this sync task was in flight`;
    }
    return null;
  };
  const superseded = (reason: string): WorkEntitySourceSyncResult => ({
    ok: false,
    kind: 'config',
    reason: `${reason}; the superseded cycle made no further writes`,
  });
  const initialSuperseded = supersededReason();
  if (initialSuperseded !== null) return superseded(initialSuperseded);
  const vendor = input.vendor ?? null;
  const edgeDeps = deps.edgeResolution ?? {};
  // Edge reconciliation is per-FOLD work, and deliberately NOT gated
  // on the declaration carrying relationships: a declaration that
  // DROPS its relationships re-folds every hinted row (the blob loses
  // its `rel_*` keys → hash changes), and the empty desired set must
  // tombstone the now-unasserted edges — gating would strand them
  // forever. A relationship-less fold costs one indexed SELECT.
  const foldEdgeStore = edges;

  const failCycle = (
    kind: 'config' | 'policy' | 'error' | 'unavailable',
    error_code: string,
    reason: string,
  ): WorkEntitySourceSyncResult => {
    syncState.markCompleted(source_id, {
      ok: false,
      error_code,
      error_message: reason,
      degraded: true,
      now: now(),
    });
    return { ok: false, kind, reason };
  };

  syncState.markStarted(source_id, now());

  // ── family-specific resolution stage ──────────────────────────
  const kind = declaration.kind;
  const listOpKey = declaration.ops.list;
  if (listOpKey === undefined || listOpKey === null || listOpKey.length === 0) {
    return failCycle('config', 'config', `source '${source_id}' declares no list op — nothing to sync`);
  }
  const profile = fetchDeps.profiles.get(connection_name);
  if (profile === null) {
    return failCycle(
      'config', 'config',
      `connection '${connection_name}' has no operation profile (not enrolled?)`,
    );
  }
  const catalogSlug = profile.catalog_slug;
  if (catalogSlug === undefined || catalogSlug.length === 0) {
    return failCycle(
      'config', 'config',
      `connection '${connection_name}' carries no catalog binding — cannot resolve '${listOpKey}'`,
    );
  }
  const manifest: IngredientManifest | null =
    fetchDeps.executorConfig.manifests.get(catalogSlug) ?? null;
  if (manifest === null) {
    return failCycle('config', 'config', `catalog manifest '${catalogSlug}' is not installed`);
  }
  const opRow = manifest.operations?.[listOpKey];
  if (opRow === undefined) {
    return failCycle(
      'config', 'config',
      `catalog '${catalogSlug}' declares no '${listOpKey}' operation — source not syncable on this connection`,
    );
  }
  const resultPath = opRow.result_path ?? manifest.surfaces?.api?.result_path;
  if (resultPath === undefined || resultPath.length === 0) {
    return failCycle(
      'config', 'config',
      `catalog '${catalogSlug}' declares no result_path for '${listOpKey}' — cannot locate the record envelope`,
    );
  }

  // ── list scoping args (op_arg_bindings.list) ──────────────────
  // D-192 — a vendor whose list op needs a per-connection scoping arg (Asana
  // `GET /tasks` → workspace, Google Tasks `/lists/{tasklist}/tasks` → tasklist)
  // resolves it from the connection config here; a Source with no
  // `op_arg_bindings.list` yields `{}` — the pre-existing full-walk args. Read
  // the config PER CYCLE so a value set after registration is picked up. A
  // bound-but-unset key degrades the cycle BEFORE the fetch (never a bad request
  // the vendor 400s on and the diff then reads as an empty authoritative walk).
  const connectionConfig = deps.resolveConnectionConfig?.(connection_name);
  const listArgs = resolveConfigArgBindings(
    declaration.op_arg_bindings?.list,
    connectionConfig,
  );
  if (!listArgs.ok) {
    return failCycle(
      'config', 'config',
      `source '${source_id}' list op needs arg '${listArgs.arg}' from connection config `
      + `'${listArgs.config_key}', which is unset — configure it on the connection`,
    );
  }

  // ── list scoping args (source_dependencies, persist) ──────────
  // D-192 — a vendor whose list op is scoped by an unmodeled CONTAINER entity
  // (Asana workspace, Google Tasks tasklist) resolves the SELECTED entity here
  // and binds its id into the walk. A lone option auto-selects (single-workspace
  // Just Works); N/none config-fail the cycle (the picker resolves it). This
  // supersedes op_arg_bindings for the entity case; both merge, deps winning a
  // key overlap (a live selection beats static config). A declaration WITH
  // persist deps but NO wired store config-fails honestly (codex fold: the old
  // silent `{}` fallback left the walk unscoped — a wire failure at best, a
  // mis-scoped read at worst — while this comment claimed a config-fail).
  const hasPersistDeps =
    (declaration.source_dependencies ?? []).some((d) => d.resolve === 'persist');
  const depArgs = deps.dependencyStore !== undefined
    ? await resolvePersistDependencies(
        {
          fetchDeps, store: deps.dependencyStore,
          ...(deps.runDependencyOperation !== undefined ? { runOperation: deps.runDependencyOperation } : {}),
        },
        { source_id, declaration, connection_name, manifest, catalogSlug, now: now() },
      )
    : hasPersistDeps
      ? {
          ok: false as const,
          reason: 'declares persist source_dependencies but no dependency store is wired'
            + ' — the container selection cannot resolve',
        }
      : { ok: true as const, listArgs: {} };
  const dependencySuperseded = supersededReason();
  if (dependencySuperseded !== null) return superseded(dependencySuperseded);
  if (!depArgs.ok) {
    return failCycle('config', 'config', `source '${source_id}': ${depArgs.reason}`);
  }

  // ── reference-list hydration config (D-192 CORE #8b) ──────────
  // `sync.list_rows: 'reference'` — the list op returns identity-only
  // rows (Azure DevOps WIQL → `WorkItemReference[]`), so every listed
  // row is read through the declared read op before projection. The
  // read config resolves ONCE per cycle through the SAME prepare the
  // read-tool escalation and the write preflight use (op resolution +
  // `op_arg_bindings.read` + read-bound persist selections) — the
  // paths cannot drift. A failure here is cycle-level: every row's
  // hydration would fail identically, so degrade BEFORE the list call.
  const resolveDeclarationForHydration = (): {
    declaration: KernelWorkEntitySourceDeclaration;
    connection_name: string;
    connection_config?: Record<string, unknown>;
  } | null => ({
    declaration,
    connection_name,
    ...(connectionConfig !== undefined ? { connection_config: connectionConfig } : {}),
  });
  let hydrationRead: WorkEntityTargetedReadPrepared | null = null;
  if (declaration.sync.list_rows === 'reference') {
    const preparedRead = prepareWorkEntitySourceTargetedRead(
      {
        fetchDeps,
        resolveDeclaration: resolveDeclarationForHydration,
        ...(deps.dependencyStore !== undefined ? { dependencyStore: deps.dependencyStore } : {}),
      },
      { source_id },
    );
    if (!preparedRead.ok) {
      return failCycle('config', 'hydration_config', `source '${source_id}': ${preparedRead.reason}`);
    }
    hydrationRead = preparedRead.prepared;
  }

  // ── the gated + audited fetch (raw mode) ──────────────────────
  const outcome = await runFetch(fetchDeps, {
    connection_name,
    manifest,
    catalogSlug,
    operationKey: listOpKey,
    args: { ...listArgs.args, ...depArgs.listArgs }, // config args + resolved dependency selections
    resultPath,
    projectionTemplate: null,
    idField: declaration.remote.id,
    auditRecipe: SOURCE_SYNC_RECIPE,
    stepId: 'source_sync',
  });
  const fetchSuperseded = supersededReason();
  if (fetchSuperseded !== null) return superseded(fetchSuperseded);
  if (!outcome.ok) {
    return failCycle(outcome.kind, `fetch_${outcome.kind}`, outcome.reason);
  }

  // ── per-row: tombstone / hash-skip / dirty-guard / project + upsert
  const priorHashes = mirror.listSnapshotHashes(kind, source_id);
  // D-192 P4b — the dirty-row guard's input (spec § Conflict model:
  // "Clean row + source update: source_wins" — a DIRTY row is not
  // clean). One query per cycle; rows without a staged state absent.
  const pendingStates = mirror.listPendingWriteStates(kind, source_id);
  // D-192 P5 repair posture (codex HIGH): an edge write can fail AFTER
  // its mirror upsert stored the new row hash — the hash-skip would
  // then strand the stale/missing edges forever while health clears
  // OK. When the PRIOR cycle was degraded (for any reason), unchanged
  // rows re-reconcile their edges this cycle; healthy cycles pay
  // nothing.
  const repairEdges = edges !== undefined
    && syncState.get(source_id)?.degraded === true;
  const polledKeys = new Set<string>();
  // D-192 — SILENT-STALENESS observability. Tally which declared load-bearing
  // paths actually carried a value on the rows we saw. A path that NEVER does is
  // a phantom, and if every hash field is a phantom the record hash is constant,
  // every row reads "unchanged", and the mirror freezes forever with no error and
  // no symptom. `work-entity-source-field-health.ts` turns this into the signal.
  const healthPaths = declaredLoadBearingPaths(declaration);
  const healthRows: Array<Record<string, unknown>> = [];
  let upserted = 0;
  let unchanged = 0;
  let tombstoned = 0;
  let skipped_dirty = 0;
  let failed_rows = 0;
  let failed_hydration = 0;
  let hydratedCount = 0;
  let hydrationAbort: { kind: 'config' | 'policy'; reason: string } | null = null;
  let edge_failures = 0;
  let firstFailure: string | undefined;
  let firstHydrationFailure: string | undefined;
  let firstEdgeFailure: string | undefined;

  const recordEdgeFailure = (source_record_id: string, e: unknown): void => {
    edge_failures += 1;
    firstEdgeFailure ??= `${source_record_id}: ${e instanceof Error ? e.message : String(e)}`;
  };
  /** Reconcile one row's edges from its raw vendor state. Resolves the
   *  owner's local id when the caller doesn't have it (non-fold paths:
   *  dirty rows, repair sweeps). An edge failure never fails the row —
   *  it degrades the cycle (which arms the next cycle's repair sweep). */
  const reconcileRowEdges = (
    source_record_id: string,
    raw: Record<string, unknown>,
    owner_local_id?: string,
  ): void => {
    if (foldEdgeStore === undefined) return;
    try {
      const ownerId = owner_local_id
        ?? mirror.getBySourceIdentity(kind, source_id, source_record_id)?.id;
      if (ownerId === undefined) return;
      foldEdgeStore.reconcileRecordEdges({
        source_id,
        source_record_id,
        owner_kind: kind,
        owner_local_id: ownerId,
        desired: desiredWorkEntityEdgesForRow(
          { declaration, source_id, connection_name, vendor, raw },
          edgeDeps,
        ),
      }, now());
    } catch (e) {
      recordEdgeFailure(source_record_id, e);
    }
  };

  for (const [source_record_id, listRow] of outcome.records) {
    // ── hydration (D-192 CORE #8b) ── a reference row carries identity
    // only; the record truth comes from the read op. Failure taxonomy:
    // policy/config abort the CYCLE (the same verdict would deny every
    // remaining row — never N denied gated calls), error/unavailable
    // fail the ROW (a single record read can 404 independently; the
    // others still land), rows beyond the per-cycle cap fail closed.
    // Hydration-failed rows still count as LIVE for the delete diff
    // (listed = present remotely).
    let raw = listRow;
    if (hydrationRead !== null) {
      if (hydratedCount >= WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE) {
        polledKeys.add(source_record_id);
        failed_hydration += 1;
        firstHydrationFailure ??=
          `${source_record_id}: per-cycle hydration cap `
          + `(${WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE}) reached — narrow the list scope`;
        continue;
      }
      hydratedCount += 1;
      const read = await runWorkEntitySourceTargetedRead(
        {
          fetchDeps,
          resolveDeclaration: resolveDeclarationForHydration,
          ...(deps.runHydrationOperation !== undefined
            ? { runOperation: deps.runHydrationOperation }
            : {}),
        },
        {
          prepared: hydrationRead,
          source_record_id,
          stepId: 'source_sync_hydrate',
          auditRecipe: SOURCE_SYNC_RECIPE,
        },
      );
      const hydrationSuperseded = supersededReason();
      if (hydrationSuperseded !== null) return superseded(hydrationSuperseded);
      if (!read.ok) {
        if (read.kind === 'policy' || read.kind === 'config') {
          hydrationAbort = { kind: read.kind, reason: `${source_record_id}: ${read.reason}` };
          break;
        }
        polledKeys.add(source_record_id);
        failed_hydration += 1;
        firstHydrationFailure ??= `${source_record_id}: ${read.reason}`;
        continue;
      }
      // Identity-drift guard — the hydrated record must BE the listed one
      // (`remote.id` reads the same path on both shapes). Folding a
      // mismatched record under the listed key would corrupt the mirror,
      // so drift fails the row (the write path's verify holds the same
      // line against catalog read-op drift).
      const hydratedId = getByDotPath(read.record, declaration.remote.id);
      const hydratedKey = typeof hydratedId === 'string'
        ? hydratedId
        : typeof hydratedId === 'number' ? String(hydratedId) : '';
      if (hydratedKey !== source_record_id) {
        polledKeys.add(source_record_id);
        failed_hydration += 1;
        firstHydrationFailure ??=
          `${source_record_id}: hydrated record carries '${declaration.remote.id}' = '${hydratedKey}'`
          + ' — identity drift (does the catalog read op resolve a different record?)';
        continue;
      }
      raw = read.record;
    }
    if (isSourceRowTombstoned(declaration.sync, raw)) {
      // Vendor-side delete/archival marker on a fetched row. Only a
      // previously-mirrored live row tombstones (false return = never
      // mirrored / already tombstoned — nothing to do). A staged local
      // edit does not hold the row: the vendor deleted the record, the
      // pending push is moot.
      const rowTombstoned =
        mirror.tombstoneBySourceIdentity(kind, source_id, source_record_id, now());
      if (rowTombstoned) tombstoned += 1;
      // P5 — a dead row's work-graph edges die with it. An edge failure
      // degrades the cycle instead of rejecting the runner (codex
      // MEDIUM); a repair cycle retries already-dead rows the vendor
      // keeps returning, so a failed cascade heals next cycle.
      if (rowTombstoned || repairEdges) {
        try {
          edges?.tombstoneForRecord(source_id, source_record_id, now());
        } catch (e) {
          recordEdgeFailure(source_record_id, e);
        }
      }
      continue;
    }
    // Seen live on this walk — including rows that FAIL projection
    // below: a row we failed to project is still PRESENT remotely, so
    // it must never enter the delete diff as absent.
    polledKeys.add(source_record_id);
    // Tally BEFORE projection, deliberately: a row that fails to project is
    // still a real vendor record, and its field paths are exactly the evidence
    // we want. Excluding it would bias the tally toward the rows that happened
    // to work.
    if (healthPaths.length > 0) healthRows.push(raw);

    const projected = projectWorkEntitySourceRow({
      declaration,
      source_id,
      connection_name,
      source_record_id,
      raw,
    });
    if (!projected.ok) {
      failed_rows += 1;
      firstFailure ??= `${source_record_id}: ${projected.reason}`;
      continue;
    }
    const pending = pendingStates.get(source_record_id);
    if (priorHashes.get(source_record_id) === projected.upsert.write.source_record_hash) {
      // Vendor state equals the stored mirror. An `awaiting_verify`
      // row is thereby trivially verified — the write executor's
      // outstanding verification completes here (a value-idempotent
      // write); a `pending` row stays staged (its push hasn't run).
      if (pending === 'awaiting_verify') {
        mirror.clearPendingWriteBySourceIdentity(kind, source_id, source_record_id);
      }
      // P5 repair sweep (codex HIGH) — see `repairEdges` above.
      if (repairEdges) reconcileRowEdges(source_record_id, raw);
      unchanged += 1;
      continue;
    }
    if (pending === 'pending') {
      // D-192 P4b dirty-row guard — the row's canonical fields hold a
      // local edit whose vendor push hasn't landed. A sync overwrite
      // here would destroy the edit's VALUES while the staged marker
      // (dirty-field names + bases) survives — the write executor's
      // read-before-write compare owns this reconciliation. The row's
      // `source_*` base columns stay stable too, so the staged bases
      // keep meaning what they meant at edit time.
      //
      // P5 (codex HIGH) — the row's EDGES still fold: relationships are
      // derived REMOTE state a local edit can never touch (relationship
      // `write_back` is fail-closed false, FK columns aren't writable
      // lanes), so the vendor's association truth lands even while the
      // VALUE fold is held. Idempotent with the eventual post-push fold.
      reconcileRowEdges(source_record_id, raw);
      skipped_dirty += 1;
      continue;
    }
    try {
      const written = mirror.upsertBySourceIdentity(projected.upsert, now());
      upserted += 1;
      // `awaiting_verify` — the vendor write landed but the executor's
      // verification could not complete; THIS fold is the deferred
      // verification (the vendor truth is now stored), so the state
      // clears.
      if (pending === 'awaiting_verify') {
        mirror.clearPendingWriteBySourceIdentity(kind, source_id, source_record_id);
      }
      // D-192 P5 — reconcile the folded row's work-graph edges from the
      // SAME raw row. Fold-time reconciliation is sound for vendor-side
      // changes (relationship hints ride the extension blob, which
      // participates in `source_record_hash`, so any association change
      // re-folds the row); edge-write failures are covered by the
      // degraded-cycle repair sweep above. An edge failure never
      // un-lands the row — it degrades the cycle like a row failure.
      reconcileRowEdges(source_record_id, raw, written.id);
    } catch (e) {
      // Store validation (canonical caps, kind cross) — a row failure,
      // not a cycle abort; the remaining rows still land.
      failed_rows += 1;
      firstFailure ??= `${source_record_id}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── hydration abort — a policy/config read verdict is Source-level ─
  // (the same gate would deny every remaining row). Rows already folded
  // stay (valid vendor truth); returning HERE guarantees the delete
  // diff below never runs on the aborted walk (polledKeys is
  // incomplete — absence proves nothing).
  if (hydrationAbort !== null) {
    return failCycle(
      hydrationAbort.kind,
      `hydration_${hydrationAbort.kind}`,
      `source '${source_id}' hydration read failed: ${hydrationAbort.reason}`,
    );
  }

  // ── absence-based deletes — fail-closed on every axis ─────────
  // Gate: declared `missing_means_deleted` semantics with a declared
  // complete-authoritative list scope, a POSITIVE completeness proof
  // from the gateway walk (`complete`, never `!truncated`), and zero
  // unkeyable rows (a row we could not key is a row we cannot prove
  // absent). Anything less ⇒ zero deletes this cycle.
  let deleted = 0;
  if (
    declaration.sync.tombstones === 'missing_means_deleted'
    && declaration.sync.list_scope === 'complete_authoritative'
    && outcome.complete
    && outcome.skipped_no_id === 0
  ) {
    for (const gone of computeCompleteWalkDeletes({
      complete: outcome.complete,
      priorKeys: priorHashes.keys(),
      polledKeys,
    })) {
      if (mirror.tombstoneBySourceIdentity(kind, source_id, gone, now())) {
        deleted += 1;
        // Edge cascade failure degrades the cycle, never rejects the
        // runner (codex MEDIUM). Note the residue: a row absent from
        // every later walk can't be retried by the repair sweep — its
        // stranded edges are only reachable via listByTarget, and the
        // owner row is tombstoned (invisible to reads).
        try {
          edges?.tombstoneForRecord(source_id, gone, now());
        } catch (e) {
          recordEdgeFailure(gone, e);
        }
      }
    }
  }

  // ── P5 late re-resolution — fill `work:`-scoped edges whose sibling
  // Source has synced since they were written (a task→project edge
  // written before the project Source's first cycle). Bounded batch;
  // a failure here is an edge failure, never a cycle abort.
  if (edges !== undefined) {
    try {
      reResolveWorkEntityEdges(edges, edgeDeps, source_id, now);
    } catch (e) {
      edge_failures += 1;
      firstEdgeFailure ??= `re-resolution: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── D-192 silent-staleness tally ──────────────────────────────
  // Folded BEFORE `markCompleted` and regardless of how the cycle ends: a walk
  // that ultimately degrades still proved which paths carried values on the rows
  // it DID see, and that evidence is worth keeping. A cycle that polled nothing
  // writes nothing (no rows ⇒ no evidence ⇒ no dilution of the denominator).
  if (healthPaths.length > 0 && healthRows.length > 0) {
    const priorBlob = syncState.get(source_id)?.field_health_blob ?? null;
    let prior: WorkEntitySourceFieldHealth | null = null;
    if (priorBlob !== null) {
      try {
        prior = JSON.parse(priorBlob) as WorkEntitySourceFieldHealth;
      } catch {
        // A corrupt blob is observability data, never correctness data — start
        // the tally over rather than fail a sync cycle over a diagnostic.
        prior = null;
      }
    }
    const merged = mergeFieldHealth(prior, tallyCycleFieldHealth(healthPaths, healthRows));
    syncState.mergeFieldHealth(source_id, JSON.stringify(merged));
  }

  // ── record the cycle on the sync-state row ────────────────────
  if (failed_rows > 0 || failed_hydration > 0 || outcome.skipped_no_id > 0 || edge_failures > 0) {
    const parts: string[] = [];
    if (failed_hydration > 0) parts.push(`${failed_hydration} row(s) failed hydration (first: ${firstHydrationFailure})`);
    if (failed_rows > 0) parts.push(`${failed_rows} row(s) failed projection (first: ${firstFailure})`);
    if (outcome.skipped_no_id > 0) parts.push(`${outcome.skipped_no_id} row(s) carried no '${declaration.remote.id}' id`);
    if (edge_failures > 0) parts.push(`${edge_failures} row(s) failed edge reconciliation (first: ${firstEdgeFailure})`);
    syncState.markCompleted(source_id, {
      ok: false,
      // Pipeline order — a hydration failure precedes projection.
      error_code: failed_hydration > 0
        ? 'hydration_failed'
        : failed_rows > 0
          ? 'projection_failed'
          : outcome.skipped_no_id > 0 ? 'rows_unkeyed' : 'edges_failed',
      error_message: parts.join('; '),
      degraded: true,
      now: now(),
    });
  } else {
    // D-192 CORE #8f — a clean cycle (no failed rows) can still cover only a
    // PARTIAL list: a Source list op with no `pagination` mirrors the first
    // page only, and a paginated walk can truncate. Persist that completeness
    // so the freshness verdict is honest (distinct from `degraded`, which this
    // branch never sets).
    syncState.markCompleted(source_id, {
      ok: true, cursor_blob: null, complete: outcome.complete, now: now(),
    });
  }

  return {
    ok: true,
    upserted,
    unchanged,
    tombstoned,
    deleted,
    failed_rows: failed_rows + outcome.skipped_no_id + failed_hydration,
    failed_hydration,
    skipped_dirty,
    edge_failures,
    complete: outcome.complete,
  };
};

// ────────────────────────────────────────────────────────────────
// Housekeeping task + wire
// ────────────────────────────────────────────────────────────────

export const workEntitySourceSyncTaskId = (source_id: string): string =>
  `work-entity-source-sync.${source_id}`;

const buildWorkEntitySourceSyncTask = (
  deps: WorkEntitySourceSyncDeps,
  input: WorkEntitySourceSyncInput,
): HousekeepingTaskInstance => ({
  meta: {
    id: workEntitySourceSyncTaskId(input.source_id),
    description:
      `Sync ${input.declaration.kind} Source '${input.source_id}' from connection '${input.connection_name}'`,
    // One gated list walk per cycle — no mid-walk checkpoint, so the
    // scheduler only steps this task with a full cycle budget.
    interruptible: false,
    kind: 'core',
    idle_eligible: true,
  },
  async step(ctx, _cursor, _budget_ms) {
    // Health lives on the sync-state row (the read resolver's
    // freshness input) — a failed cycle is a recorded outcome, not a
    // task error (CRM reconciler precedent: retry next idle window).
    await runWorkEntitySourceSync({ ...deps, now: deps.now ?? ctx.now }, input);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

export interface WireWorkEntitySourceSyncInput {
  connectionStore: ConnectionStoreSqlite;
  fetchDeps: SourceMirrorFetchDeps;
  mirror: WorkEntitySourceMirrorStore;
  syncState: WorkEntitySourceSyncStateStore;
  /** D-192 P5 — the work-graph edge substrate + its resolution lookups.
   *  Optional together: without them relationships stay `rel_*` hints. */
  edges?: WorkEntityEdgeStore;
  edgeResolution?: WorkEntityEdgeResolutionDeps;
  /** D-192 — the container-entity selection store (persist-dependency
   *  list scoping + CORE #8b hydration read args). Absent → a Source
   *  declaring persist deps config-fails its cycle. */
  dependencyStore?: SourceDependencyEntityStore;
  /** The SAME resolver the boot wire threads (kernel-only when
   *  absent) — sync tasks and Source registration enumerate one
   *  declaration set. */
  resolveCatalogManifest?: (row: ConnectionRow) => IngredientManifest | null | undefined;
  now?: () => number;
}

/** The handle `wireWorkEntitySourceSync` returns — the install/uninstall
 *  live-reconcile primitive (mirrors `WorkEntitySourceBootWiring`). */
export interface WorkEntitySourceSyncWiring {
  /** (Re)reconcile ONE connection's sync tasks NOW, by name — the install/
   *  uninstall counterpart to the upsert observer, which fires only when the
   *  connection ROW changes, NOT when a composition reinstall merely rewrites the
   *  catalog manifest. A reinstall that alters the declaration under a stable
   *  `source_id` would otherwise leave the sync task running against the STALE
   *  declaration closure until the next upsert / restart. Idempotent. */
  reconcileConnection: (connectionName: string) => void;
}

/** Wire one housekeeping sync task per registered connection-Source
 *  with a declaration. Idempotent boot scan + upsert/delete observers
 *  on the connection store, mirroring `wireCanonicalCrmReconciliation`.
 *  Returns the by-name reconcile the install/uninstall deps drive. */
export const wireWorkEntitySourceSync = (
  input: WireWorkEntitySourceSyncInput,
): WorkEntitySourceSyncWiring => {
  const { connectionStore, resolveCatalogManifest } = input;
  const deps: WorkEntitySourceSyncDeps = {
    fetchDeps: input.fetchDeps,
    mirror: input.mirror,
    syncState: input.syncState,
    // Per-cycle config read (NOT closure-captured) — the sync task's declaration
    // closure only re-registers on a declaration-hash change, so a config-only
    // upsert (setting the workspace/tasklist after enrollment) must be observed
    // at RUN time or the list op would config-fail until restart.
    resolveConnectionConfig: (connection_name: string): Record<string, unknown> | undefined => {
      const row = connectionStore.get('api', connection_name);
      return row === null ? undefined : connectionConfigOf(row);
    },
    ...(input.edges ? { edges: input.edges } : {}),
    ...(input.edgeResolution ? { edgeResolution: input.edgeResolution } : {}),
    ...(input.dependencyStore ? { dependencyStore: input.dependencyStore } : {}),
    ...(input.now ? { now: input.now } : {}),
  };

  // Task ids this wire registered, per connection name → the declaration
  // CONTRACT HASH each was registered WITH. The hash (the boot wire's
  // `seedSyncState` pin) lets the reconcile re-register a task whose declaration
  // CHANGED under a stable source_id (a pack reinstall's new projection / ops /
  // pin) instead of skipping it — the stale closure the old skip-if-exists kept.
  const registered = new Map<string, Map<string, string>>();

  const reconcile = (row: ConnectionRow | null, connection_name: string): void => {
    const desired = row === null
      ? []
      : desiredWorkEntitySourcesFor(row, resolveCatalogManifest)
          .filter((d) => d.sync_posture === 'records');
    // P5 — the vendor rides each task's input so edge resolution can
    // consult platform links + the `crm_alias` registry.
    const vendor = row === null ? null : connectionVendorOf(row);
    const desiredByTaskId = new Map(
      desired.map((d) => [workEntitySourceSyncTaskId(d.id), d] as const),
    );
    const current = registered.get(connection_name) ?? new Map<string, string>();
    // Deregister tasks no longer desired (vendor flip / declaration removal / delete).
    for (const taskId of [...current.keys()]) {
      if (!desiredByTaskId.has(taskId)) {
        unregisterHousekeepingTask(taskId);
        current.delete(taskId);
      }
    }
    // Register new tasks + RE-register any whose declaration changed, so a
    // reinstall's fresh declaration replaces the captured closure at once.
    for (const [taskId, d] of desiredByTaskId) {
      const hash = workEntitySourceContractHash(d.declaration);
      const alreadyRegistered = getHousekeepingTask(taskId) !== undefined;
      if (alreadyRegistered && current.get(taskId) === hash) continue;
      if (alreadyRegistered) unregisterHousekeepingTask(taskId);
      registerHousekeepingTask(buildWorkEntitySourceSyncTask(deps, {
        source_id: d.id,
        connection_name,
        declaration: d.declaration,
        vendor,
      }));
      current.set(taskId, hash);
    }
    if (current.size > 0) registered.set(connection_name, current);
    else registered.delete(connection_name);
  };

  // Boot scan — every already-enrolled api connection.
  for (const row of connectionStore.list({ kind: 'api' })) reconcile(row, row.name);

  // Future enrollments + vendor flips. Non-api upserts are ignored for
  // the same reason the boot wire ignores them: a non-api row may
  // coexist with an api row under the same name.
  connectionStore.addOnUpsert((row) => {
    if (row.kind === 'api') reconcile(row, row.name);
  });

  // Deletions — the desired set is empty; every task this wire
  // registered for the name deregisters.
  connectionStore.addOnDelete((kind, name) => {
    if (kind === 'api') reconcile(null, name);
  });

  // D-192 — the by-name reconcile the install/uninstall deps drive post-commit
  // (a reinstall rewrites the manifest WITHOUT a connection upsert). The
  // `composeAppContext` fan-out drives this alongside the boot wire's reconcile,
  // so a reinstalled pack's Source registration AND its sync task re-derive
  // together — the boot reconcile re-registers the Source, this swaps the sync
  // task's stale declaration closure for the fresh one.
  const reconcileConnection = (connection_name: string): void => {
    reconcile(connectionStore.get('api', connection_name), connection_name);
  };

  return { reconcileConnection };
};
