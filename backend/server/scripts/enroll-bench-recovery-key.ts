#!/usr/bin/env -S npx tsx
/** Direct (no-WS) recovery-key enrollment for recued-substrate-bench seed gen.
 *
 *  Since server commit 272fadf6 ("reject non-canonical bearers") the WS
 *  upgrade rejects a raw `?token=` bearer whenever the server wires
 *  `clientTokens` against a real db (which the seed db is) — so
 *  `regenerate-seed.mjs` can no longer enroll the realm over a live WS with a
 *  legacy token (`pair.registerRecoveryKey` is unreachable: the upgrade 401s
 *  before dispatch). Enrollment is pure db I/O though — `processRecoveryKey`
 *  writes a self-contained AEAD-sealed sentinel into the `server_config` table
 *  via `RecoveryKeyCheckStore`; the raw key is never persisted. This script
 *  does exactly that against the QUIESCENT seed db (same direct-write pattern
 *  as `seed-bench-warehouse.ts`), so the seed boots already-enrolled and
 *  run.ts's per-task `/auth/pair` verify (same recovery key) matches.
 *
 *  Run via tsx — workspace `@recued/*` packages resolve to their TS source:
 *
 *    tsx backend/server/scripts/enroll-bench-recovery-key.ts <dbPath> <recoveryKey>
 */

import Database from 'better-sqlite3';

import { createRecoveryKeyCheckStore } from '../src/recovery-key-store.js';
import { processRecoveryKey } from '../src/recovery-key-processor.js';

const dbPath = process.argv[2];
const recoveryKey = process.argv[3];
if (!dbPath || !recoveryKey) {
  console.error('[enroll] usage: enroll-bench-recovery-key.ts <dbPath> <recoveryKey>');
  process.exit(1);
}

const main = async (): Promise<void> => {
  const db = new Database(dbPath);
  try {
    const store = createRecoveryKeyCheckStore(db);
    const result = await processRecoveryKey(store, recoveryKey);
    if (!result.ok) {
      console.error(`[enroll] recovery-key enroll failed: ${result.code}: ${result.message}`);
      process.exitCode = 1;
      return;
    }
    // Flush WAL into the main db file so the sentinel survives the bench's
    // single-.db-file copy (mirrors the warehouse seeder).
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`[enroll] ✓ recovery key ${result.outcome} → ${dbPath}`);
  } finally {
    db.close();
  }
};

main().catch((e) => {
  console.error(`[enroll] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
