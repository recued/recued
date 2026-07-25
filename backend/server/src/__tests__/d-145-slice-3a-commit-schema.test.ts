/** D-145 engine-wiring slice 3a — D-153 commit table indexes. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { Commit } from '@recued/contracts';

import { ensureCommitSchema } from '../memory-schema.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const EXPECTED_INDEXES = [
  'commits_status_idx',
  'commits_correlation_id_idx',
  'commits_channel_session_id_idx',
  'commits_cognition_session_id_idx',
  'commits_idempotency_key_idx',
  'commits_dispatched_at_idx',
] as const;

const indexNames = (db: Database.Database): Set<string> => {
  const rows = db.prepare('PRAGMA index_list(commits)').all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
};

describe('ensureCommitSchema', () => {
  it('creates all commit json_extract indexes and is idempotent', () => {
    const db = new Database(':memory:');
    try {
      createSQLiteCollection<Commit>(db, 'commits');

      expect(() => ensureCommitSchema(db)).not.toThrow();
      const names = indexNames(db);
      for (const expected of EXPECTED_INDEXES) {
        expect(names.has(expected), expected).toBe(true);
      }

      expect(() => ensureCommitSchema(db)).not.toThrow();
      const namesAfterSecondCall = indexNames(db);
      for (const expected of EXPECTED_INDEXES) {
        expect(namesAfterSecondCall.has(expected), expected).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
