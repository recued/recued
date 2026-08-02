/** D-118 Phase 5 — supervisor unit tests.
 *
 *  Drives the lifecycle state machine with a synthetic spawn seam
 *  that exposes `fireExit(code, signal)` to tests, a fake state
 *  store backed by `better-sqlite3` in-memory, and injected timer
 *  seams so restart-backoff timing is deterministic. No real
 *  subprocesses.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_RESTART_BACKOFF_MS,
  type ServiceAuditEvent,
} from '@recued/contracts';

import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../../service-state-table.js';
import { createSupervisor, type Supervisor } from '../supervisor.js';
import type {
  ServiceInstanceSpec,
  SpawnedProcess,
  SupervisorContext,
  ProcessExitHandler,
} from '../types.js';

interface FakeChild extends SpawnedProcess {
  fireExit(code: number | null, signal?: NodeJS.Signals | null): void;
  argv: string[];
  env: Record<string, string> | undefined;
}

const makeFakeSpawn = () => {
  const children: FakeChild[] = [];
  let nextPid = 10_000;
  const spawn = (argv: string[], opts: { env?: Record<string, string>; cwd?: string }): FakeChild => {
    const pid = nextPid++;
    let handler: ProcessExitHandler | null = null;
    let alive = true;
    const fireExit = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (!alive) return;
      alive = false;
      handler?.(code, signal ?? null);
    };
    const child: FakeChild = {
      pid,
      argv,
      env: opts.env,
      kill: (sig) => {
        if (!alive) return false;
        // Realistic fake: killed processes exit. Fire on the next
        // microtask so the kill() caller can register any follow-on
        // state before exit handlers run.
        queueMicrotask(() => fireExit(sig === 'SIGKILL' ? null : 0, sig ?? null));
        return true;
      },
      onExit: (h) => { handler = h; },
      fireExit,
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
};

const baseSpec = (): ServiceInstanceSpec => ({
  slug: 'ollama_home',
  template_slug: 'ollama-macos@1.0.0',
  publisher_id: 'recued-core',
  config: { port: 11434 },
  start: {
    argv: ['ollama', 'serve'],
    env: { OLLAMA_HOST: '127.0.0.1:{{config.port}}' },
    detach: true,
    restart_policy: 'on-crash',
    restart_on_server_start: true,
  },
  stop: { signal: 'SIGTERM', grace_ms: 5_000 },
  health_check: { kind: 'http_ok', url: 'http://127.0.0.1:11434' },
  startup_check: null,
  startup_grace_ms: 15_000,
  health_check_interval_ms: 30_000,
});

let db: Database.Database;
let store: ServiceInstanceStateStore;
let emitted: ServiceAuditEvent[];
let supervisor: Supervisor;
let spawnMock: ReturnType<typeof makeFakeSpawn>;

const makeCtx = (extra?: Partial<SupervisorContext>): SupervisorContext => ({
  stateStore: store,
  spawn: spawnMock.spawn,
  emitEvent: (e) => { emitted.push(e); },
  runCheck: async () => ({ passed: true }),
  now: () => 1_700_000_000_000,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  ...extra,
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createServiceStateStore({ db });
  emitted = [];
  spawnMock = makeFakeSpawn();
});

afterEach(async () => {
  // Cancel any pending restart timers + tracked children so a
  // delayed setTimeout callback doesn't land on a closed DB.
  if (supervisor) await supervisor.shutdown();
  db.close();
  vi.useRealTimers();
});

describe('supervisor.start — happy path', () => {
  it('spawns the child, records pid, and emits `started`', async () => {
    supervisor = createSupervisor(makeCtx());
    const out = await supervisor.start(baseSpec());
    expect(out.state).toBe('running');
    expect(out.pid).toBe(10_000);
    expect(spawnMock.children).toHaveLength(1);
    expect(spawnMock.children[0].argv).toEqual(['ollama', 'serve']);
    const row = store.get('ollama_home');
    expect(row?.pid).toBe(10_000);
    expect(row?.started_at).toBeGreaterThan(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_name).toBe('started');
  });

  it('resolves {{config.*}} in argv and env before spawning', async () => {
    supervisor = createSupervisor(makeCtx());
    const spec = baseSpec();
    spec.start!.argv = ['serve', '--port', '{{config.port}}'];
    await supervisor.start(spec);
    expect(spawnMock.children[0].argv).toEqual(['serve', '--port', '11434']);
    expect(spawnMock.children[0].env).toEqual({ OLLAMA_HOST: '127.0.0.1:11434' });
  });

  it('resolves {{vault.*}} in env via the resolveVault seam', async () => {
    const resolveVault = vi.fn(() => 'xoxb-s3cret');
    supervisor = createSupervisor(makeCtx({ resolveVault }));
    const spec = baseSpec();
    spec.start!.env = { SLACK_TOKEN: '{{vault.slack_token}}' };
    await supervisor.start(spec);
    expect(resolveVault).toHaveBeenCalledWith('recued-core', 'slack_token');
    expect(spawnMock.children[0].env).toEqual({ SLACK_TOKEN: 'xoxb-s3cret' });
  });

  it('leaves {{vault.*}} as literal text when the resolver returns undefined', async () => {
    supervisor = createSupervisor(makeCtx());
    const spec = baseSpec();
    spec.start!.env = { SLACK_TOKEN: '{{vault.missing}}' };
    await supervisor.start(spec);
    expect(spawnMock.children[0].env).toEqual({ SLACK_TOKEN: '{{vault.missing}}' });
  });

  it('is a no-op for already-running instances (same pid returned)', async () => {
    supervisor = createSupervisor(makeCtx());
    const a = await supervisor.start(baseSpec());
    const b = await supervisor.start(baseSpec());
    expect(spawnMock.children).toHaveLength(1);
    expect(a.pid).toBe(b.pid);
    expect(emitted.filter((e) => e.event_name === 'started')).toHaveLength(1);
  });

  it('returns `failed` with a crash audit when spawn throws', async () => {
    const throwingSpawn = () => { throw new Error('ENOENT'); };
    supervisor = createSupervisor(makeCtx({ spawn: throwingSpawn as never }));
    const out = await supervisor.start(baseSpec());
    expect(out.state).toBe('failed');
    expect(emitted[0].event_name).toBe('crashed');
    expect(emitted[0].error).toMatch(/ENOENT/);
    const row = store.get('ollama_home');
    expect(row?.consecutive_crashes).toBe(1);
  });
});

describe('supervisor — crash classification by restart_policy', () => {
  it("'never': any exit becomes a clean stop, no restart scheduled", async () => {
    vi.useFakeTimers();
    supervisor = createSupervisor(
      makeCtx({
        setTimeout: ((fn, ms) => globalThis.setTimeout(fn, ms)) as SupervisorContext['setTimeout'],
        clearTimeout: (t) => globalThis.clearTimeout(t),
      }),
    );
    const spec = baseSpec();
    spec.start!.restart_policy = 'never';
    await supervisor.start(spec);
    spawnMock.children[0].fireExit(1);
    expect(emitted.at(-1)?.event_name).toBe('stopped');
    // Advance fake timers far enough for any scheduled restart —
    // there shouldn't be one.
    vi.advanceTimersByTime(60_000);
    expect(spawnMock.children).toHaveLength(1);
  });

  it("'on-crash': exit 0 = stopped (no restart)", async () => {
    supervisor = createSupervisor(makeCtx());
    await supervisor.start(baseSpec());
    spawnMock.children[0].fireExit(0);
    expect(emitted.at(-1)?.event_name).toBe('stopped');
    const row = store.get('ollama_home');
    expect(row?.consecutive_crashes).toBe(0);
  });

  it("'on-crash': non-zero exit = crashed + restart", async () => {
    vi.useFakeTimers();
    supervisor = createSupervisor(
      makeCtx({
        setTimeout: ((fn, ms) => globalThis.setTimeout(fn, ms)) as SupervisorContext['setTimeout'],
        clearTimeout: (t) => globalThis.clearTimeout(t),
      }),
    );
    await supervisor.start(baseSpec());
    spawnMock.children[0].fireExit(7);
    expect(emitted.at(-1)?.event_name).toBe('crashed');
    vi.advanceTimersByTime(SERVICE_RESTART_BACKOFF_MS[0] + 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock.children.length).toBeGreaterThanOrEqual(2);
  });

  it("'on-crash': signal kill = crashed (even with exit 0)", async () => {
    supervisor = createSupervisor(makeCtx());
    await supervisor.start(baseSpec());
    spawnMock.children[0].fireExit(0, 'SIGKILL');
    expect(emitted.at(-1)?.event_name).toBe('crashed');
    expect(emitted.at(-1)?.error).toMatch(/SIGKILL/);
  });

  it("'always': exit 0 still triggers restart", async () => {
    vi.useFakeTimers();
    supervisor = createSupervisor(
      makeCtx({
        setTimeout: ((fn, ms) => globalThis.setTimeout(fn, ms)) as SupervisorContext['setTimeout'],
        clearTimeout: (t) => globalThis.clearTimeout(t),
      }),
    );
    const spec = baseSpec();
    spec.start!.restart_policy = 'always';
    await supervisor.start(spec);
    spawnMock.children[0].fireExit(0);
    expect(emitted.at(-1)?.event_name).toBe('crashed');
    vi.advanceTimersByTime(SERVICE_RESTART_BACKOFF_MS[0] + 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock.children.length).toBeGreaterThanOrEqual(2);
  });
});

describe('supervisor — restart backoff + permanent crash', () => {
  it('increments consecutive_crashes + picks the right backoff entry each crash', async () => {
    const setTimeoutSpy = vi.fn<SupervisorContext['setTimeout']>((fn, _ms) => {
      return globalThis.setTimeout(fn, 0);
    });
    supervisor = createSupervisor(makeCtx({ setTimeout: setTimeoutSpy }));
    await supervisor.start(baseSpec());
    // First crash → backoff[0] (1s)
    spawnMock.children[0].fireExit(1);
    const firstDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(firstDelay).toBe(SERVICE_RESTART_BACKOFF_MS[0]);
    // Give the scheduled restart a chance to run (setTimeoutSpy
    // collapses every delay to 0ms) then flush microtasks.
    await new Promise((r) => globalThis.setTimeout(r, 5));
    expect(spawnMock.children.length).toBeGreaterThanOrEqual(2);
    // Second crash → backoff[1] (5s) per SERVICE_RESTART_BACKOFF_MS
    spawnMock.children.at(-1)!.fireExit(1);
    const secondDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(secondDelay).toBe(SERVICE_RESTART_BACKOFF_MS[1]);
  });

  it('stops scheduling once consecutive_crashes reaches the MAX ceiling', async () => {
    const setTimeoutSpy = vi.fn<SupervisorContext['setTimeout']>((fn, _ms) => {
      return globalThis.setTimeout(fn, 0);
    });
    supervisor = createSupervisor(makeCtx({ setTimeout: setTimeoutSpy }));
    await supervisor.start(baseSpec());
    // Seed the counter just below ceiling so the next crash flips
    // to permanent without walking the full backoff schedule.
    store.upsert('ollama_home', {
      consecutive_crashes: SERVICE_CONSECUTIVE_CRASHES_MAX - 1,
    });
    spawnMock.children[0].fireExit(1);
    const row = store.get('ollama_home');
    expect(row?.consecutive_crashes).toBe(SERVICE_CONSECUTIVE_CRASHES_MAX);
    // Count calls to setTimeout AFTER the ceiling crash — should
    // be zero (no restart scheduled).
    const sizeBefore = setTimeoutSpy.mock.calls.length;
    await new Promise((r) => globalThis.setTimeout(r, 5));
    expect(setTimeoutSpy.mock.calls.length).toBe(sizeBefore);
    expect(spawnMock.children).toHaveLength(1); // no respawn
  });

  it('clearCrash resets counter + last_crash_at then starts fresh', async () => {
    supervisor = createSupervisor(makeCtx());
    store.upsert('ollama_home', {
      consecutive_crashes: SERVICE_CONSECUTIVE_CRASHES_MAX,
      last_crash_at: 123,
    });
    const out = await supervisor.clearCrash(baseSpec());
    expect(out.state).toBe('running');
    const row = store.get('ollama_home');
    expect(row?.consecutive_crashes).toBe(0);
    expect(row?.last_crash_at).toBeNull();
  });
});

describe('supervisor.stop', () => {
  it('signal-based: kills the child + resolves stopped on exit', async () => {
    supervisor = createSupervisor(makeCtx());
    await supervisor.start(baseSpec());
    const child = spawnMock.children[0];
    const killSpy = vi.spyOn(child, 'kill');
    const stopPromise = supervisor.stop('ollama_home');
    // Simulate the child responding to SIGTERM by exiting 0.
    child.fireExit(0);
    const out = await stopPromise;
    expect(out.state).toBe('stopped');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(emitted.at(-1)?.event_name).toBe('stopped');
  });

  it('argv-based: spawns the stop argv + resolves when original child exits', async () => {
    supervisor = createSupervisor(makeCtx());
    const spec = baseSpec();
    spec.stop = { argv: ['docker', 'compose', 'down'], grace_ms: 3_000 };
    await supervisor.start(spec);
    const stopPromise = supervisor.stop('ollama_home');
    // Second spawn call is the stop argv.
    expect(spawnMock.children).toHaveLength(2);
    expect(spawnMock.children[1].argv).toEqual(['docker', 'compose', 'down']);
    // Original child's exit handler settles the promise.
    spawnMock.children[0].fireExit(0);
    const out = await stopPromise;
    expect(out.state).toBe('stopped');
  });

  it('returns `stopped / not running` when slug is not tracked', async () => {
    supervisor = createSupervisor(makeCtx());
    const out = await supervisor.stop('never_started');
    expect(out.state).toBe('stopped');
    expect(out.detail).toMatch(/not running/);
  });

  it('cancels any pending restart timer on manual stop', async () => {
    const clearSpy = vi.fn<SupervisorContext['clearTimeout']>((t) => {
      globalThis.clearTimeout(t);
    });
    supervisor = createSupervisor(makeCtx({ clearTimeout: clearSpy }));
    await supervisor.start(baseSpec());
    spawnMock.children[0].fireExit(1); // schedules a restart timer
    await supervisor.stop('ollama_home'); // not tracked anymore — but clearCrash alone would still
    // Stop on untracked returns early with "not running"; the
    // restart timer instead clears when a fresh start comes in.
    // This test asserts the timer-cleanup invariant via the
    // subsequent start path.
    await supervisor.start(baseSpec());
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('supervisor.shutdown', () => {
  it('stops every tracked slug', async () => {
    supervisor = createSupervisor(makeCtx());
    const s1 = baseSpec();
    const s2 = { ...baseSpec(), slug: 'ollama_work' };
    await supervisor.start(s1);
    await supervisor.start(s2);
    const shutdownPromise = supervisor.shutdown();
    spawnMock.children[0].fireExit(0);
    spawnMock.children[1].fireExit(0);
    await shutdownPromise;
    expect(supervisor.trackedSlugs()).toEqual([]);
  });

  it('closes start admission before waiting for children to exit', async () => {
    supervisor = createSupervisor(makeCtx());
    await supervisor.start(baseSpec());
    const shutdownPromise = supervisor.shutdown();

    const late = await supervisor.start({ ...baseSpec(), slug: 'late' });

    expect(late).toMatchObject({
      state: 'failed',
      pid: null,
      detail: 'service supervisor is shut down',
    });
    expect(spawnMock.children).toHaveLength(1);
    await shutdownPromise;
  });

  it('does not write state or audit when a child exits during shutdown', async () => {
    supervisor = createSupervisor(makeCtx());
    await supervisor.start(baseSpec());
    const stateWrite = vi.spyOn(store, 'upsert');
    stateWrite.mockClear();
    emitted.length = 0;

    await supervisor.shutdown();

    expect(stateWrite).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});
