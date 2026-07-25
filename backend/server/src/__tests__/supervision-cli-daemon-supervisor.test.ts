/** Supervision feature — the cli-daemon supervisor state machine.
 *
 *  Drives `createCliDaemonSupervisor` through its launch / liveness / restart /
 *  adopt / stop / reconcile paths with `vi.useFakeTimers` (the supervisor's
 *  default `now`/`setTimeout` seams use the globals fake timers patch) + an
 *  in-memory `fs` marker map + an executor stub. The daemon's death is simulated
 *  by writing the `.exit.<code>` marker the real executor's `child.once('close')`
 *  would write; pid-liveness + the process-group kill are injected stubs/spies.
 *
 *  Plus `process-group-kill` directly (pid guard, OS branches, never-throws). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import {
  createCliDaemonSupervisor,
  type CliDaemonSupervisor,
  type SupervisorFs,
} from '../supervision/cli-daemon-supervisor.js';
import { killProcessGroup } from '../supervision/process-group-kill.js';
import type { SupervisedDaemonConfig } from '../supervision/supervised-daemon-store.js';
import type { IngredientManifest, ServiceRestartPolicy } from '@recued/contracts';

const DATA = '/data';
const ING = 'cloudflared';
const OP = 'tunnel.run_detached';
const RESULT_DIR = join(DATA, 'daemons', ING, OP);
const EXIT = (code: number): string => join(RESULT_DIR, `daemon.exit.${code}`);
const PID_MARKER = join(RESULT_DIR, 'daemon.pid');

const POLL = 100;
const GRACE = 5_000; // STOP_SIGKILL_GRACE_MS
const CONFIRM_GRACE = 2_000; // DEATH_CONFIRM_GRACE_MS

const manifest = (): IngredientManifest =>
  ({
    slug: ING,
    surfaces: {
      connector: {
        executes: {
          [OP]: {
            kind: 'cli_invocation',
            argv_template: ['cloudflared', 'tunnel', 'run', '{tunnel_name}'],
            exit_code_handling: 'zero_is_success',
            detached: {
              mode: 'runtime_managed',
              completion: { kind: 'marker_file', exit_pattern: '{result_dir}/{key}.exit.{code}' },
              cancel: { kind: 'process_group', pid_pattern: '{result_dir}/{key}.pid' },
              supervision: { restart_policy: 'on-crash', restart_on_server_start: true },
            },
          },
        },
      },
    },
  }) as unknown as IngredientManifest;

const config = (over: Partial<SupervisedDaemonConfig> = {}): SupervisedDaemonConfig => ({
  ingredient_slug: ING,
  op: OP,
  restart_policy: 'on-crash',
  restart_on_server_start: true,
  enabled: true,
  args: { tunnel_name: 'prod' },
  ...over,
});

/** In-memory fs over the marker files (path → content). */
const makeFs = () => {
  const files = new Map<string, string>();
  const api: SupervisorFs = {
    mkdirSync: () => {},
    readdirSync: (p: string) => {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const out: string[] = [];
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes('/')) out.push(rest);
        }
      }
      return out;
    },
    rmSync: (p: string) => { files.delete(p); },
    readFileSync: (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
  };
  return { api, set: (path: string, content = '') => files.set(path, content), files };
};

interface Harness {
  supervisor: CliDaemonSupervisor;
  fs: ReturnType<typeof makeFs>;
  executor: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  setAlive: (v: boolean) => void;
  /** Swap the manifest resolver mid-test — drives the no-resolvable-binding
   *  path (an uninstall between launches). */
  setManifest: (fn: () => IngredientManifest | undefined) => void;
}

