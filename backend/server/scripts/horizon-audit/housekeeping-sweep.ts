/** Long-horizon audit — the housekeeping scheduler sweep.
 *
 *  The 8 retention pruners are the obvious time-driven surface; the
 *  housekeeping scheduler is the BIG one. It owns ~44 registered tasks, each
 *  with its own persisted cursor in `housekeeping_state`, all sharing one
 *  cycle budget and one fixed topo order. That is the exact substrate the
 *  kickoff's defect class lives in:
 *
 *    - a task that is registered but never stepped (starved by the budget, or
 *      filtered out by a trust gate) advances no cursor forever, and the cycle
 *      still reports `tasks_errored: 0` — success that made no progress
 *    - a task that errors 3× is disabled for 24 h, and nothing in the cycle
 *      result distinguishes "disabled" from "had no work"
 *    - a `depends_on` edge whose upstream never reaches `complete` blocks its
 *      downstream permanently, silently
 *
 *  ⛔ The assertion is NOT "the cycle ran". It is "every registered task was
 *  actually stepped, and its persisted state moved". A task absent from every
 *  cycle's `per_task` is reported by NAME — never summarised into a count. */

// ⛔ `openDatabase` (the D-212 chokepoint) returns better-sqlite3's Database
// type, not the multiple-ciphers one. They are the same object at runtime;
// naming the wrong one is a type error the harness carried unseen because
// `tsc -b backend/server` only includes `src`.
import type Database from 'better-sqlite3';
import type { HousekeepingCycleResult } from '@recued/contracts';

import type { BootedServer } from './boot.js';

export interface HousekeepingTaskOutcome {
  readonly task_id: string;
  readonly kind: string;
  /** Cycles (1-indexed) in which the scheduler actually stepped this task. */
  readonly steppedIn: readonly number[];
  readonly finalStatus: string | undefined;
  readonly finalCursor: string | undefined;
  readonly consecutiveErrors: number;
  readonly lastError: string | undefined;
  /** Error surfaced by the explicit Run-Now drive, when that was attempted. */
  readonly runNowError: string | undefined;
  readonly lastRunAtMoved: boolean;
  /** `gated-off` = skipped by the idle-cycle eligibility filter (D-132
   *  per-topic trust), but ran fine on the explicit Run-Now path. That is
   *  correct behaviour, NOT a finding. */
  readonly verdict: 'stepped' | 'never-stepped' | 'errored' | 'gated-off';
}

export interface HousekeepingSweepResult {
  readonly ran: boolean;
  readonly reason: string | undefined;
  readonly cycles: readonly {
    readonly cycle: number;
    readonly durationMs: number;
    readonly stepped: number;
    readonly complete: number;
    readonly yielded: number;
    readonly errored: number;
  }[];
  readonly registeredTasks: number;
  readonly outcomes: readonly HousekeepingTaskOutcome[];
  readonly findings: readonly string[];
}

interface StateRow {
  task_id: string;
  cursor_json: string;
  last_run_at: number | null;
  last_status: string;
  consecutive_errors: number;
  last_error: string | null;
}

const readState = (db: Database.Database): Map<string, StateRow> => {
  const rows = db
    .prepare(
      `SELECT task_id, cursor_json, last_run_at, last_status,
              consecutive_errors, last_error
         FROM housekeeping_state`,
    )
    .all() as StateRow[];
  return new Map(rows.map((r) => [r.task_id, r]));
};

