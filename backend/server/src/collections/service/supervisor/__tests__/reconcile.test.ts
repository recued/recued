/** D-118 Phase 5 — reconcile decision-matrix tests. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceAuditEvent } from '@recued/contracts';

import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../../service-state-table.js';
import {
  applyReconcileDecision,
  decideReconcile,
  reconcileAll,
  type ReconcileContext,
  type ReconcileDecision,
} from '../reconcile.js';
import { createSupervisor, type Supervisor } from '../supervisor.js';
import type {
  ServiceInstanceSpec,
  SpawnedProcess,
  SupervisorContext,
  ProcessExitHandler,
} from '../types.js';

const makeFakeSpawn = () => {
  const children: (SpawnedProcess & {
    fireExit: (code: number | null) => void;
  })[] = [];
  let nextPid = 10_000;
  const spawn = (argv: string[]): SpawnedProcess => {
    const pid = nextPid++;
    let handler: ProcessExitHandler | null = null;
    let alive = true;
    const fireExit = (code: number | null): void => {
      if (!alive) return;
      alive = false;
      handler?.(code, null);
    };
    const child = {
      pid,
      argv,
      kill: () => {
        if (!alive) return false;
        // Auto-exit so supervisor.shutdown() in afterEach doesn't
        // hang waiting on a fake child that has no scheduler.
        queueMicrotask(() => fireExit(0));
        return true;
      },
      onExit: (h: ProcessExitHandler) => { handler = h; },
      fireExit,
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
};

let db: Database.Database;
let store: ServiceInstanceStateStore;
let emitted: ServiceAuditEvent[];
let supervisor: Supervisor;
let spawnMock: ReturnType<typeof makeFakeSpawn>;

const baseSpec = (overrides: Partial<ServiceInstanceSpec> = {}): ServiceInstanceSpec => ({
  slug: 'ollama_home',
  template_slug: 'ollama-macos@1.0.0',
  publisher_id: 'recued-core',
  config: { port: 11434 },
  start: {
    argv: ['ollama', 'serve'],
    restart_policy: 'on-crash',
    restart_on_server_start: true,
  },
  stop: { signal: 'SIGTERM', grace_ms: 5_000 },
  health_check: null,
  startup_check: [{ kind: 'http_ok', url: 'http://127.0.0.1:11434/api/tags' }],
  startup_grace_ms: 15_000,
  health_check_interval_ms: 30_000,
  ...overrides,
});

const ctx = (overrides: Partial<ReconcileContext> = {}): ReconcileContext => ({
  runCheck: async () => ({ passed: true }),
  emitEvent: (e) => { emitted.push(e); },
  now: () => 1_700_000_000_000,
  setTimeout: (fn) => globalThis.setTimeout(fn, 0),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  ...overrides,
});

const supCtx = (): SupervisorContext => ({
  stateStore: store,
  spawn: spawnMock.spawn,
  emitEvent: (e) => { emitted.push(e); },
  runCheck: async () => ({ passed: true }),
  now: () => 1_700_000_000_000,
  setTimeout: (fn) => globalThis.setTimeout(fn, 0),
  clearTimeout: (t) => globalThis.clearTimeout(t),
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createServiceStateStore({ db });
  emitted = [];
  spawnMock = makeFakeSpawn();
  supervisor = createSupervisor(supCtx());
});

afterEach(async () => {
  if (supervisor) await supervisor.shutdown();
  db.close();
  vi.useRealTimers();
});

describe('decideReconcile', () => {
  it('returns `skip` when restart_on_server_start is false', async () => {
    const spec = baseSpec();
    spec.start!.restart_on_server_start = false;
    const decision = await decideReconcile(spec, ctx());
    expect(decision.kind).toBe('skip');
  });

  it('returns `skip` when lifecycle.start is null (tool-shaped)', async () => {
    const spec = baseSpec({ start: null });
    const decision = await decideReconcile(spec, ctx());
    expect(decision.kind).toBe('skip');
  });

  it('returns `fresh_start` when startup_check is null', async () => {
    const spec = baseSpec({ startup_check: null });
    const decision = await decideReconcile(spec, ctx());
    expect(decision.kind).toBe('fresh_start');
  });

  it('returns `adopt` when every startup_check passes', async () => {
    const spec = baseSpec({
      startup_check: [
        { kind: 'tcp_open', host: '127.0.0.1', port: 11434 },
        { kind: 'http_ok', url: 'http://127.0.0.1:11434/api/tags' },
      ],
    });
    const decision = await decideReconcile(
      spec,
      ctx({ runCheck: async () => ({ passed: true }) }),
    );
    expect(decision).toEqual({ kind: 'adopt', passed: 2, total: 2 });
  });

  it('returns `fresh_start` when every startup_check fails (none_pass)', async () => {
    const spec = baseSpec({
      startup_check: [
        { kind: 'tcp_open', host: 'h', port: 1 },
        { kind: 'http_ok', url: 'https://no' },
      ],
    });
    const decision = await decideReconcile(
      spec,
      ctx({ runCheck: async () => ({ passed: false }) }),
    );
    expect(decision).toEqual({ kind: 'fresh_start', passed: 0, total: 2 });
  });

  it('partial → waits grace → re-evals → `adopt` when the second pass is all_pass', async () => {
    const spec = baseSpec({
      startup_check: [
        { kind: 'tcp_open', host: 'h', port: 1 },
        { kind: 'http_ok', url: 'https://no' },
      ],
    });
    let pass = 0;
    const decision = await decideReconcile(
      spec,
      ctx({
        runCheck: async (_s, _c) => {
          // First 2 calls (first eval): one pass, one fail → partial.
          // Next 2 calls (second eval): both pass → adopt.
          pass += 1;
          if (pass <= 2) return { passed: pass === 1 };
          return { passed: true };
        },
        setTimeout: (fn) => globalThis.setTimeout(fn, 0),
      }),
    );
    expect(decision.kind).toBe('adopt');
  });

  it('partial → grace → still partial → `cleanup_then_start`', async () => {
    const spec = baseSpec({
      startup_check: [
        { kind: 'tcp_open', host: 'h', port: 1 },
        { kind: 'http_ok', url: 'https://no' },
      ],
    });
    const decision = await decideReconcile(
      spec,
      ctx({
        // Always exactly one passes — partial.
        runCheck: (async (s: unknown) => {
          const sp = s as { kind: string };
          return { passed: sp.kind === 'tcp_open' };
        }) as ReconcileContext['runCheck'],
        setTimeout: (fn) => globalThis.setTimeout(fn, 0),
      }),
    );
    expect(decision.kind).toBe('cleanup_then_start');
  });
});

describe('applyReconcileDecision', () => {
  it('skip: emits an event, does not start', async () => {
    const spec = baseSpec();
    const out = await applyReconcileDecision(
      spec,
      { kind: 'skip', reason: 'x' },
      supervisor,
      ctx(),
    );
    expect(out.started).toBeUndefined();
    expect(spawnMock.children).toHaveLength(0);
  });

  it('adopt: emits an event, does not start (supervisor has no process handle)', async () => {
    const spec = baseSpec();
    const out = await applyReconcileDecision(
      spec,
      { kind: 'adopt', passed: 2, total: 2 },
      supervisor,
      ctx(),
    );
    expect(out.started).toBeUndefined();
    expect(spawnMock.children).toHaveLength(0);
  });

  it('fresh_start: calls supervisor.start', async () => {
    const spec = baseSpec();
    const out = await applyReconcileDecision(
      spec,
      { kind: 'fresh_start', passed: 0, total: 1 },
      supervisor,
      ctx(),
    );
    expect(out.started?.state).toBe('running');
    expect(spawnMock.children).toHaveLength(1);
  });

  it('cleanup_then_start: calls supervisor.start (cleanup argv wiring is Phase 8)', async () => {
    const spec = baseSpec();
    const out = await applyReconcileDecision(
      spec,
      { kind: 'cleanup_then_start', passed: 1, total: 2 },
      supervisor,
      ctx(),
    );
    expect(out.started?.state).toBe('running');
    expect(spawnMock.children).toHaveLength(1);
  });
});

describe('reconcileAll — bounded parallelism', () => {
  it('processes every instance exactly once', async () => {
    const instances = Array.from({ length: 10 }, (_, i) => baseSpec({
      slug: `s${i}`,
      startup_check: null, // → fresh_start
    }));
    const outcomes = await reconcileAll(instances, supervisor, ctx(), 4);
    expect(outcomes).toHaveLength(10);
    expect(spawnMock.children).toHaveLength(10);
  });

  it('never runs more than `concurrency` at the same time', async () => {
    let peak = 0;
    let inFlight = 0;
    const instances = Array.from({ length: 8 }, (_, i) => baseSpec({
      slug: `s${i}`,
      startup_check: [{ kind: 'tcp_open', host: 'h', port: 1 }],
    }));
    const outcomes = await reconcileAll(
      instances,
      supervisor,
      ctx({
        runCheck: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => globalThis.setTimeout(r, 5));
          inFlight -= 1;
          return { passed: true };
        },
      }),
      3,
    );
    expect(outcomes).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('reconcile — audit', () => {
  it('emits a decision event per instance', async () => {
    const instances = [
      baseSpec({ slug: 'a', startup_check: null }),
      baseSpec({ slug: 'b' }),
    ];
    await reconcileAll(instances, supervisor, ctx(), 4);
    const decisionEvents = emitted.filter(
      (e) => e.argv?.[0] === 'reconcile',
    );
    expect(decisionEvents.map((e) => e.argv?.[1])).toEqual(
      expect.arrayContaining(['fresh_start']),
    );
    expect(decisionEvents.length).toBe(2);
  });

  it('skip decisions emit a `stopped` event with the reason in error', async () => {
    const spec = baseSpec();
    spec.start!.restart_on_server_start = false;
    await applyReconcileDecision(
      spec,
      { kind: 'skip', reason: 'restart_on_server_start !== true' } satisfies ReconcileDecision,
      supervisor,
      ctx(),
    );
    const evt = emitted.at(-1);
    expect(evt?.event_name).toBe('stopped');
    expect(evt?.error).toMatch(/restart_on_server_start/);
  });
});
