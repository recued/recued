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

const MCP_SOURCE_A: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-a',
  tool_call_id: 'call-a',
  mcp_token_id: 'token-a',
  contract_id: 'contract-a',
};

const CHAT_SOURCE_A: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-a',
  user_id: 'owner',
};

const MESSENGER_SOURCE_A: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'U123',
};

const MCP_SOURCE_B: ExecutionSource = {
  ...MCP_SOURCE_A,
  agent_id: 'agent-b',
  tool_call_id: 'call-b',
  mcp_token_id: 'token-b',
  contract_id: 'contract-b',
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

describe('InFlightRegistry — D-259 running-twin attachment', () => {
  it('elects one leader atomically and gives every follower the same response', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    expect(reg.runningTwin('identity')).toBeNull();
    expect(reg.claimRunningTwin('identity', 'leader')).toEqual({ leader: true });

    const followerA = reg.claimRunningTwin('identity', 'follower-a');
    const followerB = reg.claimRunningTwin('identity', 'follower-b');
    expect(followerA.leader).toBe(false);
    expect(followerB.leader).toBe(false);
    if (followerA.leader || followerB.leader) throw new Error('expected followers');
    expect(followerA.run_id).toBe('leader');
    expect(followerB.run_id).toBe('leader');

    const response = { recipe_id: 'r', success: true };
    reg.settleRunningTwin('leader', { status: 'completed', response });
    await expect(followerA.outcome).resolves.toEqual({ status: 'completed', response });
    await expect(followerB.outcome).resolves.toEqual({ status: 'completed', response });
    expect(reg.runningTwin('identity')).toBeNull();
  });

  it('shares failures as data and ignores a non-owner settle', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    reg.claimRunningTwin('identity', 'leader');
    const follower = reg.claimRunningTwin('identity', 'follower');
    if (follower.leader) throw new Error('expected follower');
    reg.settleRunningTwin('follower', { status: 'completed', response: 'wrong' });
    expect(reg.runningTwin('identity')?.run_id).toBe('leader');
    const error = new Error('failed');
    reg.settleRunningTwin('leader', { status: 'failed', error });
    await expect(follower.outcome).resolves.toEqual({ status: 'failed', error });
  });
});

