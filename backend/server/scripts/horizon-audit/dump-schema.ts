/** Boot the real server once and copy its database out, so the query audit
 *  EXPLAINs against a FULLY MIGRATED schema.
 *
 *  ⛔ WHY NOT JUST USE THE BENCH SEED. It is missing tables that only exist
 *  after migrations run — `chat_plans`, `execution_reports`,
 *  `execution_case_arguments`, `case_interventions`, `hostnames` and more. Every
 *  query against one of those came back "no such table", i.e. NOT ANALYSED, and
 *  a sweep whose denominator quietly excludes whole subsystems is worse than no
 *  sweep. Booting is the only honest way to get the schema the server actually
 *  runs on.
 *
 *  ⚠ The copy is taken BEFORE any vault open, so the file stays plaintext and
 *  readable. Opening the vault applies D-212 at-rest encryption and the dump
 *  would be unreadable from outside the server.
 *
 *  ⛔ AND IT COPIES THE WAL SIDECAR WITH IT. The server runs in WAL mode, so a
 *  bare file copy silently loses every write since the last checkpoint — 23% of
 *  the schema, measured. Booting for an honest schema and then dropping a
 *  quarter of it one line later is worse than not booting at all, because the
 *  result still looks authoritative. See `copy-db-snapshot.ts`. */

import { resolve } from 'node:path';

import { copyDatabaseSnapshot } from './copy-db-snapshot.js';

import { bootInstrumentedServer } from './boot.js';
import { seedReceptionRateLimiter } from './probes.js';
import { resolveSeedDir, seedNotFoundMessage } from './seed-dir.js';

const REPO = resolve(import.meta.dirname, '../../../..');
// Resolved by CONTENT, not by name — see `seed-dir.ts`. Same lookup every other
// horizon-audit entry point uses, so they cannot disagree about which seed.
const SEED = resolveSeedDir(REPO);
if (SEED.dir === null) {
  console.error(seedNotFoundMessage(SEED));
  process.exit(1);
}
const SEED_DIR = SEED.dir;
const out = process.argv[2];
if (!out) {
  console.error('usage: dump-schema.ts <out.db>');
  process.exit(2);
}

const main = async (): Promise<void> => {
  const booted = await bootInstrumentedServer({
    workDir: resolve(REPO, '.horizon-audit-scratch/schema-boot'),
    seedDb: resolve(SEED_DIR, 'seed-test.db'),
    seedIdentity: resolve(SEED_DIR, 'seed-identity.json'),
    port: 47921,
    preBootSeed: seedReceptionRateLimiter,
  });
  // ⛔ SIDECARS INCLUDED. A plain `copyFileSync` dropped everything still in
  // the WAL — measured at 185 of 808 schema objects on a real boot, which made
  // the SQL audit report indexes as missing when they existed. See
  // `copy-db-snapshot.ts`.
  copyDatabaseSnapshot(booted.dbPath, resolve(out));
  process.stdout.write(`schema dumped to ${out}\n`);
};

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
