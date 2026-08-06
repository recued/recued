/** Count SQL work, so the audit can ask an OPTIMIZATION question as well as a
 *  liveness one.
 *
 *  ⛔ WHY NOT WALL TIME. The sweep already records `wallMs`, and at the
 *  observed cadence it is useless as a signal: the housekeeping cycles run
 *  2336ms / 7ms / 5ms / 6ms and the cron scheduler runs 1ms / 0ms / 0ms / 0ms.
 *  A comparison between 0 and 1 is noise, and a check built on it would report
 *  whatever the machine felt like that second. Statement counts are
 *  deterministic: the same input produces the same number every run.
 *
 *  ⛔ WHY STATEMENT COUNTS ARE NOT ENOUGH EITHER, and what this actually
 *  measures. A pruner that scans the whole table each cycle issues the SAME
 *  NUMBER of statements as one that uses an index — the difference is rows
 *  READ, not statements run. So the meter counts both: statements executed,
 *  and (via `SQLITE_STMTSTATUS`-equivalent bookkeeping we cannot reach from
 *  better-sqlite3) a corpus-scaling probe supplies the missing dimension by
 *  measuring the same idle cycle at two corpus sizes. See `optimization.ts`.
 *
 *  ⚠ THE METER IS PROCESS-WIDE. It wraps `Database.prototype.prepare`, so it
 *  counts every statement any part of the booted server runs — including
 *  background work that happens to overlap a measurement window. That is why
 *  `optimization.ts` measures a QUIESCED idle cycle and compares two
 *  measurements taken the same way, rather than trusting one absolute number. */

import { createRequire } from 'node:module';

import type Database from 'better-sqlite3';

const require_ = createRequire(import.meta.url);

/** ⛔ TWO DRIVERS, TWO PROTOTYPES. `openDatabase` — the D-212 chokepoint every
 *  db handle goes through — imports `better-sqlite3-multiple-ciphers`, NOT
 *  `better-sqlite3`. They share an API and a TYPE (`open-database.ts` imports
 *  the cipher class and the plain type side by side), which makes them look
 *  interchangeable, but they are separate modules with separate prototypes.
 *
 *  The first version of this meter patched `better-sqlite3` only. Nothing at
 *  runtime uses it, so the meter counted ZERO statements — and zero is the best
 *  possible optimization score. `assertMeterLive` caught it on the first run and
 *  withheld the whole section, which is the only reason this comment exists
 *  rather than a report declaring every subsystem perfectly optimized. */
const DRIVER_MODULES = [
  'better-sqlite3-multiple-ciphers',
  'better-sqlite3',
] as const;

interface Meter {
  statements: number;
  /** ⛔ THE MEASURE THAT ACTUALLY MOVES. A statement COUNT cannot confirm a
   *  full scan: a pruner issues exactly ONE `SELECT data FROM t` whether the
   *  table holds 3 rows or 3 million, so a count-based ratio reads 1.0× under
   *  any corpus growth and "confirms" nothing. Rows RETURNED is the signal —
   *  a scan returns everything, an indexed query returns only what is due. */
  rows: number;
  /** SQL text of every statement EXECUTED while capture is on. A Set, because
   *  the same prepared statement runs many times per cycle and the query plan
   *  is a property of the text, not of the execution. */
  captured: Set<string> | undefined;
}

const meter: Meter = { statements: 0, rows: 0, captured: undefined };
let installed = false;
let restoreFn: (() => void) | undefined;

/** Wrap `prepare` so each returned Statement counts its executions.
 *
 *  ⚠ Must run BEFORE `serve()` — every store prepares its statements during
 *  composition, and a `Statement` object created by the unwrapped `prepare` is
 *  never counted afterwards. A meter installed after boot reads a confident
 *  zero, which is the "instrument reports its own bug" failure this audit keeps
 *  finding. Guarded by `assertMeterLive()` below. */
export const installSqlMeter = (): void => {
  if (installed) return;
  installed = true;
  const undo: Array<() => void> = [];

  for (const moduleName of DRIVER_MODULES) {
    let ctor: { prototype: { prepare: (this: unknown, sql: string) => unknown } };
    try {
      ctor = require_(moduleName) as typeof ctor;
    } catch {
      // A driver this install does not carry. Not an error — the OTHER one
      // being absent too is, and `assertMeterLive` is what detects that.
      continue;
    }
    const proto = ctor.prototype;
    if (typeof proto?.prepare !== 'function') continue;
    const originalPrepare = proto.prepare;
    proto.prepare = function patchedPrepare(this: unknown, sql: string): unknown {
      const stmt = originalPrepare.call(this, sql) as Record<string, unknown>;
      // Only the three that actually EXECUTE. `pluck`/`iterate` return the
      // statement or an iterator, so counting the call would double-count a
      // chained `.pluck().get()`.
      for (const method of ['run', 'get', 'all'] as const) {
        const fn = stmt[method];
        if (typeof fn !== 'function') continue;
        stmt[method] = function counted(this: unknown, ...args: unknown[]): unknown {
          meter.statements++;
          meter.captured?.add(sql);
          const result = (fn as (...a: unknown[]) => unknown).apply(this, args);
          // `all` returns the row array — its length IS rows read. `get`
          // returns at most one. `run` returns an info object, no rows.
          if (method === 'all' && Array.isArray(result)) meter.rows += result.length;
          else if (method === 'get' && result !== undefined) meter.rows += 1;
          return result;
        };
      }
      return stmt;
    };
    undo.push(() => { proto.prepare = originalPrepare; });
  }

  restoreFn = () => {
    for (const fn of undo) fn();
    installed = false;
  };
};

export const restoreSqlMeter = (): void => {
  restoreFn?.();
  restoreFn = undefined;
};

export const readSqlMeter = (): { statements: number; rows: number } => ({
  statements: meter.statements,
  rows: meter.rows,
});

export const resetSqlMeter = (): void => {
  meter.statements = 0;
  meter.rows = 0;
};

/** ⛔ PROVE THE METER BEFORE TRUSTING A ZERO FROM IT.
 *
 *  A meter installed too late, or defeated by a store that caches its
 *  `Statement` objects from before the wrap, reports 0 for everything — and 0
 *  looks exactly like "this subsystem does no SQL work when idle", which is the
 *  BEST possible result. The optimization check would then declare every
 *  subsystem perfectly optimized. Called once at sweep start; a false return
 *  disables the whole optimization section rather than letting it report
 *  flattering nonsense. */
export const assertMeterLive = (db: Database.Database): boolean => {
  const before = readSqlMeter();
  db.prepare('SELECT 1 AS probe').get();
  const after = readSqlMeter();
  // BOTH dimensions must move. A meter that counts statements but not rows
  // would let the corpus-growth confirmation report a flat 1.0× forever.
  return after.statements > before.statements && after.rows > before.rows;
};

/** Start recording the SQL text of every statement executed. */
export const beginSqlCapture = (): void => {
  meter.captured = new Set<string>();
};

/** Stop recording and return what ran. */
export const endSqlCapture = (): readonly string[] => {
  const out = [...(meter.captured ?? [])];
  meter.captured = undefined;
  return out;
};
