/** The audit's OPTIMIZATION check: does an idle cycle cost scale with the
 *  corpus, or with the pending work?
 *
 *  ⛔ WHY THIS IS THE RIGHT QUESTION FOR THIS AUDIT. Everything else here asks
 *  "did it make progress". A subsystem can make perfect progress forever and
 *  still be the thing that kills a long-lived server: a pruner whose idle cycle
 *  scans the whole table costs O(total rows) every tick, forever, while doing
 *  nothing. On a fresh seed it is indistinguishable from an indexed one — both
 *  are instant, both report clean, both drain correctly. It only bites after
 *  months of accumulation, which is precisely the horizon this audit is named
 *  for and precisely what no unit test covers.
 *
 *  THE INVARIANT: measure the SAME idle cycle at two corpus sizes. Cost that
 *  tracks the corpus means a full scan; cost that stays flat means the query is
 *  bounded by pending work.
 *
 *      growth = idleCostLarge / idleCostSmall
 *      corpus grew by N×  ⇒  a scanning subsystem grows ~N×, an indexed one ~1×
 *
 *  ⛔ THE ROWS ADDED MUST NOT BE DUE. If growing the corpus also grows the
 *  pending set, cost rises for the honest reason (there is more work) and the
 *  check fires on correct code. Every `growCorpus` implementation adds rows the
 *  subsystem must look at but must NOT act on — which is also the shape that
 *  makes the finding meaningful: real servers accumulate settled rows, not
 *  pending ones.
 *
 *  ⚠ HEADROOM IS ASSERTED, NOT ASSUMED. If the small-corpus idle cycle issues
 *  almost no statements there is nothing to detect a multiple of, and a ratio
 *  computed from 1 vs 2 statements is noise that reads as a 2× regression. Below
 *  `MIN_HEADROOM_STATEMENTS` the verdict is `no-headroom` — never `clean`. Same
 *  rule the rest of this audit follows: "could not measure" must never render
 *  the same as "measured, fine".
 *
 *  ⚠ AND A SUBSYSTEM WITHOUT A `growCorpus` IS `no-probe`, NOT `clean`. Most
 *  probes do not implement it yet; that is a gap in the harness, and it is
 *  reported as one. */

import type Database from 'better-sqlite3';

import type { Probe, ProbeContext } from './probes.js';
import {
  beginSqlCapture,
  endSqlCapture,
  readSqlMeter,
  resetSqlMeter,
} from './sql-meter.js';

/** Tables that grow without bound on a long-lived server. A full scan of one of
 *  these on every idle tick is the defect this check exists to find; a full scan
 *  of a small bounded table (settings, a registry) is fine and must not be
 *  reported, or the signal drowns.
 *
 *  ⚠ Deliberately a NAMED LIST rather than a row-count heuristic. On the bench
 *  seed every table is small, so "scan a big table" would find nothing and the
 *  check would pass vacuously on a fresh database — which is exactly the
 *  long-horizon blindness being audited. What matters is whether the table
 *  grows in PRODUCTION, which is a fact about the schema, not about this seed. */
const UNBOUNDED_TABLES = new Set([
  'audit_entries',
  'audit_activities',
  'correction_events',
  'execution_case_arguments',
  'execution_reports',
  'pending_asks',
  'shared_store',
  'data_enrichment',
  'core_record_outbox',
  'chat_messages',
]);

/** ⛔ `checkpoints` DELIBERATELY ABSENT — an instrument correction, kept as a
 *  note so it is not "helpfully" re-added.
 *
 *  The check flagged `checkpoint-stale-prune` for `SELECT data FROM checkpoints`
 *  on every idle tick. The scan is real, but the table is NOT unbounded:
 *  `wire-retention-pruners.ts` states the design directly — "the checkpoint
 *  store holds a handful of rows" — because a checkpoint exists only per
 *  CONCURRENTLY PAUSED preflight approval, and each is consumed on answer or
 *  garbage-collected 24h past its grace. Bounded by live pauses, not by history.
 *
 *  Reporting it would have been a false positive produced entirely by this
 *  list, which is the load-bearing guess in this whole check. */

export interface ScanFinding {
  readonly table: string;
  readonly sql: string;
}

/** Ask SQLite how it will run each captured statement, and keep the ones that
 *  FULL SCAN an unbounded table.
 *
 *  ⛔ `EXPLAIN QUERY PLAN` distinguishes `SCAN t` (every row) from
 *  `SEARCH t USING INDEX …` (bounded). This is the dimension a statement
 *  COUNTER cannot reach: the pruners issue exactly one statement per idle
 *  cycle, so counting statements reports 1 whether that statement reads three
 *  rows or three million. */
