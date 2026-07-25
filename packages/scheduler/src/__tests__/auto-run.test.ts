import { describe, it, expect } from 'vitest';
import { CIRCUIT_BREAKER_THRESHOLD } from '@recued/contracts';
import type { AutoRunSpec } from '@recued/contracts';
import {
  createAutoRunScheduler,
  rosterAllAutoRun,
  type AutoRunEntry,
  type AutoRunInstallInput,
} from '../auto-run.js';

const SEC = 1000;

const mkInstall = (
  over: Partial<AutoRunInstallInput> = {},
): AutoRunInstallInput => ({
  recipe_id: over.recipe_id ?? 'detect-deal-risk',
  publisher_id: over.publisher_id ?? 'recued-core',
  status: over.status ?? 'enabled',
  process_id: over.process_id,
  auto_run: over.auto_run,
});

const mkAutoRun = (
  over: Partial<AutoRunSpec> = {},
): AutoRunSpec => ({
  interval_ms: over.interval_ms ?? 60 * SEC,
  dynamic: over.dynamic,
});

/** Deterministic mint sequence for tests. */
const mkMinter = (prefix = 'pid') => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// ────────────────────────────────────────────────────────────────
// rosterAllAutoRun — pure rebuild from install snapshot
// ────────────────────────────────────────────────────────────────

