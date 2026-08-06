/** Long-horizon audit — the cron scheduler sweep.
 *
 *  The schedulers are the surface the kickoff's motivating defect lived on:
 *  `context.recipe.*` unbacked for `auto_run`, so every reactive tick read
 *  `undefined`, `coalesce` made each look like a first run, and a cursor gate
 *  was unconditionally true — at `success: true`, forever.
 *
 *  ⛔ `backgroundServices.register({ kind: 'scheduler' })` exposes only `stop`,
 *  so the registry alone cannot reach a tick. The slots are captured off
 *  `SCHEDULER_REGISTRY` at boot instead (see `boot.ts`), which gives the live
 *  `SchedulerHandle` and its `tick()` — documented as "run one tick
 *  synchronously … fires due schedules and returns the ids that fired".
 *
 *  The invariant here is a genuine CURSOR one, not a row count:
 *
 *    - a due schedule FIRES on the first tick
 *    - firing ADVANCES `next_run_at` past now (the cursor moved)
 *    - later ticks do NOT re-fire it (no double-fire on unchanged input)
 *    - `last_run_at` moved, so the fire is recorded, not just attempted
 *
 *  ⚠ The seeded recipe does not exist, so the fire takes the error path. That
 *  is deliberate: this probe asserts the SCHEDULER advances its cursor, not
 *  that a recipe succeeds. A cron schedule must tick forward regardless of the
 *  run's outcome — a scheduler that only advances on success would stall
 *  forever on one broken recipe, which is exactly this audit's defect class. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ⛔ `openDatabase` (the D-212 chokepoint) returns better-sqlite3's Database
// type, not the multiple-ciphers one. They are the same object at runtime;
// naming the wrong one is a type error the harness carried unseen because
// `tsc -b backend/server` only includes `src`.
import type Database from 'better-sqlite3';

import type { BootedServer } from './boot.js';
import { IDENTITY_KEYS_FILENAME } from '../../src/identity/boot.js';

/** ⛔ PRECONDITION, checked before driving rather than inferred after.
 *
 *  `autoUnlockServerVaultFromKeyfile` no-ops (`'skipped'`) unless the keyfile
 *  holds a SERVER VAULT key. The bench seed's keyfile holds only
 *  `server_identity` + `publisher_identity`, so the seed boots ENROLLED BUT
 *  SEALED — and every autonomous scheduler tick then correctly returns `[]` at
 *  its `isVaultUnlocked` gate (`scheduler.ts`, first line of `tick`).
 *
 *  ⚠ Without this check the sweep reported three confident findings against a
 *  scheduler that was behaving exactly as designed: "did not fire", "did not
 *  record last_run_at", "cursor did not move". Reading the precondition turns
 *  that from a false finding into an honest "not driven, and here is why". */
