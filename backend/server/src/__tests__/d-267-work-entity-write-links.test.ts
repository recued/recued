/** D-267 follow-on — work-entity mutations emit D-120 write links.
 *
 *  ⛔⛔ THE GAP THIS CLOSES. `data.timeline('task:<id>')` returned an empty feed
 *  for every owner, forever, and the reason was one missing declaration. The
 *  read side was fully built: the timeline merges memory / annotation / link /
 *  enrichment keyed on `<collection>:<id>`, and the engine already emits a
 *  write link per `writes`-declaring step (D-210 step 3). But only SEVEN kernel
 *  manifests declared `writes` and every one named `calendar` or `mail` — so a
 *  recipe that created a task emitted nothing, no shipped recipe annotated or
 *  linked a work entity either (zero `target_collection` across the corpus),
 *  and the run's own audit row is keyed by activity, not by target.
 *
 *  ⚠ `id_output_field` also had to learn a DOTTED PATH. The two families that
 *  declared `writes` first return the written id as a top-level scalar
 *  (`record_id` / `source_id`); every work-entity op returns
 *  `{ <kind>: { id, … } }`. The format could not express the shape of the ops
 *  that most needed it.
 *
 *  🔑 This drives the REAL kernel manifests through the REAL executor and
 *  asserts the row that lands in `links` — the subject `data.timeline()` reads.
 *  Asserting the manifest's `writes` block alone would be a DEFINITION check;
 *  the declared-vs-backed gap is exactly what bit here. */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import type { KernelDispatchers } from '@recued/ingredients';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { ensureMemorySchema } from '../memory-schema.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const kernelManifest = (slug: string): IngredientManifest => {
  const m = KERNEL_MANIFESTS.find((x) => x.slug === slug);
  if (!m) throw new Error(`kernel manifest '${slug}' not found`);
  return m;
};

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'd267-we',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-267 work entity',
    author: 'tester',
    description: 'fixture',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

/** Every work-entity write op returns `{ <kind>: { id, … } }` — the nested
 *  shape the dotted `id_output_field` exists to reach. */
const workEntityDispatchers = (): KernelDispatchers => ({
  taskCreate: vi.fn(async () => ({ task: { id: 'task-1', title: 'Ship it' } })),
  taskUpdate: vi.fn(async (input: { id: string }) => ({ task: { id: input.id, title: 'Ship it' } })),
  noteCreate: vi.fn(async () => ({ note: { id: 'note-1', body: 'A thought' } })),
  commitmentCreate: vi.fn(async () => ({ commitment: { id: 'c-1', statement: 'Send the draft' } })),
  projectCreate: vi.fn(async () => ({ project: { id: 'p-1', title: 'Q4' } })),
  bookingCreate: vi.fn(async () => ({ booking: { id: 'b-1', title: 'Haircut' } })),
  // Deletes ECHO a top-level id so the link can still name the row after its
  // warehouse record is gone — the shape `calendar-delete` established.
  taskDelete: vi.fn(async (input: { id: string }) => ({ ok: true, id: input.id, tombstoned: true })),
  commitmentFulfill: vi.fn(async (input: { id: string }) => ({ commitment: { id: input.id, statement: 'Send the draft' } })),
  projectArchive: vi.fn(async (input: { id: string }) => ({ project: { id: input.id, title: 'Q4' } })),
  taskMarkDone: vi.fn(async (input: { id: string }) => ({ task: { id: input.id, title: 'Ship it', done: true } })),
} as unknown as KernelDispatchers);

const setupDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureAuditIndexes(db);
  ensureMemorySchema(db);
  return db;
};

const setupDeps = (db: Database.Database, recipe: RecipeDefinition): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent', db);
  recipeStore.register(recipe);
  const auditCol = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  const activityCol = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  const auditLog = createAuditLogStore(auditCol, activityCol);
  return { recipeStore, executorConfig: { manifests }, baseVault: {}, auditLog, db };
};

const linkRowsFor = (db: Database.Database, memory_id: string) =>
  db
    .prepare(`SELECT entity_id, kind FROM links WHERE memory_id = ? ORDER BY entity_id`)
    .all(memory_id) as Array<{ entity_id: string; kind: string }>;

const runId = (db: Database.Database): string => {
  const rows = db.prepare(`SELECT data FROM audit_entries`).all() as Array<{ data: string }>;
  const entry = JSON.parse(rows[0]!.data) as AuditEntry;
  return entry.run_id;
};

const runWorkEntity = async (
  slug: string,
  step: RecipeDefinition['steps'][number],
): Promise<Array<{ entity_id: string; kind: string }>> => {
  const db = setupDb();
  const recipe = baseRecipe({ recipe_id: `d267-${slug}`, steps: [step] });
  const deps = setupDeps(db, recipe);
  deps.recipeStore.save(recipe, 'pub', 'inline');
  deps.executorConfig.manifests.register(kernelManifest(slug));
  deps.executorConfig.kernelDispatchers = workEntityDispatchers();
  const result = await handleExecute(deps, { recipe_id: recipe.recipe_id });
  // ⚠ Names the slug and the refusal. A bare `expect(success).toBe(true)` here
  // reports "expected false to be true" for ten different ops, which is how a
  // fixture's own missing input reads as a defect in the thing under test.
  if (!result.success) throw new Error(`${slug} did not run: ${JSON.stringify(result).slice(0, 300)}`);
  return linkRowsFor(db, runId(db));
};

