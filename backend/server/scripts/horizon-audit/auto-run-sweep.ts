/** Long-horizon audit — the auto-run scheduler sweep.
 *
 *  ⛔ THIS IS THE SURFACE THE KICKOFF'S MOTIVATING DEFECT LIVED ON.
 *  `context.recipe.*` is not backed for `auto_run`: the host write is gated on
 *  `trigger_source !== 'auto_run'`, so every reactive read resolves
 *  `undefined`, `coalesce` makes each tick look like a first run, and a cursor
 *  gate is unconditionally true — at `success: true`, forever.
 *
 *  What this sweep can and cannot assert:
 *
 *  ✓ CAN — that the scheduler's own long-horizon state CONVERGES. An entry
 *    that keeps failing must trip the circuit breaker, land in
 *    `skipped_circuit`, and STOP firing. A breaker that never trips, or that
 *    trips and then fires anyway, is "a reconciler that does not converge" and
 *    "work that repeats on unchanged input" — both named defect classes.
 *
 *  ✗ CANNOT — that a fired recipe made progress in its own domain. That needs
 *    per-recipe cursor semantics the harness has no general handle on, and it
 *    is exactly where the known `context.recipe.*` defect sits. Recorded in the
 *    report as needing a correctness assertion rather than silently implied.
 *
 *  ⚠ The roster is built from installed recipes that declare `auto_run`. On a
 *  seed with none, a tick is a CORRECT no-op and this sweep says so rather than
 *  reporting a clean pass it did not earn. */

// ⛔ `openDatabase` (the D-212 chokepoint) returns better-sqlite3's Database
// type, not the multiple-ciphers one. They are the same object at runtime;
// naming the wrong one is a type error the harness carried unseen because
// `tsc -b backend/server` only includes `src`.
import type Database from 'better-sqlite3';

import type { BootedServer } from './boot.js';

interface TickReportish {
  fired: Array<{ recipe_id: string }>;
  skipped_overlap: string[];
  skipped_circuit: string[];
}

interface AutoRunHandleish {
  tick(): Promise<TickReportish>;
  refreshRoster(): Promise<void>;
  readonly roster: ReadonlyMap<string, unknown>;
}

export interface AutoRunCycleRecord {
  readonly cycle: number;
  readonly rosterSize: number;
  readonly fired: number;
  readonly skippedOverlap: number;
  readonly skippedCircuit: number;
  readonly circuitRows: number;
  readonly autoDisabled: number;
  readonly wallMs: number;
  readonly error: string | undefined;
}

export interface AutoRunSweepResult {
  readonly ran: boolean;
  readonly reason: string | undefined;
  readonly cycles: readonly AutoRunCycleRecord[];
  readonly findings: readonly string[];
}

const circuitCounts = (
  db: Database.Database,
): { rows: number; disabled: number } => {
  try {
    const rows = (
      db.prepare(`SELECT COUNT(*) c FROM auto_run_circuit`).get() as { c: number }
    ).c;
    const disabled = (
      db
        .prepare(`SELECT COUNT(*) c FROM auto_run_circuit WHERE auto_disabled = 1`)
        .get() as { c: number }
    ).c;
    return { rows, disabled };
  } catch {
    return { rows: -1, disabled: -1 };
  }
};

