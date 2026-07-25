/* `listCollectionReferencedBlobHashes` — the collection CAS-ref reader that the
 * eviction sweep keepset + the archive blob set both build on (blob-encryption
 * Phase 1). Exercised against a REAL sqlite db (the reader was previously only
 * reached through mocks). Key behaviors:
 *   - unions blob_hash across every body `collection_*` table;
 *   - STRUCTURALLY skips collection_* tables with no blob_hash column
 *     (`collection_instances`, `collection_file_inbound_storage_refs`) via the
 *     column probe — WITHOUT swallowing, so a transient error would still throw
 *     (fail-closed, matching the sibling cache/shared/annotation readers). */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { listCollectionReferencedBlobHashes } from '../storage/collection-blob-refs.js';

describe('listCollectionReferencedBlobHashes', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('returns ∅ when there are no collection_* tables', () => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE cache_entries (blob_hash TEXT);`);
    expect(listCollectionReferencedBlobHashes(db)).toEqual(new Set());
  });

  it('unions blob_hash across body collection tables, ignoring NULLs + dupes', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE collection_mail_work (record_id TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE collection_calendar_home (record_id TEXT PRIMARY KEY, blob_hash TEXT);
    `);
    db.exec(`
      INSERT INTO collection_mail_work VALUES ('a','h1'),('b','h2'),('c',NULL),('d','h1');
      INSERT INTO collection_calendar_home VALUES ('e','h3'),('f',NULL);
    `);
    expect(listCollectionReferencedBlobHashes(db)).toEqual(new Set(['h1', 'h2', 'h3']));
  });

  it('STRUCTURALLY skips collection_* tables with no blob_hash column (no throw)', () => {
    db = new Database(':memory:');
    // A body table + the two real non-body collection tables that lack a
    // blob_hash column. A naive `SELECT blob_hash FROM collection_instances`
    // would throw "no such column" and — if that throw were swallowed — a
    // transient error would be indistinguishable. The column probe skips these
    // structurally instead.
    db.exec(`
      CREATE TABLE collection_mail_work (record_id TEXT PRIMARY KEY, blob_hash TEXT);
      CREATE TABLE collection_instances (platform TEXT, slug TEXT, config_json TEXT);
      CREATE TABLE collection_file_inbound_storage_refs (slug TEXT, record_id TEXT, storage_ref TEXT);
    `);
    db.exec(`INSERT INTO collection_mail_work VALUES ('a','body-hash');`);
    // Must NOT throw despite the two column-less tables, and returns only the
    // body table's ref.
    expect(listCollectionReferencedBlobHashes(db)).toEqual(new Set(['body-hash']));
  });

  it('fail-closed: a genuine query error on a body table PROPAGATES (not swallowed)', () => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE collection_mail_work (record_id TEXT PRIMARY KEY, blob_hash TEXT);`);
    db.exec(`INSERT INTO collection_mail_work VALUES ('a','h1');`);
    db.close(); // reading a closed db throws — stands in for a transient/IO error
    expect(() => listCollectionReferencedBlobHashes(db)).toThrow();
    // guard afterEach against double-close
    db = undefined as unknown as Database.Database;
  });
});
