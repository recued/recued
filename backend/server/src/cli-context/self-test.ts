/** `recued self-test` — prove this payload can LOAD ITS NATIVE ADDON AND OPEN A
 *  DATABASE. Installer-internal, like `report-boot-failure` and `revert-release`.
 *
 *  ⛔⛔⛔ WHAT `--version` CANNOT SHOW. The installer's smoke check ran
 *  `recued --version` and treated a zero exit as "the result can EXECUTE" — and
 *  that command returns at the top of `bin.ts`'s dispatch, before a single
 *  dynamic import. The SEA loads `lib/better_sqlite3.node` at its first database
 *  open, so a correctly SIGNED but mispackaged or ABI-incompatible addon passed
 *  the smoke, the installer then cleared its unwind window and deleted the
 *  previous pair, and the failure surfaced later as a server that would not start
 *  — with nothing to go back to.
 *
 *  🔑 THE SMOKE'S OWN COMMENT ALREADY NAMED THE GAP: "Every check up to here says
 *  the BYTES are right — signature, sha256, both files placed. None says the
 *  result can EXECUTE." True, and `--version` proves only that the EXECUTABLE
 *  runs. The addon is a second file, loaded lazily, by a path the exe resolves at
 *  runtime — which is exactly the pairing an install can get wrong.
 *
 *  ⚠ IT TOUCHES NO REALM. The probe opens a database in a fresh temp directory
 *  and removes it; the owner's data is never a party to an install-time check.
 *  It also proves nothing about the SERVER — only that the driver loads, opens,
 *  writes and reads back.
 *
 *  Exit status: 0 the payload can open a database; 1 it cannot, with the reason
 *  on stderr for the installer to quote.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';

export interface SelfTestProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** Overridden in tests to drive the FAILURE path. Production omits it and the
   *  probe below runs for real — the success path must exercise the actual
   *  driver, or this proves nothing about the thing it exists to check. */
  probe?: (dbPath: string) => Promise<void> | void;
}

/** Open a database with the installed addon and round-trip one row.
 *
 *  ⚠ A ROUND TRIP, NOT JUST AN OPEN. An ABI mismatch can survive `require` and
 *  fail at first use — the shape this repo has hit before — so the probe
 *  prepares, writes and reads back rather than trusting a constructor. */
export const probeDatabaseRoundTrip = async (dbPath: string): Promise<void> => {
  const { openDatabase } = await import('../open-database.js');
  const db = await openDatabase(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE probe (v TEXT NOT NULL)');
    db.prepare('INSERT INTO probe (v) VALUES (?)').run('ok');
    const row = db.prepare('SELECT v FROM probe').get() as { v?: string } | undefined;
    if (row?.v !== 'ok') throw new Error('the database did not return what was written');
  } finally {
    try { db.close(); } catch { /* the probe is over either way */ }
  }
};

export async function runSelfTestProfile(options: SelfTestProfileOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const probe = options.probe ?? probeDatabaseRoundTrip;

  const dir = mkdtempSync(join(tmpdir(), 'recued-self-test-'));
  try {
    await probe(join(dir, 'probe.db'));
    options.bootTrace.mark('self-test', 'ok');
    exit(0);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    options.bootTrace.mark('self-test', 'failed');
    log(`self-test: this build cannot open a database: ${detail}`);
    log('  the executable runs, so this is usually its native addon —'
      + ' lib/better_sqlite3.node missing, built for another platform, or a different ABI.');
    exit(1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