const harness = (opts: { aliveDefault?: boolean; pid?: number } = {}): Harness => {
  const fs = makeFs();
  let alive = opts.aliveDefault ?? true;
  let manifestFn: () => IngredientManifest | undefined = () => manifest();
  const executor = vi.fn(async () => ({ mode: 'detached', pid: opts.pid ?? 4242 }));
  const kill = vi.fn();
  const broadcast = vi.fn();
  const audit = vi.fn();
  const supervisor = createCliDaemonSupervisor({
    cliInvocationExecutor: executor as never,
    getManifest: (slug) => (slug === ING ? manifestFn() : undefined),
    dataPath: DATA,
    fs: fs.api,
    isPidAlive: () => alive,
    killProcessGroup: kill,
    pollIntervalMs: POLL,
    broadcast,
    audit,
    log: () => {},
  });
  return {
    supervisor, fs, executor, kill, broadcast, audit,
    setAlive: (v) => { alive = v; },
    setManifest: (fn) => { manifestFn = fn; },
  };
};

describe('cli-daemon-supervisor — launch + liveness + restart', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() launches the detached job and tracks it running', async () => {
    const h = harness();
    const st = await h.supervisor.start(config());
    expect(h.executor).toHaveBeenCalledTimes(1);
    expect(st.state).toBe('running');
    expect(st.pid).toBe(4242);
    expect(h.supervisor.isTracked(ING, OP)).toBe(true);
  });

  it('fans a supervision broadcast on a state transition (launch + crash)', async () => {
    const h = harness();
    await h.supervisor.start(config()); // unknown -> running
    expect(h.broadcast).toHaveBeenCalledWith({ ingredient_slug: ING, op: OP });
    h.broadcast.mockClear();
    h.fs.set(EXIT(1));
    await vi.advanceTimersByTimeAsync(POLL); // running -> crashed (async, no user action)
    expect(h.broadcast).toHaveBeenCalledWith({ ingredient_slug: ING, op: OP });
  });

  it('a crash (non-zero exit marker) restarts after the backoff', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.fs.set(EXIT(1)); // simulate the daemon dying with a crash code
    await vi.advanceTimersByTimeAsync(POLL); // poll detects the marker → handleExit(1)
    expect(h.supervisor.status(ING, OP)!.state).toBe('crashed');
    await vi.advanceTimersByTimeAsync(1_000); // SERVICE_RESTART_BACKOFF_MS[0]
    expect(h.executor).toHaveBeenCalledTimes(2); // relaunched
    expect(h.supervisor.status(ING, OP)!.state).toBe('running');
  });

  it('escalates to permanently_crashed after the consecutive-crash ceiling', async () => {
    const h = harness();
    await h.supervisor.start(config());
    const backoffs = [1_000, 5_000, 30_000, 120_000, 600_000];
    for (let i = 0; i < 5; i += 1) {
      h.fs.set(EXIT(1));
      await vi.advanceTimersByTimeAsync(POLL); // crash detected
      await vi.advanceTimersByTimeAsync(backoffs[i]); // restart window (no-op on the 5th)
    }
    expect(h.supervisor.status(ING, OP)!.state).toBe('permanently_crashed');
    expect(h.executor).toHaveBeenCalledTimes(5); // 1 initial + 4 restarts; the 5th crash does not restart
  });

  it('a clean exit (code 0) under on-crash stops without restarting', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.fs.set(EXIT(0));
    await vi.advanceTimersByTimeAsync(POLL);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.supervisor.status(ING, OP)!.state).toBe('stopped');
    expect(h.executor).toHaveBeenCalledTimes(1); // no restart
  });

  it('a manual daemon (restart_policy never) does not restart on crash', async () => {
    const h = harness();
    await h.supervisor.start(config({ restart_policy: 'never' as ServiceRestartPolicy }));
    h.fs.set(EXIT(1));
    await vi.advanceTimersByTimeAsync(POLL);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.supervisor.status(ING, OP)!.state).toBe('crashed');
    expect(h.executor).toHaveBeenCalledTimes(1);
  });

  it('confirmDeath: a pid death with no marker yet uses the marker code that lands within the grace', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.setAlive(false); // pid gone, but NO exit marker written yet
    await vi.advanceTimersByTimeAsync(POLL); // poll → pid dead, no marker → confirmDeath armed
    h.fs.set(EXIT(0)); // the (clean) marker lands during the confirm grace
    await vi.advanceTimersByTimeAsync(CONFIRM_GRACE);
    // Used the marker's code 0 → stopped (NOT a blind unknown-code crash → restart).
    expect(h.supervisor.status(ING, OP)!.state).toBe('stopped');
    expect(h.executor).toHaveBeenCalledTimes(1);
  });

  it('confirmDeath: a marker-less death (grace expires) is treated as a crash → restart', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.setAlive(false);
    await vi.advanceTimersByTimeAsync(POLL); // confirmDeath armed
    await vi.advanceTimersByTimeAsync(CONFIRM_GRACE + POLL); // no marker → handleExit(null)=crash
    await vi.advanceTimersByTimeAsync(1_000); // backoff
    expect(h.executor).toHaveBeenCalledTimes(2); // restarted
  });
});

