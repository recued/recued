/** D-120 Phase 3 — server-side link sink wiring + bulk insert.
 *
 *  Covers:
 *    - `insertLinks` writes the buffered EmittedLinks against the
 *      audit row's run_id (memory_id) + recipe_insight_id
 *    - INSERT OR IGNORE keeps a retried emission idempotent on the
 *      composite PK (memory_id, entity_id, kind, ts)
 *    - `handleExecute`:
 *        - audit row stamped with `recipe_insight_id` for installed
 *          recipes (no backfill round-trip needed)
 *        - audit row's run_id matches the memory_id on emitted links
 *        - inline recipe (no prior install) auto-creates the
 *          recipe_insights row before linking
 *        - `provenance: false` opts the entire run out — audit row
 *          still landed, no links table activity
 *        - missing `db` dep: audit still appended, link emission
 *          short-circuits silently
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { EmittedLink, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import type { KernelDispatchers } from '@recued/ingredients';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { insertLinks } from '../memory-links.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'phase-3-srv',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Phase 3 server',
    author: 'tester',
    description: 'fixture',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'template', template: 'ran' }],
  output: { sidebar: [] },
  ...overrides,
});

const mailSendManifest: IngredientManifest = {
  slug: 'mail-send',
  name: 'mail-send',
  description: 'Test mail-send manifest',
  author: 'recued',
  kind: 'storage',
  risk_tier: 'write',
  version: 1,
  category: 'action',
  input: {},
  output: { message_id: 'message_id' },
} as unknown as IngredientManifest;

const mailSendRecipe = (): RecipeDefinition => baseRecipe({
  recipe_id: 'phase-3-provenance-degraded',
  steps: [
    {
      id: 'send',
      ingredient: 'mail-send',
      input: {
        sender_mail_instance: 'work',
        to: ['user@example.com'],
        subject: 'hello',
        body: 'sent',
        provenance_probe: '{{data.mail.msg-1.subject}}',
      },
    },
  ],
});

const mailSendDispatchers = (): KernelDispatchers => ({
  mailSend: vi.fn(async () => ({
    source_id: 'mail-source',
    message_id: '<msg-1@example.com>',
    sent_at: 1_700_000_000_000,
    _id: null,
    _collection: 'data.mail' as const,
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

const setupDeps = (
  db: Database.Database | undefined,
  recipe: RecipeDefinition,
): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent', db);
  recipeStore.register(recipe);
  const auditCol = db
    ? createSQLiteCollection<AuditEntry>(db, 'audit_entries')
    : undefined;
  const activityCol = db
    ? createSQLiteCollection<ActivityEntry>(db, 'audit_activities')
    : undefined;
  const auditLog = auditCol
    ? createAuditLogStore(auditCol, activityCol)
    : undefined;
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    ...(auditLog ? { auditLog } : {}),
    ...(db ? { db } : {}),
  };
};

const linkRowsFor = (db: Database.Database, memory_id: string) =>
  db
    .prepare(
      `SELECT memory_id, entity_id, recipe_insight_id, kind, ts
         FROM links WHERE memory_id = ?
        ORDER BY entity_id, kind, ts`,
    )
    .all(memory_id) as Array<{
      memory_id: string;
      entity_id: string;
      recipe_insight_id: number;
      kind: string;
      ts: number;
    }>;

const auditEntries = (db: Database.Database): AuditEntry[] => {
  const rows = db.prepare(`SELECT data FROM audit_entries`).all() as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as AuditEntry);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('insertLinks — SQL bulk write', () => {
  let db: Database.Database;
  let insightId: number;

  beforeEach(() => {
    db = setupDb();
    insightId = getOrCreateRecipeInsight(db, {
      hash: 'h-1',
      slug: 'phase-3',
      version: 1,
      flattened: '{"trigger":{"type":"manual"},"steps":[]}',
    });
  });

  it('returns 0 when given an empty buffer (cheap no-op)', () => {
    expect(insertLinks(db, { memory_id: 'run-1', recipe_insight_id: insightId }, [])).toBe(0);
  });

  it('inserts one row per EmittedLink and returns the count', () => {
    const links: EmittedLink[] = [
      { step_id: 's1', collection: 'mail', entity_id: 'msg-1', access: 'read', kind: 'execution.action', ts: 1000 },
      { step_id: 's1', collection: 'deal', entity_id: '42',    access: 'read', kind: 'execution.write',  ts: 1000 },
    ];
    const inserted = insertLinks(db, { memory_id: 'run-1', recipe_insight_id: insightId }, links);
    expect(inserted).toBe(2);
    const rows = linkRowsFor(db, 'run-1');
    // Entity_id is persisted in the qualified `<collection>:<entity_id>`
    // wire form (Phase 5 spec). Sort key is the qualified string —
    // `deal:42` < `mail:msg-1` lexicographically.
    expect(rows).toEqual([
      { memory_id: 'run-1', entity_id: 'deal:42',    recipe_insight_id: insightId, kind: 'execution.write',  ts: 1000 },
      { memory_id: 'run-1', entity_id: 'mail:msg-1', recipe_insight_id: insightId, kind: 'execution.action', ts: 1000 },
    ]);
  });

  it('is idempotent on the composite PK — retried emission inserts 0 new rows', () => {
    const links: EmittedLink[] = [
      { step_id: 's', collection: 'mail', entity_id: 'msg-1', access: 'read', kind: 'execution.action', ts: 1000 },
    ];
    insertLinks(db, { memory_id: 'run-1', recipe_insight_id: insightId }, links);
    const reInsert = insertLinks(db, { memory_id: 'run-1', recipe_insight_id: insightId }, links);
    expect(reInsert).toBe(0);
    expect(linkRowsFor(db, 'run-1')).toHaveLength(1);
  });

  it('keeps distinct ts values on the same (memory, entity, kind) — composite PK includes ts', () => {
    const links: EmittedLink[] = [
      { step_id: 's', collection: 'mail', entity_id: 'msg-1', access: 'read', kind: 'execution.action', ts: 1000 },
      { step_id: 's', collection: 'mail', entity_id: 'msg-1', access: 'read', kind: 'execution.action', ts: 1500 },
    ];
    expect(insertLinks(db, { memory_id: 'run-1', recipe_insight_id: insightId }, links)).toBe(2);
  });
});

describe('handleExecute — link emission wiring', () => {
  it('returns degraded audit_unwritten and logs when the audit append fails', async () => {
    const recipe = baseRecipe({ recipe_id: 'audit-append-fails' });
    const deps = setupDeps(undefined, recipe);
    const appendError = new Error('audit append exploded');
    deps.auditLog = {
      append: vi.fn(async () => {
        throw appendError;
      }),
    } as unknown as AuditLogStore;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleExecute(deps, { recipe_id: recipe.recipe_id });

    expect(result.success).toBe(true);
    expect(result.degraded).toEqual(['audit_unwritten']);
    expect(errorSpy).toHaveBeenCalledWith(
      '[execute-handler] run observability write failed',
      expect.objectContaining({
        run_id: expect.stringMatching(/^\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}\d{3}-[a-z0-9]{6}$/),
        failed_write: 'audit_append',
        degraded: 'audit_unwritten',
        all_degraded: ['audit_unwritten'],
        error: expect.objectContaining({ message: 'audit append exploded' }),
      }),
    );
  });

  it('keeps the audit row and marks provenance_incomplete when link insert fails', async () => {
    const db = setupDb();
    const recipe = mailSendRecipe();
    const deps = setupDeps(db, recipe);
    deps.recipeStore.save(recipe, 'pub', 'inline');
    deps.executorConfig.manifests.register(mailSendManifest);
    deps.executorConfig.kernelDispatchers = mailSendDispatchers();
    db.prepare(`DROP TABLE links`).run();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleExecute(deps, { recipe_id: recipe.recipe_id });
    const entries = auditEntries(db);

    expect(result.success).toBe(true);
    expect(result.degraded).toEqual(['provenance_incomplete']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.commit_status).toBe('succeeded');
    expect(entries[0]?.degraded).toEqual(['provenance_incomplete']);
    expect(errorSpy).toHaveBeenCalledWith(
      '[execute-handler] run observability write failed',
      expect.objectContaining({
        run_id: entries[0]?.run_id,
        failed_write: 'provenance_links',
        degraded: 'provenance_incomplete',
        all_degraded: ['provenance_incomplete'],
      }),
    );
  });

  it('stamps recipe_insight_id on the audit entry without backfill', async () => {
    const db = setupDb();
    const recipe = baseRecipe();
    const deps = setupDeps(db, recipe);
    // Pre-install — populates recipe_insights via Phase 2 hook.
    deps.recipeStore.save(recipe, 'pub', 'inline');
    await handleExecute(deps, { recipe_id: recipe.recipe_id });
    const [entry] = auditEntries(db);
    expect(entry).toBeDefined();
    expect(entry.recipe_insight_id).toBeTypeOf('number');
    expect(entry.recipe_insight_id).toBeGreaterThan(0);
  });

  it('uses the same run_id for audit row and (would-be) link memory_id', async () => {
    const db = setupDb();
    const recipe = baseRecipe();
    const deps = setupDeps(db, recipe);
    deps.recipeStore.save(recipe, 'pub', 'inline');
    await handleExecute(deps, { recipe_id: recipe.recipe_id });
    const [entry] = auditEntries(db);
    // No links land for a transform-only recipe (stepEmitsLinks is
    // false), so the table stays empty even though run_id is wired.
    expect(entry.run_id).toMatch(/^\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}\d{3}-[a-z0-9]{6}$/);
    expect(linkRowsFor(db, entry.run_id)).toHaveLength(0);
  });

  it('auto-creates recipe_insights row for inline (non-installed) recipes', async () => {
    const db = setupDb();
    const recipe = baseRecipe({ recipe_id: 'inline-runner' });
    const deps = setupDeps(db, recipe);
    // Skip recipeStore.save — exercise the inline POST /execute path.
    await handleExecute(deps, { recipe });
    // Phase 3 ensureRecipeInsightId path: missing row → flatten + insert.
    const insightCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM recipe_insights WHERE slug = ?`).get('inline-runner') as { c: number }
    ).c;
    expect(insightCount).toBe(1);
  });

  it('opts out entirely when recipe declares provenance: false', async () => {
    const db = setupDb();
    const recipe = baseRecipe({ recipe_id: 'opt-out', provenance: false });
    const deps = setupDeps(db, recipe);
    deps.recipeStore.save(recipe, 'pub', 'inline');
    await handleExecute(deps, { recipe_id: recipe.recipe_id });
    const [entry] = auditEntries(db);
    expect(entry).toBeDefined();
    expect(entry.commit_status).toBe('succeeded');
    // Opt-out path — audit still appended; recipe_insight_id stays
    // unset (we skip the lookup) so links can't be associated even
    // if a buggy code path tried to emit.
    expect(entry.recipe_insight_id).toBeUndefined();
    expect(linkRowsFor(db, entry.run_id)).toHaveLength(0);
  });

  it('falls back gracefully when db is not wired (test / daemon-only mode)', async () => {
    const recipe = baseRecipe({ recipe_id: 'no-db' });
    const deps = setupDeps(undefined, recipe);
    const result = await handleExecute(deps, { recipe_id: recipe.recipe_id });
    // Audit log + db both absent — execution still succeeds, response
    // shape unchanged. Phase 3 wiring must not introduce hard
    // dependencies on the SQL surface.
    expect(result.success).toBe(true);
  });
});
