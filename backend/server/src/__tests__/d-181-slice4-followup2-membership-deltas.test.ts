// D-181 slice-4 follow-up #2 — fine-grained membership deltas.
//
// The long-op governor now fans the queue-lifecycle ops the slice-4 registry
// could not see on its own: the LaneSemaphore emits `queued` (a heavy call
// blocked on a slot) + `slot_acquired` (a queued call won its slot), and the
// in-flight registry emits `stalled` (the cli stall monitor flagged the run) +
// carries the lane on `promoted` / `cancelled`. A subscribed client reconstructs
// its active list from an `execution.active` snapshot + these live deltas, so the
// 5b/6c client-side catch-up polls are retired. This suite covers the new emits
// at the source (semaphore + registry) and the cli-executor → registry chain.

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource, SlotRequest } from '@recued/contracts';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

const OWNER_SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u1',
  client_token_id: 'tok-web',
};

const slot = (
  call_class: SlotRequest['call_class'],
  run_id?: string,
): SlotRequest => ({
  call_class,
  descriptor: { recipe_id: 'r', slug: 's', ...(run_id ? { run_id, step_id: 'step1' } : {}) },
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const registerRun = (
  reg: InFlightRegistry,
  run_id: string,
  origin: 'attended' | 'unattended' = 'attended',
) =>
  reg.registerRun({ run_id, recipe_id: 'r', source: OWNER_SOURCE, origin, started_at: 1, abort: () => {} });

// ────────────────────────────────────────────────────────────────
// LaneSemaphore — queued / slot_acquired deltas
// ────────────────────────────────────────────────────────────────

describe('LaneSemaphore — queue-lifecycle deltas', () => {
  it('emits a `queued` delta (with run_id + queued_call_id + lane) when a call blocks on a slot', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 1, emit });
    const held = await sem.acquire(slot('local-heavy', 'runA')); // direct grant — never queued
    expect(emit).not.toHaveBeenCalled();

    void sem.acquire(slot('local-heavy', 'runB')); // lane full → queues
    await flush();
    const waiting = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      recipe_id: 'r',
      run_id: 'runB',
      op: 'queued',
      queued_call_id: waiting.call_id,
      lane: 'local-heavy',
    });
    held.release('succeeded');
  });

  it('emits a `slot_acquired` delta when a queued call wins its slot (pump only)', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 1, emit });
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB'));
    await flush();
    emit.mockClear(); // drop the `queued` delta — assert only the grant transition

    held.release('succeeded'); // frees the slot → pump grants runB
    await queued;
    expect(emit).toHaveBeenCalledWith({
      recipe_id: 'r',
      run_id: 'runB',
      op: 'slot_acquired',
      queued_call_id: expect.any(String),
      lane: 'local-heavy',
    });
  });

  it('a fresh direct grant never emits (it never queued; the run already showed via `start`)', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 2, emit });
    await sem.acquire(slot('local-heavy', 'runA'));
    await sem.acquire(slot('local-heavy', 'runB'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('a call without a run_id emits nothing (the bus event keys on run_id)', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 1, emit });
    const held = await sem.acquire(slot('local-heavy')); // no run_id, direct grant
    const queued = sem.acquire(slot('local-heavy')); // no run_id, queues
    await flush();
    expect(emit).not.toHaveBeenCalled();
    held.release('succeeded');
    await queued;
  });

  it('a throwing emit never blocks slot acquisition or release (best-effort)', async () => {
    const emit = vi.fn(() => {
      throw new Error('bus down');
    });
    const sem = new LaneSemaphore({ local_heavy_n: 1, emit });
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB')); // queued → throwing emit swallowed
    let resolved = false;
    void queued.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false); // still queued, not rejected by the throw
    held.release('succeeded'); // pump grants runB → slot_acquired emit throws, swallowed
    await queued;
    expect(resolved).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// InFlightRegistry — stalled delta + snapshot + cancel/promote lane
// ────────────────────────────────────────────────────────────────

describe('InFlightRegistry — stalled flag', () => {
  it('markStalled emits a `stalled` delta and the snapshot reflects progress.stalled', () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    registerRun(reg, 'runA');
    reg.markStalled('runA');
    expect(emit).toHaveBeenCalledWith({ recipe_id: 'r', run_id: 'runA', op: 'stalled' });
    const entry = reg.snapshot().entries.find((e) => e.run_id === 'runA')!;
    expect(entry.progress.stalled).toBe(true);
  });

  it('markStalled is idempotent (emits once) and no-ops for an unregistered run', () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    registerRun(reg, 'runA');
    reg.markStalled('runA');
    reg.markStalled('runA'); // already flagged — no second delta
    expect(emit).toHaveBeenCalledTimes(1);
    reg.markStalled('ghost'); // unregistered — no-op
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('completeRun clears the stalled flag (a reused run id reads clean)', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA');
    reg.markStalled('runA');
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runA')!.progress.stalled).toBe(true);
    reg.completeRun('runA');
    registerRun(reg, 'runA');
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runA')!.progress.stalled).toBe(false);
  });
});

