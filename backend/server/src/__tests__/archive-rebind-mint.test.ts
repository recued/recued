/** M5 S2a — `mintRebindIntoStagedDb`: the driving-client bearer handoff.
 *
 *  A committing restore swaps the db (wiping the import-driving client's bearer
 *  — it lived in the now-discarded db), so the runtime mints that paired
 *  instance a FRESH bearer INTO the staged db (which becomes live at the swap).
 *  These cover the security-critical durability invariant directly:
 *   - the minted bearer + roster row survive a MAIN-FILE-ONLY swap (the commit
 *     renames ONLY the main staging file, discarding any `-wal` sidecar);
 *   - an incomplete WAL checkpoint (busy) FAILS the handoff (returns undefined)
 *     rather than hand back a PHANTOM bearer the client would stash over its
 *     working one and then be unable to reconnect with (Codex S2a MEDIUM);
 *   - the new token carries `metadata.instance_id` so the client re-derives the
 *     SAME paired identity, and the roster row is scoped to the right owner.
 *
 *  Uses weak Argon2id params for speed; the full runImport→swap path with prod
 *  params is covered in `archive-rpc-import.test.ts`. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { mintRebindIntoStagedDb } from '../archive/archive-runtime.js';
import type { ArchiveImportDrivingClient } from '../archive/archive-handler.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';

const FAST_ARGON = { t: 1, m: 8, p: 1 };

const DRIVER: ArchiveImportDrivingClient = {
  instance_id: 'inst-driver-1',
  client_kind: 'webclient',
  client_label: 'My Laptop',
  display_name: 'My Laptop',
  user_id: 'self',
};

let dir: string;
let stagingPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recued-rebind-mint-'));
  stagingPath = join(dir, 'staged.db');
  // Model the staged restore db: a real WAL-mode sqlite file (the source server
  // runs WAL, so the streamed-verbatim archive db is WAL too).
  const db = new Database(stagingPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO example VALUES (?)').run('seed');
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mintRebindIntoStagedDb', () => {
  it('mints a bearer + roster row that survive a MAIN-FILE-ONLY swap', async () => {
    // Hold a passive, IDLE (no read transaction) second connection open across
    // the mint + the main-file copy. This defeats SQLite's close-time WAL
    // cleanup: the mint's own `.close()` is no longer the last-connection close,
    // so the ONLY thing that can fold the bearer into the main file is the
    // EXPLICIT `wal_checkpoint(TRUNCATE)`. A mutant dropping that checkpoint
    // would leave the bearer in the `-wal` → the main-file copy below misses it
    // → this test fails (an idle reader does not hold a snapshot, so TRUNCATE
    // still succeeds on the real code).
    const keepalive = new Database(stagingPath);
    let rebind: Awaited<ReturnType<typeof mintRebindIntoStagedDb>>;
    try {
      rebind = await mintRebindIntoStagedDb(stagingPath, DRIVER, {
        argon2_params: FAST_ARGON,
      });
      expect(rebind).toBeDefined();
      expect(rebind?.instance_id).toBe('inst-driver-1');
      expect((rebind?.token_id ?? '').length).toBeGreaterThan(0);
      expect((rebind?.bearer ?? '').length).toBeGreaterThan(0);

      // The commit renames ONLY the main staging file (discarding `-wal`/`-shm`).
      // Copy JUST the main file to model that swap, then prove the bearer +
      // roster are durable in it.
      const swapped = join(dir, 'live.db');
      copyFileSync(stagingPath, swapped);
      const live = new Database(swapped);
      try {
        const verified = await createClientTokenStore(live, {
          argon2_params: FAST_ARGON,
        }).verify(rebind!.token_id, rebind!.bearer);
        expect(verified.ok).toBe(true);
        expect(verified.record?.client_kind).toBe('webclient');
        expect(verified.record?.client_label).toBe('My Laptop');
        // The token carries metadata.instance_id so the next WS upgrade
        // re-derives the SAME paired identity (deriveBearerInstanceId).
        expect(verified.record?.metadata?.instance_id).toBe('inst-driver-1');

        const roster = live
          .prepare('SELECT user_id, display_name FROM paired_instances WHERE instance_id = ?')
          .get('inst-driver-1') as { user_id: string; display_name: string } | undefined;
        expect(roster).toBeDefined();
        expect(roster?.user_id).toBe('self');
        expect(roster?.display_name).toBe('My Laptop');
      } finally {
        live.close();
      }
    } finally {
      keepalive.close();
    }
  });

  it('FAILS CLOSED (returns undefined) when the WAL checkpoint cannot complete', async () => {
    // Hold an open read snapshot from a second connection that PREDATES the
    // mint's writes, so `wal_checkpoint(TRUNCATE)` cannot reclaim the WAL and
    // reports busy != 0. The bearer would then live only in the `-wal` the swap
    // discards, so the handoff must fail closed (no phantom rebind).
    const blocker = new Database(stagingPath);
    blocker.pragma('journal_mode = WAL');
    blocker.exec('BEGIN');
    blocker.prepare('SELECT count(*) AS n FROM example').get(); // acquire snapshot
    try {
      const rebind = await mintRebindIntoStagedDb(stagingPath, DRIVER, {
        argon2_params: FAST_ARGON,
      });
      expect(rebind).toBeUndefined();
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });
});