const findFullScans = (
  db: Database.Database,
  statements: readonly string[],
): ScanFinding[] => {
  const out: ScanFinding[] = [];
  for (const sql of statements) {
    // Only read-ish shapes have a query plan worth reading; a bare INSERT does
    // not scan. DELETE/UPDATE with a WHERE very much do.
    if (/^\s*(insert|create|pragma|begin|commit|rollback)/i.test(sql)) continue;
    let rows: Array<{ detail?: string }>;
    try {
      rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as typeof rows;
    } catch {
      // Parameterised statements EXPLAIN fine; anything that does not is not a
      // signal, it is an un-analysable statement. Skipped, not counted clean.
      continue;
    }
    for (const row of rows) {
      const detail = row.detail ?? '';
      const m = /^SCAN (?:TABLE )?([A-Za-z0-9_]+)/.exec(detail);
      if (m && UNBOUNDED_TABLES.has(m[1])) {
        out.push({ table: m[1], sql: sql.replace(/\s+/g, ' ').slice(0, 120) });
      }
    }
  }
  return out;
};

/** How many times the corpus is grown for the second measurement. Large enough
 *  that linear scaling is unmistakable against measurement jitter, small enough
 *  to stay fast. */
export const CORPUS_GROWTH_FACTOR = 50;

export type OptimizationVerdict =
  | 'clean'
  | 'finding'
  /** The idle tick ran no sql through the meter — nothing observed, so nothing
   *  concluded. NOT a clean result. */
  | 'not-observed';

export interface OptimizationResult {
  readonly name: string;
  readonly verdict: OptimizationVerdict;
  /** Statements the idle tick executed. */
  readonly idleStatements: number;
  /** Full scans of unbounded tables found in the idle tick's query plans. */
  readonly scans: readonly ScanFinding[];
  /** Rows-read ratio after corpus growth, where the probe could confirm. */
  readonly ratio: number | undefined;
  readonly corpusAdded: number;
  readonly detail: string;
}

/** Run one idle cycle, returning both the statement count and the SQL text of
 *  everything that executed.
 *
 *  ⚠ Two ticks, and only the SECOND is measured. The first absorbs first-touch
 *  cost — a lazily-prepared statement, a cache fill — that would otherwise land
 *  entirely in whichever measurement ran first and manufacture a ratio out of
 *  nothing. */
/** True when every statement in the idle cycle projects ONLY aggregates, so its
 *  result is O(1) rows by construction and a rows-RETURNED delta can say
 *  nothing about how many rows it READ.
 *
 *  ⚠ Deliberately conservative: a `GROUP BY` returns one row per group and DOES
 *  grow with the corpus, so it is excluded and stays confirmable. */
