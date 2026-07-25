import { describe, it, expect } from 'vitest';
import {
  DRAIN_STEP_NAMES,
  LIFECYCLE_STATE_RANK,
  isLifecycleAcceptingRpc,
  computeUptimeSeconds,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  ERR,
  type LifecycleState,
  type LifecycleStatus,
  type DrainState,
  type DrainStepName,
  type SupervisorMode,
  type ResolvedSupervisorMode,
} from '../index.js';

describe('DRAIN_STEP_NAMES', () => {
  it('is a stable, ordered tuple of 11 step names', () => {
    expect(DRAIN_STEP_NAMES).toEqual([
      'flip_to_draining',
      'stop_accepting_rpc',
      'pause_collections',
      'pause_scheduler',
      'await_inflight',
      'close_ws',
      'stop_timers',
      'close_cascade',
      'flush_audit',
      'close_db',
      'release_lock',
    ]);
    expect(DRAIN_STEP_NAMES.length).toBe(11);
  });

  it('pause_collections comes before pause_scheduler (Phase D)', () => {
    // Collections must stop before the scheduler so in-flight ticks
    // that read from the warehouse get a clean error rather than a
    // dangling IMAP socket / fs.watch handle during drain.
    const colIdx = DRAIN_STEP_NAMES.indexOf('pause_collections');
    const schedIdx = DRAIN_STEP_NAMES.indexOf('pause_scheduler');
    expect(colIdx).toBeGreaterThan(-1);
    expect(schedIdx).toBeGreaterThan(-1);
    expect(colIdx).toBeLessThan(schedIdx);
  });

  it('DrainStepName union covers every tuple entry', () => {
    // Compile-time check: every string in the tuple must be assignable
    // to DrainStepName. Exhaustiveness verified by this assignment.
    const _exhaustive: readonly DrainStepName[] = DRAIN_STEP_NAMES;
    expect(_exhaustive.length).toBe(DRAIN_STEP_NAMES.length);
  });
});

describe('LIFECYCLE_STATE_RANK', () => {
  it('orders booting < running < draining < restarting/shutting_down < crashed', () => {
    expect(LIFECYCLE_STATE_RANK.booting).toBe(0);
    expect(LIFECYCLE_STATE_RANK.running).toBe(1);
    expect(LIFECYCLE_STATE_RANK.draining).toBe(2);
    expect(LIFECYCLE_STATE_RANK.restarting).toBe(3);
    expect(LIFECYCLE_STATE_RANK.shutting_down).toBe(3);
    expect(LIFECYCLE_STATE_RANK.crashed).toBe(4);
  });

  it('terminal exit states share rank (restarting / shutting_down)', () => {
    expect(LIFECYCLE_STATE_RANK.restarting).toBe(LIFECYCLE_STATE_RANK.shutting_down);
  });
});

describe('isLifecycleAcceptingRpc', () => {
  it('accepts only the running state', () => {
    expect(isLifecycleAcceptingRpc('running')).toBe(true);
    expect(isLifecycleAcceptingRpc('booting')).toBe(false);
    expect(isLifecycleAcceptingRpc('draining')).toBe(false);
    expect(isLifecycleAcceptingRpc('restarting')).toBe(false);
    expect(isLifecycleAcceptingRpc('shutting_down')).toBe(false);
    expect(isLifecycleAcceptingRpc('crashed')).toBe(false);
  });

  it('covers every LifecycleState value (exhaustive)', () => {
    const states: LifecycleState[] = [
      'booting', 'running', 'draining',
      'restarting', 'shutting_down', 'crashed',
    ];
    // Exactly one state (running) should accept rpc.
    const accepting = states.filter(isLifecycleAcceptingRpc);
    expect(accepting).toEqual(['running']);
  });
});

