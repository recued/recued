#!/usr/bin/env -S npx tsx
/** CLI wrapper around `seedBenchWarehouse` for recued-substrate-bench.
 *
 *  Usage (run via tsx — workspace `@recued/*` packages resolve to their
 *  TS source, so plain `node` can't run this):
 *
 *    tsx backend/server/scripts/seed-bench-warehouse.ts <dbPath>
 *
 *  `recued-substrate-bench/regenerate-seed.mjs` invokes this against the
 *  quiescent throwaway db AFTER the base server boot has written the
 *  schema + canonical seed and the server has exited. We WAL-checkpoint
 *  before closing because the bench copies only the main `.db` file (no
 *  `-wal` / `-shm`) into `seed-test.db`, so the seeded rows must be
 *  flushed into the main file to survive the copy.
 */

import Database from 'better-sqlite3';

import { seedBenchWarehouse } from '../src/dev/seed-bench-warehouse.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('[seed-warehouse] usage: seed-bench-warehouse.ts <dbPath>');
  process.exit(1);
}

const db = new Database(dbPath);
try {
  const result = seedBenchWarehouse(db);
  // Flush WAL into the main db file so the seeded rows are present when
  // the bench copies the single .db file.
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(
    `[seed-warehouse] ✓ calendar '${result.calendar.slug}': ${result.calendar.event_count} event(s), `
      + `mail '${result.mail.slug}': ${result.mail.message_count} message(s), `
      + `deal: ${result.deal.count} record(s), `
      + `contact: ${result.contact.count} record(s), `
      + `recipe: '${result.recipe.tool_name}' → ${dbPath}`,
  );
} finally {
  db.close();
}