describe('rosterAllAutoRun', () => {
  it('skips installs without auto_run (manual + cron-only recipes)', () => {
    const out = rosterAllAutoRun({
      installs: [
        mkInstall({ recipe_id: 'manual' }),
        mkInstall({ recipe_id: 'reactive', auto_run: mkAutoRun() }),
      ],
      now: 0,
    });
    expect(out.map((e) => e.recipe_id)).toEqual(['reactive']);
  });

  it('skips installs that are not enabled', () => {
    const out = rosterAllAutoRun({
      installs: [
        mkInstall({ recipe_id: 'a', status: 'disabled_by_user', auto_run: mkAutoRun() }),
        mkInstall({ recipe_id: 'b', status: 'disabled_broken', auto_run: mkAutoRun() }),
        mkInstall({ recipe_id: 'c', status: 'enabled', auto_run: mkAutoRun() }),
      ],
      now: 0,
    });
    expect(out.map((e) => e.recipe_id)).toEqual(['c']);
  });

  it('mints a fresh process_id when the install record has none', () => {
    const mint = mkMinter();
    const out = rosterAllAutoRun({
      installs: [mkInstall({ auto_run: mkAutoRun() })],
      now: 0,
      mintProcessId: mint,
    });
    expect(out[0].process_id).toBe('pid-1');
  });

  it('reuses the persisted process_id from the install record', () => {
    const out = rosterAllAutoRun({
      installs: [mkInstall({ process_id: 'persisted-id', auto_run: mkAutoRun() })],
      now: 0,
    });
    expect(out[0].process_id).toBe('persisted-id');
  });

  it('seeds next_run_at to `now` for brand-new entries (fires on next tick)', () => {
    const out = rosterAllAutoRun({
      installs: [mkInstall({ auto_run: mkAutoRun({ interval_ms: 30 * SEC }) })],
      now: 1_700_000_000_000,
    });
    expect(out[0].next_run_at).toBe(1_700_000_000_000);
  });

  it('starts new entries with counter 0 + not auto_disabled', () => {
    const out = rosterAllAutoRun({
      installs: [mkInstall({ auto_run: mkAutoRun() })],
      now: 0,
    });
    expect(out[0].consecutive_failures).toBe(0);
    expect(out[0].auto_disabled).toBe(false);
  });

  it('preserves live state (counter, next_run_at, auto_disabled) for surviving entries', () => {
    const prev = new Map<string, AutoRunEntry>([
      [
        'a',
        {
          recipe_id: 'a',
          publisher_id: 'recued-core',
          interval_ms: 60 * SEC,
          dynamic: false,
          process_id: 'stable-id',
          consecutive_failures: 3,
          auto_disabled: false,
          next_run_at: 5_000,
          last_started_at: 4_500,
          last_finished_at: 4_900,
        },
      ],
    ]);
    const out = rosterAllAutoRun({
      installs: [mkInstall({ recipe_id: 'a', auto_run: mkAutoRun() })],
      previousRoster: prev,
      now: 9_000,
    });
    expect(out[0]).toMatchObject({
      process_id: 'stable-id',
      consecutive_failures: 3,
      next_run_at: 5_000,
      last_started_at: 4_500,
      last_finished_at: 4_900,
    });
  });

  it('picks up interval / dynamic edits on a surviving entry', () => {
    const prev = new Map<string, AutoRunEntry>([
      [
        'a',
        {
          recipe_id: 'a',
          publisher_id: 'recued-core',
          interval_ms: 60 * SEC,
          dynamic: false,
          process_id: 'pid-a',
          consecutive_failures: 0,
          auto_disabled: false,
          next_run_at: 0,
        },
      ],
    ]);
    const out = rosterAllAutoRun({
      installs: [
        mkInstall({
          recipe_id: 'a',
          auto_run: mkAutoRun({ interval_ms: 120 * SEC, dynamic: true }),
        }),
      ],
      previousRoster: prev,
      now: 0,
    });
    expect(out[0].interval_ms).toBe(120 * SEC);
    expect(out[0].dynamic).toBe(true);
  });

  it('omits entries that disappeared from the install snapshot', () => {
    const prev = new Map<string, AutoRunEntry>([
      [
        'old',
        {
          recipe_id: 'old',
          publisher_id: 'recued-core',
          interval_ms: 60 * SEC,
          dynamic: false,
          process_id: 'pid-old',
          consecutive_failures: 0,
          auto_disabled: false,
          next_run_at: 0,
        },
      ],
    ]);
    const out = rosterAllAutoRun({
      installs: [],
      previousRoster: prev,
      now: 0,
    });
    expect(out).toEqual([]);
  });

  it('defaults dynamic to false when auto_run omits it', () => {
    const out = rosterAllAutoRun({
      installs: [mkInstall({ auto_run: { interval_ms: 60 * SEC } })],
      now: 0,
    });
    expect(out[0].dynamic).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// scheduler.setRoster — wholesale replace, starting-set cleanup
// ────────────────────────────────────────────────────────────────

describe('scheduler.setRoster', () => {
  const makeEntry = (
    recipe_id: string,
    over: Partial<AutoRunEntry> = {},
  ): AutoRunEntry => ({
    recipe_id,
    publisher_id: 'recued-core',
    interval_ms: 60 * SEC,
    dynamic: false,
    process_id: `pid-${recipe_id}`,
    consecutive_failures: 0,
    auto_disabled: false,
    next_run_at: 0,
    ...over,
  });

  it('replaces the roster wholesale', () => {
    const s = createAutoRunScheduler();
    s.setRoster([makeEntry('a'), makeEntry('b')]);
    expect([...s.roster.keys()]).toEqual(['a', 'b']);
    s.setRoster([makeEntry('c')]);
    expect([...s.roster.keys()]).toEqual(['c']);
  });

  it('evicts starting entries that aren\'t in the new roster', () => {
    const s = createAutoRunScheduler();
    s.setRoster([makeEntry('a')]);
    s.markStarting('a', 'pid-a', 100);
    // Confirm concurrency=1 is in effect before rebuild.
    const before = s.tick(10_000);
    expect(before.skipped_overlap).toEqual(['a']);
    // Drop 'a' from the install set.
    s.setRoster([makeEntry('b')]);
    // Re-add 'a' — tick should now fire it, because the previous
    // starting flag was cleared when 'a' left the roster.
    s.setRoster([makeEntry('a'), makeEntry('b')]);
    const after = s.tick(10_000);
    expect(after.fired.map((f) => f.recipe_id).sort()).toEqual(['a', 'b']);
    expect(after.skipped_overlap).toEqual([]);
  });

  it('preserves starting flag for entries that survive the rebuild', () => {
    const s = createAutoRunScheduler();
    s.setRoster([makeEntry('a')]);
    s.markStarting('a', 'pid-a', 100);
    s.setRoster([makeEntry('a', { interval_ms: 120 * SEC })]);
    // Recipe is still mid-execution — the next tick should NOT refire.
    const report = s.tick(10_000);
    expect(report.fired).toEqual([]);
    expect(report.skipped_overlap).toEqual(['a']);
  });
});

// ────────────────────────────────────────────────────────────────
// scheduler.tick — fire / skip_overlap / skip_circuit / preemptive advance
// ────────────────────────────────────────────────────────────────

describe('scheduler.tick', () => {
  const seed = (): AutoRunEntry[] => [
    {
      recipe_id: 'due',
      publisher_id: 'recued-core',
      interval_ms: 60 * SEC,
      dynamic: false,
      process_id: 'pid-due',
      consecutive_failures: 0,
      auto_disabled: false,
      next_run_at: 1_000,
    },
    {
      recipe_id: 'future',
      publisher_id: 'recued-core',
      interval_ms: 60 * SEC,
      dynamic: false,
      process_id: 'pid-future',
      consecutive_failures: 0,
      auto_disabled: false,
      next_run_at: 10_000,
    },
  ];

  it('fires entries whose next_run_at is <= now', () => {
    const s = createAutoRunScheduler();
    s.setRoster(seed());
    const report = s.tick(5_000);
    expect(report.fired.map((f) => f.recipe_id)).toEqual(['due']);
  });

  it('threads the live process_id into the fired list', () => {
    const s = createAutoRunScheduler();
    s.setRoster(seed());
    const report = s.tick(5_000);
    expect(report.fired[0]).toEqual({ recipe_id: 'due', process_id: 'pid-due' });
  });

  it('preemptively advances next_run_at by interval_ms', () => {
    const s = createAutoRunScheduler();
    s.setRoster(seed());
    s.tick(5_000);
    expect(s.roster.get('due')!.next_run_at).toBe(5_000 + 60 * SEC);
  });

  it('is a silent no-op inside the preemptive-advance window', () => {
    const s = createAutoRunScheduler();
    s.setRoster(seed());
    s.tick(5_000);
    const second = s.tick(5_500);
    expect(second.fired).toEqual([]);
    expect(second.skipped_overlap).toEqual([]);
  });

  it('classifies already-starting entries under skipped_overlap', () => {
    const s = createAutoRunScheduler();
    s.setRoster(seed());
    s.markStarting('due', 'pid-due', 1_000);
    // Roll clock past the preemptive advance so `due` is nominally
    // ready again — the starting flag should still drop it.
    s.roster.get('due')!.next_run_at = 2_000;
    const report = s.tick(3_000);
    expect(report.fired).toEqual([]);
    expect(report.skipped_overlap).toEqual(['due']);
  });

  it('classifies auto_disabled entries under skipped_circuit', () => {
    const s = createAutoRunScheduler();
    s.setRoster([
      {
        recipe_id: 'broken',
        publisher_id: 'recued-core',
        interval_ms: 60 * SEC,
        dynamic: false,
        process_id: 'pid-broken',
        consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
        auto_disabled: true,
        next_run_at: 0,
      },
    ]);
    const report = s.tick(9_999);
    expect(report.fired).toEqual([]);
    expect(report.skipped_circuit).toEqual(['broken']);
  });

  it('returns an empty report for an empty roster', () => {
    const s = createAutoRunScheduler();
    const report = s.tick(Date.now());
    expect(report).toEqual({ fired: [], skipped_overlap: [], skipped_circuit: [] });
  });
});

// ────────────────────────────────────────────────────────────────
// scheduler.markStarting — idempotent concurrency guard
// ────────────────────────────────────────────────────────────────

describe('scheduler.markStarting', () => {
  const one = (): AutoRunEntry => ({
    recipe_id: 'r',
    publisher_id: 'p',
    interval_ms: 60 * SEC,
    dynamic: false,
    process_id: 'pid-r',
    consecutive_failures: 0,
    auto_disabled: false,
    next_run_at: 0,
  });

  it('records last_started_at on the entry', () => {
    const s = createAutoRunScheduler();
    s.setRoster([one()]);
    s.markStarting('r', 'pid-r', 7_777);
    expect(s.roster.get('r')!.last_started_at).toBe(7_777);
  });

  it('drops stale calls whose process_id no longer matches the entry', () => {
    const s = createAutoRunScheduler();
    s.setRoster([one()]);
    // Caller still holds an old process_id; scheduler rotated it.
    s.markStarting('r', 'old-pid', 7_777);
    expect(s.roster.get('r')!.last_started_at).toBeUndefined();
    // The entry is NOT in starting — a fresh tick at the next due
    // window would still fire.
    s.roster.get('r')!.next_run_at = 0;
    const report = s.tick(9_999);
    expect(report.fired.map((f) => f.recipe_id)).toEqual(['r']);
  });

  it('no-ops for an unknown recipe_id', () => {
    const s = createAutoRunScheduler();
    expect(() => s.markStarting('ghost', 'x', 0)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// scheduler.markFinished — counter, circuit, dynamic interval
// ────────────────────────────────────────────────────────────────

describe('scheduler.markFinished', () => {
  const make = (over: Partial<AutoRunEntry> = {}): AutoRunEntry => ({
    recipe_id: 'r',
    publisher_id: 'p',
    interval_ms: 60 * SEC,
    dynamic: false,
    process_id: 'pid-r',
    consecutive_failures: 0,
    auto_disabled: false,
    next_run_at: 0,
    ...over,
  });

  it('clears starting + records last_finished_at', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make()]);
    s.markStarting('r', 'pid-r', 100);
    s.markFinished('r', 'success', undefined, 1_200);
    expect(s.roster.get('r')!.last_finished_at).toBe(1_200);
    // Next tick should fire if enough time passes — starting is cleared.
    s.roster.get('r')!.next_run_at = 2_000;
    const report = s.tick(3_000);
    expect(report.fired.map((f) => f.recipe_id)).toEqual(['r']);
  });

  it('resets the counter to 0 on success', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ consecutive_failures: 3 })]);
    s.markFinished('r', 'success', undefined, 1_000);
    expect(s.roster.get('r')!.consecutive_failures).toBe(0);
  });

  it('increments the counter on failed', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ consecutive_failures: 2 })]);
    s.markFinished('r', 'failed', undefined, 1_000);
    expect(s.roster.get('r')!.consecutive_failures).toBe(3);
  });

  it('leaves the counter unchanged on skipped (trigger gate returned false)', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ consecutive_failures: 2 })]);
    s.markFinished('r', 'skipped', undefined, 1_000);
    expect(s.roster.get('r')!.consecutive_failures).toBe(2);
  });

  it('auto-disables at the threshold', () => {
    const s = createAutoRunScheduler();
    s.setRoster([
      make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 }),
    ]);
    s.markFinished('r', 'failed', undefined, 1_000);
    const e = s.roster.get('r')!;
    expect(e.consecutive_failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(e.auto_disabled).toBe(true);
  });

  it('stays below the threshold does not auto-disable', () => {
    const s = createAutoRunScheduler();
    s.setRoster([
      make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 2 }),
    ]);
    s.markFinished('r', 'failed', undefined, 1_000);
    expect(s.roster.get('r')!.auto_disabled).toBe(false);
  });

  it('uses the dynamic hint when entry.dynamic === true', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ dynamic: true })]);
    s.markFinished('r', 'success', 5_000_000, 1_000);
    expect(s.roster.get('r')!.next_run_at).toBe(5_000_000);
  });

  it('falls back to interval_ms when dynamic + no hint', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ dynamic: true, interval_ms: 30 * SEC })]);
    s.markFinished('r', 'success', undefined, 1_000);
    expect(s.roster.get('r')!.next_run_at).toBe(1_000 + 30 * SEC);
  });

  it('ignores the hint when dynamic is false', () => {
    const s = createAutoRunScheduler();
    s.setRoster([make({ dynamic: false, interval_ms: 30 * SEC })]);
    s.markFinished('r', 'success', 5_000_000, 1_000);
    expect(s.roster.get('r')!.next_run_at).toBe(1_000 + 30 * SEC);
  });

  // ──────────────────────────────────────────────────────────────
  // D-115 Phase 8 — onCircuitTripped notification
  // ──────────────────────────────────────────────────────────────

  it('Phase 8: fires onCircuitTripped exactly once on the threshold crossing', () => {
    const events: Array<{
      recipe_id: string;
      publisher_id: string;
      retired_process_id: string;
      consecutive_failures: number;
      tripped_at: number;
    }> = [];
    const s = createAutoRunScheduler({
      onCircuitTripped: (e) => events.push(e),
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    s.markFinished('r', 'failed', undefined, 42);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      recipe_id: 'r',
      publisher_id: 'p',
      retired_process_id: 'pid-r',
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      tripped_at: 42,
    });
  });

  it('Phase 8: does NOT re-fire while entry stays auto_disabled', () => {
    const events: unknown[] = [];
    const s = createAutoRunScheduler({
      onCircuitTripped: (e) => events.push(e),
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    s.markFinished('r', 'failed', undefined, 1);
    s.markFinished('r', 'failed', undefined, 2);
    s.markFinished('r', 'failed', undefined, 3);
    expect(events).toHaveLength(1);
  });

  it('Phase 8: fires again after resetCircuit → re-trip', () => {
    const events: unknown[] = [];
    const s = createAutoRunScheduler({
      onCircuitTripped: (e) => events.push(e),
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    s.markFinished('r', 'failed', undefined, 1); // trip 1
    s.resetCircuit('r', 2);
    // Re-trip: counter drifts back to threshold over subsequent failures.
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      s.markFinished('r', 'failed', undefined, 10 + i);
    }
    expect(events).toHaveLength(2);
  });

  it('Phase 8: does NOT fire on skipped (trigger gate silent-skip)', () => {
    const events: unknown[] = [];
    const s = createAutoRunScheduler({
      onCircuitTripped: (e) => events.push(e),
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    // skipped outcome leaves counter unchanged — no trip.
    s.markFinished('r', 'skipped', undefined, 1);
    expect(events).toEqual([]);
    expect(s.roster.get('r')!.auto_disabled).toBe(false);
  });

  it('Phase 8: a success below threshold does NOT fire', () => {
    const events: unknown[] = [];
    const s = createAutoRunScheduler({
      onCircuitTripped: (e) => events.push(e),
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    s.markFinished('r', 'success', undefined, 1);
    expect(events).toEqual([]);
  });

  it('Phase 8: a thrown listener does not break the scheduler', () => {
    const s = createAutoRunScheduler({
      onCircuitTripped: () => {
        throw new Error('UI bug');
      },
    });
    s.setRoster([make({ consecutive_failures: CIRCUIT_BREAKER_THRESHOLD - 1 })]);
    // Should not throw.
    expect(() => s.markFinished('r', 'failed', undefined, 1)).not.toThrow();
    expect(s.roster.get('r')!.auto_disabled).toBe(true);
  });

  it('no-ops for an unknown recipe_id', () => {
    const s = createAutoRunScheduler();
    expect(() => s.markFinished('ghost', 'success', undefined, 0)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// scheduler.resetCircuit — rearm after auto-disable
// ────────────────────────────────────────────────────────────────

describe('scheduler.resetCircuit', () => {
  it('clears counter + flag and rearms next_run_at', () => {
    const s = createAutoRunScheduler({ mintProcessId: mkMinter() });
    s.setRoster([
      {
        recipe_id: 'r',
        publisher_id: 'p',
        interval_ms: 60 * SEC,
        dynamic: false,
        process_id: 'old-pid',
        consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
        auto_disabled: true,
        next_run_at: 999_999_999,
      },
    ]);
    s.resetCircuit('r', 5_000);
    const e = s.roster.get('r')!;
    expect(e.consecutive_failures).toBe(0);
    expect(e.auto_disabled).toBe(false);
    expect(e.next_run_at).toBe(5_000);
  });

  it('mints a fresh process_id (retires the circuit_broken one)', () => {
    const s = createAutoRunScheduler({ mintProcessId: mkMinter() });
    s.setRoster([
      {
        recipe_id: 'r',
        publisher_id: 'p',
        interval_ms: 60 * SEC,
        dynamic: false,
        process_id: 'old-pid',
        consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
        auto_disabled: true,
        next_run_at: 0,
      },
    ]);
    s.resetCircuit('r', 5_000);
    expect(s.roster.get('r')!.process_id).toBe('pid-1');
  });

  it('allows the next tick to fire the rearmed recipe', () => {
    const s = createAutoRunScheduler();
    s.setRoster([
      {
        recipe_id: 'r',
        publisher_id: 'p',
        interval_ms: 60 * SEC,
        dynamic: false,
        process_id: 'pid',
        consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
        auto_disabled: true,
        next_run_at: 0,
      },
    ]);
    const blocked = s.tick(5_000);
    expect(blocked.skipped_circuit).toEqual(['r']);
    s.resetCircuit('r', 5_000);
    const afterReset = s.tick(5_000);
    expect(afterReset.fired.map((f) => f.recipe_id)).toEqual(['r']);
  });

  it('no-ops for an unknown recipe_id', () => {
    const s = createAutoRunScheduler();
    expect(() => s.resetCircuit('ghost', 0)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end lifecycle — install → tick → run → finish → circuit → reset
// ────────────────────────────────────────────────────────────────

describe('scheduler lifecycle', () => {
  it('survives a full install → tick → run → finished cycle', () => {
    const s = createAutoRunScheduler({ mintProcessId: mkMinter() });
    s.setRoster(
      rosterAllAutoRun({
        installs: [mkInstall({ auto_run: mkAutoRun({ interval_ms: 30 * SEC }) })],
        now: 0,
      }),
    );

    const pid = s.roster.get('detect-deal-risk')!.process_id;

    // First tick fires at now=0.
    const t1 = s.tick(0);
    expect(t1.fired).toEqual([{ recipe_id: 'detect-deal-risk', process_id: pid }]);

    // Caller dispatches + marks starting.
    s.markStarting('detect-deal-risk', pid, 100);

    // Second tick mid-run — concurrency=1 drop.
    const t2 = s.tick(1_000);
    expect(t2.fired).toEqual([]);
    expect(t2.skipped_overlap).toEqual([]); // next_run_at preemptively advanced

    // Run finishes. Counter stays at 0 on success.
    s.markFinished('detect-deal-risk', 'success', undefined, 2_000);
    expect(s.roster.get('detect-deal-risk')!.consecutive_failures).toBe(0);
    expect(s.roster.get('detect-deal-risk')!.next_run_at).toBe(2_000 + 30 * SEC);
  });

  it('trips the breaker after N consecutive failures and reset rearms', () => {
    const s = createAutoRunScheduler({ mintProcessId: mkMinter('pid') });
    s.setRoster(
      rosterAllAutoRun({
        installs: [mkInstall({ auto_run: mkAutoRun({ interval_ms: 30 * SEC }) })],
        now: 0,
      }),
    );

    const initialPid = s.roster.get('detect-deal-risk')!.process_id;

    // Fail N times.
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      s.markFinished('detect-deal-risk', 'failed', undefined, 1_000 * (i + 1));
    }
    expect(s.roster.get('detect-deal-risk')!.auto_disabled).toBe(true);

    // Ticks now skip under circuit.
    const blocked = s.tick(999_999);
    expect(blocked.skipped_circuit).toEqual(['detect-deal-risk']);

    // Reset mints a new process_id and rearms.
    s.resetCircuit('detect-deal-risk', 1_000_000);
    const newPid = s.roster.get('detect-deal-risk')!.process_id;
    expect(newPid).not.toBe(initialPid);

    const rearmed = s.tick(1_000_000);
    expect(rearmed.fired).toEqual([
      { recipe_id: 'detect-deal-risk', process_id: newPid },
    ]);
  });
});
