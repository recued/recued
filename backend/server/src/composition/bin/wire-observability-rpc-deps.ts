/** Observability rpc-deps composer.
 *
 *  Bundles five rpc-deps slices that share the "server-introspection"
 *  theme but were previously inlined as five separate fields inside
 *  `createServerHandlerSet({...})`:
 *
 *    1. **`recipeListDeps`** — `recipe.list` backend (D-119 P5). Always
 *       defined; just packages the recipe store + the boot-time
 *       `serverStartedAt` fallback for bundled-recipe `installed_at`.
 *    2. **`approvalDeps`** — `approval.{list,resolve,subscribe}` (D-119
 *       P10). Always defined; wraps the in-memory approval store +
 *       carries a `pushToClient` closure that serialises the event onto
 *       the WsClient's pair-WS channel. The `try / readyState === 1`
 *       guard mirrors the pre-extraction inline so disconnect races
 *       silently drop without aborting the subscribe handler.
 *    3. **`eventsDeps`** — D-121 P6 broadcast bus rpc. Always defined;
 *       a trivial `{ bus }` wrapper.
 *    4. **`auditExportDeps`** — D-120 P7 unified memory export rpc
 *       (estimate + page). Conditional on `db && auditLog` — both are
 *       absent in dbless harnesses. `serverInstanceId` surfaces in the
 *       envelope's `instance_id` field.
 *    5. **`statusPageDeps`** — D-116 follow-up `/status` HTML mirror +
 *       `/status.json` realm-token-gated route. Conditional on
 *       `pairing && circuitStore`. `buildSummary` reads
 *       `getAutoRunHandle()` at REQUEST time (the auto-run scheduler is
 *       built a few hundred LOC further down in cmdServe), so a
 *       pre-startup curl just sees an empty roster instead of a TDZ /
 *       reference-error.
 *
 *  Caller-side spread shape — fields 1-3 always present, fields 4-5
 *  conditional:
 *
 *  ```ts
 *  const obs = composeObservabilityRpcDeps({...});
 *  createServerHandlerSet({
 *    recipeListDeps: obs.recipeListDeps,
 *    approvalDeps:   obs.approvalDeps,
 *    eventsDeps:     obs.eventsDeps,
 *    ...(obs.auditExportDeps ? { auditExportDeps: obs.auditExportDeps } : {}),
 *    ...(obs.statusPageDeps  ? { statusPageDeps:  obs.statusPageDeps  } : {}),
 *    // ...other deps
 *  });
 *  ```
 *
 *  Late-binding contract for `getAutoRunHandle`: the auto-run
 *  scheduler's `SchedulersBundle.autoRun?.getHandle()` is published by
 *  `composeSchedulers` later in cmdServe. The composer captures a
 *  thunk that reads the live handle at request time so a `/status`
 *  curl before the scheduler boots returns an empty summary instead
 *  of throwing.
 *
 *  Returns 3 always-defined + 2 conditional fields rather than a
 *  single bundle gated on one predicate — the five deps surfaces are
 *  independent (e.g. `recipe.list` works in a dbless harness even
 *  though `audit.export.*` is `not_configured`). */

import { loadBundledPackManifests } from '../../bundled-pack-source.js';
import type Database from 'better-sqlite3';
import type { LaneStatus } from '@recued/contracts';
import type { AuditLogStore, CheckpointStore, CommitStore } from '@recued/storage';
import type { CircuitBreakerStore, ServerAutoRunHandle } from '../../auto-run-scheduler.js';
import { summarizeAutoDisabled } from '@recued/scheduler';
import type {
  ApprovalHandlerDeps,
  ApprovalStore,
} from '../../approval-handler.js';
import type { AuditExportRpcDeps } from '../../audit-export-handler.js';
import type { ExecutionFeedRpcDeps } from '../../execution-feed-handler.js';
import type { GatedActionStore } from '../../gated-action-store.js';
import type { EventBus } from '../../events/bus.js';
import type { PairingManager } from '../../pairing.js';
import type { RecipeListHandlerDeps } from '../../recipe-list-handler.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { StatusPageDeps } from '../../status-page.js';

