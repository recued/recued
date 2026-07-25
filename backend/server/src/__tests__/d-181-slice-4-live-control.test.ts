// D-181 Slice 4 — the live active-list + kill control surface.
//
// Covers the three acceptance criteria + the queue-control + auth edges:
//   - LaneSemaphore queue control: cancel-before-dispatch rejects the waiter;
//     promote moves to head; signal-abort drops a waiter; the promotion
//     starvation bound jumps an over-age waiter; the gated-entry read model.
//   - InFlightRegistry: snapshot (run + queued-call entries); kill SIGKILLs the
//     attached subprocess + abandons the await + records `killed`; cancel records
//     `cancelled_before_dispatch`; session-scoping; kill idempotency.
//   - execution-control handler: owner/viewer auth + the bridge-approval gate.

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource, SlotRequest } from '@recued/contracts';
import { LaneSemaphore, SlotCancelledError } from '../execution/lane-semaphore.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import {
  handleExecutionActive,
  handleExecutionKill,
  handleExecutionCancel,
  handleExecutionPromote,
  type ExecutionControlDeps,
} from '../execution-control-handler.js';
import type { WsClient } from '../ws-server.js';

const OWNER_SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u1',
  client_token_id: 'tok-web',
};

const slot = (
  call_class: SlotRequest['call_class'],
  run_id?: string,
  signal?: AbortSignal,
): SlotRequest => ({
  call_class,
  descriptor: { recipe_id: 'r', slug: 's', ...(run_id ? { run_id, step_id: 'step1' } : {}) },
  ...(signal ? { signal } : {}),
});

const settled = (p: Promise<unknown>) => {
  let value: 'pending' | 'resolved' | 'rejected' = 'pending';
  let error: unknown;
  void p.then(
    () => {
      value = 'resolved';
    },
    (e) => {
      value = 'rejected';
      error = e;
    },
  );
  return {
    state: () => value,
    error: () => error,
  };
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ────────────────────────────────────────────────────────────────
// LaneSemaphore — queue control (cancel / promote / signal / starvation)
// ────────────────────────────────────────────────────────────────

describe('LaneSemaphore — queue control', () => {
  it('cancel drops a queued waiter and rejects its acquire (cancelled_before_dispatch)', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const held = await sem.acquire(slot('local-heavy', 'runA')); // takes the slot
    const queued = sem.acquire(slot('local-heavy', 'runB')); // queues
    const track = settled(queued);
    await flush();
    expect(track.state()).toBe('pending');

    const waiting = sem.gatedEntries().find((e) => e.state === 'waiting_slot');
    expect(waiting).toBeDefined();
    expect(sem.cancel(waiting!.call_id)).toBe('cancelled_before_dispatch');
    await flush();
    expect(track.state()).toBe('rejected');
    expect(track.error()).toBeInstanceOf(SlotCancelledError);
    expect(sem.occupancy().find((o) => o.lane === 'local-heavy')!.queued).toBe(0);
    held.release('succeeded');
  });

  it('cancel of a running call returns already_dispatched; unknown returns not_found', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    await sem.acquire(slot('local-heavy', 'runA'));
    const running = sem.gatedEntries().find((e) => e.state === 'running')!;
    expect(sem.cancel(running.call_id)).toBe('already_dispatched');
    expect(sem.cancel('call_does_not_exist')).toBe('not_found');
  });

  it('promote moves a queued call to the head so it is granted first', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const first = sem.acquire(slot('local-heavy', 'runB'));
    const second = sem.acquire(slot('local-heavy', 'runC'));
    await flush();
    const waiters = sem.gatedEntries().filter((e) => e.state === 'waiting_slot');
    expect(waiters).toHaveLength(2);
    const secondCallId = waiters[1].call_id;
    expect(sem.promote(secondCallId)).toBe('promoted');

    // Release the slot — the promoted (second) waiter wins it.
    const secondTrack = settled(second.then((l) => l.lane));
    const firstTrack = settled(first.then((l) => l.lane));
    held.release('succeeded');
    await flush();
    expect(secondTrack.state()).toBe('resolved');
    expect(firstTrack.state()).toBe('pending');
    expect(sem.promote('nope')).toBe('not_found');
  });

  it('a SlotRequest.signal abort drops the queued waiter', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const ctrl = new AbortController();
    const queued = sem.acquire(slot('local-heavy', 'runB', ctrl.signal));
    const track = settled(queued);
    await flush();
    expect(track.state()).toBe('pending');
    ctrl.abort();
    await flush();
    expect(track.state()).toBe('rejected');
    expect(track.error()).toBeInstanceOf(SlotCancelledError);
    expect(sem.occupancy().find((o) => o.lane === 'local-heavy')!.queued).toBe(0);
    held.release('succeeded');
  });

  it('a pre-aborted signal rejects the acquire without ever taking a slot', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sem.acquire(slot('local-heavy', 'runA', ctrl.signal))).rejects.toBeInstanceOf(
      SlotCancelledError,
    );
    expect(sem.occupancy().find((o) => o.lane === 'local-heavy')!.in_use).toBe(0);
  });

  it('the promotion starvation bound grants an over-age waiter before a promoted newer one', async () => {
    let t = 0;
    const sem = new LaneSemaphore({ local_heavy_n: 1, max_queue_age_ms: 100, now: () => t });
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const old = sem.acquire(slot('local-heavy', 'runOld')); // enqueued at t=0
    await flush();
    t = 50;
    const fresh = sem.acquire(slot('local-heavy', 'runFresh')); // enqueued at t=50
    await flush();
    // Promote the fresh waiter to the head — normally it would win the slot.
    const freshId = sem.gatedEntries().find(
      (e) => e.state === 'waiting_slot' && e.descriptor.run_id === 'runFresh',
    )!.call_id;
    sem.promote(freshId);
    // Advance past the starvation bound for the OLD waiter (age 200 > 100).
    t = 200;
    const oldTrack = settled(old);
    const freshTrack = settled(fresh);
    held.release('succeeded');
    await flush();
    // The starved old waiter jumps the promoted fresh one.
    expect(oldTrack.state()).toBe('resolved');
    expect(freshTrack.state()).toBe('pending');
  });

  it('laneStatus reports oldest_wait_ms over the queued waiters', async () => {
    let t = 0;
    const sem = new LaneSemaphore({ local_heavy_n: 1, now: () => t });
    await sem.acquire(slot('local-heavy', 'runA'));
    void sem.acquire(slot('local-heavy', 'runB'));
    await flush();
    t = 5000;
    const status = sem.laneStatus().find((l) => l.lane === 'local-heavy')!;
    expect(status.queued).toBe(1);
    expect(status.oldest_wait_ms).toBe(5000);
  });
});