describe('InFlightRegistry — retired (membership removal)', () => {
  it('completeRun emits a `retired` delta for a registered run (covers the no-terminal exit paths)', () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    registerRun(reg, 'runA');
    reg.completeRun('runA');
    expect(emit).toHaveBeenCalledWith({ recipe_id: 'r', run_id: 'runA', op: 'retired' });
  });

  it('completeRun emits `retired` exactly once (the handler `finally` calls it twice)', () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    registerRun(reg, 'runA');
    reg.completeRun('runA');
    reg.completeRun('runA'); // run already gone — silent
    const retired = emit.mock.calls.filter(([a]) => a.op === 'retired');
    expect(retired).toHaveLength(1);
  });

  it('completeRun on an unregistered run emits nothing', () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    reg.completeRun('ghost');
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('InFlightRegistry — cancel / promote carry the lane', () => {
  it('cancel emits a `cancelled` delta carrying the queued call lane', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem, { emit });
    registerRun(reg, 'runA');
    registerRun(reg, 'runB');
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB'));
    queued.catch(() => {}); // cancel rejects the waiter
    await flush();
    const callId = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!.call_id;
    emit.mockClear(); // drop the `queued` delta

    expect(reg.cancel(callId)).toBe('cancelled_before_dispatch');
    expect(emit).toHaveBeenCalledWith({
      recipe_id: 'r',
      run_id: 'runB',
      op: 'cancelled',
      queued_call_id: callId,
      lane: 'local-heavy',
    });
    held.release('succeeded');
  });

  it('promote emits a `promoted` delta carrying the queued call lane', async () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem, { emit });
    registerRun(reg, 'runA');
    registerRun(reg, 'runB');
    registerRun(reg, 'runC');
    await sem.acquire(slot('local-heavy', 'runA'));
    void sem.acquire(slot('local-heavy', 'runB'));
    void sem.acquire(slot('local-heavy', 'runC')); // two waiters so one is promotable off-head
    await flush();
    const tailCallId = sem.gatedEntries().filter((e) => e.state === 'waiting_slot')[1].call_id;
    emit.mockClear();

    expect(reg.promote(tailCallId)).toBe('promoted');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'promoted', queued_call_id: tailCallId, lane: 'local-heavy' }),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// cli executor → registry chain — a real stall flags the run
// ────────────────────────────────────────────────────────────────

describe('cli stall monitor → registry stalled delta', () => {
  // k·T ≈ 600ms; large hard cap so the unattended kill trips on no_progress.
  const tinyTuning = { pollMs: 20, factorK: 3, expectedIntervalMs: 200, silentHardCapMs: 5_000 };

  it('flags the registered run (emits a `stalled` delta) when the foreground monitor detects a stall', async () => {
    const emit = vi.fn();
    const reg = new InFlightRegistry(new LaneSemaphore(), { emit });
    registerRun(reg, 'runDoc', 'unattended');
    const exec = createCliInvocationExecutor({ stallTuning: tinyTuning, inFlightRegistry: reg });

    await expect(
      exec({
        slug: 'docling',
        operation_key: 'docling.convert',
        operation_id: 'recued-core/docling.convert',
        args: {},
        stepMeta: { step_id: 's1', trigger_source: 'reactive', run_id: 'runDoc' },
        binding: {
          kind: 'cli_invocation',
          // emits nothing then hangs → no heartbeat for k·T → stalled + SIGKILLed.
          argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
          shape: 'text',
          exit_code_handling: 'zero_is_success',
          progress: { contract: 'heartbeat', adapter: 'codex-jsonl', stall_ms: 50 },
        },
      }),
    ).rejects.toThrow(/killed: no_progress stall/);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'runDoc', op: 'stalled' }),
    );
  });
});