export interface ComposeObservabilityRpcDepsInput {
  /** Recipe store — required (always populated at boot). Backs
   *  `recipeListDeps` + the `lookupName` closure inside `statusPageDeps.
   *  buildSummary`. */
  recipeStore: RecipeStore;
  /** In-memory approval store — required (always populated at boot). */
  approvalStore: ApprovalStore;
  /** Override for the bundled pack directory, forwarded to the
   *  `provably_read_only` projection's roster. Undefined uses the bundled
   *  location, exactly as every other reader of that roster does. */
  packDir?: string;
  /** D-121 broadcast bus — required (always populated at boot). */
  eventBus: EventBus;
  /** Epoch ms at server boot. Surfaces as the fallback `installed_at`
   *  for bundled recipes that don't track their own first-seen time. */
  serverStartedAt: number;
  /** SQLite handle. Gates `auditExportDeps` alongside `auditLog`. */
  db: Database.Database | undefined;
  /** Audit log store. Gates `auditExportDeps` and `executionFeedDeps`
   *  alongside `db`. */
  auditLog: AuditLogStore | undefined;
  /** D-157 checkpoint store. Gates `executionFeedDeps` so
   *  `execution.get` can join approval pause points. */
  checkpointStore: CheckpointStore | undefined;
  /** D-153 commit store. Gates `executionFeedDeps` so Runs can read
   *  real per-call Gateway trace rows by run id. */
  commitStore: CommitStore | undefined;
  /** Operation-scoped approval outcome receipts. */
  gatedActionStore?: GatedActionStore;
  /** Pair-instance id. Surfaces in the audit-export envelope's
   *  `instance_id` field + optionally the status page header. Always
   *  defined in bin.ts (initialised to `'server'` then overwritten on
   *  pair-store read). */
  serverInstanceId: string;
  /** Pairing manager. Gates `statusPageDeps` alongside `circuitStore`;
   *  supplies the realm token for the `/status` route auth check +
   *  optionally the server id surfaced in the page header. */
  pairing: PairingManager | undefined;
  /** Auto-run circuit-breaker store. Gates `statusPageDeps` alongside
   *  `pairing`; supplies the `last_failure_reason` lookup in
   *  `buildSummary`. */
  circuitStore: CircuitBreakerStore | undefined;
  /** Late-bound auto-run handle getter. The auto-run scheduler is
   *  composed AFTER this composer call in cmdServe; the thunk reads
   *  the live handle at `/status` request time. Returns undefined
   *  while the scheduler is still booting → empty summary. */
  getAutoRunHandle: () => ServerAutoRunHandle | undefined;
  /** D-181 §12 — live per-lane long-op governor occupancy for the
   *  `/status` lanes line. Wired off the in-flight registry
   *  (`registry.laneStatus()`) when the execute deps are present; absent
   *  (dbless / unwired registry) ⇒ the lanes section is omitted. Read at
   *  request time inside `statusPageDeps.laneStatus`. */
  getLaneStatus?: () => LaneStatus[];
}

export interface ObservabilityRpcBundle {
  /** Threaded into `createServerHandlerSet({ recipeListDeps })`.
   *  Always defined — `recipe.list` works in dbless harnesses too
   *  (bundled recipes only). */
  recipeListDeps: RecipeListHandlerDeps;
  /** Threaded into `createServerHandlerSet({ approvalDeps })`.
   *  Always defined — the approval store is in-memory + boot-
   *  unconditional. */
  approvalDeps: ApprovalHandlerDeps;
  /** Threaded into `createServerHandlerSet({ eventsDeps })`. Always
   *  defined — the bus is boot-unconditional. */
  eventsDeps: { bus: EventBus };
  /** Conditional on `db && auditLog`. Caller drops the spread when
   *  undefined → `audit.export.{estimate,page}` returns
   *  `not_configured`. */
  auditExportDeps: AuditExportRpcDeps | undefined;
  /** Conditional on `db && auditLog && checkpointStore && commitStore`.
   *  Caller drops the spread when undefined → `execution.{list,get}` returns
   *  `not_configured`. */
  executionFeedDeps: ExecutionFeedRpcDeps | undefined;
  /** Conditional on `pairing && circuitStore`. Caller drops the
   *  spread when undefined → the `/status` HTML + JSON routes 404. */
  statusPageDeps: StatusPageDeps | undefined;
}

