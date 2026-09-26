/** R2 step 6 (write-saga) — torn-saga reconciliation (gateway-side leaf).
 *
 *  A multi-write canonical recipe is a cross-system SAGA: independent
 *  gated boundary calls with no 2PC across vendors (recipe-identity doc
 *  §1.3/§4). When a later step fails AFTER ≥1 catalog write landed —
 *  move = read A → create B → delete A, "B created, A-delete failed" —
 *  the run today ends as a generic failure while the landed writes
 *  persist silently. This leaf is the missing semantic, mirroring the
 *  `in_doubt` reconciliation leaf (D-157 P0) one grain up: the unit is
 *  a torn RUN, not a single uncertain commit.
 *
 *  The flow (no recipe at either end):
 *
 *    run terminal-failed + ≥1 landed catalog write (derived from the
 *    run's commits — `detectTornSaga`)
 *      → gateway: notification.ask("Recipe X failed after N action(s)
 *        had already gone through …", [Undo? / Keep as-is],
 *        handler kind `gateway.saga`)
 *      → user answers (any channel, durable across a restart)
 *      → on_answer → a fresh annotation linked to the run + the landed
 *        commits; `undo` ADDITIONALLY dispatches each derived
 *        compensation plan as a FRESH gated run via the injected
 *        dispatcher.
 *
 *  Posture (what this leaf does and refuses to do):
 *   - Detection is DERIVED, never stored — pure classification over
 *     the flat commit log ("store atomic facts, derive aggregates").
 *   - The saga ask ROUTES; it never ENFORCES. An `undo` answer
 *     dispatches a compensation run that flows through the normal door
 *     — dispatch-resolve → catalog gate → preflight `ask`/`always`
 *     approval — so the destructive undo is approved AT THE GATE like
 *     any other write (two asks by design; the gate is the gate).
 *   - This is NOT a violation of "no auto-resume, ever" (D-157 I-2):
 *     nothing here re-dispatches the FAILED call. `undo` dispatches a
 *     NEW, user-requested, separately-gated compensating action;
 *     retrying the failed remainder stays a fresh user-triggered
 *     run (the ask body says so, and offers no retry button).
 *   - `in_doubt` commits are NEVER compensable and never trigger a
 *     saga ask by themselves — their outcome is unknown (no recorded
 *     output, possibly no side effect), so they stay the `in_doubt`
 *     ask's jurisdiction; the saga ask mentions them as context only.
 *   - The commit log stays append-only; answers are fresh annotations.
 *
 *  Scope (v1): landed writes are CATALOG-form dispatches (the
 *  connection-api wire shape the catalog gateway emits). Simple-form
 *  wrapper writes (mail-send, …) surface only via the generic
 *  `other_actions` mention. The classifier reverse-maps a commit's
 *  wire `(method, path)` onto the catalog's REST `executes` table —
 *  ambiguous matches classify at the HIGHEST colliding risk and are
 *  never compensable (fail toward disclosure, away from undo).
 *
 *  Injected seams mirror `in-doubt-reconciliation.ts`: the notifier
 *  (D-158 block), the annotation writer, and — the one deliberate
 *  addition — the compensation dispatcher (host-side, over
 *  `handleExecute`). All three live server-side; `@recued/gateway`
 *  cannot reach them (public-boundary rule).
 */

import type { Commit, IngredientManifest } from '@recued/contracts';
import { RISK_TIER_RANK, describeCatalogOperation } from '@recued/contracts';
import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';

// ────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` for torn-saga reconciliation answers. The block
 *  persists this slug + the JSON payload — never a closure — so the
 *  handler survives a restart between ask and answer. */
export const SAGA_HANDLER_KIND: AskHandlerKind = 'gateway.saga';

/** The annotation `key` of a saga reconciliation memory row. */
export const SAGA_ANNOTATION_KEY = 'saga_reconciliation';

/** The annotation `target_collection` for a saga reconciliation. The
 *  unit is the RUN (the execution-request anchor), so the annotation
 *  targets `run:<run_id>` — a synthetic collection name, exactly like
 *  the `in_doubt` leaf's `'commit'`: `data.timeline()`'s annotation
 *  loader keys purely on `(target_collection, target_id)`, no schema
 *  change needed. The annotation VALUE additionally echoes the landed
 *  `commit_id`s as link keys. */
export const SAGA_TARGET_COLLECTION = 'run';