export const runHousekeepingSweep = async (input: {
  booted: BootedServer;
  db: Database.Database;
  cycles: number;
}): Promise<HousekeepingSweepResult> => {
  const scheduler = input.booted.housekeepingScheduler;
  const empty = {
    cycles: [],
    registeredTasks: 0,
    outcomes: [],
    findings: [],
  } as const;

  if (!scheduler) {
    return {
      ran: false,
      reason:
        'no housekeeping scheduler was published to the registry at boot — '
        + 'the composition root did not construct one',
      ...empty,
    };
  }

  // ⚠ The SAME module-level registry the scheduler reads. Importing it here
  // (in-process with the real boot) is what makes "registered but never
  // stepped" observable at all — from outside the process the task simply
  // would not appear, and absence would read as "nothing there".
  const { topoSortHousekeepingTasks } = await import(
    '../../src/housekeeping/registry.js'
  );
  const registered = topoSortHousekeepingTasks();
  if (registered.length === 0) {
    return {
      ran: false,
      reason: 'the housekeeping registry is empty at boot',
      ...empty,
    };
  }

  const steppedIn = new Map<string, number[]>();
  const cycleRecords: Array<HousekeepingSweepResult['cycles'][number]> = [];
  const lastRunAtSeen = new Map<string, Set<number>>();

  for (let cycle = 1; cycle <= input.cycles; cycle++) {
    let result: HousekeepingCycleResult;
    try {
      // Run-Now with a full budget. This bypasses the idle GATE (which is
      // wall-clock + busy-signal driven and cannot be compressed honestly)
      // but runs the identical `runCycleInner` body the probe tick runs.
      result = await scheduler.runOnce({ budget_ms: 60_000 });
    } catch (err) {
      return {
        ran: false,
        reason: `runOnce() threw on cycle ${cycle}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ...empty,
      };
    }
    for (const per of result.per_task) {
      const list = steppedIn.get(per.task_id) ?? [];
      list.push(cycle);
      steppedIn.set(per.task_id, list);
    }
    cycleRecords.push({
      cycle,
      durationMs: result.duration_ms,
      stepped: result.tasks_stepped,
      complete: result.tasks_complete,
      yielded: result.tasks_yielded,
      errored: result.tasks_errored,
    });
    for (const [task_id, row] of readState(input.db)) {
      if (row.last_run_at === null) continue;
      const seen = lastRunAtSeen.get(task_id) ?? new Set<number>();
      seen.add(row.last_run_at);
      lastRunAtSeen.set(task_id, seen);
    }
  }

  // ── Phase B — per-task Run-Now for anything the cycle never stepped ──
  //
  // ⚠ Instrument correction #3 (2026-08-04). Phase A alone reported "12 of 59
  // tasks never stepped" as a finding. That reading was not earned: the idle
  // cycle applies `isEligibleForIdleCycle`, and an enrichment topic whose
  // trust_state is not 'auto' is skipped BY DESIGN (D-132). "Gated off by user
  // policy" and "cannot run at all" are different things and the harness must
  // not collapse them — so every never-stepped task is now additionally driven
  // through `runOnce({ task_id })`, the documented per-topic Run-Now surface,
  // which bypasses the eligibility filter and runs the identical step body.
  const runNowOutcome = new Map<string, { ok: boolean; error?: string }>();
  const neverInCycle = registered.filter(
    (t) => (steppedIn.get(t.meta.id) ?? []).length === 0,
  );
  for (const task of neverInCycle) {
    const id = task.meta.id;
    try {
      const result = await scheduler.runOnce({ budget_ms: 30_000, task_id: id });
      const per = result.per_task.find((p) => p.task_id === id);
      if (!per) {
        runNowOutcome.set(id, {
          ok: false,
          error: 'Run-Now produced no per-task result (task filtered out even '
            + 'on the explicit path — disabled by consecutive errors?)',
        });
        continue;
      }
      const row = readState(input.db).get(id);
      runNowOutcome.set(
        id,
        per.status === 'error'
          ? { ok: false, error: row?.last_error ?? 'error with no message' }
          : { ok: true },
      );
    } catch (err) {
      runNowOutcome.set(id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finalState = readState(input.db);
  const outcomes: HousekeepingTaskOutcome[] = [];
  const findings: string[] = [];

  for (const task of registered) {
    const id = task.meta.id;
    const stepped = steppedIn.get(id) ?? [];
    const row = finalState.get(id);
    const runNow = runNowOutcome.get(id);
    const verdict: HousekeepingTaskOutcome['verdict'] =
      row?.last_status === 'error'
        ? 'errored'
        : stepped.length === 0
          ? runNow?.ok === true
            ? 'gated-off'
            : 'never-stepped'
          : 'stepped';

    outcomes.push({
      task_id: id,
      kind: task.meta.kind,
      steppedIn: stepped,
      finalStatus: row?.last_status,
      finalCursor: row?.cursor_json,
      consecutiveErrors: row?.consecutive_errors ?? 0,
      lastError: row?.last_error ?? undefined,
      runNowError: runNow?.ok === false ? runNow.error : undefined,
      lastRunAtMoved: (lastRunAtSeen.get(id)?.size ?? 0) > 1,
      verdict,
    });

    // ⛔ A POOL-POLICY REFUSAL IS NOT A DEFECT. D-132 gates an AI producer to a
    // pool (`free_only` by default), and `forceLayer: free` means it will not
    // spend the owner's BYOK credit without consent. Verified: configuring a
    // real BYOK slot from dev.env left both producers refusing IDENTICALLY,
    // which is the gate holding, not a stuck task. Reported, never as a
    // finding.
    const poolGated = (row?.last_error ?? '').includes('forceLayer: free');
    if (verdict === 'errored' && !poolGated) {
      findings.push(
        `housekeeping task '${id}' ended in status 'error' after `
        + `${row?.consecutive_errors ?? '?'} consecutive failures `
        + `(${row?.last_error ?? 'no message'}) — `
        + 'the cycle result reports this only as a count',
      );
    }
  }

  const neverStepped = outcomes.filter((o) => o.verdict === 'never-stepped');
  if (neverStepped.length > 0) {
    findings.push(
      `${neverStepped.length} of ${registered.length} registered housekeeping `
      + 'tasks were never stepped by an idle cycle AND could not be driven by '
      + `an explicit Run-Now across ${input.cycles} cycles: `
      + neverStepped.map((o) => `${o.task_id} (${o.runNowError ?? '?'})`).join('; '),
    );
  }

  return {
    ran: true,
    reason: undefined,
    cycles: cycleRecords,
    registeredTasks: registered.length,
    outcomes,
    findings,
  };
};
