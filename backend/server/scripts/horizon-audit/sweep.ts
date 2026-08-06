/** Long-horizon audit — the K-cycle sweep.
 *
 *  ⛔ The whole design rests on one rule from the kickoff: ASSERT PROGRESS,
 *  NEVER INVOCATION. "The task ran" is exactly what a stuck cursor does. So
 *  every probe below is shaped as:
 *
 *      seed()      — put a known quantity of DUE work in front of the task
 *      pending()   — count the work that is still due
 *      drive K×    — run the real tick body
 *      assert      — pending fell, reached zero, and STAYED zero; and the
 *                    later cycles did less work than the first
 *
 *  ⚠ A probe whose `seed()` cannot create due work yields `undrivable`, which
 *  is a non-zero exit — NOT a pass. An idle-and-correct subsystem is the
 *  common case and must not be reported as a defect, but "I could not make it
 *  do anything" and "it correctly did nothing" are different readings and the
 *  harness must never collapse them. */

import { openDatabase } from '../../src/open-database.js';

import type { BootedServer, CapturedInterval } from './boot.js';
import {
  runHousekeepingSweep,
  type HousekeepingSweepResult,
} from './housekeeping-sweep.js';
import { NOT_DRIVABLE, PROBES, type Probe, type ProbeContext } from './probes.js';
import type { RpcConn } from './unlock-vault.js';
import {
  runSchedulerSweep,
  type SchedulerSweepResult,
} from './scheduler-sweep.js';
import { runAutoRunSweep, type AutoRunSweepResult } from './auto-run-sweep.js';
import {
  runOptimizationCheck,
  type OptimizationResult,
} from './optimization.js';
import { assertMeterLive } from './sql-meter.js';

export interface CycleRecord {
  readonly cycle: number;
  readonly pendingBefore: number;
  readonly pendingAfter: number;
  readonly deleted: number;
  readonly cursor: string | undefined;
  readonly storeSize: number | undefined;
  readonly wallMs: number;
  readonly error: string | undefined;
}

export type SubsystemVerdict =
  | 'clean'
  | 'finding'
  /** seed() ran but produced no due work — cannot tell idle from stuck. */
  | 'undrivable'
  /** Structurally not drivable by this harness, with a stated reason. */
  | 'not-drivable'
  | 'no-probe';

export interface SubsystemResult {
  readonly name: string;
  readonly intervalMs: number | undefined;
  readonly fireImmediate: boolean;
  readonly verdict: SubsystemVerdict;
  readonly drivenBy: string;
  readonly cycles: readonly CycleRecord[];
  readonly failedInvariant: string | undefined;
  readonly note: string | undefined;
  readonly tickErrors: readonly string[];
}

export interface SweepResult {
  readonly subsystems: readonly SubsystemResult[];
  /** OPTIMIZATION check — does an idle cycle's cost scale with the corpus?
   *  `undefined` ⇒ the SQL meter could not be proven live, so the whole section
   *  is withheld rather than reported as clean. */
  readonly optimization: readonly OptimizationResult[] | undefined;
  /** Registered intervals with no probe written yet — a first-class output,
   *  per Phase 2: "list what you could not drive". */
  readonly unprobed: readonly string[];
  readonly housekeeping: HousekeepingSweepResult;
  readonly cronScheduler: SchedulerSweepResult;
  readonly autoRun: AutoRunSweepResult;
}