/** The two answers a saga ask offers:
 *   - `undo` — dispatch every derived compensation plan as a fresh
 *              gated run (each still requires its own preflight
 *              approval before anything crosses the boundary). Offered
 *              ONLY when ≥1 landed write derived a plan.
 *   - `keep` — record the torn state as acknowledged; change nothing.
 *  Both record the same annotation shape; they differ in the recorded
 *  `answer` and in whether the dispatcher fires. */
export const SAGA_ASK_OPTIONS = {
  undo: { id: 'undo', label: 'Undo' },
  keep: { id: 'keep', label: 'Keep as-is' },
} as const;

// ────────────────────────────────────────────────────────────────
// Detection — pure classification over the run's commits
// ────────────────────────────────────────────────────────────────

/** Risk ranking for the highest-colliding-risk rule — the canonical
 *  {@link RISK_TIER_RANK} (read 0 … destructive 3). Any non-read write ranks
 *  above `read`, so a landed one is surfaced for reconciliation, not dropped as
 *  `topRank <= read`. */
const RISK_RANK = RISK_TIER_RANK;

/** One confirmed-landed catalog write inside a torn run. Field shape
 *  is structurally compatible with `@recued/recipes`'
 *  `LandedCatalogWrite` (no cross-package import — layering). */
export interface TornSagaWrite {
  commit_id: string;
  /** Catalog `operations` map key (vendor-entity-keyed,
   *  `'opportunity.create'`). Empty string for an UNCLASSIFIED write
   *  (non-GET api dispatch whose wire pair matched no `executes` row —
   *  manifest drift; disclosed, never compensable). */
  operation_key: string;
  /** Publisher-scoped operation id for display; for an unclassified
   *  write, a `"<METHOD> <path>"` rendering. */
  operation_id: string;
  /** Resolved effective risk — the HIGHEST risk among the matched ops
   *  when the wire pair is ambiguous; `'write'` assumed for an
   *  unclassified non-GET dispatch. */
  risk_tier: string;
  catalog_slug: string;
  /** The resolved connection the write targeted (wire `connection`);
   *  empty string when absent on the commit args. */
  connection_name: string;
  /** The commit's recorded output — carries the created record id a
   *  compensation derives from. */
  output: unknown;
  dispatched_at: number;
  /** True iff the wire pair matched EXACTLY ONE declared op (an
   *  ambiguous or unclassified write must never derive an undo). */
  unambiguous: boolean;
}

/** The derived torn-saga summary for one failed run. */
export interface TornSaga {
  run_id: string;
  recipe_id: string;
  /** Confirmed-landed (status `succeeded`) catalog writes —
   *  write/admin/destructive tier, plus unclassified non-GET api
   *  dispatches. ≥1 entry by construction (else `detectTornSaga`
   *  returns null). Dispatch order (oldest first). */
  landed_writes: TornSagaWrite[];
  /** Catalog writes that FAILED (the step that tore the saga) —
   *  narrative context for the ask body. */
  failed_writes: TornSagaWrite[];
  /** `in_doubt` commits of this run (any ingredient) — outcome
   *  unknown; reconciled separately by the `in_doubt` ask.
   *
   *  ⛔ `write` WAS ALWAYS DERIVABLE AND WAS ALWAYS SKIPPED. The classifier that
   *  names `landed_writes` and `failed_writes` runs two lines below the
   *  `in_doubt` branch, on the same commit, with the same manifest getter — the
   *  branch just `continue`d before reaching it. So the ask could only ever say
   *  "1 call crashed unconfirmed" while holding everything needed to say which.
   *  Null for a non-catalog commit, exactly as for any unclassifiable dispatch. */
  uncertain: { commit_id: string; ingredient: string; write: TornSagaWrite | null }[];
  /** Other landed side-effect commits (`kind: 'action'`, non-catalog)
   *  — mentioned for honesty, never compensable here. */
  other_actions: { commit_id: string; ingredient: string }[];
}

/** True when the manifest is catalog-form with a REST surface — the
 *  shape whose dispatches this leaf can classify. */
const isCatalogManifest = (
  manifest: IngredientManifest | undefined,
): manifest is IngredientManifest =>
  manifest !== undefined
  && manifest.operations !== undefined
  && Object.keys(manifest.operations).length > 0
  && manifest.surfaces?.api?.executes !== undefined;

