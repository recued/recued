/** D-123 Phase 1 — Per-task `housekeeping_state` store tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHousekeepingStateStore } from '../housekeeping/state-store.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-state-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createHousekeepingStateStore', () => {
  it('returns null for an unseen task', () => {
    const store = createHousekeepingStateStore(db);
    expect(store.get('audit-compaction')).toBeNull();
  });

  it('round-trips a complete state row', () => {
    const store = createHousekeepingStateStore(db);
    store.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'time', last_seen_at: NOW },
      last_status: 'complete',
      last_run_at: NOW,
      last_run_duration_ms: 320,
    });
    const row = store.get('audit-compaction');
    expect(row).toEqual({
      task_id: 'audit-compaction',
      cursor: { kind: 'time', last_seen_at: NOW },
      last_status: 'complete',
      last_run_at: NOW,
      last_run_duration_ms: 320,
      consecutive_errors: 0,
    });
  });

  it("clears prior 'last_error' on a fresh successful set", () => {
    const store = createHousekeepingStateStore(db);
    store.recordError('audit-compaction', 'boom', NOW);
    store.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'complete' },
      last_status: 'complete',
      last_run_at: NOW + 1_000,
      consecutive_errors: 0,
    });
    const row = store.get('audit-compaction');
    expect(row?.last_error).toBeUndefined();
    expect(row?.consecutive_errors).toBe(0);
  });

  it('list returns rows ordered by task_id', () => {
    const store = createHousekeepingStateStore(db);
    store.set({
      task_id: 'link-discovery',
      cursor: { kind: 'time', last_seen_at: NOW },
      last_status: 'complete',
    });
    store.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'time', last_seen_at: NOW },
      last_status: 'complete',
    });
    const rows = store.list();
    expect(rows.map((r) => r.task_id)).toEqual([
      'audit-compaction',
      'link-discovery',
    ]);
  });

  it('recordError increments consecutive_errors across calls', () => {
    const store = createHousekeepingStateStore(db);
    expect(store.recordError('audit-compaction', 'first', NOW)).toBe(1);
    expect(store.recordError('audit-compaction', 'second', NOW + 1)).toBe(2);
    expect(store.recordError('audit-compaction', 'third', NOW + 2)).toBe(3);
    const row = store.get('audit-compaction');
    expect(row?.last_status).toBe('error');
    expect(row?.last_error).toBe('third');
  });

  it("resetError clears counter + flips 'error' status to 'pending'", () => {
    const store = createHousekeepingStateStore(db);
    store.recordError('audit-compaction', 'boom', NOW);
    store.resetError('audit-compaction');
    const row = store.get('audit-compaction');
    expect(row?.consecutive_errors).toBe(0);
    expect(row?.last_error).toBeUndefined();
    expect(row?.last_status).toBe('pending');
  });

  it("resetError leaves non-'error' status untouched", () => {
    const store = createHousekeepingStateStore(db);
    store.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'complete' },
      last_status: 'complete',
    });
    store.resetError('audit-compaction');
    expect(store.get('audit-compaction')?.last_status).toBe('complete');
  });

  it('clear drops the row entirely', () => {
    const store = createHousekeepingStateStore(db);
    store.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'complete' },
      last_status: 'complete',
    });
    store.clear('audit-compaction');
    expect(store.get('audit-compaction')).toBeNull();
  });

  it('preserves topic-cursor variants through round-trip', () => {
    const store = createHousekeepingStateStore(db);
    store.set({
      task_id: 'enrichment.thread_signals',
      cursor: {
        kind: 'topic',
        topic: 'thread_signals',
        scope: 'mail',
        max_target_id_seen: 'mail_99',
      },
      last_status: 'complete',
    });
    expect(store.get('enrichment.thread_signals')?.cursor).toEqual({
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'mail_99',
    });
  });
});
