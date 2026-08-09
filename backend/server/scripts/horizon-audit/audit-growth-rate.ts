/** How fast does the audit log actually grow?
 *
 *      npx tsx backend/server/scripts/horizon-audit/audit-growth-rate.ts [idleSeconds]
 *
 *  ⛔ WHY THIS EXISTS. The retention pruner's idle cost was benchmarked against
 *  a row count (124ms at 400,000 rows) — but a row count is an AXIS, not a
 *  date. "When does a real server get there" is the question that decides
 *  whether that cost is a footnote or a problem, and nothing measured it.
 *
 *  🔑 TWO RATES, MEASURED SEPARATELY, because they scale with different things:
 *    - the IDLE FLOOR: rows written with nobody using the server. Scheduled
 *      work only — housekeeping, cron, reactive ticks. Scales with TIME.
 *    - the PER-ACTION cost: rows written by one chat turn / one recipe run.
 *      Scales with USE.
 *  A single blended "rows per day" hides which one dominates, and they have
 *  different fixes.
 *
 *  ⚠ REPORTS RATES AND THE ARITHMETIC, NOT A PREDICTION. What a given server
 *  writes depends on how many recipes are installed, what is scheduled, and how
 *  much the owner chats — none of which this can know. It measures THIS server
 *  and shows the scenarios; the reader supplies the usage. */

import { spawnSync } from 'node:child_process';
import { resolveSeedDir, seedNotFoundMessage } from './seed-dir.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInstrumentedServer } from './boot.js';
import { openServerVault } from './unlock-vault.js';
import { configureLlmFromDevEnv } from './llm-env.js';
import { createRecordViaRecipe, driveChatTurn, installPack } from './install-packs.js';

const REPO = resolve(import.meta.dirname, '../../../..');

interface Counts { entries: number; activities: number; bytes: number }

const countRows = (db: import('better-sqlite3').Database): Counts => {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  return {
    entries: one('SELECT COUNT(*) c FROM audit_entries'),
    activities: one('SELECT COUNT(*) c FROM audit_activities'),
    bytes: one(`SELECT COALESCE((SELECT SUM(length(data)) FROM audit_entries), 0)
                     + COALESCE((SELECT SUM(length(data)) FROM audit_activities), 0) AS c`),
  };
};

const delta = (a: Counts, b: Counts): Counts => ({
  entries: b.entries - a.entries,
  activities: b.activities - a.activities,
  bytes: b.bytes - a.bytes,
});

const rows = (c: Counts): number => c.entries + c.activities;