/** Reverse-map a commit's wire `(method, path)` onto the catalog's
 *  REST `executes` table. Returns every matching op key — the shipped
 *  catalogs collide on reads (Salesforce's three SOQL searches share
 *  `GET /query`), so a multi-match is a real, expected shape. */
const matchOperations = (
  manifest: IngredientManifest,
  method: string,
  path: string,
): string[] => {
  const executes = manifest.surfaces?.api?.executes ?? {};
  const matches: string[] = [];
  for (const [key, binding] of Object.entries(executes)) {
    const b = binding as { kind?: unknown; method?: unknown; path_template?: unknown };
    if (b.kind !== 'rest') continue;
    if (b.method !== method) continue;
    if (b.path_template !== path) continue;
    matches.push(key);
  }
  return matches;
};

/** Classify one commit against its catalog manifest. Returns null for
 *  a non-catalog dispatch or a read-tier call. */
const classifyCatalogWrite = (
  commit: Commit,
  manifest: IngredientManifest,
): TornSagaWrite | null => {
  const args = commit.args as Record<string, unknown>;
  if (args.connection_kind !== 'api') return null;
  const method = typeof args.method === 'string' ? args.method : '';
  const path = typeof args.path === 'string' ? args.path : '';
  if (method === '' || path === '') return null;
  const connection =
    typeof args.connection === 'string' ? args.connection : '';

  const matches = matchOperations(manifest, method, path);
  if (matches.length === 0) {
    // Unclassified non-GET api dispatch — the binding came FROM the
    // manifest at dispatch time, so a miss here means the manifest
    // drifted between dispatch and detection. GET is read-shaped;
    // anything else is disclosed as an assumed write (fail toward
    // disclosure), never compensable.
    //
    // Deliberate trade (codex LOW, held): an unmatched GET is DROPPED,
    // not disclosed. Disclosing drifted GETs would turn every failed
    // run that searched through a since-edited catalog into a saga ask
    // (false-positive ask fatigue); a side-effecting GET op would need
    // a vendor-API anomaly AND manifest drift simultaneously. If a
    // catalog ever declares a side-effecting GET, revisit — persisted
    // per-commit operation metadata (stepMeta → commit `detail`) is the
    // drift-proof classification follow-on.
    if (method === 'GET') return null;
    return {
      commit_id: commit.commit_id,
      operation_key: '',
      operation_id: `${method} ${path}`,
      risk_tier: 'write',
      catalog_slug: commit.ingredient,
      connection_name: connection,
      output: commit.output,
      dispatched_at: commit.dispatched_at,
      unambiguous: false,
    };
  }

  const operations = manifest.operations ?? {};
  let topKey = matches[0];
  let topRank = -1;
  for (const key of matches) {
    const rank = RISK_RANK[operations[key]?.risk_tier ?? ''] ?? 0;
    if (rank > topRank) {
      topRank = rank;
      topKey = key;
    }
  }
  // Highest colliding risk ≤ read ⇒ a read call — not saga material.
  if (topRank <= RISK_RANK.read) return null;

  return {
    commit_id: commit.commit_id,
    operation_key: topKey,
    operation_id: operations[topKey]?.operation_id ?? topKey,
    risk_tier: operations[topKey]?.risk_tier ?? 'write',
    catalog_slug: commit.ingredient,
    connection_name: connection,
    output: commit.output,
    dispatched_at: commit.dispatched_at,
    unambiguous: matches.length === 1,
  };
};

/** Derive the torn-saga summary for one FAILED run from its commits,
 *  or null when the run landed no catalog write (an ordinary failure —
 *  no saga to reconcile). Pure; the caller supplies the run's commits
 *  (`CommitStore.listByRun`) and a manifest getter.
 *
 *  The caller is responsible for the run-level trigger predicate
 *  (terminal failure, not awaiting approval, not trigger-skipped) —
 *  this function only answers "did writes land before it died?". */
/** Name one commit's operation for an owner-facing ask, or null when it is not
 *  a classifiable catalog dispatch. Shared with the in-doubt leaf so both asks
 *  describe a call the same way. */
export const describeCommitOperation = (
  commit: Commit,
  getManifest: (slug: string) => IngredientManifest | undefined,
): string | null => {
  const manifest = getManifest(commit.ingredient);
  const write = isCatalogManifest(manifest) ? classifyCatalogWrite(commit, manifest) : null;
  return write === null ? null : describeWrite(write);
};

