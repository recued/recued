/** D-145 engine-wiring slice 3b.1 — request-scoped commit index. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { Commit } from '@recued/contracts';

import { ensureCommitSchema } from '../memory-schema.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const REQUEST_INDEX = 'commits_request_id_idx';

const indexNames = (db: Database.Database): Set<string> => {
  const rows = db.prepare('PRAGMA index_list(commits)').all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
};

const requestIndexInfo = (db: Database.Database): Array<{
  seqno: number;
  cid: number;
  name: string | null;
}> =>
  db.prepare(`PRAGMA index_info(${REQUEST_INDEX})`).all() as Array<{
    seqno: number;
    cid: number;
    name: string | null;
  }>;

const requestIndexKeyColumns = (db: Database.Database): Array<{
  seqno: number;
  cid: number;
  name: string | null;
  key: number;
}> =>
  (
    db.prepare(`PRAGMA index_xinfo(${REQUEST_INDEX})`).all() as Array<{
      seqno: number;
      cid: number;
      name: string | null;
      key: number;
    }>
  )
    .filter((row) => row.key === 1)
    .sort((a, b) => a.seqno - b.seqno);

const requestIndexSql = (db: Database.Database): string => {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    )
    .get(REQUEST_INDEX) as { sql: string } | undefined;
  expect(row).toBeDefined();
  return row!.sql;
};

const requestIndexTable = (db: Database.Database): string => {
  const row = db
    .prepare(
      `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    )
    .get(REQUEST_INDEX) as { tbl_name: string } | undefined;
  expect(row).toBeDefined();
  return row!.tbl_name;
};

describe('ensureCommitSchema D-145 slice 3b.1 request index', () => {
  it('creates commits_request_id_idx on the commits table', () => {
    const db = new Database(':memory:');
    try {
      createSQLiteCollection<Commit>(db, 'commits');

      ensureCommitSchema(db);

      expect(indexNames(db).has(REQUEST_INDEX)).toBe(true);
      expect(requestIndexTable(db)).toBe('commits');
    } finally {
      db.close();
    }
  });

  it('creates a composite request_id then dispatched_at json_extract index', () => {
    const db = new Database(':memory:');
    try {
      createSQLiteCollection<Commit>(db, 'commits');

      ensureCommitSchema(db);

      const info = requestIndexInfo(db);
      expect(info).toHaveLength(2);
      expect(info.map((row) => row.seqno)).toEqual([0, 1]);
      expect(info.every((row) => row.cid === -2)).toBe(true);
      expect(info.every((row) => row.name === null)).toBe(true);

      const keyColumns = requestIndexKeyColumns(db);
      expect(keyColumns).toHaveLength(2);
      expect(keyColumns.map((row) => row.seqno)).toEqual([0, 1]);
      expect(keyColumns.every((row) => row.cid === -2)).toBe(true);
      expect(keyColumns.every((row) => row.name === null)).toBe(true);

      const ddl = requestIndexSql(db);
      const requestIdPosition = ddl.indexOf('$.request_id');
      const dispatchedAtPosition = ddl.indexOf('$.dispatched_at');
      expect(requestIdPosition).toBeGreaterThanOrEqual(0);
      expect(dispatchedAtPosition).toBeGreaterThanOrEqual(0);
      expect(requestIdPosition).toBeLessThan(dispatchedAtPosition);
    } finally {
      db.close();
    }
  });

  it('is idempotent and leaves the request index installed', () => {
    const db = new Database(':memory:');
    try {
      createSQLiteCollection<Commit>(db, 'commits');

      expect(() => ensureCommitSchema(db)).not.toThrow();
      expect(() => ensureCommitSchema(db)).not.toThrow();

      expect(indexNames(db).has(REQUEST_INDEX)).toBe(true);
    } finally {
      db.close();
    }
  });
});
