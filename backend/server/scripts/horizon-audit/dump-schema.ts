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
 *  would be unreadable from outside the server. */

import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInstrumentedServer } from './boot.js';
import { seedReceptionRateLimiter } from './probes.js';

const REPO = resolve(import.meta.dirname, '../../../..');
// The bench seed is a sibling checkout that is NOT part of this repository and
// whose directory name is local to the machine it was cloned on. Honours the
// same HORIZON_SEED_DIR the other horizon-audit entry points read.
const SEED_DIR = process.env.HORIZON_SEED_DIR ?? resolve(REPO, '..', 'bench-seed');
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
  copyFileSync(booted.dbPath, resolve(out));
  process.stdout.write(`schema dumped to ${out}\n`);
};

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
