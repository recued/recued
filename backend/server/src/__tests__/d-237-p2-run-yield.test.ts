/** D-237 P2 — a run that did all its work and a run that did none stop being
 *  the same audit row.
 *
 *  WHY THIS EXISTS. `RunAuditSummary` carried 22 fields — timing, identity,
 *  errors, provenance — and no measure of what the run PRODUCED. `status` ranges
 *  over `RunAnchorStatus` and means "no exception was thrown"; `output_string`
 *  is length-capped free text; `RunGatewayCallTraceEntry` adds 10 more fields
 *  and no yield either. So the audit trail had no field in which the difference
 *  could appear, which is the substrate-level reason this project has repeatedly
 *  shipped — and caught only with a live drive — a `foreach` whose per-item
 *  writes were all rejected reporting `success`, a records import that wrote
 *  nothing audited `success`, and a cursor stall reprocessing nothing while
 *  reporting `success`.
 *
 *  🔑 THE CONSTRAINT IS AS IMPORTANT AS THE FIELD: no added write frequency.
 *  Every number is derived from `StepLog`s the engine already returns and is
 *  stamped on the anchor row already written once per run — no new row, no new
 *  table, no extra store read, nothing on the per-item path.
 *
 *  ⛔ THE TWO SEAMS ARE THE POINT, AND EACH CAN DROP THE FIELD SILENTLY.
 *  `buildAuditEntry` is an ENUMERATING COPIER — its own comment records that
 *  `exchange_ref` was lost in exactly that way, with NO type error — and
 *  `projectAuditSummary` is a second hand-written copier one layer up. A pure
 *  test of the derivation would pass while the number reached nobody.
 *  ⇒ [[feedback_two_suites_stubbing_the_same_boundary_cover_everything_but_the_join]]
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveRunYield,
  type Checkpoint,
  type Commit,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';

import { ensureMemorySchema } from '../memory-schema.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import {
  handleExecutionGet,
  type ExecutionFeedRpcDeps,
} from '../execution-feed-handler.js';

// ────────────────────────────────────────────────────────────────
// 1. The derivation — pure
// ────────────────────────────────────────────────────────────────

describe('D-237 P2 — deriveRunYield', () => {
  it('separates steps that RAN from steps a condition SKIPPED', () => {
    const y = deriveRunYield([
      { skipped: false },
      { skipped: true },
      { skipped: true },
    ]);
    expect(y).toEqual({ steps_run: 1, steps_skipped: 2, items_total: 0, items_failed: 0 });
  });

  it('sums foreach tallies across every step', () => {
    const y = deriveRunYield([
      { skipped: false, foreach: { items: 10, failed: 0 } },
      { skipped: false, foreach: { items: 5, failed: 2 } },
      { skipped: false },
    ]);
    expect(y.items_total).toBe(15);
    expect(y.items_failed).toBe(2);
    expect(y.steps_run).toBe(3);
  });

  it('⛔ the all-refused run is visible: items_failed === items_total > 0', () => {
    // The exact shape that reports `success: true` — a foreach is
    // continue-on-error, so every item failing still leaves `errors[]` empty.
    const y = deriveRunYield([{ skipped: false, foreach: { items: 12, failed: 12 } }]);
    expect(y.items_total).toBe(12);
    expect(y.items_failed).toBe(12);
  });

  it('⛔ "correctly had nothing to do" is DISTINGUISHABLE from "ran and produced nothing"', () => {
    // The distinction the field exists for, and the reason steps_skipped is
    // carried rather than inferred.
    const nothingToDo = deriveRunYield([{ skipped: true }, { skipped: true }]);
    const ranProducedNothing = deriveRunYield([
      { skipped: false, foreach: { items: 0, failed: 0 } },
    ]);
    expect(nothingToDo.steps_run).toBe(0);
    expect(ranProducedNothing.steps_run).toBe(1);
    expect(nothingToDo).not.toEqual(ranProducedNothing);
  });

  it('a malformed tally is SKIPPED, never coerced into NaN', () => {
    // A NaN total renders a confident, meaningless yield — worse than none.
    const y = deriveRunYield([
      { skipped: false, foreach: { items: Number.NaN, failed: 1 } },
      { skipped: false, foreach: { items: 4, failed: 1 } },
    ]);
    expect(Number.isFinite(y.items_total)).toBe(true);
    expect(y.items_total).toBe(4);
    expect(y.items_failed).toBe(1);
  });

  it('an absent `skipped` counts as RUN — the engine only sets it when true-ish', () => {
    expect(deriveRunYield([{}]).steps_run).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. THE SEAMS — the copier and the projection, each of which can drop it
// ────────────────────────────────────────────────────────────────

let db: Database.Database;
let auditLog: AuditLogStore;
let checkpointStore: CheckpointStore;
let commitStore: CommitStore;
let deps: ExecutionFeedRpcDeps;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  ensureMemorySchema(db);
  auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection(),
  );
  checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  commitStore = createCommitStore(createInMemoryCollection<Commit>());
  deps = { db, auditLog, checkpointStore, commitStore, serverInstanceId: 'srv-test' };
});

const anchor = (run_id: string, patch: Partial<AuditEntry> = {}): AuditEntry =>
  buildAuditEntry({
    run_id,
    recipe_id: 'recipe-a',
    recipe_hash: 'hash-a',
    now: 1_000_010,
    duration_ms: 10,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'srv-test',
    ...(patch.run_yield !== undefined ? { run_yield: patch.run_yield } : {}),
  });

describe('D-237 P2 — buildAuditEntry retains the yield', () => {
  it('⛔ THE ENUMERATING COPIER KEEPS IT — the trap that already lost `exchange_ref`', () => {
    const e = anchor('r1', {
      run_yield: { steps_run: 3, steps_skipped: 1, items_total: 10, items_failed: 10 },
    });
    expect(e.run_yield).toEqual({
      steps_run: 3, steps_skipped: 1, items_total: 10, items_failed: 10,
    });
  });

  it('⛔⛔ AN ALL-ZERO YIELD SURVIVES THE COPIER — it is not falsy-guarded away', () => {
    // Every sibling spread in `buildAuditEntry` is a truthiness guard, which is
    // right for strings and catastrophic here: the zero run is the one this
    // field exists to expose.
    const e = anchor('r2', {
      run_yield: { steps_run: 0, steps_skipped: 0, items_total: 0, items_failed: 0 },
    });
    expect(e.run_yield).toBeDefined();
    expect(e.run_yield?.items_total).toBe(0);
  });

  it('a row written WITHOUT a yield stays absent — never a fabricated zero', () => {
    // Absent must keep meaning "predates D-237", not "produced nothing".
    expect(anchor('r3').run_yield).toBeUndefined();
  });
});

describe('D-237 P2 — the yield reaches execution.get', () => {
  it('⛔ THE JOIN: a 400-item run and a 0-item run are now DIFFERENT rows', async () => {
    await auditLog.append(anchor('busy', {
      run_yield: { steps_run: 2, steps_skipped: 0, items_total: 400, items_failed: 0 },
    }));
    await auditLog.append(anchor('idle', {
      run_yield: { steps_run: 2, steps_skipped: 0, items_total: 0, items_failed: 0 },
    }));

    const busy = await handleExecutionGet(deps, { run_id: 'busy' });
    const idle = await handleExecutionGet(deps, { run_id: 'idle' });

    // Both report success — that is the point; `status` never distinguished them.
    expect(busy.run.audit.status).toBe('succeeded');
    expect(idle.run.audit.status).toBe('succeeded');
    expect(busy.run.audit.run_yield?.items_total).toBe(400);
    expect(idle.run.audit.run_yield?.items_total).toBe(0);
    expect(busy.run.audit.run_yield).not.toEqual(idle.run.audit.run_yield);
  });

  it('⛔ the ALL-REFUSED run survives the projection, still reporting success', async () => {
    await auditLog.append(anchor('refused', {
      run_yield: { steps_run: 1, steps_skipped: 0, items_total: 12, items_failed: 12 },
    }));
    const out = await handleExecutionGet(deps, { run_id: 'refused' });
    expect(out.run.audit.status).toBe('succeeded');
    expect(out.run.audit.run_yield?.items_failed).toBe(12);
    expect(out.run.audit.run_yield?.items_total).toBe(12);
  });

  it('a pre-D-237 row projects with no yield rather than a zero one', async () => {
    await auditLog.append(anchor('legacy'));
    const out = await handleExecutionGet(deps, { run_id: 'legacy' });
    expect(out.run.audit.run_yield).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. ⛔⛔ THE WIRING — a REAL run, through the REAL handler, to the anchor.
//
//    Everything above passes with the execute-handler line DELETED. Verified:
//    severing `run_yield: deriveRunYield(result.steps)` left all 12 tests green
//    — the exact "two suites stubbing the same boundary cover everything but
//    the join" failure, committed here so the next reader knows this section is
//    load-bearing and not redundant with section 2.
// ────────────────────────────────────────────────────────────────

const WIRE_SLUG = 'run-yield-http';

const wireManifest = (): IngredientManifest => ({
  slug: WIRE_SLUG,
  name: 'Run yield probe',
  description: 'Posts one row.',
  author: 'test',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  version: 1,
  input: { method: 'POST', url: 'https://example.test/{{item.id}}' },
  output: { ok: 'ok' },
} as unknown as IngredientManifest);

const wireRecipe = (): RecipeDefinition => ({
  recipe_id: 'run-yield',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Run yield', description: 'Writes each row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: { rows: { label: 'Rows', type: 'array', default: [] } },
  prefetch_steps: [],
  steps: [{ id: 'write_each', ingredient: WIRE_SLUG, input: {}, foreach: '{{config.rows}}' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** `bad` ids are refused by the endpoint; everything else succeeds. */