describe('cli-daemon-supervisor — stop + reconcile + dispose', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stop() SIGTERMs then escalates to SIGKILL, awaiting actual death', async () => {
    const h = harness();
    await h.supervisor.start(config());
    const stopped = h.supervisor.stop(ING, OP); // do not await yet
    expect(h.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(GRACE); // grace elapses, still alive → SIGKILL
    expect(h.kill).toHaveBeenCalledWith(4242, 'SIGKILL');
    h.setAlive(false); // the kill worked
    await vi.advanceTimersByTimeAsync(300); // next poll observes death → resolves
    const st = await stopped;
    expect(st.state).toBe('stopped');
    expect(st.pid).toBeNull();
  });

  it('startAll adopts a surviving daemon (alive pid + no marker) without relaunching', async () => {
    const h = harness();
    h.fs.set(PID_MARKER, '9999'); // a prior-lifetime survivor
    await h.supervisor.startAll([config()]); // alive (default) + no exit marker → adopt
    expect(h.executor).not.toHaveBeenCalled();
    const st = h.supervisor.status(ING, OP)!;
    expect(st.state).toBe('running');
    expect(st.pid).toBe(9999);
  });

  it('startAll fresh-starts a dead daemon when restart_on_server_start', async () => {
    const h = harness({ aliveDefault: false });
    h.fs.set(EXIT(1)); // prior lifetime died
    await h.supervisor.startAll([config()]);
    expect(h.executor).toHaveBeenCalledTimes(1);
    expect(h.supervisor.status(ING, OP)!.state).toBe('running');
  });

  it('startAll skips a disabled daemon entirely', async () => {
    const h = harness();
    await h.supervisor.startAll([config({ enabled: false })]);
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.supervisor.isTracked(ING, OP)).toBe(false);
  });

  it('disposeAll leaves the daemon running (no kill) and cancels the poll', async () => {
    const h = harness();
    await h.supervisor.start(config());
    await h.supervisor.disposeAll();
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.supervisor.isTracked(ING, OP)).toBe(false);
    // A crash marker after dispose must not trigger a relaunch (poll cancelled).
    h.fs.set(EXIT(1));
    await vi.advanceTimersByTimeAsync(POLL + 1_000);
    expect(h.executor).toHaveBeenCalledTimes(1);
  });
});