describe('InFlightRegistry — D-259 same-token MCP stop', () => {
  const registerMcpRun = (
    reg: InFlightRegistry,
    opts: {
      run_id: string;
      recipe_id?: string;
      source?: ExecutionSource;
      origin?: 'attended' | 'unattended';
      started_at?: number;
      abort?: () => void;
    },
  ) => reg.registerRun({
    run_id: opts.run_id,
    recipe_id: opts.recipe_id ?? 'recipe-a',
    source: opts.source ?? MCP_SOURCE_A,
    origin: opts.origin ?? 'attended',
    started_at: opts.started_at ?? 1,
    abort: opts.abort ?? (() => {}),
  });

  it('stops one owned attended run and reports a second stop as already_terminal', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abort = vi.fn();
    registerMcpRun(reg, { run_id: 'run-a', started_at: 42, abort });

    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'run-a' })).toEqual({
      status: 'stopped',
      run_id: 'run-a',
      recipe_id: 'recipe-a',
      started_at: 42,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'run-a' })).toEqual({
      status: 'already_terminal',
      run_id: 'run-a',
    });
  });

  // ── D-259 § 7.4.3 — ONE method, every door ──────────────────────────────
  //
  // The arity rule and the ownership rule must not be re-implemented per
  // channel, so the ONLY thing that varies is the channel-session key. These
  // drive the two non-MCP doors and, more importantly, the ISOLATION between
  // them: a scope that leaks would let one conversation stop another's work.

  it('stops a chat-scoped run through the same method', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abort = vi.fn();
    registerMcpRun(reg, { run_id: 'run-chat', started_at: 7, abort, source: CHAT_SOURCE_A });

    expect(reg.stopOwnRun('chat:sess-a', { recipe_id: 'recipe-a' })).toEqual({
      status: 'stopped', run_id: 'run-chat', recipe_id: 'recipe-a', started_at: 7,
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('stops a messenger-scoped run through the same method', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abort = vi.fn();
    registerMcpRun(reg, { run_id: 'run-msg', started_at: 9, abort, source: MESSENGER_SOURCE_A });

    expect(reg.stopOwnRun('messenger:slack:U123', { recipe_id: 'recipe-a' })).toEqual({
      status: 'stopped', run_id: 'run-msg', recipe_id: 'recipe-a', started_at: 9,
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('⛔ does NOT let one channel stop another channel\'s run', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abort = vi.fn();
    registerMcpRun(reg, { run_id: 'run-mcp', abort, source: MCP_SOURCE_A });

    // A chat turn, a messenger turn, and a DIFFERENT mcp token all miss it.
    expect(reg.stopOwnRun('chat:sess-a', { run_id: 'run-mcp' })).toEqual({ status: 'not_yours' });
    expect(reg.stopOwnRun('messenger:slack:U123', { run_id: 'run-mcp' })).toEqual({ status: 'not_yours' });
    expect(reg.stopOwnRun('mcp:token-b', { run_id: 'run-mcp' })).toEqual({ status: 'not_yours' });
    expect(abort).not.toHaveBeenCalled();
  });

  it('⛔ keeps two chat sessions isolated from each other', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abort = vi.fn();
    registerMcpRun(reg, { run_id: 'run-a', abort, source: CHAT_SOURCE_A });

    expect(reg.stopOwnRun('chat:sess-other', { recipe_id: 'recipe-a' }))
      .toEqual({ status: 'not_yours' });
    expect(abort).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous recipe match and kills none of the candidates', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    const abortA = vi.fn();
    const abortB = vi.fn();
    registerMcpRun(reg, { run_id: 'run-a', started_at: 20, abort: abortA });
    registerMcpRun(reg, { run_id: 'run-b', started_at: 10, abort: abortB });

    expect(reg.stopOwnRun('mcp:token-a', { recipe_id: 'recipe-a' })).toEqual({
      status: 'ambiguous',
      candidates: [
        { run_id: 'run-b', recipe_id: 'recipe-a', started_at: 10 },
        { run_id: 'run-a', recipe_id: 'recipe-a', started_at: 20 },
      ],
    });
    expect(abortA).not.toHaveBeenCalled();
    expect(abortB).not.toHaveBeenCalled();
  });

  it('distinguishes another token and unattended work internally', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerMcpRun(reg, { run_id: 'other-token', source: MCP_SOURCE_B });
    registerMcpRun(reg, { run_id: 'unattended', origin: 'unattended' });

    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'other-token' })).toEqual({
      status: 'not_yours',
    });
    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'unattended' })).toEqual({
      status: 'not_yours',
    });
  });

  it('keeps a bounded terminal address long enough to distinguish replay', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerMcpRun(reg, { run_id: 'settled' });
    reg.completeRun('settled');

    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'settled' })).toEqual({
      status: 'already_terminal',
      run_id: 'settled',
    });
    expect(reg.stopOwnRun('mcp:token-a', { run_id: 'unknown' })).toEqual({
      status: 'not_found',
    });
  });
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

  it('projects only the bounded host-derived declaration summary', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    reg.registerRun({
      run_id: 'runA',
      recipe_id: 'r',
      intent: 'Review repository',
      risk: 'write',
      effect: 'codex.review',
      source: OWNER_SOURCE,
      origin: 'attended',
      session_id: 'sess1',
      started_at: 1,
      abort: () => {},
    });
    expect(reg.snapshot('sess1').entries[0]).toEqual(expect.objectContaining({
      intent: 'Review repository',
      risk: 'write',
      effect: 'codex.review',
    }));
    const context = reg.promptContext('sess1')!;
    expect(context).toContain('Prefer answering, inspecting, or stopping');
    expect(context).toContain('run=runA; recipe=r');
    expect(context).toContain('intent="Review repository"');
    expect(context).toContain('risk=write');
    expect(context.split('\n')).toHaveLength(2);
  });

  it('projects host-observed progress and clears a recovered stall', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', 'sess1');
    reg.markStalled('runA');
    reg.reportProgress('runA', 'heartbeat', 1234);

    const entry = reg.snapshot('sess1').entries[0]!;
    expect(entry.progress).toEqual({
      contract: 'heartbeat',
      last_signal_at: 1234,
      stalled: false,
    });
    expect(reg.promptContext('sess1')).toContain(
      'progress=heartbeat,last=1234,stalled=false',
    );

    reg.completeRun('runA');
    reg.reportProgress('runA', 'file-growth', 9999);
    expect(reg.snapshot('sess1').entries).toHaveLength(0);
  });

  it('never injects another session or unattended work into a turn', () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'mine', 'attended', 'sess1');
    registerRun(reg, 'theirs', 'attended', 'sess2');
    registerRun(reg, 'cron', 'unattended', undefined);
    const context = reg.promptContext('sess1')!;
    expect(context).toContain('run=mine');
    expect(context).not.toContain('theirs');
    expect(context).not.toContain('cron');
  });
});

describe('InFlightRegistry — kill', () => {
  it('waits for every finite child to detach before declaring subprocess cleanup drained', async () => {
    const reg = new InFlightRegistry(new LaneSemaphore());
    registerRun(reg, 'runA', 'attended', 'sess1');
    const childA = reg.attachSubprocess('runA', 91, () => {});
    const childB = reg.attachSubprocess('runA', 92, () => {});
    const drain = reg.waitForSubprocessDrain('runA');
    const track = settled(drain);

    reg.detachSubprocess('runA', childA);
    await flush();
    expect(track.state()).toBe('pending');
    reg.detachSubprocess('runA', childB);
    await drain;
    expect(track.state()).toBe('resolved');

    await expect(reg.waitForSubprocessDrain('runA')).resolves.toBeUndefined();
  });

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