export const detectTornSaga = (input: {
  run_id: string;
  recipe_id: string;
  /** The run's commits, any order. */
  commits: readonly Commit[];
  /** Manifest lookup for classification; `undefined` for an unknown
   *  slug (its commits then surface only via `other_actions` /
   *  `uncertain`). */
  getManifest: (slug: string) => IngredientManifest | undefined;
}): TornSaga | null => {
  const landed: TornSagaWrite[] = [];
  const failed: TornSagaWrite[] = [];
  const uncertain: TornSaga['uncertain'] = [];
  const other: TornSaga['other_actions'] = [];

  const ordered = [...input.commits].sort(
    (a, b) => a.dispatched_at - b.dispatched_at,
  );
  for (const commit of ordered) {
    const manifest = input.getManifest(commit.ingredient);
    const write = isCatalogManifest(manifest)
      ? classifyCatalogWrite(commit, manifest)
      : null;
    if (commit.status === 'in_doubt') {
      uncertain.push({
        commit_id: commit.commit_id,
        ingredient: commit.ingredient,
        write,
      });
      continue;
    }
    if (write !== null && commit.status === 'succeeded') {
      landed.push(write);
      continue;
    }
    if (write !== null && commit.status === 'failed') {
      failed.push(write);
      continue;
    }
    if (commit.status === 'succeeded' && commit.kind === 'action') {
      other.push({
        commit_id: commit.commit_id,
        ingredient: commit.ingredient,
      });
    }
  }

  if (landed.length === 0) return null;
  return {
    run_id: input.run_id,
    recipe_id: input.recipe_id,
    landed_writes: landed,
    failed_writes: failed,
    uncertain,
    other_actions: other,
  };
};

// ────────────────────────────────────────────────────────────────
// Injected seams
// ────────────────────────────────────────────────────────────────

/** The annotation a saga answer produces — a fresh row; no commit or
 *  audit anchor is ever mutated. The implementation MUST persist it as:
 *    target_collection = SAGA_TARGET_COLLECTION   (`'run'`)
 *    target_id         = run_id
 *    key               = SAGA_ANNOTATION_KEY      (`'saga_reconciliation'`)
 *    value             = { answer, answered_at, run_id, recipe_id,
 *                          landed_commit_ids }
 *    event_at          = event_at
 *  upsert-keyed on `(target_collection, target_id, key)` so the
 *  notification block's at-least-once `on_answer` dispatch yields
 *  exactly one reconciliation row per run. */
export interface SagaReconciliationAnnotation {
  run_id: string;
  recipe_id: string;
  /** The landed writes' commit ids — the link keys back into the
   *  commit log. */
  landed_commit_ids: string[];
  /** The chosen answer (`'undo'` / `'keep'`), recorded verbatim. */
  answer: string;
  /** Unix-ms the answer was recorded. */
  answered_at: number;
  /** The FIRST landed write's `dispatched_at` — the bistemporal
   *  event-time of the torn state coming into being. */
  event_at: number;
}

export interface SagaAnnotationWriter {
  writeReconciliation(annotation: SagaReconciliationAnnotation): Promise<void>;
}

/** A derived compensation plan as carried in the ask payload —
 *  structurally `@recued/recipes`' `CompensationPlan` (the leaf treats
 *  the recipe as opaque JSON; no cross-package import). */
export interface SagaCompensationPlanRef {
  recipe: unknown;
  config: Record<string, unknown>;
  predecessor_commit_id: string;
  description: string;
}

/** The host-side dispatcher an `undo` answer fires — over the server's
 *  `handleExecute`, threading `predecessor_commit_id` via the internal
 *  channel onto the run's `CommitRunIdentity`.
 *
 *  Contract the implementation MUST honor:
 *   - the dispatch flows through the NORMAL gate path (dispatch-
 *     resolve → catalog gate → preflight approval) — never a bypass;
 *     the compensating delete pauses `awaiting_approval` and only the
 *     user's preflight answer releases it;
 *   - IDEMPOTENT per plan: `on_answer` is at-least-once, so a replay
 *     after a crash must not mint a second compensation run for the
 *     same `predecessor_commit_id` (derive a deterministic run id /
 *     check the existing anchor — mirroring `PreflightResumer`'s
 *     at-entry guard). */
export interface SagaCompensationDispatcher {
  dispatchCompensation(plan: SagaCompensationPlanRef): Promise<void>;
}

/** The narrow notification-block seam (same shape the `in_doubt` leaf
 *  uses — a `NotificationBlock` satisfies it structurally). */