const aggregateOnly = (sql: readonly string[]): boolean =>
  sql.length > 0 && sql.every((text) => {
    const flat = text.replace(/\s+/g, ' ');
    if (/\bGROUP\s+BY\b/i.test(flat)) return false;
    if (!/^\s*SELECT\b/i.test(flat)) return false;
    const projection = /^\s*SELECT\b([\s\S]*?)\bFROM\b/i.exec(flat)?.[1]
      // A scalar subquery in the projection (`(SELECT SUM(x) FROM t)`) is the
      // audit-usage shape; strip the inner FROM so the outer parse still sees
      // the aggregate.
      ?? /^\s*SELECT\b([\s\S]*)$/i.exec(flat)?.[1] ?? '';
    return /\b(SUM|COUNT|MIN|MAX|AVG|TOTAL|GROUP_CONCAT)\s*\(/i.test(projection)
      && !/\*\s*FROM/i.test(flat);
  });

const measureIdleCycle = async (
  probe: Probe,
  ctx: ProbeContext,
  tick: () => Promise<void> | void,
): Promise<{ statements: number; rows: number; sql: readonly string[] }> => {
  await tick();
  void probe.pending(ctx);
  resetSqlMeter();
  beginSqlCapture();
  await tick();
  const { statements, rows } = readSqlMeter();
  return { statements, rows, sql: endSqlCapture() };
};

export const runOptimizationCheck = async (input: {
  name: string;
  probe: Probe;
  ctx: ProbeContext;
  tick: () => Promise<void> | void;
  db: Database.Database;
}): Promise<OptimizationResult> => {
  const { name, probe, ctx, tick, db } = input;

  // Drain first, so the measurement is of a genuinely IDLE cycle. A cycle that
  // still has work to do would attribute the cost of that work to scanning.
  for (let i = 0; i < 3 && probe.pending(ctx) > 0; i++) await tick();

  const idle = await measureIdleCycle(probe, ctx, tick);
  const scans = findFullScans(db, idle.sql);

  const base = {
    name,
    idleStatements: idle.statements,
    scans,
    ratio: undefined as number | undefined,
    corpusAdded: 0,
  };

  // ⛔ A cycle that executed NOTHING was not observed. It is not a subsystem
  // with no cost — it is a measurement that saw nothing, and the two render
  // identically unless this says otherwise.
  if (idle.statements === 0) {
    return {
      ...base,
      verdict: 'not-observed',
      detail:
        'the idle tick executed NO sql through the meter — nothing was '
        + 'observed, so nothing can be concluded. Either the tick short-circuits '
        + 'before touching the db, or its statements were prepared before the '
        + 'meter was installed.',
    };
  }

  if (scans.length === 0) {
    return {
      ...base,
      verdict: 'clean',
      detail:
        `idle tick ran ${idle.statements} statement(s), none of which full-scans `
        + 'an unbounded table — cost is bounded by pending work, not by history.',
    };
  }

  // A scan is a real signal on its own. Where the probe can grow the corpus,
  // CONFIRM it costs what the plan says it costs, so the finding rests on
  // measurement rather than on reading a query plan.
  const tables = [...new Set(scans.map((sc) => sc.table))].join(', ');
  let confirmation = 'unconfirmed (no growCorpus on this probe)';
  let ratio: number | undefined;
  let corpusAdded = 0;

  if (probe.growCorpus) {
    try {
      corpusAdded = probe.growCorpus(ctx, CORPUS_GROWTH_FACTOR);
    } catch (err) {
      corpusAdded = 0;
      confirmation = `growCorpus() threw: ${
        err instanceof Error ? err.message : String(err)}`;
    }
    if (corpusAdded > 0) {
      // ⛔ The added rows must be SETTLED. If they created work, the cost rise
      // is honest and confirming against it would be a lie.
      const stillPending = probe.pending(ctx);
      if (stillPending > 0) {
        confirmation =
          `growCorpus() left ${stillPending} row(s) DUE — cannot confirm, a `
          + 'cost rise would be honest work rather than a scan';
      } else {
        const after = await measureIdleCycle(probe, ctx, tick);
        // ⛔ ROWS, not statements. The statement count is 1 either way.
        const grew = after.rows - idle.rows;
        ratio = idle.rows === 0 ? undefined : after.rows / idle.rows;
        if (grew >= corpusAdded) {
          confirmation =
            `CONFIRMED by measurement: +${corpusAdded} settled rows made the `
            + `idle tick read ${idle.rows} → ${after.rows} rows (+${grew}). `
            + 'The tick reads every settled row it can never act on';
        } else if (aggregateOnly(after.sql)) {
          // ⛔⛔ THIS METHOD CANNOT SEE AN AGGREGATE, AND MUST SAY SO RATHER
          // THAN REPORT A REFUTATION. The meter counts rows RETURNED
          // (`result.length` / 1 for `.get()`), so `SUM(...)`, `COUNT(*)` and
          // friends return ONE row whether they read 3 or 3 million. A verdict
          // of "the cost does not follow the corpus" is then a claim the
          // instrument is structurally incapable of supporting — the exact
          // shape this audit exists to refuse: a run that COULD NOT LOOK is
          // not a run that found nothing.
          //
          // Caught on `audit-prune`, whose idle tick is
          // `SUM(length(data))` over both audit tables: +2000 settled rows
          // moved rows-read by 0 (2 → 2) and the checker called the finding
          // refuted. The scan is real; only the confirmation is out of reach.
          confirmation =
            `CANNOT CONFIRM BY THIS METHOD — the scanning statement is an `
            + `AGGREGATE, which returns O(1) rows however many it reads, so a `
            + `rows-returned delta (+${grew} over +${corpusAdded} settled rows) `
            + 'is blind to it, NOT evidence against. The plan still says SCAN; '
            + 'confirm or refute by timing the statement at two corpus sizes';
        } else {
          confirmation =
            `NOT confirmed: +${corpusAdded} settled rows changed rows read by `
            + `only ${grew} (${idle.rows} → ${after.rows}) — the plan says SCAN `
            + 'but the cost does not follow the corpus';
        }
      }
    }
  }

  return {
    ...base,
    ratio,
    corpusAdded,
    verdict: 'finding',
    detail:
      `an IDLE tick full-scans ${tables} — a table that grows without bound. `
      + `Cost is O(total rows) every tick, forever, while doing no work. `
      + `${confirmation}. Plan: ${scans.map((sc) => sc.sql).join(' | ')}`,
  };
};