export const composeObservabilityRpcDeps = (
  input: ComposeObservabilityRpcDepsInput,
): ObservabilityRpcBundle => {
  const {
    recipeStore,
    approvalStore,
    packDir,
    eventBus,
    serverStartedAt,
    db,
    auditLog,
    checkpointStore,
    commitStore,
    gatedActionStore,
    serverInstanceId,
    pairing,
    circuitStore,
    getAutoRunHandle,
    getLaneStatus,
  } = input;

  const recipeListDeps: RecipeListHandlerDeps = {
    store: recipeStore,
    serverStartedAt,
    /** ⛔ A THUNK, NOT A VALUE. Read per call so a pack installed since boot is
     *  in the roster; the loader caches per unchanged tree, so re-reading is a
     *  stat sweep rather than a re-parse. The roster is deliberately every
     *  BUNDLED pack, not just the installed ones — a pack's recipes routinely
     *  call ops from dependency packs, and an op that does not resolve makes
     *  the read-only rule fail closed on a recipe that is genuinely fine. */
    packRoster: () => loadBundledPackManifests(packDir).map((manifest) => ({
      slug: manifest.slug,
      publisher: manifest.publisher,
      name: manifest.name,
      manifest,
    })),
  };

  const approvalDeps: ApprovalHandlerDeps = {
    store: approvalStore,
    pushToClient: (client, payload) => {
      try {
        if (client.ws.readyState === 1) {
          client.ws.send(JSON.stringify(payload));
        }
      } catch { /* non-fatal — client disconnect race */ }
    },
  };

  const eventsDeps = { bus: eventBus };

  const auditExportDeps: AuditExportRpcDeps | undefined =
    db && auditLog
      ? { db, auditLog, serverInstanceId }
      : undefined;

  const executionFeedDeps: ExecutionFeedRpcDeps | undefined =
    db && auditLog && checkpointStore && commitStore
      ? {
          db,
          auditLog,
          checkpointStore,
          commitStore,
          serverInstanceId,
          ...(gatedActionStore !== undefined ? { gatedActionStore } : {}),
        }
      : undefined;

  const statusPageDeps: StatusPageDeps | undefined =
    pairing && circuitStore
      ? {
          realmToken: pairing.getRealmToken(),
          ...(serverInstanceId ? { serverId: serverInstanceId } : {}),
          // D-181 §12 — live lanes line. Absent getter ⇒ section omitted.
          ...(getLaneStatus ? { laneStatus: getLaneStatus } : {}),
          buildSummary: () => {
            const autoRunHandle = getAutoRunHandle();
            if (!autoRunHandle) return [];
            return summarizeAutoDisabled({
              roster: autoRunHandle.roster.values(),
              lookupName: (recipe_id) => {
                try {
                  const r = recipeStore.get(recipe_id);
                  return r?.metadata?.name ?? null;
                } catch { return null; }
              },
              lookupFailureReason: (recipe_id) => {
                try { return circuitStore.get(recipe_id)?.last_failure_reason; }
                catch { return undefined; }
              },
            });
          },
        }
      : undefined;

  return {
    recipeListDeps,
    approvalDeps,
    eventsDeps,
    auditExportDeps,
    executionFeedDeps,
    statusPageDeps,
  };
};