// ────────────────────────────────────────────────────────────────
// InFlightRegistry — snapshot + kill + cancel + session-scoping
// ────────────────────────────────────────────────────────────────

const registerRun = (
  reg: InFlightRegistry,
  run_id: string,
  origin: 'attended' | 'unattended',
  session_id: string | undefined,
  abort = () => {},
) =>
  reg.registerRun({
    run_id,
    recipe_id: 'r',
    source: OWNER_SOURCE,
    origin,
    ...(session_id ? { session_id } : {}),
    started_at: 1,
    abort,
  });

describe('InFlightRegistry — snapshot', () => {
  it('surfaces a run entry (with its held lane) + a queued-call entry', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', 'sess1');
    registerRun(reg, 'runB', 'attended', 'sess1');
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    void sem.acquire(slot('local-heavy', 'runB')); // queues
    await flush();

    const snap = reg.snapshot();
    const runEntry = snap.entries.find((e) => e.entry_kind === 'run' && e.run_id === 'runA')!;
    expect(runEntry.state).toBe('running');
    expect(runEntry.lane).toBe('local-heavy');
    expect(runEntry.kill.mechanism).toBe('abandon_await');

    const queuedEntry = snap.entries.find((e) => e.entry_kind === 'queued-call')!;
    expect(queuedEntry.state).toBe('waiting_slot');
    expect(queuedEntry.run_id).toBe('runB');
    expect(queuedEntry.queued_call_id).toBeDefined();
    expect(snap.lanes.find((l) => l.lane === 'local-heavy')!.in_use).toBe(1);
    held.release('succeeded');
  });

  it('a run with an attached subprocess advertises a sigkill descriptor', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'unattended', undefined);
    reg.attachSubprocess('runA', 4321, () => {});
    const entry = reg.snapshot().entries.find((e) => e.run_id === 'runA')!;
    expect(entry.kill).toEqual({ mechanism: 'sigkill', pid: 4321 });
  });
});