describe('computeUptimeSeconds', () => {
  it('returns floor of elapsed seconds', () => {
    expect(computeUptimeSeconds(1_000_000, 1_000_000 + 5500)).toBe(5);
    expect(computeUptimeSeconds(1_000_000, 1_000_000 + 999)).toBe(0);
    expect(computeUptimeSeconds(1_000_000, 1_000_000 + 1000)).toBe(1);
  });

  it('returns 0 when boot_at is 0 / missing / in the future', () => {
    expect(computeUptimeSeconds(0)).toBe(0);
    // @ts-expect-error undefined not assignable to number — guard still holds at runtime
    expect(computeUptimeSeconds(undefined)).toBe(0);
    expect(computeUptimeSeconds(2_000_000, 1_000_000)).toBe(0);
  });

  it('defaults to Date.now when `now` is omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = computeUptimeSeconds(Date.now() - 3000);
    const after = Math.floor(Date.now() / 1000);
    expect(result).toBeGreaterThanOrEqual(3);
    // Sanity: at most ~1s drift between the two reads.
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe('SupervisorMode + ResolvedSupervisorMode', () => {
  it("ResolvedSupervisorMode excludes 'auto'", () => {
    // Compile-time: the resolved type must reject 'auto'.
    // @ts-expect-error 'auto' is not assignable to ResolvedSupervisorMode
    const _bad: ResolvedSupervisorMode = 'auto';
    const ok: ResolvedSupervisorMode = 'native';
    expect(ok).toBe('native');
  });

  it('SupervisorMode accepts all six values', () => {
    const modes: SupervisorMode[] = [
      'auto', 'native', 'systemd', 'launchd', 'docker', 'dev',
    ];
    expect(modes.length).toBe(6);
  });
});

describe('LifecycleStatus shape', () => {
  it('accepts a fully-populated status (draining)', () => {
    const drain: DrainState = {
      active: true,
      started_at: 1_700_000_000_000,
      reason: 'SIGTERM',
      intent: 'shutdown',
      current_step: 'await_inflight',
      completed_steps: ['flip_to_draining', 'stop_accepting_rpc', 'pause_scheduler'],
      aborted_steps: [],
    };
    const status: LifecycleStatus = {
      state: 'draining',
      boot_at: 1_699_999_000_000,
      uptime_s: 1000,
      restart_count: 2,
      restart_pending: false,
      last_crash: {
        at: 1_699_900_000_000,
        reason: 'unhandled promise rejection',
        exit_code: 1,
      },
      drain,
      supervisor_mode: 'systemd',
    };
    expect(status.drain?.current_step).toBe('await_inflight');
    expect(status.last_crash?.exit_code).toBe(1);
  });

  it('accepts a minimal running status (no drain, no crash)', () => {
    const status: LifecycleStatus = {
      state: 'running',
      boot_at: 1_700_000_000_000,
      uptime_s: 30,
      restart_count: 0,
      restart_pending: false,
      supervisor_mode: 'dev',
    };
    expect(status.drain).toBeUndefined();
    expect(status.last_crash).toBeUndefined();
  });
});

describe('Phase C rpc method registry', () => {
  it('registers server.requestShutdown + getLifecycleState + resetCrashLoop', () => {
    expect(SERVER_RPC_METHOD_SET.has('server.requestShutdown')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('server.getLifecycleState')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('server.resetCrashLoop')).toBe(true);
  });

  it('keeps requestRestart in the registry (Phase C rewires; does not rename)', () => {
    expect(SERVER_RPC_METHOD_SET.has('server.requestRestart')).toBe(true);
  });

  it('runtime method list matches the registry (no duplicates)', () => {
    expect(SERVER_RPC_METHODS.length).toBe(SERVER_RPC_METHOD_SET.size);
  });
});

describe('Phase C error codes', () => {
  it('adds DRAINING, NOT_READY, LOCK_HELD, CRASH_LOOP_ACTIVE with expected severities', () => {
    expect(ERR.DRAINING).toBe('warn');
    expect(ERR.NOT_READY).toBe('warn');
    expect(ERR.LOCK_HELD).toBe('fatal');
    expect(ERR.CRASH_LOOP_ACTIVE).toBe('error');
  });
});