describe('D-267 — a recipe-written work entity is reachable from data.timeline', () => {
  it('task-create links the minted task id', async () => {
    const rows = await runWorkEntity('task-create', {
      id: 'make', ingredient: 'task-create', input: { title: 'Ship it' },
    });
    // ⛔ THE SUBJECT `data.timeline('task:task-1')` READS. Before the
    // declaration this array was empty and the detail panel would have been
    // empty for every owner — an empty provenance feed reads as "nothing has
    // touched this", which is worse than showing none.
    expect(rows).toContainEqual({ entity_id: 'task:task-1', kind: 'execution.write' });
  });

  it('task-update links the same task, so the feed is a history and not one row', async () => {
    const rows = await runWorkEntity('task-update', {
      id: 'patch', ingredient: 'task-update', input: { id: 'task-1', patch: { title: 'Ship it' } },
    });
    expect(rows).toContainEqual({ entity_id: 'task:task-1', kind: 'execution.write' });
  });

  it('every kind links under its own collection, not a shared one', async () => {
    // ⚠ The collection IS the timeline address. One shared `work_entity`
    // bucket would make `data.timeline('task:<id>')` unaddressable, and the
    // read-side alias (`data.<kind>.*`) is already per-kind.
    for (const [slug, ingredient, input, expected] of [
      ['note-create', 'note-create', { body: 'A thought' }, 'note:note-1'],
      ['commitment-create', 'commitment-create',
        { statement: 'Send the draft', direction: 'outbound', derivation: 'user_declared' },
        'commitment:c-1'],
      ['project-create', 'project-create', { title: 'Q4' }, 'project:p-1'],
      ['booking-create', 'booking-create', { title: 'Haircut' }, 'booking:b-1'],
    ] as const) {
      const rows = await runWorkEntity(slug, { id: 'w', ingredient, input });
      expect(rows).toContainEqual({ entity_id: expected, kind: 'execution.write' });
    }
  });

  it('⛔ an ENDING is linked too — the half a create/update scoping misses', async () => {
    // "It exists" and "it changed" are the cheap half of a history. The events
    // an owner actually looks for are the endings: a commitment FULFILLED or
    // cancelled (the contract calls those "what an owner actually wants to
    // count at the end of a month"), a project archived, a row tombstoned.
    // Tombstoning keeps the row, so the link stays meaningful after the end.
    for (const [slug, ingredient, input, expected] of [
      ['task-delete', 'task-delete', { id: 'task-1' }, 'task:task-1'],
      ['commitment-fulfill', 'commitment-fulfill', { id: 'c-1' }, 'commitment:c-1'],
      ['project-archive', 'project-archive', { id: 'p-1' }, 'project:p-1'],
      ['task-mark-done', 'task-mark-done', { id: 'task-1' }, 'task:task-1'],
    ] as const) {
      const rows = await runWorkEntity(slug, { id: 'end', ingredient, input });
      expect(rows).toContainEqual({ entity_id: expected, kind: 'execution.write' });
    }
  });

  it('⛔ EVERY mutating work-entity op declares it, with a reachable id path', () => {
    // The drives above prove the chain for the ops they exercise; this proves
    // none was left out. An op whose manifest lacks `writes` emits nothing and
    // fails silently — exactly how this went unnoticed in the first place, and
    // exactly how the endings were missed on the first pass.
    const expected: ReadonlyArray<readonly [string, string, string]> = [
      ...['task', 'note', 'commitment', 'project', 'booking'].flatMap((kind) =>
        ['create', 'update'].map((action) =>
          [`${kind}-${action}`, kind, `${kind}.id`] as const)),
      ['task-delete', 'task', 'id'],
      ['note-delete', 'note', 'id'],
      ['booking-delete', 'booking', 'id'],
      ['commitment-cancel', 'commitment', 'commitment.id'],
      ['commitment-fulfill', 'commitment', 'commitment.id'],
      ['commitment-propose', 'commitment', 'commitment.id'],
      ['project-archive', 'project', 'project.id'],
      // ⛔ FOUND BY THE SWEEP BELOW, not by me. `task-mark-done` is the single
      // most-looked-for event in a task's life and my hand-written list of
      // "creates, updates and endings" simply did not contain it — which is the
      // argument for asserting completeness against the corpus rather than
      // against a list someone typed.
      ['task-mark-done', 'task', 'task.id'],
    ];
    for (const [slug, collection, id_output_field] of expected) {
      expect(kernelManifest(slug).writes).toEqual({ collection, id_output_field });
    }

    // ⚠ And no mutating work-entity op is MISSING from that list. A sweep that
    // only checks the ops it names cannot notice a new one — which is the
    // failure mode this whole arc is about.
    const mutating = KERNEL_MANIFESTS
      .filter((m) => /^(task|note|commitment|project|booking)-/.test(m.slug))
      // ⚠ BOTH TIERS. The deletes are `destructive`, not `write` — a filter on
      // `write` alone silently excused exactly the ops whose absence started
      // this round, which is the sweep failing in the same way as the thing it
      // is meant to catch.
      .filter((m) => m.risk_tier === 'write' || m.risk_tier === 'destructive')
      .map((m) => m.slug)
      .sort();
    expect(mutating).toEqual([...expected.map(([slug]) => slug)].sort());
  });
});