const main = async (): Promise<number> => {
  const workDir = process.env.HORIZON_WORKDIR ?? resolve(REPO, '.audit-rate-scratch');
  const seed = resolveSeedDir(REPO);
  if (seed.dir === null) {
    console.error(seedNotFoundMessage(seed));
    return 1;
  }
  const seedDir = seed.dir;
  const seedDb = resolve(seedDir, 'seed-test.db');
  const seedIdentity = resolve(seedDir, 'seed-identity.json');
  const seedRecoveryKey = resolve(seedDir, 'seed-recovery-key.txt');
  const port = Number(process.env.HORIZON_PORT ?? 47930);

  if (!existsSync(seedDb)) {
    console.error(`[audit-rate] seed not found under ${seedDir}`);
    return 1;
  }

  const DEV_ENV_PATH = resolve(REPO, '../dev.env');
  const llm = configureLlmFromDevEnv(DEV_ENV_PATH);
  if (llm.configured && llm.slot) {
    spawnSync(
      process.execPath,
      ['--import', 'tsx',
        fileURLToPath(new URL('./llm-phase1.ts', import.meta.url)),
        workDir, seedDb, seedIdentity, String(port + 1), seedRecoveryKey, DEV_ENV_PATH],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  }

  const booted = await bootInstrumentedServer({
    workDir, seedDb, seedIdentity, port, reuseWorkDir: true,
  });
  const vault = await openServerVault({ port, recoveryKeyPath: seedRecoveryKey });
  if (!vault.ok) {
    console.error(`[audit-rate] vault not opened — ${vault.reason}`);
    await booted.shutdown();
    return 1;
  }
  const conn = vault.conn;

  // ⛔ `openDatabase` IS THE D-212 CHOKEPOINT — the only opener that applies
  // at-rest encryption. My first cut said "the server's own handle" in a
  // comment and then did `new Database(booted.dbPath)`, which fails outright
  // with "file is not a database". The comment was right; the code was not.
  const { openDatabase } = await import('../../src/open-database.js');
  const db = await openDatabase(booted.dbPath);

  // ── 1. Idle floor, PER TICK × CADENCE ────────────────────────────────
  // ⛔ WALL-CLOCK SAMPLING CANNOT MEASURE THIS, and the first version of this
  // script tried. It watched for 180s, saw +0 rows, and reported "0 rows/hour,
  // 0 rows/day" — but the registered cadences here are 1h and 24h, so a
  // three-minute window is structurally incapable of observing a single fire of
  // the writers that matter. A zero from a window shorter than the period is
  // not a zero.
  //
  // So: drive each registered interval ONCE, attribute the audit rows it wrote,
  // and scale by how often it actually fires. That reads the real tick, not a
  // model of it.
  console.error('[audit-rate] measuring IDLE floor per tick × cadence…');
  let idlePerDayRows = 0;
  let idlePerDayBytes = 0;
  const perTick: Array<{ name: string; rows: number; perDay: number }> = [];
  for (const interval of booted.capture.intervals) {
    const before = countRows(db);
    try {
      await interval.tick();
    } catch {
      // A tick that throws writes nothing; it is not an idle-floor contributor.
    }
    const d = delta(before, countRows(db));
    const firesPerDay = interval.intervalMs > 0
      ? 86_400_000 / interval.intervalMs
      : 0;
    const rowsPerDay = rows(d) * firesPerDay;
    idlePerDayRows += rowsPerDay;
    idlePerDayBytes += d.bytes * firesPerDay;
    if (rows(d) > 0) {
      perTick.push({ name: interval.name, rows: rows(d), perDay: rowsPerDay });
    }
    console.error(
      `    ${interval.name.padEnd(32)} +${String(rows(d)).padStart(3)} rows/tick`
      + `  × ${firesPerDay.toFixed(1).padStart(7)} fires/day = ${rowsPerDay.toFixed(0)}/day`,
    );
  }

  // ── 2a. Per RECIPE RUN ───────────────────────────────────────────────
  // ⛔ THE CONVERSION THAT ACTUALLY MATTERS. The interval layer above writes
  // nothing, but intervals are not what a busy server runs — CRON and REACTIVE
  // recipes are, and each of those is a recipe RUN. This seed schedules none,
  // so the idle floor it reports is honest for this seed and says nothing about
  // a server with cron recipes installed. Measuring one run gives the
  // multiplier a reader needs to turn their own schedule into a rate.
  console.error('[audit-rate] measuring PER-RECIPE-RUN cost…');
  await installPack(conn, resolve(REPO, 'community/packs'), 'decision-log')
    .catch(() => undefined);
  const RUNS = 5;
  const runStart = countRows(db);
  let ranOk = 0;
  for (let i = 0; i < RUNS; i++) {
    // ⚠ Recipe id and config copied VERBATIM from `installAuditSubstrate`,
    // which is proved to work every harness run. A publisher-qualified id
    // (`recued-core/log-decision`) and a config missing `review_in_days` both
    // failed silently — 0/5 runs, which would have read as "a recipe run
    // writes no audit rows" rather than "my call was wrong".
    const res = await createRecordViaRecipe(conn, 'log-decision', {
      title: `Audit rate run ${i}`,
      rationale: 'measuring audit growth per recipe run',
      review_in_days: 90,
    }).catch(() => undefined);
    if (res?.ok) ranOk += 1;
  }
  const runDelta = delta(runStart, countRows(db));
  // ⛔ NO SUCCESSFUL RUN MEANS NO MEASUREMENT — not a rate of zero. Reporting
  // 0 rows/run from 0/5 runs is the same lie as "0 rows in a window shorter
  // than the period".
  const perRun = ranOk > 0 ? rows(runDelta) / ranOk : Number.NaN;
  const bytesPerRun = ranOk > 0 ? runDelta.bytes / ranOk : Number.NaN;
  console.error(
    `    ${ranOk}/${RUNS} runs → ${rows(runDelta)} rows`
    + ` (entries ${runDelta.entries} / activities ${runDelta.activities})`,
  );

  // ── 2b. Per-action cost ──────────────────────────────────────────────
  console.error('[audit-rate] measuring PER-CHAT-TURN cost…');
  const TURNS = 3;
  const chatStart = countRows(db);
  for (let i = 0; i < TURNS; i++) {
    await driveChatTurn(
      conn,
      `Record a decision titled "Audit rate probe ${i}" with the rationale `
      + '"measuring audit growth", then tell me whether you completed it.',
      180_000,
    ).catch(() => undefined);
  }
  const chatDelta = delta(chatStart, countRows(db));

  db.close();
  conn.close();
  await booted.shutdown();

  // ── Report ───────────────────────────────────────────────────────────
  const idlePerDay = idlePerDayRows;
  const perTurn = TURNS > 0 ? rows(chatDelta) / TURNS : 0;
  const bytesPerTurn = TURNS > 0 ? chatDelta.bytes / TURNS : 0;

  console.error('\n══ AUDIT GROWTH RATE ══\n');
  console.error(`idle floor        : ${idlePerDay.toFixed(0)} rows/day`
    + `  (~${(idlePerDayBytes / 1024).toFixed(0)} KB/day) from scheduled work alone`);
  for (const t of perTick.sort((a, b) => b.perDay - a.perDay)) {
    console.error(`    ${t.name.padEnd(32)} ${t.rows}/tick → ${t.perDay.toFixed(0)}/day`);
  }
  console.error(`per recipe run    : ${
    Number.isNaN(perRun) ? 'NOT MEASURED — 0 runs succeeded' : `${perRun.toFixed(1)} rows  (~${bytesPerRun.toFixed(0)} B)`
  }   [${ranOk}/${RUNS} runs succeeded]`);
  console.error(`per chat turn     : ${perTurn.toFixed(1)} rows`
    + `  (~${bytesPerTurn.toFixed(0)} B)`
    + `  [entries ${chatDelta.entries} / activities ${chatDelta.activities} over ${TURNS} turns]`);

  console.error('\n── days to 400,000 rows, by SCHEDULED RECIPE RUNS ──');
  for (const runsPerDay of [24, 240, 1440, 8640]) {
    const perDay = idlePerDay + runsPerDay * (Number.isNaN(perRun) ? 0 : perRun);
    const days = perDay > 0 ? 400_000 / perDay : Infinity;
    console.error(
      `  ${String(runsPerDay).padStart(5)} runs/day (${(runsPerDay / 24).toFixed(0)}/h)`
      + ` → ${perDay.toFixed(0).padStart(7)} rows/day`
      + `  → ${days === Infinity ? 'never' : `${days.toFixed(0)} days (${(days / 365).toFixed(1)} yr)`}`,
    );
  }

  console.error('\n── days to 400,000 rows, by CHAT ──');
  for (const turnsPerDay of [0, 20, 100, 500]) {
    const perDay = idlePerDay + turnsPerDay * perTurn;
    const days = perDay > 0 ? 400_000 / perDay : Infinity;
    console.error(
      `  ${String(turnsPerDay).padStart(4)} chat turns/day → ${perDay.toFixed(0).padStart(7)} rows/day`
      + `  → ${days === Infinity ? 'never' : `${days.toFixed(0)} days (${(days / 365).toFixed(1)} yr)`}`,
    );
  }
  console.error(
    '\n⚠ THIS SERVER, THIS SEED. The idle floor is whatever is SCHEDULED here;\n'
    + '  a server with cron recipes or reactive triggers writes more, one with\n'
    + '  none writes less. The per-turn figure is one model on one pack set.\n'
    + '  Retention also caps the corpus by BYTES, so a server never reaches a\n'
    + '  row count its quota cannot hold — the row axis is the scan cost, the\n'
    + '  byte axis is what actually stops growth.',
  );
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('[audit-rate] fatal:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
