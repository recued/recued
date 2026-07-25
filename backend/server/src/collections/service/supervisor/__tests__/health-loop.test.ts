/** D-118 Phase 5 — health-check polling loop tests. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  type ServiceAuditEvent,
} from '@recued/contracts';

import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../../service-state-table.js';
import {
  createHealthLoop,
  createHealthLoopRegistry,
  type HealthLoopContext,
} from '../health-loop.js';
import type { ServiceInstanceSpec } from '../types.js';

const spec = (overrides: Partial<ServiceInstanceSpec> = {}): ServiceInstanceSpec => ({
  slug: 'ollama_home',
  template_slug: 'ollama-macos@1.0.0',
  publisher_id: 'recued-core',
  config: { port: 11434 },
  start: null,
  stop: null,
  health_check: { kind: 'http_ok', url: 'http://127.0.0.1:11434' },
  startup_check: null,
  startup_grace_ms: 15_000,
  /** Floor-equal interval keeps `advanceTimersByTimeAsync(FLOOR)`
   *  walking exactly one tick at a time. Template-typical intervals
   *  sit at 30 s+ but the loop's interval math clamps to the floor
   *  either way. */
  health_check_interval_ms: SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  ...overrides,
});

let db: Database.Database;
let store: ServiceInstanceStateStore;
let emitted: ServiceAuditEvent[];

const makeCtx = (overrides: Partial<HealthLoopContext> = {}): HealthLoopContext => ({
  stateStore: store,
  runCheck: async () => ({ passed: true }),
  emitEvent: (e) => { emitted.push(e); },
  now: () => 1_700_000_000_000,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createServiceStateStore({ db });
  emitted = [];
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('createHealthLoop — per-tick semantics', () => {
  it('writes last_health_at + last_health_state on each tick', async () => {
    vi.useFakeTimers();
    const loop = createHealthLoop(spec(), makeCtx());
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    const row = store.get('ollama_home');
    expect(row?.last_health_state).toBe('healthy');
    expect(row?.last_health_at).toBe(1_700_000_000_000);
    loop.stop();
  });

  it('does NOT emit a transition event when state stays the same', async () => {
    vi.useFakeTimers();
    // Seed prior state.
    store.upsert('ollama_home', { last_health_state: 'healthy' });
    const loop = createHealthLoop(spec(), makeCtx());
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    expect(emitted.filter((e) => e.event_name === 'health_changed')).toHaveLength(0);
    loop.stop();
  });

  it('emits `health_changed` on unknown → healthy', async () => {
    vi.useFakeTimers();
    const loop = createHealthLoop(spec(), makeCtx());
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    const evt = emitted.find((e) => e.event_name === 'health_changed');
    expect(evt).toBeTruthy();
    expect(evt?.argv).toEqual(['unknown', 'healthy']);
    loop.stop();
  });

  it('emits `health_changed` on healthy → unhealthy with detail', async () => {
    vi.useFakeTimers();
    store.upsert('ollama_home', { last_health_state: 'healthy' });
    const loop = createHealthLoop(
      spec(),
      makeCtx({
        runCheck: async () => ({ passed: false, detail: 'ECONNREFUSED' }),
      }),
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    const evt = emitted.find((e) => e.event_name === 'health_changed');
    expect(evt?.argv).toEqual(['healthy', 'unhealthy']);
    expect(evt?.error).toBe('ECONNREFUSED');
    loop.stop();
  });

  it('resets consecutive_crashes on first healthy tick after a crash', async () => {
    vi.useFakeTimers();
    store.upsert('ollama_home', {
      consecutive_crashes: 3,
      last_health_state: 'unhealthy',
    });
    const loop = createHealthLoop(spec(), makeCtx());
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    expect(store.get('ollama_home')?.consecutive_crashes).toBe(0);
    loop.stop();
  });

  it('tolerates a runCheck throw — marks unhealthy + keeps polling', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const loop = createHealthLoop(
      spec(),
      makeCtx({
        runCheck: async () => {
          calls += 1;
          if (calls === 1) throw new Error('check blew up');
          return { passed: true };
        },
      }),
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    expect(store.get('ollama_home')?.last_health_state).toBe('unhealthy');
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    expect(store.get('ollama_home')?.last_health_state).toBe('healthy');
    loop.stop();
  });
});

describe('createHealthLoop — interval floor + stop', () => {
  it('clamps interval to SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.fn<HealthLoopContext['setTimeout']>((fn, ms) =>
      globalThis.setTimeout(fn, ms),
    );
    const loop = createHealthLoop(
      spec({ health_check_interval_ms: 1_000 }), // below floor
      makeCtx({ setTimeout: setTimeoutSpy }),
    );
    loop.start();
    // First schedule uses the floor, not 1_000.
    const firstDelay = setTimeoutSpy.mock.calls[0][1];
    expect(firstDelay).toBe(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR);
    loop.stop();
  });

  it('stop cancels the pending timer + prevents further ticks', async () => {
    vi.useFakeTimers();
    const loop = createHealthLoop(spec(), makeCtx());
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR * 3);
    expect(emitted).toHaveLength(0);
    expect(store.get('ollama_home')?.last_health_at).toBeUndefined();
  });

  it('start on an already-running loop is idempotent', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.fn<HealthLoopContext['setTimeout']>((fn, ms) =>
      globalThis.setTimeout(fn, ms),
    );
    const loop = createHealthLoop(spec(), makeCtx({ setTimeout: setTimeoutSpy }));
    loop.start();
    loop.start();
    loop.start();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});

describe('createHealthLoopRegistry', () => {
  it('starts a loop per instance + stops them all on stopAll', async () => {
    vi.useFakeTimers();
    const reg = createHealthLoopRegistry(makeCtx());
    reg.add(spec({ slug: 'a' }));
    reg.add(spec({ slug: 'b' }));
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(true);
    reg.stopAll();
    expect(reg.has('a')).toBe(false);
    expect(reg.has('b')).toBe(false);
  });

  it('skips instances whose health_check is null (caps.health === "none")', () => {
    const reg = createHealthLoopRegistry(makeCtx());
    reg.add(spec({ health_check: null }));
    expect(reg.has('ollama_home')).toBe(false);
  });

  it('remove stops one loop without affecting others', async () => {
    vi.useFakeTimers();
    const reg = createHealthLoopRegistry(makeCtx());
    reg.add(spec({ slug: 'a' }));
    reg.add(spec({ slug: 'b' }));
    reg.remove('a');
    expect(reg.has('a')).toBe(false);
    expect(reg.has('b')).toBe(true);
    reg.stopAll();
  });
});