const runReal = async (ids: readonly string[]): Promise<AuditEntry | undefined> => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(wireManifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(wireRecipe());
  const log = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection(),
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const refused = String(url).includes('bad');
    return {
      ok: !refused,
      status: refused ? 500 : 200,
      statusText: refused ? 'Server Error' : 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: !refused }),
      text: async () => JSON.stringify({ ok: !refused }),
    };
  }) as unknown as typeof fetch;
  try {
    await handleExecute({
      recipeStore,
      executorConfig: { manifests: registry },
      baseVault: {},
      instanceId: 'run-yield-test',
      auditLog: log,
    } as unknown as ExecuteHandlerDeps, {
      recipe_id: 'run-yield',
      trigger_source: 'manual',
      config: { rows: ids.map((id) => ({ id })) },
    } as never);
  } finally {
    globalThis.fetch = original;
  }
  return (await log.listRecent(10))[0];
};

describe('D-237 P2 — the wiring: a real run stamps its own yield', () => {
  it('⛔ THE ALL-REFUSED RUN — success on the anchor, and the yield says otherwise', async () => {
    const entry = await runReal(['bad_1', 'bad_2', 'bad_3']);
    expect(entry).toBeDefined();
    // Unchanged and deliberate: a foreach is continue-on-error, so the run
    // succeeded. Before D-237 this row was byte-identical to one that wrote all
    // three.
    expect(entry?.commit_status).toBe('succeeded');
    expect(entry?.errors ?? []).toEqual([]);
    expect(entry?.run_yield).toEqual({
      steps_run: 1, steps_skipped: 0, items_total: 3, items_failed: 3,
    });
  });

  it('a fully successful run stamps the same shape with zero failures', async () => {
    const entry = await runReal(['ok_1', 'ok_2', 'ok_3']);
    expect(entry?.commit_status).toBe('succeeded');
    expect(entry?.run_yield).toEqual({
      steps_run: 1, steps_skipped: 0, items_total: 3, items_failed: 0,
    });
  });

  it('⛔ the two runs above differ ONLY in the yield — that is the whole change', async () => {
    const refused = await runReal(['bad_1', 'bad_2']);
    const written = await runReal(['ok_1', 'ok_2']);
    expect(refused?.commit_status).toBe(written?.commit_status);
    expect(refused?.errors ?? []).toEqual(written?.errors ?? []);
    expect(refused?.run_yield).not.toEqual(written?.run_yield);
  });

  it('an EMPTY collection stamps a real zero, not an absent yield', async () => {
    const entry = await runReal([]);
    expect(entry?.run_yield).toEqual({
      steps_run: 1, steps_skipped: 0, items_total: 0, items_failed: 0,
    });
  });
});