describe('process-group-kill', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('no-ops on a pid <= 1 (never self- or init-kills)', () => {
    const spy = vi.spyOn(process, 'kill').mockReturnValue(true);
    for (const pid of [0, 1, -3]) killProcessGroup(pid, 'SIGTERM', 'linux');
    expect(spy).not.toHaveBeenCalled();
  });

  it('POSIX signals the process group (negative pid)', () => {
    const spy = vi.spyOn(process, 'kill').mockReturnValue(true);
    killProcessGroup(4242, 'SIGTERM', 'linux');
    expect(spy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('POSIX falls back to the bare pid when the group is gone, never throws', () => {
    let first = true;
    const spy = vi.spyOn(process, 'kill').mockImplementation(((): boolean => {
      if (first) { first = false; throw new Error('ESRCH'); }
      return true;
    }) as never);
    expect(() => killProcessGroup(4242, 'SIGKILL', 'linux')).not.toThrow();
    expect(spy).toHaveBeenNthCalledWith(1, -4242, 'SIGKILL');
    expect(spy).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
  });

  it('Windows uses taskkill (not process.kill) and never throws', () => {
    const spy = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(() => killProcessGroup(4242, 'SIGTERM', 'win32')).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('cli-daemon-supervisor — audit seam (D-120 daemon lifecycle)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits started on launch, carrying the running pid', async () => {
    const h = harness();
    await h.supervisor.start(config()); // unknown -> running
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      ingredient_slug: ING, op: OP, state: 'running', pid: 4242, last_exit_code: null,
    }));
  });

  it('emits crashed (with the exit code) then started across a crash + restart', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.audit.mockClear();
    h.fs.set(EXIT(1));
    await vi.advanceTimersByTimeAsync(POLL); // running -> crashed
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      state: 'crashed', pid: null, last_exit_code: 1, consecutive_crashes: 1,
    }));
    h.audit.mockClear();
    await vi.advanceTimersByTimeAsync(1_000); // backoff -> relaunch
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', pid: 4242 }));
  });

  it('emits stopped on an explicit stop()', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.audit.mockClear();
    h.setAlive(false); // the SIGTERM lands — awaitPidDeath sees the pid gone
    await h.supervisor.stop(ING, OP);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped', pid: null }));
  });

  it('emits permanently_crashed at the consecutive-crash ceiling', async () => {
    const h = harness();
    await h.supervisor.start(config());
    h.audit.mockClear();
    const backoffs = [1_000, 5_000, 30_000, 120_000, 600_000];
    for (let i = 0; i < 5; i += 1) {
      h.fs.set(EXIT(1));
      await vi.advanceTimersByTimeAsync(POLL);
      await vi.advanceTimersByTimeAsync(backoffs[i]);
    }
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      state: 'permanently_crashed', consecutive_crashes: 5,
    }));
  });

  it('suppresses the boot unknown -> stopped reconciliation row, but still broadcasts', async () => {
    const h = harness();
    // enabled, dead (no survivor pid / no exit marker), NOT boot-persistent.
    await h.supervisor.startAll([config({ restart_on_server_start: false })]);
    expect(h.supervisor.status(ING, OP)!.state).toBe('stopped');
    // The daemon never ran this boot — a durable 'stopped' row would be a false
    // reserve-class breadcrumb, so the audit is suppressed...
    expect(h.audit).not.toHaveBeenCalled();
    // ...while the live broadcast still fires so clients render the initial state.
    expect(h.broadcast).toHaveBeenCalledWith({ ingredient_slug: ING, op: OP });
  });

  it('audits the boot adopt of a surviving daemon as started', async () => {
    const h = harness();
    h.fs.set(PID_MARKER, '9'); // survivor pid, alive (default), no exit marker
    await h.supervisor.startAll([config()]);
    expect(h.supervisor.status(ING, OP)!.state).toBe('running');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', pid: 9 }));
  });

  it('a no-resolvable-binding (re)launch audits crashed with a null exit code, not the prior crash code', async () => {
    const h = harness();
    await h.supervisor.start(config());      // running
    h.fs.set(EXIT(7));
    await vi.advanceTimersByTimeAsync(POLL); // running -> crashed, last_exit_code = 7
    await h.supervisor.stop(ING, OP);        // -> stopped (last_exit_code stays 7)
    expect(h.supervisor.status(ING, OP)!.last_exit_code).toBe(7);
    h.audit.mockClear();
    h.setManifest(() => undefined);          // the binding disappears (uninstall)
    await h.supervisor.start(config());       // launch -> no binding -> crashed
    expect(h.supervisor.status(ING, OP)!.state).toBe('crashed');
    // The fix stamps the runtime fields: the row is honest (it never ran) rather
    // than carrying the stale exit code 7 from the prior lifetime.
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      state: 'crashed', pid: null, last_exit_code: null,
    }));
  });

  it('never throws out of setState when the audit seam throws', async () => {
    const h = harness();
    h.audit.mockImplementation(() => { throw new Error('audit boom'); });
    await expect(h.supervisor.start(config())).resolves.toBeDefined();
    expect(h.supervisor.status(ING, OP)!.state).toBe('running'); // state machine intact
  });
});
