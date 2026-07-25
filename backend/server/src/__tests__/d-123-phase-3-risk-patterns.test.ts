/** D-123 Phase 3 — `deterministic-risk-patterns` task tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deterministicRiskPatternsTask,
  deterministicRiskAnnotationId,
  RISK_PATTERN_ANNOTATION_KEY,
  RISK_PATTERN_AUTHORED_BY,
  RISK_PATTERN_FAILURE_THRESHOLD,
  RISK_PATTERN_TARGET_COLLECTION,
  RISK_PATTERN_WINDOW_MS,
} from '../housekeeping/tasks/deterministic-risk-patterns.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let now = 1_700_000_000_000;

const ensureAuditTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      key  TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
};

const ensureAnnotationTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotation (
      id                    TEXT PRIMARY KEY,
      target_collection     TEXT NOT NULL,
      target_id             TEXT NOT NULL,
      key                   TEXT NOT NULL,
      value_inline          TEXT,
      blob_hash             TEXT,
      size_bytes            INTEGER NOT NULL,
      authored_by_recipe_id TEXT NOT NULL,
      source_record_hash    TEXT NOT NULL,
      recipe_hash           TEXT NOT NULL,
      model_used            TEXT,
      authored_at           INTEGER NOT NULL,
      event_at              INTEGER
    );
  `);
};

const insertAuditFailure = (
  run_id: string,
  recipe_id: string,
  started_at: number,
  succeeded = false,
): void => {
  const data = {
    run_id,
    recipe_id,
    recipe_hash: `${recipe_id}-hash`,
    started_at,
    finished_at: started_at,
    duration_ms: 0,
    // D-153 P1 — risk-patterns scan keys on commit_status='failed';
    // succeeded rows must not contribute to the count.
    commit_status: succeeded ? 'succeeded' : 'failed',
    config_snapshot: {},
    steps: [],
    errors: [],
    trigger_url: null,
    trigger_source: 'auto_run',
    instance_id: 'srv-test',
  };
  db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`).run(
    run_id,
    JSON.stringify(data),
  );
};

const seedNFailures = (
  recipe_id: string,
  count: number,
  start_ts: number = now - 60 * 60_000,
  spacing_ms = 60_000,
): void => {
  for (let i = 0; i < count; i++) {
    insertAuditFailure(`run-${recipe_id}-${i}`, recipe_id, start_ts + i * spacing_ms, false);
  }
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const listRiskAnnotations = (): Array<{
  id: string;
  target_id: string;
  key: string;
  value: { pattern: string; failure_count: number; window_hours: number };
  authored_by_recipe_id: string;
}> =>
  (db
    .prepare(
      `SELECT id, target_id, key, value_inline, authored_by_recipe_id
         FROM annotation
        WHERE authored_by_recipe_id = ?`,
    )
    .all(RISK_PATTERN_AUTHORED_BY) as Array<{
      id: string;
      target_id: string;
      key: string;
      value_inline: string;
      authored_by_recipe_id: string;
    }>).map((r) => ({
      id: r.id,
      target_id: r.target_id,
      key: r.key,
      value: JSON.parse(r.value_inline) as { pattern: string; failure_count: number; window_hours: number },
      authored_by_recipe_id: r.authored_by_recipe_id,
    }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-risk-patterns-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  now = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('deterministicRiskPatternsTask metadata', () => {
  it('declares core kind, interruptible, no deps; implements onInvalidate', () => {
    expect(deterministicRiskPatternsTask.meta.id).toBe('deterministic-risk-patterns');
    expect(deterministicRiskPatternsTask.meta.kind).toBe('core');
    expect(deterministicRiskPatternsTask.meta.interruptible).toBe(true);
    expect(deterministicRiskPatternsTask.meta.depends_on).toBeUndefined();
    expect(typeof deterministicRiskPatternsTask.onInvalidate).toBe('function');
  });
});

describe('deterministicRiskPatternsTask.step — no-op fast paths', () => {
  it('returns complete when audit_entries table is missing', async () => {
    ensureAnnotationTable();
    const result = await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
  });

  it('returns complete when annotation table is missing', async () => {
    ensureAuditTable();
    seedNFailures('recipe-x', RISK_PATTERN_FAILURE_THRESHOLD);
    const result = await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
  });
});

describe('deterministicRiskPatternsTask.step — emission', () => {
  beforeEach(() => {
    ensureAuditTable();
    ensureAnnotationTable();
  });

  it('emits a runtime_risk annotation when failures clear the threshold', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listRiskAnnotations();
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      id: deterministicRiskAnnotationId('recipe-a'),
      target_id: 'recipe-a',
      key: RISK_PATTERN_ANNOTATION_KEY,
      authored_by_recipe_id: RISK_PATTERN_AUTHORED_BY,
    });
    expect(annotations[0].value).toMatchObject({
      pattern: 'runtime_risk',
      failure_count: RISK_PATTERN_FAILURE_THRESHOLD,
      window_hours: 24,
    });

    // Stamp on the right collection too.
    const row = db
      .prepare(`SELECT target_collection FROM annotation WHERE id = ?`)
      .get(deterministicRiskAnnotationId('recipe-a')) as { target_collection: string };
    expect(row.target_collection).toBe(RISK_PATTERN_TARGET_COLLECTION);
  });

  it('does not emit below the threshold', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD - 1);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(0);
  });

  it('counts only commit_status=failed rows (succeeded rows are ignored)', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    // Add many successes — they must not contribute to the failure count.
    for (let i = 0; i < 20; i++) {
      insertAuditFailure(`success-${i}`, 'recipe-a', now - 60_000 - i * 1_000, true);
    }
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listRiskAnnotations();
    expect(annotations).toHaveLength(1);
    expect(annotations[0].value.failure_count).toBe(RISK_PATTERN_FAILURE_THRESHOLD);
  });

  it('emits one annotation per recipe', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    seedNFailures('recipe-b', RISK_PATTERN_FAILURE_THRESHOLD + 2);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listRiskAnnotations();
    expect(annotations).toHaveLength(2);
    const targets = annotations.map((a) => a.target_id).sort();
    expect(targets).toEqual(['recipe-a', 'recipe-b']);
  });
});

describe('deterministicRiskPatternsTask.step — window boundary + cleanup', () => {
  beforeEach(() => {
    ensureAuditTable();
    ensureAnnotationTable();
  });

  it('does not count failures older than the 24h window', async () => {
    const inside_ts = now - 60_000; // 1 min ago
    const outside_ts = now - RISK_PATTERN_WINDOW_MS - 60_000; // 24h+1min ago
    for (let i = 0; i < RISK_PATTERN_FAILURE_THRESHOLD - 1; i++) {
      insertAuditFailure(`in-${i}`, 'recipe-a', inside_ts - i * 1_000, false);
    }
    for (let i = 0; i < 10; i++) {
      insertAuditFailure(`out-${i}`, 'recipe-a', outside_ts - i * 1_000, false);
    }
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(0);
  });

  it('clears stale annotation when window aged out the failures', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(1);

    // Advance virtual now by 25h — all the failures are now outside the rolling window.
    now += 25 * 60 * 60_000;
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(0);
  });

  it('preserves user-authored runtime_risk annotations during cleanup', async () => {
    // User hand-flagged a recipe — different authored_by, same key.
    db.prepare(`
      INSERT INTO annotation (
        id, target_collection, target_id, key, value_inline, blob_hash, size_bytes,
        authored_by_recipe_id, source_record_hash, recipe_hash, model_used,
        authored_at, event_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(
      'user-flag-1',
      'recipe',
      'recipe-z',
      RISK_PATTERN_ANNOTATION_KEY,
      JSON.stringify({ note: 'I keep an eye on this one' }),
      40,
      'user-recipe-id',
      'user-hash',
      'user-hash',
      now,
    );

    // No failures for any recipe → housekeeping cleanup pass runs.
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const userRow = db
      .prepare(`SELECT id FROM annotation WHERE id = 'user-flag-1'`)
      .get();
    expect(userRow).toBeDefined();
  });
});

describe('deterministicRiskPatternsTask.onInvalidate', () => {
  beforeEach(() => {
    ensureAuditTable();
    ensureAnnotationTable();
  });

  it('drops the risk annotation for the upgraded recipe', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    seedNFailures('recipe-b', RISK_PATTERN_FAILURE_THRESHOLD);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(2);

    // User upgraded recipe-a — the hook clears its annotation while leaving recipe-b intact.
    deterministicRiskPatternsTask.onInvalidate?.(stubCtx(), {
      reason: 'recipe_upgrade',
      source_id: 'recipe-a',
    });

    const remaining = listRiskAnnotations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].target_id).toBe('recipe-b');
  });

  it('is a no-op for non-recipe_upgrade reasons', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listRiskAnnotations()).toHaveLength(1);

    deterministicRiskPatternsTask.onInvalidate?.(stubCtx(), {
      reason: 'source_update',
      source_id: 'recipe-a',
    });

    expect(listRiskAnnotations()).toHaveLength(1);
  });

  it('is a no-op when source_id is missing', async () => {
    seedNFailures('recipe-a', RISK_PATTERN_FAILURE_THRESHOLD);
    await deterministicRiskPatternsTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    deterministicRiskPatternsTask.onInvalidate?.(stubCtx(), {
      reason: 'recipe_upgrade',
    });

    expect(listRiskAnnotations()).toHaveLength(1);
  });
});