const keyfileHoldsServerVaultKey = (dbPath: string): boolean => {
  try {
    const raw = readFileSync(
      join(dirname(resolve(dbPath)), IDENTITY_KEYS_FILENAME),
      'utf8',
    );
    const file = JSON.parse(raw) as { encrypted?: boolean; payload?: string };
    if (file.encrypted === true || typeof file.payload !== 'string') return false;
    const payload = JSON.parse(
      Buffer.from(file.payload, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    return Object.keys(payload).some((k) => k.includes('server_vault'));
  } catch {
    return false;
  }
};

/** Mirrors `SchedulerHandle` without importing the whole module graph. */
interface TickableScheduler {
  tick(): Promise<string[]>;
}

export interface SchedulerCycleRecord {
  readonly cycle: number;
  readonly fired: readonly string[];
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
  readonly wallMs: number;
  readonly error: string | undefined;
}

export interface SchedulerSweepResult {
  readonly ran: boolean;
  readonly reason: string | undefined;
  readonly cycles: readonly SchedulerCycleRecord[];
  readonly findings: readonly string[];
}

const SCHEDULE_ID = 'hz-horizon-schedule';

const readSchedule = (
  db: Database.Database,
): { next_run_at: number | null; last_run_at: number | null; last_status: string | null } | null => {
  const row = db
    .prepare(`SELECT data FROM schedules WHERE schedule_id = ?`)
    .get(SCHEDULE_ID) as { data: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.data) as {
    next_run_at: number | null;
    last_run_at: number | null;
    last_status: string | null;
  };
  return {
    next_run_at: parsed.next_run_at ?? null,
    last_run_at: parsed.last_run_at ?? null,
    last_status: parsed.last_status ?? null,
  };
};

export const runSchedulerSweep = async (input: {
  booted: BootedServer;
  db: Database.Database;
  cycles: number;
  /** The harness opened the vault (pair + auth rpc). False ⇒ the tick's own
   *  `isVaultUnlocked` gate makes every drive a correct no-op. */
  vaultOpen: boolean;
}): Promise<SchedulerSweepResult> => {
  const empty = { cycles: [], findings: [] } as const;
  const slot = input.booted.capture.schedulerSlots.get('cron-scheduler');
  if (!slot) {
    return {
      ran: false,
      reason:
        'no cron-scheduler slot was booted — SCHEDULER_REGISTRY produced none, '
        + 'or `ctx.scheduleStore` was missing at boot',
      ...empty,
    };
  }
  // The keyfile check stays as a diagnostic: it explains WHY the realm needed
  // opening at all, and distinguishes "sealed seed we opened over rpc" from
  // "seed that auto-unlocks". Only the live open decides whether to drive.
  const autoUnlocks = keyfileHoldsServerVaultKey(input.booted.dbPath);
  if (!input.vaultOpen) {
    return {
      ran: false,
      reason:
        'the vault is SEALED and the harness could not open it'
        + (autoUnlocks
          ? ''
          : ' (this seed carries no server_vault key, so it never '
            + 'auto-unlocks — seed.mjs leaves the vault uninitialized on '
            + 'purpose)')
        + '. Every autonomous scheduler tick correctly no-ops at its '
        + 'isVaultUnlocked gate, so driving one would measure the GATE, not '
        + 'the subsystem.',
      ...empty,
    };
  }
  const handle = slot.getHandle() as TickableScheduler | undefined;
  if (!handle || typeof handle.tick !== 'function') {
    return {
      ran: false,
      reason: 'the cron-scheduler slot exposes no tick() handle',
      ...empty,
    };
  }

  const now = Date.now();
  // Every minute — so a fire always has a next slot to advance to, and the
  // "did not re-fire" assertion is not an artifact of a sparse cron.
  input.db
    .prepare(`INSERT OR REPLACE INTO schedules (schedule_id, recipe_id, data) VALUES (?, ?, ?)`)
    .run(
      SCHEDULE_ID,
      'hz.horizon.recipe',
      JSON.stringify({
        schedule_id: SCHEDULE_ID,
        recipe_id: 'hz.horizon.recipe',
        publisher_id: 'hz',
        mode: 'recurring',
        cron_expression: '* * * * *',
        enabled: true,
        created_at: now - 3_600_000,
        // Overdue by an hour — the tick must pick it up on cycle 1.
        last_run_at: null,
        next_run_at: now - 3_600_000,
        last_status: null,
        last_error: null,
      }),
    );

  const seeded = readSchedule(input.db);
  if (!seeded) {
    return { ran: false, reason: 'seeded schedule row did not persist', ...empty };
  }

  const cycles: SchedulerCycleRecord[] = [];
  for (let cycle = 1; cycle <= input.cycles; cycle++) {
    const started = Date.now();
    let fired: string[] = [];
    let error: string | undefined;
    try {
      fired = await handle.tick();
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const state = readSchedule(input.db);
    cycles.push({
      cycle,
      fired: fired.filter((id) => id === SCHEDULE_ID),
      nextRunAt: state?.next_run_at ?? null,
      lastRunAt: state?.last_run_at ?? null,
      lastStatus: state?.last_status ?? null,
      wallMs: Date.now() - started,
      error,
    });
  }

  const findings: string[] = [];
  const first = cycles[0];
  const last = cycles[cycles.length - 1];

  if (first.fired.length === 0) {
    findings.push(
      'cron scheduler: a schedule overdue by an hour did not fire on the first '
      + `tick (fired=[], next_run_at=${first.nextRunAt})`,
    );
  }
  if (first.lastRunAt === null) {
    findings.push(
      'cron scheduler: the fire did not record `last_run_at` — an unrecorded '
      + 'fire cannot be distinguished from no fire on the next boot',
    );
  }
  if (first.nextRunAt !== null && first.nextRunAt <= now) {
    findings.push(
      'cron scheduler: `next_run_at` did not advance past now after firing '
      + `(${first.nextRunAt} <= ${now}) — the cursor did not move, so the same `
      + 'slot stays due forever',
    );
  }
  const refires = cycles.slice(1).filter((c) => c.fired.length > 0);
  if (refires.length > 0) {
    findings.push(
      `cron scheduler: re-fired on cycle ${refires[0].cycle} with no new due `
      + 'slot — a double-fire on unchanged input',
    );
  }
  if (last.nextRunAt === null) {
    findings.push(
      'cron scheduler: a RECURRING schedule ended with next_run_at = null — it '
      + 'will never become due again',
    );
  }

  // Leave no residue: the schedule is harness fixture, not user content.
  input.db.prepare(`DELETE FROM schedules WHERE schedule_id = ?`).run(SCHEDULE_ID);

  return { ran: true, reason: undefined, cycles, findings };
};