const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const driveSubsystem = async (
  interval: CapturedInterval,
  probe: Probe,
  ctx: ProbeContext,
  cycles: number,
): Promise<SubsystemResult> => {
  const base = {
    name: interval.name,
    intervalMs: interval.intervalMs,
    fireImmediate: interval.fireImmediate,
    drivenBy: probe.drivenBy,
  };

  let seeded: number;
  try {
    if (probe.prepare) await probe.prepare(ctx);
    seeded = probe.seed(ctx);
  } catch (err) {
    return {
      ...base,
      verdict: 'undrivable',
      cycles: [],
      failedInvariant: undefined,
      note: `seed() threw: ${describeError(err)}`,
      tickErrors: [],
    };
  }

  const pendingAtStart = probe.pending(ctx);
  if (seeded === 0 || pendingAtStart === 0) {
    return {
      ...base,
      verdict: 'undrivable',
      cycles: [],
      failedInvariant: undefined,
      note:
        `seed() produced no due work (seeded=${seeded}, pending=${pendingAtStart}). `
        + 'Cannot distinguish "correctly idle" from "never advances".'
        + (probe.note ? ` — ${probe.note}` : ''),
      tickErrors: [],
    };
  }

  const records: CycleRecord[] = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const pendingBefore = probe.pending(ctx);
    const started = Date.now();
    let error: string | undefined;
    try {
      await interval.tick();
    } catch (err) {
      error = describeError(err);
    }
    if (probe.settle) await probe.settle(ctx);
    const wallMs = Date.now() - started;
    const pendingAfter = probe.pending(ctx);
    records.push({
      cycle,
      pendingBefore,
      pendingAfter,
      deleted: pendingBefore - pendingAfter,
      cursor: probe.cursor?.(ctx),
      storeSize: probe.storeSize?.(ctx),
      wallMs,
      error,
    });
  }

  const tickErrors = (ctx.booted.capture.tickErrors.get(interval.name) ?? [])
    .map(describeError);

  // ── invariants ────────────────────────────────────────────────────────
  const first = records[0];
  const last = records[records.length - 1];

  if (probe.customInvariant) {
    const failed = probe.customInvariant(ctx, records);
    return {
      ...base,
      verdict: failed ? 'finding' : 'clean',
      cycles: records,
      failedInvariant: failed,
      note: probe.note,
      tickErrors,
    };
  }

  if (first.deleted === 0) {
    return {
      ...base,
      verdict: 'finding',
      cycles: records,
      failedInvariant:
        `cycle 1 ran against ${first.pendingBefore} due rows and drained 0`,
      note: probe.note,
      tickErrors,
    };
  }
  if (last.pendingAfter !== 0) {
    return {
      ...base,
      verdict: 'finding',
      cycles: records,
      failedInvariant:
        `after ${cycles} cycles ${last.pendingAfter} due rows remain `
        + `(started at ${first.pendingBefore})`,
      note: probe.note,
      tickErrors,
    };
  }
  // Once drained, a later cycle must do LESS work — a task that keeps
  // "succeeding" on unchanged input is the exact defect class.
  const afterDrain = records.filter((r) => r.pendingBefore === 0);
  const repeats = afterDrain.filter((r) => r.deleted !== 0);
  if (repeats.length > 0) {
    return {
      ...base,
      verdict: 'finding',
      cycles: records,
      failedInvariant:
        `cycle ${repeats[0].cycle} reported ${repeats[0].deleted} rows drained `
        + 'with 0 due rows at entry — repeating work on unchanged input',
      note: probe.note,
      tickErrors,
    };
  }

  const extra = probe.extraInvariant?.(ctx, records);
  if (extra) {
    return {
      ...base,
      verdict: 'finding',
      cycles: records,
      failedInvariant: extra,
      note: probe.note,
      tickErrors,
    };
  }

  return {
    ...base,
    verdict: 'clean',
    cycles: records,
    failedInvariant: undefined,
    note: probe.note,
    tickErrors,
  };
};

