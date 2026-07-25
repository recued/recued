/** D-210 step 3 — end-to-end calendar write links.
 *
 *  Slice A proved the engine's write-lane with a hand-rolled manifest;
 *  this closes the declared-vs-backed gap by driving the REAL kernel
 *  calendar manifests (`writes` declaration in `kernel-manifests.ts`)
 *  through the REAL executor + kernel adapter, and asserting a D-120
 *  `links` row lands keyed on `calendar:<source_id>` — the subject
 *  `data.timeline()` reads for the calendar detail's move history.
 *
 *  Covers the three mutations:
 *    - create → the minted `source_id` (from the dispatcher result)
 *    - update → the same `source_id` (the moved event)
 *    - delete → the echoed `source_id` (slice B added it to the result
 *      so the link can name the event after its warehouse row is gone)
 *
 *  The kernel adapter returns the calendar dispatcher's result RAW (no
 *  output-map projection — `kernel.ts` `case 'calendar-*'`), so the
 *  engine reads `source_id` straight off the step result.
 */

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
  recipe_id: 'd210-cal',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-210 calendar',
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

const calendarDispatchers = (): KernelDispatchers => ({
  calendarCreate: vi.fn(async () => ({
    source_id: 'evt-1',
    ical_uid: 'evt-1@local.recued',
  })),
  calendarUpdate: vi.fn(async (input: { source_id: string }) => ({
    source_id: input.source_id,
  })),
  calendarDelete: vi.fn(async (input: { source_id: string }) => ({
    deleted: true as const,
    source_id: input.source_id,
  })),
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
    .prepare(
      `SELECT entity_id, kind FROM links WHERE memory_id = ? ORDER BY entity_id`,
    )
    .all(memory_id) as Array<{ entity_id: string; kind: string }>;

const runId = (db: Database.Database): string => {
  const rows = db.prepare(`SELECT data FROM audit_entries`).all() as Array<{ data: string }>;
  const entry = JSON.parse(rows[0]!.data) as AuditEntry;
  return entry.run_id;
};

/** Drive one calendar recipe through the real executor + return the
 *  links that landed for the run. Registers only the manifest the recipe
 *  uses so each case is isolated. */
const runCalendar = async (
  slug: string,
  step: RecipeDefinition['steps'][number],
): Promise<Array<{ entity_id: string; kind: string }>> => {
  const db = setupDb();
  const recipe = baseRecipe({ recipe_id: `d210-${slug}`, steps: [step] });
  const deps = setupDeps(db, recipe);
  deps.recipeStore.save(recipe, 'pub', 'inline');
  deps.executorConfig.manifests.register(kernelManifest(slug));
  deps.executorConfig.kernelDispatchers = calendarDispatchers();
  const result = await handleExecute(deps, { recipe_id: recipe.recipe_id });
  expect(result.success).toBe(true);
  return linkRowsFor(db, runId(db));
};

describe('D-210 step 3 — calendar mutations emit D-120 write links (real manifests)', () => {
  it('calendar-create links the minted event id', async () => {
    const rows = await runCalendar('calendar-create', {
      id: 'make',
      ingredient: 'calendar-create',
      input: {
        slug: 'local',
        calendar_id: 'local',
        event: { summary: 'Booking', start_at: 1, end_at: 2, timezone: 'UTC' },
      },
    });
    expect(rows).toContainEqual({ entity_id: 'calendar:evt-1', kind: 'execution.write' });
  });

  it('calendar-update links the moved event id', async () => {
    const rows = await runCalendar('calendar-update', {
      id: 'move',
      ingredient: 'calendar-update',
      input: { slug: 'local', source_id: 'evt-7', patch: { start_at: 99 } },
    });
    expect(rows).toContainEqual({ entity_id: 'calendar:evt-7', kind: 'execution.write' });
  });

  it('calendar-delete links the removed event id (echoed source_id)', async () => {
    // The dispatcher is mocked here (echoes source_id like the real one),
    // so this asserts the manifest `writes` → engine link wiring reaches
    // delete's result field. That the REAL handleCalendarDelete actually
    // echoes source_id is pinned in calendar-dispatcher.test.ts (the real
    // gate) — without that echo the link would have no id to key on and a
    // cancellation would leave the timeline blank.
    const rows = await runCalendar('calendar-delete', {
      id: 'cancel',
      ingredient: 'calendar-delete',
      input: { slug: 'local', source_id: 'evt-9' },
    });
    expect(rows).toContainEqual({ entity_id: 'calendar:evt-9', kind: 'execution.write' });
  });

  it('the real calendar manifests declare the writes target', () => {
    for (const slug of ['calendar-create', 'calendar-update', 'calendar-delete']) {
      expect(kernelManifest(slug).writes).toEqual({
        collection: 'calendar',
        id_output_field: 'source_id',
      });
    }
    // calendar-delete additionally surfaces source_id in its output map so
    // the declaration is honest about where the id comes from.
    expect(kernelManifest('calendar-delete').output).toMatchObject({ source_id: 'source_id' });
  });
});