export const runAutoRunSweep = async (input: {
  booted: BootedServer;
  db: Database.Database;
  cycles: number;
  vaultOpen: boolean;
}): Promise<AutoRunSweepResult> => {
  const empty = { cycles: [], findings: [] } as const;
  const slot = input.booted.capture.schedulerSlots.get('auto-run-scheduler');
  if (!slot) {
    return {
      ran: false,
      reason:
        'no auto-run-scheduler slot was booted — `ctx.db` was missing at boot',
      ...empty,
    };
  }
  if (!input.vaultOpen) {
    return {
      ran: false,
      reason:
        'the vault is sealed, so every auto-run tick correctly no-ops at its '
        + 'isVaultUnlocked gate — driving it would measure the gate',
      ...empty,
    };
  }
  const handle = slot.getHandle() as AutoRunHandleish | undefined;
  if (!handle || typeof handle.tick !== 'function') {
    return {
      ran: false,
      reason: 'the auto-run-scheduler slot exposes no tick() handle',
      ...empty,
    };
  }

  try {
    await handle.refreshRoster();
  } catch {
    /* a roster refresh failure surfaces as an empty roster below */
  }
  if (handle.roster.size === 0) {
    return {
      ran: false,
      reason:
        'the auto-run roster is EMPTY on this seed — no installed recipe '
        + 'declares auto_run, so a tick is a correct no-op. Driving it needs a '
        + 'pack install carrying an auto_run recipe (the paired connection can '
        + 'do that via `packs.install`); a hand-written roster row would '
        + 'exercise a state the installer never produces.',
      ...empty,
    };
  }

  const cycles: AutoRunCycleRecord[] = [];
  for (let cycle = 1; cycle <= input.cycles; cycle++) {
    const started = Date.now();
    let report: TickReportish = { fired: [], skipped_overlap: [], skipped_circuit: [] };
    let error: string | undefined;
    try {
      report = await handle.tick();
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const circuit = circuitCounts(input.db);
    cycles.push({
      cycle,
      rosterSize: handle.roster.size,
      fired: report.fired.length,
      skippedOverlap: report.skipped_overlap.length,
      skippedCircuit: report.skipped_circuit.length,
      circuitRows: circuit.rows,
      autoDisabled: circuit.disabled,
      wallMs: Date.now() - started,
      error,
    });
  }

  // ⛔ VACUITY GUARD. A roster of N with nothing DUE means every tick was a
  // correct no-op, and asserting "the circuit converged" over four no-ops is a
  // pass the probe did not earn — the same shape as the mcp-callback probe
  // that would have gone green on a broken TTL. Report it as not-driven.
  const didAnything = cycles.some(
    (c) => c.fired > 0 || c.skippedOverlap > 0 || c.skippedCircuit > 0,
  );
  if (!didAnything) {
    return {
      ran: false,
      reason:
        `the roster holds ${cycles[0].rosterSize} entries but NOTHING WAS DUE `
        + `across ${input.cycles} ticks (fired 0, skipped 0 every cycle), so `
        + 'the convergence assertion never ran. Auto-run arms a per-entry '
        + 'setTimeout from the recipe interval floored at '
        + 'AUTO_RUN_SERVER_FLOOR_MS, and the next-due time is in-memory — '
        + 'there is no persisted watermark the harness can age the way it ages '
        + 'a retention row. Driving a real fire needs either an injectable '
        + 'clock on this scheduler or a roster entry whose interval is short '
        + 'enough to come due inside a sweep.',
      cycles,
      findings: [],
    };
  }

  const findings: string[] = [];
  const first = cycles[0];
  const last = cycles[cycles.length - 1];

  if (last.rosterSize !== first.rosterSize) {
    findings.push(
      `auto-run: roster size drifted across ticks (${first.rosterSize} → `
      + `${last.rosterSize}) with no install/uninstall — the roster is rebuilt `
      + 'per tick and should be stable on unchanged input',
    );
  }
  // Convergence: once the breaker disables an entry it must stay disabled and
  // stop firing. A count that oscillates is the non-converging case.
  const disabledSeries = cycles.map((c) => c.autoDisabled);
  for (let i = 1; i < disabledSeries.length; i++) {
    if (disabledSeries[i] < disabledSeries[i - 1]) {
      findings.push(
        `auto-run: auto_disabled count FELL between cycle ${i} and ${i + 1} `
        + `(${disabledSeries[i - 1]} → ${disabledSeries[i]}) with no operator `
        + 'rearm — the circuit breaker is oscillating rather than converging',
      );
      break;
    }
  }
  // ⛔ THE no-repeat invariant, and the one that actually ran here. `tick()`
  // preemptively advances `next_run_at = now + interval_ms` the moment it
  // fires, so a second tick inside the same interval MUST be a no-op. A
  // scheduler that re-fires on unchanged input is this audit's defect class.
  const firstFireAt = cycles.findIndex((c) => c.fired > 0);
  if (firstFireAt !== -1) {
    const later = cycles.slice(firstFireAt + 1).filter((c) => c.fired > 0);
    if (later.length > 0) {
      findings.push(
        `auto-run: re-fired on cycle ${later[0].cycle} inside the same `
        + 'interval — `next_run_at` was not advanced preemptively, so the '
        + 'entry stays due and repeats work on unchanged input',
      );
    }
  }
  // Circuit rows are per-roster-entry state; they must not outgrow the roster.
  for (const c of cycles) {
    if (c.circuitRows > c.rosterSize) {
      findings.push(
        `auto-run: circuit rows (${c.circuitRows}) exceed the roster `
        + `(${c.rosterSize}) on cycle ${c.cycle} — per-entry state is `
        + 'accumulating for entries no longer rostered',
      );
      break;
    }
  }
  for (const c of cycles) {
    if (c.error !== undefined) {
      findings.push(`auto-run: tick ${c.cycle} threw — ${c.error}`);
      break;
    }
  }

  return { ran: true, reason: undefined, cycles, findings };
};