export interface SagaNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;
}

// ────────────────────────────────────────────────────────────────
// The ask
// ────────────────────────────────────────────────────────────────

/** The three components of a saga `notification.ask`. */
export interface SagaAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

/** Build the `notification.ask` for one torn saga. `plans` carries the
 *  host-derived compensation per landed write (keyed by commit id) —
 *  the leaf offers `undo` iff at least one plan exists, and persists
 *  the plans verbatim in the handler payload so the answer dispatches
 *  exactly what was offered (no re-derivation against a drifted
 *  world). */
/** The owner-facing rendering of one write: the composed phrase when the
 *  identifier carries a recognisable verb and entity, and the exact
 *  `operation_id` when it does not — which is what this ask printed for every
 *  write before. Never both; the id stays the audit record, not the sentence. */
const describeWrite = (write: TornSagaWrite): string =>
  describeCatalogOperation({ operation_key: write.operation_key,
    operation_id: write.operation_id, catalog_slug: write.catalog_slug });

export const buildSagaAsk = (
  saga: TornSaga,
  plans: ReadonlyMap<string, SagaCompensationPlanRef>,
): SagaAsk => {
  // ⚠ ALL THREE LINES USE THE SAME RENDERING. Naming only the uncertain call
  // would leave one sentence in English beside two in identifiers, which reads
  // worse than either alone. `describeWrite` falls back to the exact id, so an
  // uncomposable op still appears exactly as it does today.
  const landedLines = saga.landed_writes.map((w) => {
    const at = new Date(w.dispatched_at).toISOString();
    return `${describeWrite(w)} on '${w.connection_name}' at ${at}`;
  });
  const compensable = saga.landed_writes.filter((w) =>
    plans.has(w.commit_id),
  );
  const nonCompensable = saga.landed_writes.length - compensable.length;

  const parts: string[] = [
    `Recipe '${saga.recipe_id}' failed, but `
      + `${plural(saga.landed_writes.length, 'action')} had already gone `
      + `through: ${landedLines.join('; ')}.`,
  ];
  if (saga.failed_writes.length > 0) {
    const f = saga.failed_writes[saga.failed_writes.length - 1];
    parts.push(
      `The failing step was ${describeWrite(f)} on '${f.connection_name}'.`,
    );
  }
  if (saga.uncertain.length > 0) {
    // NAME THEM. A count told the owner something happened and refused to say
    // what, while the classification sat unused on every row.
    const named = saga.uncertain
      .map(u => u.write)
      .filter((w): w is TornSagaWrite => w !== null)
      .map(w => `${describeWrite(w)} on '${w.connection_name}'`);
    parts.push(
      named.length === saga.uncertain.length
        ? `${plural(saga.uncertain.length, 'call')} crashed unconfirmed `
          + `(${named.join('; ')}) — you'll be asked about ${saga.uncertain.length === 1 ? 'it' : 'those'} separately.`
        : `${plural(saga.uncertain.length, 'call')} crashed unconfirmed`
          + `${named.length > 0 ? ` (including ${named.join('; ')})` : ''} — `
          + `you'll be asked about those separately.`,
    );
  }
  if (saga.other_actions.length > 0) {
    parts.push(
      `${plural(saga.other_actions.length, 'other side-effect')} also `
        + `completed (${saga.other_actions.map((a) => a.ingredient).join(', ')}).`,
    );
  }
  if (compensable.length > 0) {
    parts.push(
      `Undo will request approval to reverse `
        + (compensable.length === saga.landed_writes.length
          ? 'them'
          : `${plural(compensable.length, 'action')} (${
            compensable.map((w) => plans.get(w.commit_id)!.description).join('; ')
          }); the other ${plural(nonCompensable, 'action')} cannot be undone automatically`)
        + ' — each undo asks for approval before it runs.',
    );
  } else {
    parts.push('These actions cannot be undone automatically.');
  }
  parts.push('To retry the failed part, re-run the recipe.');

  const message: NotificationMessage = {
    title: 'Recipe failed after changes were made',
    text: parts.join(' '),
  };
  const options: AskOption[] =
    compensable.length > 0
      ? [SAGA_ASK_OPTIONS.undo, SAGA_ASK_OPTIONS.keep]
      : [SAGA_ASK_OPTIONS.keep];
  const handler: AskHandlerRef = {
    kind: SAGA_HANDLER_KIND,
    payload: {
      run_id: saga.run_id,
      recipe_id: saga.recipe_id,
      landed_commit_ids: saga.landed_writes.map((w) => w.commit_id),
      event_at: saga.landed_writes[0]?.dispatched_at ?? 0,
      plans: [...plans.values()],
    },
  };
  return { message, options, handler };
};