describe('InFlightRegistry — kill', () => {
  it('SIGKILLs the subprocess, abandons the await, and records killed', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    const abort = vi.fn();
    const kill = vi.fn();
    registerRun(reg, 'runA', 'attended', 'sess1', abort);
    reg.attachSubprocess('runA', 99, kill);

    expect(reg.kill('runA')).toBe('killed');
    expect(kill).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(reg.takeTermination('runA')).toBe('killed');
  });

  it('SIGKILLs EVERY attached child of a run (parallel prefetch), detach removes only its own', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    const killA = vi.fn();
    const killB = vi.fn();
    const childA = reg.attachSubprocess('runA', 1, killA);
    reg.attachSubprocess('runA', 2, killB);
    // Child A settles + detaches — child B's handle must survive.
    reg.detachSubprocess('runA', childA);
    expect(reg.kill('runA')).toBe('killed');
    expect(killA).not.toHaveBeenCalled(); // detached
    expect(killB).toHaveBeenCalledOnce(); // still live → SIGKILLed
  });

  it('is idempotent (already_terminal) and reports not_found for an unknown run', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    expect(reg.kill('runA')).toBe('killed');
    expect(reg.kill('runA')).toBe('already_terminal');
    expect(reg.kill('ghost')).toBe('not_found');
  });

  it('a run with a stale cancelled_before_dispatch marker is STILL killable (not already_terminal)', async () => {
    // A queued call's cancel marks its run `cancelled_before_dispatch`, but an
    // OPTIONAL-prefetch cancel is swallowed by the engine and the run keeps
    // running. A kill on that still-live run must NOT be refused as
    // `already_terminal` (the unkillable-run bug) — it kills + overwrites the
    // stale marker.
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    registerRun(reg, 'runB', 'attended', undefined);
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB'));
    queued.catch(() => {}); // cancel rejects the waiter
    await flush();
    const callId = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!.call_id;
    expect(reg.cancel(callId)).toBe('cancelled_before_dispatch');
    // runB is still registered (live) — the kill proceeds + overwrites the marker.
    expect(reg.kill('runB')).toBe('killed');
    expect(reg.takeTermination('runB')).toBe('killed');
    held.release('succeeded');
  });

  it('takeTermination consumes the marker (read once)', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    reg.kill('runA');
    expect(reg.takeTermination('runA')).toBe('killed');
    expect(reg.takeTermination('runA')).toBeUndefined();
  });

  it('a run retired by completeRun is no longer killable (not_found)', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    expect(reg.isActive('runA')).toBe(true);
    reg.completeRun('runA');
    expect(reg.isActive('runA')).toBe(false);
    // a kill arriving after the run retired finds nothing to mis-stamp
    expect(reg.kill('runA')).toBe('not_found');
    expect(reg.takeTermination('runA')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// InFlightRegistry — `stopping` state (slice-4 #1 resolution)
// ────────────────────────────────────────────────────────────────

describe('InFlightRegistry — stopping state', () => {
  it('a killed-but-not-yet-retired run reads `stopping` (instant kill feedback)', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    // running before the kill
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runA')!.state).toBe('running');
    // the owner kills it; the engine is still unwinding (the handler has not
    // `completeRun`'d the run yet) — the snapshot surfaces `stopping`.
    expect(reg.kill('runA')).toBe('killed');
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runA')!.state).toBe('stopping');
    // it drops from the list once the handler retires it.
    reg.completeRun('runA');
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runA')).toBeUndefined();
  });

  it('a cancelled queued call does NOT flip its run to `stopping` (an optional-prefetch cancel may continue)', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    registerRun(reg, 'runB', 'attended', undefined);
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB'));
    queued.catch(() => {}); // cancel rejects the waiter
    await flush();
    const callId = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!.call_id;
    expect(reg.cancel(callId)).toBe('cancelled_before_dispatch');
    // Only `killed` flips the state — a cancel drops the queued call (its entry
    // vanishes) but the run may keep running (a swallowed optional prefetch), so
    // its run entry stays `running` rather than a long-lived false `stopping`.
    const runBEntry = reg
      .snapshot()
      .entries.find((e) => e.entry_kind === 'run' && e.run_id === 'runB')!;
    expect(runBEntry.state).toBe('running');
    held.release('succeeded');
  });

  it('an untouched running run stays `running`', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    registerRun(reg, 'runB', 'attended', undefined);
    reg.kill('runA');
    // only the killed run flips; the sibling is unaffected.
    expect(reg.snapshot().entries.find((e) => e.run_id === 'runB')!.state).toBe('running');
  });
});

