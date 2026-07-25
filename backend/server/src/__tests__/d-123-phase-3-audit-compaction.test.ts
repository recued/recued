/** D-123 Phase 3 — `audit-compaction` task tests.
 *
 *  Verifies the 2-minute rolling-window dedup against the actual
 *  `AuditEntry` shape (`recipe_id` / `recipe_hash` / `commit_status`,
 *  not the spec's `action` / `detail` strawman — see the task's
 *  module header for the schema-fit deviation note). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditCompactionTask,
  AUDIT_COMPACTION_WINDOW_MS,
} from '../housekeeping/tasks/audit-compaction.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type { HousekeepingCursor } from '@recued/contracts';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-audit-compaction-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      key  TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_700_000_000_000;
const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const insertAudit = (
  run_id: string,
  recipe_id: string,
  recipe_hash: string,
  started_at: number,
  succeeded = true,
): void => {
  const data = {
    run_id,
    recipe_id,
    recipe_hash,
    started_at,
    finished_at: started_at,
    duration_ms: 0,
    // D-153 P1 — audit rows carry the CommitStatus enum; the boolean
    // helper arg flips between the two terminal lifecycle values.
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

const countRows = (): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM audit_entries`).get() as { c: number }).c;

const stepWith = async (
  task: HousekeepingTaskInstance,
  cursor: HousekeepingCursor,
  budget_ms = 60_000,
) => task.step(stubCtx(), cursor, budget_ms);

describe('auditCompactionTask metadata', () => {
  it('declares core kind, interruptible, and a stable id', () => {
    expect(auditCompactionTask.meta.id).toBe('audit-compaction');
    expect(auditCompactionTask.meta.kind).toBe('core');
    expect(auditCompactionTask.meta.interruptible).toBe(true);
    // No depends_on — the four core tasks are independent.
    expect(auditCompactionTask.meta.depends_on).toBeUndefined();
  });

  it('does not implement onInvalidate — audit is append-only', () => {
    expect(auditCompactionTask.onInvalidate).toBeUndefined();
  });
});

describe('auditCompactionTask.step — dedup behaviour', () => {
  it('collapses 5 rapid same-hash runs to a single anchor row', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-a', 'h1', base + 10_000);
    insertAudit('r3', 'recipe-a', 'h1', base + 30_000);
    insertAudit('r4', 'recipe-a', 'h1', base + 60_000);
    insertAudit('r5', 'recipe-a', 'h1', base + 90_000);

    const result = await stepWith(auditCompactionTask, { kind: 'complete' });
    expect(result.status).toBe('complete');
    // Anchor (r1) survives; r2..r5 are within the 2-min window.
    expect(countRows()).toBe(1);
    expect(db.prepare(`SELECT key FROM audit_entries`).get()).toEqual({ key: 'r1' });
  });

  it('preserves the earliest as anchor and re-anchors past the window', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-a', 'h1', base + 30_000); // dupe of r1
    insertAudit('r3', 'recipe-a', 'h1', base + AUDIT_COMPACTION_WINDOW_MS + 1_000); // new anchor (out of window)
    insertAudit('r4', 'recipe-a', 'h1', base + AUDIT_COMPACTION_WINDOW_MS + 30_000); // dupe of r3

    await stepWith(auditCompactionTask, { kind: 'complete' });

    const keys = (db.prepare(`SELECT key FROM audit_entries ORDER BY key ASC`).all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(['r1', 'r3']);
  });

  it('does not collapse across recipe_hash mismatch (recipe upgraded mid-stream)', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-a', 'h2', base + 10_000); // hash differs → different anchor
    insertAudit('r3', 'recipe-a', 'h1', base + 30_000); // hash differs again → still its own anchor

    await stepWith(auditCompactionTask, { kind: 'complete' });

    expect(countRows()).toBe(3);
  });

  it('does not collapse across recipe_id mismatch', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-b', 'h1', base + 10_000);
    insertAudit('r3', 'recipe-c', 'h1', base + 30_000);

    await stepWith(auditCompactionTask, { kind: 'complete' });

    expect(countRows()).toBe(3);
  });

  it('skips commit_status=failed rows entirely (operators need every failure)', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base, false); // failure — never compacted
    insertAudit('r2', 'recipe-a', 'h1', base + 10_000, false);
    insertAudit('r3', 'recipe-a', 'h1', base + 20_000, false);

    await stepWith(auditCompactionTask, { kind: 'complete' });

    expect(countRows()).toBe(3);
  });

  it('treats commit_status=succeeded and =failed rows as separate streams', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base, true);
    insertAudit('r2', 'recipe-a', 'h1', base + 5_000, false); // failure not compacted
    insertAudit('r3', 'recipe-a', 'h1', base + 10_000, true); // dupe of r1 (failure in between is invisible to the succeeded scan)

    await stepWith(auditCompactionTask, { kind: 'complete' });

    const keys = (db.prepare(`SELECT key FROM audit_entries ORDER BY key ASC`).all() as Array<{ key: string }>).map((r) => r.key);
    // r1 anchor preserved, r3 dropped, r2 (failure) untouched.
    expect(keys).toEqual(['r1', 'r2']);
  });

  it('advances cursor to the latest started_at processed', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-b', 'h1', base + 10_000);

    const result = await stepWith(auditCompactionTask, { kind: 'complete' });
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: base + 10_000 });
  });

  it('honours an existing time cursor — only walks rows past last_seen_at', async () => {
    const base = 1_000_000;
    insertAudit('r1', 'recipe-a', 'h1', base);
    insertAudit('r2', 'recipe-a', 'h1', base + 30_000);
    insertAudit('r3', 'recipe-a', 'h1', base + 60_000);

    // Pretend we already saw r1 + r2 last cycle.
    const result = await stepWith(auditCompactionTask, {
      kind: 'time',
      last_seen_at: base + 30_000,
    });
    expect(result.status).toBe('complete');
    // r1 + r2 untouched (cursor skipped them); r3 alone has no anchor → kept.
    expect(countRows()).toBe(3);
  });

  it('returns complete with cursor=time even when no rows are present', async () => {
    const result = await stepWith(auditCompactionTask, { kind: 'complete' });
    expect(result.status).toBe('complete');
    // Empty DB → cursor stays at 0 (no rows to advance over).
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 0 });
  });
});

describe('auditCompactionTask.step — budget exhaustion', () => {
  it('yields with budget_exhausted when the budget runs out mid-walk', async () => {
    // Seed 100 rows so we reliably exceed the budget on a tiny budget_ms.
    const base = 1_000_000;
    for (let i = 0; i < 100; i++) {
      insertAudit(`row-${i}`, 'recipe-a', 'h1', base + i * 1_000);
    }
    // Budget of 0 ms forces a yield on the first batch attempt.
    const result = await auditCompactionTask.step(stubCtx(), { kind: 'complete' }, 0);
    expect(result.status).toBe('yield');
    if (result.status === 'yield') {
      expect(result.reason).toBe('budget_exhausted');
      expect(result.cursor.kind).toBe('time');
    }
  });
});