// ────────────────────────────────────────────────────────────────
// The answer handler
// ────────────────────────────────────────────────────────────────

/** Build the durable `on_answer` handler for saga reconciliation
 *  answers. Every answer records the annotation (the decision is
 *  honest history either way); `undo` then dispatches each persisted
 *  plan through the injected dispatcher — sequentially, best-effort
 *  per plan, re-throwing at the end if any dispatch failed so the
 *  at-least-once redelivery retries (both seams are idempotent by
 *  contract, so a replay converges instead of double-acting). */
export const createSagaAnswerHandler = (
  writer: SagaAnnotationWriter,
  dispatcher: SagaCompensationDispatcher,
): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    const runId = payload.run_id;
    const recipeId = payload.recipe_id;
    const landed = payload.landed_commit_ids;
    const eventAt = payload.event_at;
    const plans = payload.plans;
    if (
      typeof runId !== 'string'
      || typeof recipeId !== 'string'
      || !Array.isArray(landed)
      || !landed.every((id): id is string => typeof id === 'string')
      || typeof eventAt !== 'number'
      || !Number.isFinite(eventAt)
      || !Array.isArray(plans)
    ) {
      throw new Error(
        'saga reconciliation handler: malformed payload — expected '
          + '{ run_id: string, recipe_id: string, landed_commit_ids: '
          + 'string[], event_at: finite number, plans: array }',
      );
    }

    await writer.writeReconciliation({
      run_id: runId,
      recipe_id: recipeId,
      landed_commit_ids: landed,
      answer: answer.option,
      answered_at: answer.answered_at,
      event_at: eventAt,
    });

    if (answer.option !== SAGA_ASK_OPTIONS.undo.id) return;

    const failures: string[] = [];
    for (const raw of plans) {
      const plan = raw as Partial<SagaCompensationPlanRef>;
      if (
        plan === null
        || typeof plan !== 'object'
        || typeof plan.predecessor_commit_id !== 'string'
        || plan.recipe === undefined
        || plan.config === null
        || typeof plan.config !== 'object'
      ) {
        failures.push('malformed plan entry in persisted payload');
        continue;
      }
      try {
        await dispatcher.dispatchCompensation(plan as SagaCompensationPlanRef);
      } catch (e) {
        failures.push(
          `${plan.predecessor_commit_id}: `
            + (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `saga compensation dispatch failed for ${failures.length} plan(s) — `
          + failures.join('; '),
      );
    }
  };
};

/** Register the `gateway.saga` `on_answer` handler with the
 *  notification block. Call once at boot, before live traffic. */
export const registerSagaHandler = (
  notifier: SagaNotifier,
  writer: SagaAnnotationWriter,
  dispatcher: SagaCompensationDispatcher,
): void => {
  notifier.registerAskHandler(
    SAGA_HANDLER_KIND,
    createSagaAnswerHandler(writer, dispatcher),
  );
};

/** Raise the saga ask for one torn run. Thin — the host computes the
 *  saga + plans and owns the best-effort posture around the raise. */
/** How many terminally-failed run anchors one boot sweep inspects. */
export const SAGA_SWEEP_DEFAULT_LIMIT = 200;

/** The seams a boot sweep needs. All storage-shaped, so all injected: the leaf
 *  cannot reach a store (public-boundary rule), and `derivePlans` additionally
 *  cannot live here because `deriveCompensation` is `@recued/recipes` and this
 *  package declares no dependencies. */
