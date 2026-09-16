/** D-192 — a failed mirror-data purge must NOT delete the connection.
 *
 *  ⛔ THE BUG THIS PINS. The purge runs BEFORE `store.delete` (it must —
 *  once the row is gone `listSources()` cannot reach the connection's
 *  sources). It used to swallow a throw with the comment "the purge is
 *  idempotent + re-runnable". It is not: a re-run reads
 *  `store.get(kind, name)`, gets null, and the purge is gated on
 *  `existing !== null`. So the residue was orphaned permanently while the
 *  owner — who had explicitly ticked "also remove the mirrored records" —
 *  was told the delete succeeded.
 *
 *  🔑 THE PAIR IS THE DEFECT, NOT EITHER HALF. "Purge before delete" is
 *  correct. "Swallow and continue" is a normal best-effort posture, and its
 *  two neighbours in this handler keep it legitimately because they run
 *  AFTER the delete and have real recovery paths. Only the COMPOSITION is
 *  wrong — a best-effort step whose recovery the next line destroys. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleConnectionDelete } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';

let dir: string;
let db: Database.Database;
let store: ReturnType<typeof createConnectionStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-192-purge-fail-'));
  db = new Database(join(dir, 'conn.db'));
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const enrolled = (name: string, subtype = 'hubspot'): void => {
  store.upsert({
    kind: 'api',
    name,
    subtype,
    display_name: name,
    config_json: '{}',
    auth_ciphertext: 'placeholder',
    enrolled_at: 1_750_000_000_000,
    updated_at: 1_750_000_000_000,
  });
};

describe('handleConnectionDelete — a failed purge keeps the connection', () => {
  it('⛔ throws and KEEPS the row when the opted-in purge fails', async () => {
    enrolled('my_hubspot');
    const purge = vi.fn(() => { throw new Error('mirror table locked'); });

    await expect(handleConnectionDelete(
      { store, purgeConnectionData: purge },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    )).rejects.toMatchObject({ code: 'conflict' });

    expect(purge).toHaveBeenCalledTimes(1);
    // The row surviving is the whole point: it keeps the residue reachable
    // and makes the retry below actually able to run.
    expect(store.get('api', 'my_hubspot')).not.toBeNull();
  });

  it('🔑 the retry then WORKS — which is what the old comment falsely promised', async () => {
    enrolled('my_hubspot');
    let attempt = 0;
    const purge = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return { work_entities: 0, files: 0 } as never;
    });

    await expect(handleConnectionDelete(
      { store, purgeConnectionData: purge },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    )).rejects.toMatchObject({ code: 'conflict' });

    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purge },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    );
    expect(out.deleted).toBe(true);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(store.get('api', 'my_hubspot')).toBeNull();
  });

  it('⚠ nobody is trapped — deleting WITHOUT the removal still succeeds', async () => {
    enrolled('my_hubspot');
    const purge = vi.fn(() => { throw new Error('permanently broken'); });

    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purge },
      { kind: 'api', name: 'my_hubspot' },
    );
    expect(out.deleted).toBe(true);
    expect(purge).not.toHaveBeenCalled();
    expect(store.get('api', 'my_hubspot')).toBeNull();
  });

  it('a SUCCEEDING purge is unaffected — delete proceeds and reports the summary', async () => {
    enrolled('my_hubspot');
    const summary = { work_entities: 3, files: 1 } as never;
    const purge = vi.fn(() => summary);

    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purge },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    );
    expect(out.deleted).toBe(true);
    expect(out.purged).toBe(summary);
    expect(store.get('api', 'my_hubspot')).toBeNull();
  });
});