export const runSweep = async (input: {
  booted: BootedServer;
  cycles: number;
  /** False ⇒ every vault-gated autonomous tick no-ops; the scheduler sweep
   *  reports that as its reason instead of driving into the gate. */
  vaultOpen: boolean;
  /** Live paired client — lets a probe observe an outbound-only subsystem. */
  conn: RpcConn | undefined;
}): Promise<SweepResult> => {
  // ⛔ Through the D-212 chokepoint, never by constructing the driver directly.
  // The harness reads and seeds the same file the server has open, and a raw
  // driver construction would bypass at-rest key application — which happens to
  // work on the plaintext bench seed and would silently read garbage on a
  // sealed one. The `d-212-open-database-chokepoint` ratchet caught exactly
  // this, which is the ratchet doing its job on the audit's own instrument.
  const db = await openDatabase(input.booted.dbPath);
  const ctx: ProbeContext = {
    db, booted: input.booted, now: Date.now(), conn: input.conn,
  };

  const byName = new Map<string, CapturedInterval>();
  for (const interval of input.booted.capture.intervals) {
    byName.set(interval.name, interval);
  }

  const subsystems: SubsystemResult[] = [];
  const unprobed: string[] = [];

  for (const interval of input.booted.capture.intervals) {
    const reason = NOT_DRIVABLE[interval.name];
    if (reason !== undefined) {
      subsystems.push({
        name: interval.name,
        intervalMs: interval.intervalMs,
        fireImmediate: interval.fireImmediate,
        verdict: 'not-drivable',
        drivenBy: 'not drivable by this harness',
        cycles: [],
        failedInvariant: undefined,
        note: reason,
        tickErrors: [],
      });
      continue;
    }
    const probe = PROBES[interval.name];
    if (!probe) {
      unprobed.push(interval.name);
      subsystems.push({
        name: interval.name,
        intervalMs: interval.intervalMs,
        fireImmediate: interval.fireImmediate,
        verdict: 'no-probe',
        drivenBy: 'not driven',
        cycles: [],
        failedInvariant: undefined,
        note: 'no progress probe written for this subsystem',
        tickErrors: [],
      });
      continue;
    }
    console.error(`[horizon] driving ${interval.name}…`);
    subsystems.push(
      await driveSubsystem(interval, probe, ctx, input.cycles),
    );
  }

  // ── OPTIMIZATION pass ─────────────────────────────────────────────────
  // Runs AFTER the progress sweep, on the same live subsystems, because it
  // needs them already drained to idle. A subsystem still holding work would
  // compare "drain 5 rows" against "drain 0 rows" and call the difference a
  // scaling result.
  //
  // ⛔ THE METER IS PROVEN BEFORE ANY VERDICT IS RENDERED. A meter that
  // silently failed to install reads 0 statements for everything, and 0 is the
  // BEST possible score — every subsystem would be declared perfectly
  // optimized. On a failed proof the entire section is withheld.
  let optimization: OptimizationResult[] | undefined;
  if (!assertMeterLive(db)) {
    console.error(
      '[horizon] ⛔ SQL meter is NOT live — optimization section WITHHELD '
      + '(a dead meter reads 0 statements, which would score every subsystem '
      + 'as perfectly optimized)',
    );
  } else {
    optimization = [];
    for (const interval of input.booted.capture.intervals) {
      if (NOT_DRIVABLE[interval.name] !== undefined) continue;
      const probe = PROBES[interval.name];
      if (!probe) continue;
      console.error(`[horizon] optimization: ${interval.name}…`);
      optimization.push(
        await runOptimizationCheck({
          name: interval.name,
          probe,
          ctx,
          tick: interval.tick,
          db,
        }),
      );
    }
  }

  console.error('[horizon] driving cron scheduler…');
  const cronScheduler = await runSchedulerSweep({
    booted: input.booted,
    db,
    cycles: input.cycles,
    vaultOpen: input.vaultOpen,
  });

  console.error('[horizon] driving auto-run scheduler…');
  const autoRun = await runAutoRunSweep({
    booted: input.booted,
    db,
    cycles: input.cycles,
    vaultOpen: input.vaultOpen,
  });

  console.error('[horizon] driving housekeeping scheduler…');
  const housekeeping = await runHousekeepingSweep({
    booted: input.booted,
    db,
    cycles: input.cycles,
  });

  db.close();
  return {
    subsystems, unprobed, housekeeping, cronScheduler, autoRun, optimization,
  };
};