export interface TornSagaSweepDeps {
  /** Run anchors whose status is terminally FAILED, newest first, at most
   *  `limit`.
   *
   *  ⛔⛔ THE FILTER IS LOAD-BEARING AND IT CANNOT MOVE INTO THIS FUNCTION.
   *  `detectTornSaga` returns a saga whenever ONE catalog write landed — it
   *  does not know, and cannot know, whether the run went on to succeed. In
   *  the live path that judgement is the caller's (`execute-handler` reaches
   *  the hook only on a terminal failure). A sweep handed "every run with a
   *  landed write" would therefore tell the owner that every SUCCESSFUL
   *  multi-write recipe had failed after acting — on every boot.
   *
   *  ⚠ And a HELD run is not a failed one. Use `isHeldRunAnchorStatus` rather
   *  than comparing against `'awaiting_approval'`: a run waiting on a peer is
   *  waiting, not torn, and the literal misses it. */
  listFailedRuns(
    limit: number,
  ): Promise<ReadonlyArray<{ run_id: string; recipe_id: string }>>;
  /** Every commit of one run. */
  listRunCommits(run_id: string): Promise<readonly Commit[]>;
  /** Has this run already reached the owner?
   *
   *  ⛔ WITHOUT THIS THE SWEEP IS A NOTIFICATION STORM. One-ask-per-torn-run
   *  holds in the live path "by reachability, not by a durable suppression
   *  row" — a logical run re-enters `handleExecute` only through guarded
   *  channels. A boot sweep is exactly the "future host path re-dispatches
   *  terminal run ids" that argument excludes, so it must ask the question the
   *  live path never had to. */
  alreadySurfaced(run_id: string): Promise<boolean>;
  getManifest(slug: string): IngredientManifest | undefined;
  derivePlans(saga: TornSaga): ReadonlyMap<string, SagaCompensationPlanRef>;
  notifier: SagaNotifier;
  log?(message: string): void;
}

export interface TornSagaSweepResult {
  /** Failed anchors inspected. */
  scanned: number;
  /** Asks raised. */
  raised: number;
  /** Torn runs skipped because the owner has already seen them. */
  suppressed: number;
  /** Runs whose inspection threw. The sweep continues past them. */
  errored: number;
}

/** R2 step 6 — surface torn runs whose ask was never raised.
 *
 *  The live hook raises its ask BEST-EFFORT after the audit anchor write, so a
 *  detection or raise failure leaves the torn state visible in the commit log
 *  and invisible to the owner. That is the hole this closes, and it is the
 *  follow-on `execute-handler` records at its own hook.
 *
 *  ⚠ SCOPE, STATED SO IT IS NOT MISTAKEN FOR MORE. Only anchors that reached a
 *  terminal FAILED status are candidates. A run that CRASHED mid-flight never
 *  reached one, so its torn state is still unsurfaced after this sweep — a
 *  known, deliberate gap (owner's call, 2026-09-21), not an oversight. Closing
 *  it means sweeping non-terminal anchors too, which must be ordered after
 *  `sweepPendingToInDoubt` or in-flight commits still read as landed writes.
 *
 *  ⚠ BOUNDED, SO OLD ENOUGH IS FORGOTTEN. `limit` caps the anchors inspected,
 *  newest first. A torn run that falls out of that window is never surfaced.
 *  The alternative is an unbounded table walk on every boot; the bound is the
 *  honest trade, not an accident.
 *
 *  Per-run failures never abort the batch — the same posture as the in-doubt
 *  sweep. One unreadable run must not cost the owner every other disclosure. */
export const sweepTornSagas = async (
  deps: TornSagaSweepDeps,
  limit: number = SAGA_SWEEP_DEFAULT_LIMIT,
): Promise<TornSagaSweepResult> => {
  const result: TornSagaSweepResult = {
    scanned: 0, raised: 0, suppressed: 0, errored: 0,
  };
  const candidates = await deps.listFailedRuns(limit);
  for (const candidate of candidates) {
    result.scanned += 1;
    try {
      const commits = await deps.listRunCommits(candidate.run_id);
      const saga = detectTornSaga({
        run_id: candidate.run_id,
        recipe_id: candidate.recipe_id,
        commits,
        getManifest: deps.getManifest,
      });
      // Not torn: the run failed without any write landing, which is the
      // ordinary failure and has nothing to disclose.
      if (saga === null) continue;
      if (await deps.alreadySurfaced(candidate.run_id)) {
        result.suppressed += 1;
        continue;
      }
      await raiseSagaAsk(deps.notifier, saga, deps.derivePlans(saga));
      result.raised += 1;
    } catch (error) {
      result.errored += 1;
      deps.log?.(
        `[saga-sweep] run ${candidate.run_id}: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return result;
};

export const raiseSagaAsk = async (
  notifier: SagaNotifier,
  saga: TornSaga,
  plans: ReadonlyMap<string, SagaCompensationPlanRef>,
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildSagaAsk(saga, plans);
  return notifier.ask(message, options, handler);
};