describe('InFlightRegistry — cancel / promote delegation', () => {
  it('cancel rejects the waiter but writes NO run-level termination marker (§7c)', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    registerRun(reg, 'runB', 'attended', undefined);
    const held = await sem.acquire(slot('local-heavy', 'runA'));
    const queued = sem.acquire(slot('local-heavy', 'runB'));
    const track = settled(queued);
    await flush();
    const callId = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!.call_id;

    expect(reg.cancel(callId)).toBe('cancelled_before_dispatch');
    await flush();
    expect(track.state()).toBe('rejected'); // the queued waiter is dropped
    // §7c — the cancel does NOT mark the run terminated (a queued-call cancel may
    // not actually fail the run — an optional prefetch swallows it). The
    // `cancelled_before_dispatch` LABEL is derived by the host from the engine's
    // `slot_cancelled` step error only when the cancel genuinely failed the run.
    expect(reg.takeTermination('runB')).toBeUndefined();
    held.release('succeeded');
  });

  it('promote delegates to the semaphore', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runA', 'attended', undefined);
    registerRun(reg, 'runB', 'attended', undefined);
    await sem.acquire(slot('local-heavy', 'runA'));
    void sem.acquire(slot('local-heavy', 'runB'));
    await flush();
    const callId = sem.gatedEntries().find((e) => e.state === 'waiting_slot')!.call_id;
    expect(reg.promote(callId)).toBe('promoted');
    expect(reg.promote('ghost')).toBe('not_found');
  });
});

describe('InFlightRegistry — session-scoping', () => {
  it('a session filter keeps that session plus all unattended runs', () => {
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem);
    registerRun(reg, 'runAttendedA', 'attended', 'sessA');
    registerRun(reg, 'runAttendedB', 'attended', 'sessB');
    registerRun(reg, 'runUnattended', 'unattended', undefined);

    const all = reg.snapshot().entries.map((e) => e.run_id).sort();
    expect(all).toEqual(['runAttendedA', 'runAttendedB', 'runUnattended']);

    const scoped = reg.snapshot('sessA').entries.map((e) => e.run_id).sort();
    expect(scoped).toEqual(['runAttendedA', 'runUnattended']);
  });

  it('emits a killed delta on the bus when wired', () => {
    const emit = vi.fn();
    const sem = new LaneSemaphore();
    const reg = new InFlightRegistry(sem, { emit });
    registerRun(reg, 'runA', 'attended', undefined);
    reg.kill('runA');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'runA', op: 'killed' }),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// execution-control handler — auth + bridge-approval gate
// ────────────────────────────────────────────────────────────────

const wsClient = (over: Partial<WsClient> = {}): WsClient =>
  ({
    ws: {},
    realm: 'r',
    instance_id: null,
    display_name: 'd',
    connected_at: 0,
    ...over,
  }) as WsClient;

const depsWith = (reg: InFlightRegistry, bridgeApproved?: boolean): ExecutionControlDeps => ({
  registry: reg,
  ...(bridgeApproved === undefined
    ? {}
    : { bridgeApprovalLookup: async () => bridgeApproved }),
});

describe('execution-control handler — auth', () => {
  it('rejects an unauthenticated viewer', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    expect(() => handleExecutionActive(depsWith(reg), wsClient(), {})).toThrow(/paired client/);
  });

  it('lets the owner webclient read the active list', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', 'sess1');
    const res = handleExecutionActive(depsWith(reg), wsClient({ user_id: 'u1' }), {});
    expect(res.entries.some((e) => e.run_id === 'runA')).toBe(true);
  });

  it('the owner webclient may kill (no bridge gate)', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', undefined);
    const res = await handleExecutionKill(depsWith(reg), wsClient({ user_id: 'u1' }), {
      run_id: 'runA',
    });
    expect(res.status).toBe('killed');
  });
});

describe('execution-control handler — bridge-approval gate', () => {
  const bridgeCtx = wsClient({ client_kind: 'bridge', client_token_id: 'tok-bridge' });

  it('a non-approval bridge may VIEW but not kill', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', undefined);
    // view is allowed for a paired bridge
    expect(handleExecutionActive(depsWith(reg, false), bridgeCtx, {}).entries).toHaveLength(1);
    // control is denied without approval mode
    await expect(
      handleExecutionKill(depsWith(reg, false), bridgeCtx, { run_id: 'runA' }),
    ).rejects.toThrow(/approval mode/);
  });

  it('an approval-mode bridge may kill / cancel / promote', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', undefined);
    const res = await handleExecutionKill(depsWith(reg, true), bridgeCtx, { run_id: 'runA' });
    expect(res.status).toBe('killed');
    // cancel + promote on unknown ids still pass the gate (return not_found)
    expect(
      (await handleExecutionCancel(depsWith(reg, true), bridgeCtx, { queued_call_id: 'x' })).status,
    ).toBe('not_found');
    expect(
      (await handleExecutionPromote(depsWith(reg, true), bridgeCtx, { queued_call_id: 'x' })).status,
    ).toBe('not_found');
  });

  it('a bridge with no approval lookup wired is denied control (fail-closed)', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', undefined);
    await expect(
      handleExecutionKill(depsWith(reg), bridgeCtx, { run_id: 'runA' }),
    ).rejects.toThrow(/approval mode/);
  });
});
