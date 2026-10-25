#!/usr/bin/env node
/**
 * `npm run typecheck:tests`: type-check the test tree as several programs, one after
 * another, instead of one.
 *
 * ⛔ WHY NOT ONE `tsc -p tsconfig.test.json`. A program keeps every file's syntax tree
 * and types until it ends: nothing is freed when a file's check is done, because a later
 * file can reach the same types. As one program the test tree (8,698 files with what
 * they import) ended holding 7.8 GiB of heap on 2026-10-23, 98% of the 8 GiB cap, on a
 * 24 GB machine that sweeps share with every session, and it gains 2-3k tests a month.
 * Each part here is its own process, so its memory is returned before the next part
 * starts: the peak is the largest part, not the sum. The four parts ended at 2.4 to
 * 3.7 GiB and took 169 s together, against 176 s as one program. What a part re-checks
 * is the source it shares with others (contracts, above all): time, not peak memory.
 *
 * THE PARTS are the root's `tsconfig.test.<part>.json` files, run in name order. Each
 * extends `tsconfig.test.json` and takes a slice of its `include`. In the source
 * repository `scripts/typecheck-tests.test.ts` fails unless together they name exactly
 * its test files, each once, so a pattern added to `tsconfig.test.json` alone fails
 * there. Backend is two parts, its decision tests (`d-*`) and the rest: as one part it
 * ended at 4.9 GiB.
 *
 * Every part runs even when one fails, so a run lists every error, and the exit status
 * is non-zero when any part failed: the sweep reads both (`error TS` lines and status).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const parts = readdirSync(root).filter((name) => /^tsconfig\.test\.[a-z0-9-]+\.json$/u.test(name)).sort();
if (parts.length === 0) {
  console.error('[typecheck:tests] no tsconfig.test.<part>.json at the repository root');
  process.exit(2);
}

let failed = 0;
for (const part of parts) {
  const started = Date.now();
  // The cap each part had as one program, so no part can run out sooner than the whole did.
  const run = spawnSync(process.execPath, ['--max-old-space-size=8192', tsc, '-p', part, '--noEmit'], {
    cwd: root,
    stdio: 'inherit',
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (run.status === 0) {
    console.log(`[typecheck:tests] ${part}: ok in ${seconds}s`);
  } else {
    failed += 1;
    const why = run.error?.message ?? (run.signal ? `killed by ${run.signal}` : `exit ${run.status}`);
    console.log(`[typecheck:tests] ${part}: FAILED (${why}) in ${seconds}s`);
  }
}
process.exit(failed === 0 ? 0 : 1);
