/** D-118 Phase 6 — service dispatcher unit tests.
 *
 *  Drives the six handlers with stubbed supervisor + state store +
 *  bundle resolver + quota tracker + spawn seam so each branch
 *  (caps gating, validation, audit emission, cap-aware output
 *  shaping) can be asserted without real subprocesses.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  type ServiceAuditEvent,
  type ServiceCollectionCaps,
} from '@recued/contracts';

import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../../service-state-table.js';
import {
  createServiceDispatcher,
  ServiceDispatcherError,
} from '../dispatcher.js';
import type { SpawnInvokeFn } from '../types.js';
import type {
  InvokeSpawnResult,
  ServiceBundleResolver,
  ServiceDispatcherDeps,
  ServiceInstanceBundle,
  ServiceLogReader,
} from '../types.js';
import type { Supervisor } from '../../supervisor/supervisor.js';
import type { ServiceQuotaTracker } from '../../quota-tracker.js';

const fullCaps: ServiceCollectionCaps = {
  install: 'yes',
  upgrade: 'yes',
  uninstall: 'yes',
  start: 'yes',
  stop: 'yes',
  invoke: ['pull', 'list_models'],
  health: 'http_ok',
  restart: 'on-crash',
};

const toolCaps: ServiceCollectionCaps = {
  install: 'yes',
  upgrade: 'yes',
  uninstall: 'yes',
  start: 'no',
  stop: 'no',
  invoke: ['convert'],
  health: 'install_check',
  restart: 'never',
};

const baseBundle = (overrides: Partial<ServiceInstanceBundle> = {}): ServiceInstanceBundle => ({
  slug: 'ollama_home',
  template_slug: 'ollama-macos@1.0.0',
  publisher_id: 'recued-core',
  config: { port: 11434 },
  config_schema: {
    port: { type: 'number', public: true },
    token: { type: 'vault_ref' },
  },
  caps: fullCaps,
  health_check: { kind: 'http_ok', url: 'http://127.0.0.1:11434' },
  startup_check: null,
  start: { argv: ['ollama', 'serve'], restart_policy: 'on-crash' },
  stop: { signal: 'SIGTERM', grace_ms: 5_000 },
  invoke: {
    pull: {
      argv: ['ollama', 'pull', '{{input.model}}'],
      timeout_ms: 600_000,
      input: { model: { type: 'string', required: true } },
      output: { log_lines: 'lines', exit_code: 'number', duration_ms: 'number' },
    },
    list_models: {
      argv: ['ollama', 'list'],
      timeout_ms: 10_000,
      input: {},
      output: { log_lines: 'lines', exit_code: 'number' },
    },
  },
  exposes: {
    endpoint: { template: 'http://127.0.0.1:{{config.port}}' },
    api_version: { source: 'health_check.last_response.version' },
  },
  startup_grace_ms: 15_000,
  health_check_interval_ms: SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  ...overrides,
});

const makeResolver = (bundles: ServiceInstanceBundle[]): ServiceBundleResolver => {
  const map = new Map(bundles.map((b) => [b.slug, b]));
  return {
    get: async (slug) => map.get(slug) ?? null,
    list: async () => [...map.values()],
  };
};

const makeSupervisor = (): Supervisor & {
  startMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
} => {
  const startMock = vi.fn(async () => ({
    state: 'running' as const,
    pid: 10_000,
    started_at: 1_700_000_000_000,
  }));
  const stopMock = vi.fn(async () => ({ state: 'stopped' as const }));
  return {
    start: startMock as unknown as Supervisor['start'],
    stop: stopMock as unknown as Supervisor['stop'],
    clearCrash: (async () => ({
      state: 'running' as const,
      pid: 10_001,
      started_at: 1_700_000_001_000,
    })) as unknown as Supervisor['clearCrash'],
    isTracked: () => true,
    trackedSlugs: () => [],
    hasPendingRestart: () => false,
    shutdown: async () => {},
    startMock,
    stopMock,
  };
};

const makeQuotaTracker = (outcome: ReturnType<ServiceQuotaTracker['checkInvokeQuota']> = { ok: true }): ServiceQuotaTracker => ({
  checkInvokeQuota: () => outcome,
  sampleNow: async () => 0,
  startSampler: () => () => {},
});

const makeLogReader = (events: ServiceAuditEvent[]): ServiceLogReader => ({
  listEvents: async () => events,
});

let db: Database.Database;
let store: ServiceInstanceStateStore;
let emitted: ServiceAuditEvent[];

const makeDeps = (overrides: Partial<ServiceDispatcherDeps> = {}): ServiceDispatcherDeps => ({
  supervisor: makeSupervisor(),
  stateStore: store,
  bundleResolver: makeResolver([baseBundle()]),
  quotaTracker: makeQuotaTracker(),
  spawnInvoke: (async () => ({
    exit_code: 0,
    log_lines: ['ok'],
    stdout_truncated: false,
    duration_ms: 42,
    timed_out: false,
  })) as SpawnInvokeFn,
  runCheck: async () => ({ passed: true }),
  logReader: makeLogReader([]),
  emitEvent: (e) => { emitted.push(e); },
  resolveQuotaConfig: () => ({
    quota_bytes: 5 * 1024 ** 3,
    invoke_slack_bytes: 100 * 1024 * 1024,
    min_disk_free_bytes: 1024 ** 3,
  }),
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

describe('service-start', () => {
  it('spawns via supervisor + returns running', async () => {
    const deps = makeDeps();
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.start({ slug: 'ollama_home' });
    expect(out.state).toBe('running');
    expect(out.pid).toBe(10_000);
  });

  it('rejects with OP_NOT_SUPPORTED for tool-shaped templates', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({ caps: toolCaps, start: null, stop: null })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.start({ slug: 'ollama_home' }),
    ).rejects.toMatchObject({
      code: 'SERVICE_OP_NOT_SUPPORTED',
      name: 'ServiceDispatcherError',
    });
  });

  it('rejects with PERMANENTLY_CRASHED when ceiling reached', async () => {
    store.upsert('ollama_home', {
      consecutive_crashes: SERVICE_CONSECUTIVE_CRASHES_MAX,
      last_crash_at: 1_699_999_000_000,
    });
    const deps = makeDeps();
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.start({ slug: 'ollama_home' }),
    ).rejects.toMatchObject({ code: 'SERVICE_PERMANENTLY_CRASHED' });
  });

  it('SERVICE_NOT_FOUND for unknown slug', async () => {
    const deps = makeDeps({ bundleResolver: makeResolver([]) });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.start({ slug: 'nope' }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('wait_until_healthy polls and returns running on first passed health', async () => {
    const runCheck = vi.fn(async () => ({ passed: true }));
    const deps = makeDeps({ runCheck });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.start({
      slug: 'ollama_home',
      wait_until_healthy: { timeout_ms: 5_000 },
    });
    expect(runCheck).toHaveBeenCalled();
    expect(out.state).toBe('running');
  });

  it('wait_until_healthy returns unhealthy on timeout', async () => {
    let t = 1_700_000_000_000;
    const deps = makeDeps({
      runCheck: async () => ({ passed: false }),
      now: () => t,
      setTimeout: (fn, ms) => {
        // Advance our fake clock forward on each scheduled tick so
        // the inline while-loop exits when the deadline passes.
        t += ms;
        return globalThis.setTimeout(fn, 0);
      },
    });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.start({
      slug: 'ollama_home',
      wait_until_healthy: { timeout_ms: 2_000 },
    });
    expect(out.state).toBe('unhealthy');
  });
});

describe('service-stop', () => {
  it('delegates to supervisor.stop + returns stopped', async () => {
    const deps = makeDeps();
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.stop({ slug: 'ollama_home' });
    expect(out.state).toBe('stopped');
  });

  it('rejects OP_NOT_SUPPORTED for tool-shaped templates', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({ caps: toolCaps, start: null, stop: null })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.stop({ slug: 'ollama_home' }),
    ).rejects.toMatchObject({ code: 'SERVICE_OP_NOT_SUPPORTED' });
  });
});

describe('service-status', () => {
  it('returns snapshot with derived state + uptime + exposes + redacted config', async () => {
    store.upsert('ollama_home', {
      pid: 10_000,
      started_at: 1_699_999_990_000,
      last_health_state: 'healthy',
    });
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({
        config: { port: 11434, token: 'secret' },
      })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    const snap = await dispatcher.status({ slug: 'ollama_home' });
    expect(snap.state).toBe('running');
    expect(snap.health).toBe('healthy');
    expect(snap.uptime_s).toBe(10);
    expect(snap.pid).toBe(10_000);
    expect(snap.config).toEqual({ port: 11434 });
    expect(snap.exposes.endpoint).toBe('http://127.0.0.1:11434');
  });

  it('strips vault_ref fields + non-public entries from config', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({
        config: { port: 11434, secret: 'xoxb', extra: 'hidden' },
        config_schema: {
          port: { type: 'number', public: true },
          secret: { type: 'vault_ref' },
          extra: { type: 'string', public: false },
        },
      })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    const snap = await dispatcher.status({ slug: 'ollama_home' });
    expect(snap.config).toEqual({ port: 11434 });
    expect(snap.config).not.toHaveProperty('secret');
    expect(snap.config).not.toHaveProperty('extra');
  });

  it('returns unknown state when no row exists', async () => {
    const deps = makeDeps();
    const dispatcher = createServiceDispatcher(deps);
    const snap = await dispatcher.status({ slug: 'ollama_home' });
    expect(snap.state).toBe('unknown');
    expect(snap.pid).toBeNull();
    expect(snap.uptime_s).toBeNull();
  });

  it('SERVICE_NOT_FOUND for unknown slug', async () => {
    const deps = makeDeps({ bundleResolver: makeResolver([]) });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.status({ slug: 'nope' }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });
});

describe('service-invoke', () => {
  it('validates inputs + spawns + emits invoked audit event', async () => {
    const spawnInvoke = vi.fn<SpawnInvokeFn>(async () => ({
      exit_code: 0,
      log_lines: ['pulled'],
      stdout_truncated: false,
      duration_ms: 1_200,
      timed_out: false,
    }));
    const deps = makeDeps({ spawnInvoke });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });
    expect(out.exit_code).toBe(0);
    expect(out.log_lines).toEqual(['pulled']);
    expect(spawnInvoke.mock.calls[0][0]).toEqual(['ollama', 'pull', 'llama3']);
    const invoked = emitted.find((e) => e.event_name === 'invoked');
    expect(invoked).toBeTruthy();
    expect(invoked?.argv).toEqual(['ollama', 'pull', 'llama3']);
  });

  it('marks invoke with non-zero exit in audit error field', async () => {
    const deps = makeDeps({
      spawnInvoke: (async () => ({
        exit_code: 2,
        log_lines: [],
        stdout_truncated: false,
        duration_ms: 10,
        timed_out: false,
      })) as SpawnInvokeFn,
    });
    const dispatcher = createServiceDispatcher(deps);
    await dispatcher.invoke({ slug: 'ollama_home', op: 'pull', inputs: { model: 'x' } });
    const invoked = emitted.find((e) => e.event_name === 'invoked');
    expect(invoked?.error).toMatch(/exit 2/);
  });

  it('rejects OP_NOT_SUPPORTED when op not in caps.invoke', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({
        caps: { ...fullCaps, invoke: ['list_models'] },
      })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.invoke({ slug: 'ollama_home', op: 'pull', inputs: { model: 'x' } }),
    ).rejects.toMatchObject({ code: 'SERVICE_OP_NOT_SUPPORTED' });
  });

  it('rejects INPUT_INVALID on schema violation', async () => {
    const deps = makeDeps();
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.invoke({ slug: 'ollama_home', op: 'pull', inputs: {} }),
    ).rejects.toMatchObject({ code: 'SERVICE_INPUT_INVALID' });
  });

  it('rejects STORAGE_PRESSURE when quota gate trips', async () => {
    const deps = makeDeps({
      quotaTracker: makeQuotaTracker({
        ok: false,
        tripped: 'instance_quota',
        detail: 'used=5GB, limit=5GB',
      }),
    });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.invoke({ slug: 'ollama_home', op: 'pull', inputs: { model: 'x' } }),
    ).rejects.toMatchObject({ code: 'SERVICE_STORAGE_PRESSURE' });
  });

  it('rejects flag-injection in file_ref input', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({
        caps: { ...fullCaps, invoke: ['convert'] },
        invoke: {
          convert: {
            argv: ['ffmpeg', '-i', '{{input.src}}'],
            timeout_ms: 30_000,
            input: { src: { type: 'file_ref', required: true } },
            output: {},
          },
        },
      })]),
    });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.invoke({ slug: 'ollama_home', op: 'convert', inputs: { src: '--evil' } }),
    ).rejects.toMatchObject({ code: 'SERVICE_INPUT_INVALID' });
  });

  it('surfaces timeout as exit_code -9 with audit error', async () => {
    const deps = makeDeps({
      spawnInvoke: (async () => ({
        exit_code: -9,
        log_lines: [],
        stdout_truncated: false,
        duration_ms: 60_000,
        timed_out: true,
      })) as SpawnInvokeFn,
    });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'x' },
    });
    expect(out.exit_code).toBe(-9);
    const invoked = emitted.find((e) => e.event_name === 'invoked');
    expect(invoked?.error).toMatch(/exit -9/);
  });
});

describe('service-logs', () => {
  it('returns filtered events + clamps limit', async () => {
    const events: ServiceAuditEvent[] = [
      {
        type: 'service_event',
        slug: 'ollama_home',
        binary: 'ollama',
        event_name: 'started',
        argv: ['ollama', 'serve'],
        error: null,
        timestamp: 1_700_000_000_000,
      },
    ];
    const listEvents =
      vi.fn<ServiceLogReader['listEvents']>(async () => events);
    const deps = makeDeps({ logReader: { listEvents } });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.logs({
      slug: 'ollama_home',
      limit: 5_000,
      event_names: ['started'],
    });
    expect(out.events).toEqual(events);
    // clamped to max
    expect(listEvents.mock.calls[0][0].limit).toBe(1_000);
  });

  it('defaults `since` to 24h ago when omitted', async () => {
    const listEvents = vi.fn<ServiceLogReader['listEvents']>(async () => []);
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      logReader: { listEvents },
    });
    const dispatcher = createServiceDispatcher(deps);
    await dispatcher.logs({ slug: 'ollama_home' });
    expect(listEvents.mock.calls[0][0].since).toBe(now - 24 * 60 * 60 * 1000);
  });

  it('SERVICE_NOT_FOUND for unknown slug', async () => {
    const deps = makeDeps({ bundleResolver: makeResolver([]) });
    const dispatcher = createServiceDispatcher(deps);
    await expect(
      dispatcher.logs({ slug: 'nope' }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });
});

describe('service-list', () => {
  it('returns one row per bundle with derived state/health', async () => {
    store.upsert('b', { pid: 42, started_at: 1_699_999_999_000, last_health_state: 'healthy' });
    const deps = makeDeps({
      bundleResolver: makeResolver([
        baseBundle({ slug: 'a' }),
        baseBundle({ slug: 'b' }),
      ]),
    });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.list();
    expect(out.instances).toHaveLength(2);
    const a = out.instances.find((i) => i.slug === 'a')!;
    const b = out.instances.find((i) => i.slug === 'b')!;
    expect(a.state).toBe('unknown');
    expect(b.state).toBe('running');
    expect(b.health).toBe('healthy');
  });

  it('returns empty list when no instances enrolled (not an error)', async () => {
    const deps = makeDeps({ bundleResolver: makeResolver([]) });
    const dispatcher = createServiceDispatcher(deps);
    const out = await dispatcher.list();
    expect(out.instances).toEqual([]);
  });
});

describe('ServiceDispatcherError — typed surface', () => {
  it('name = ServiceDispatcherError, code carries through', async () => {
    const deps = makeDeps({ bundleResolver: makeResolver([]) });
    const dispatcher = createServiceDispatcher(deps);
    try {
      await dispatcher.start({ slug: 'nope' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceDispatcherError);
      expect((err as ServiceDispatcherError).code).toBe('SERVICE_NOT_FOUND');
    }
  });
});

describe('invoke — vault redaction already applied upstream', () => {
  it('audit.argv contains resolved config values but not vault secrets', async () => {
    const deps = makeDeps({
      bundleResolver: makeResolver([baseBundle({
        invoke: {
          pull: {
            argv: ['ollama', '--host', '{{config.host}}', '--model', '{{input.model}}'],
            timeout_ms: 60_000,
            input: { model: { type: 'string', required: true } },
            output: {},
          },
        },
        config: { host: '127.0.0.1:11434' },
      })]),
      resolveVault: (_pub, key) => (key === 'token' ? 'sk-secret' : undefined),
    });
    const dispatcher = createServiceDispatcher(deps);
    await dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });
    const invoked = emitted.find((e) => e.event_name === 'invoked');
    expect(invoked?.argv).toEqual([
      'ollama', '--host', '127.0.0.1:11434', '--model', 'llama3',
    ]);
    // No vault ref was in argv; validated that the audit event
    // carries the resolved value without leaking `{{vault.token}}`
    // or the plaintext secret.
    expect(JSON.stringify(invoked)).not.toContain('sk-secret');
  });
});

describe('service-invoke - D-179 P5 invoke guards', () => {
  const successResult = (duration_ms = 10): InvokeSpawnResult => ({
    exit_code: 0,
    log_lines: ['ok'],
    stdout_truncated: false,
    duration_ms,
    timed_out: false,
  });

  const pendingInvoke = () => {
    let resolve!: (value: InvokeSpawnResult) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<InvokeSpawnResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const flushInvokeStart = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('clamps timeout with limits and preserves authored timeout without limits', async () => {
    const clampedSpawn = vi.fn<SpawnInvokeFn>(async () => successResult());
    const clampedDispatcher = createServiceDispatcher(makeDeps({
      spawnInvoke: clampedSpawn,
      resolveInvokeLimits: () => ({
        invoke_timeout_ceiling_ms: 30_000,
        max_concurrent_invokes: 10,
        max_concurrent_invokes_per_instance: 10,
      }),
    }));

    await clampedDispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });

    expect(clampedSpawn.mock.calls[0]?.[1].timeout_ms).toBe(30_000);

    const authoredSpawn = vi.fn<SpawnInvokeFn>(async () => successResult());
    const authoredDispatcher = createServiceDispatcher(makeDeps({
      spawnInvoke: authoredSpawn,
    }));

    await authoredDispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });

    expect(authoredSpawn.mock.calls[0]?.[1].timeout_ms).toBe(600_000);
  });

  it('rejects a second concurrent invoke on the same slug and releases the instance slot', async () => {
    const firstSpawn = pendingInvoke();
    const spawnInvoke = vi.fn<SpawnInvokeFn>(() => firstSpawn.promise);
    const dispatcher = createServiceDispatcher(makeDeps({
      spawnInvoke,
      resolveInvokeLimits: () => ({
        invoke_timeout_ceiling_ms: 600_000,
        max_concurrent_invokes: 10,
        max_concurrent_invokes_per_instance: 1,
      }),
    }));

    const firstInvoke = dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });
    await flushInvokeStart();
    expect(spawnInvoke).toHaveBeenCalledTimes(1);

    await expect(dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'mistral' },
    })).rejects.toMatchObject({
      code: 'SERVICE_INVOKE_CONCURRENCY',
      name: 'ServiceDispatcherError',
    });
    expect(spawnInvoke).toHaveBeenCalledTimes(1);

    firstSpawn.resolve(successResult());
    await expect(firstInvoke).resolves.toMatchObject({ exit_code: 0 });

    await expect(dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'phi3' },
    })).resolves.toMatchObject({ exit_code: 0 });
    expect(spawnInvoke).toHaveBeenCalledTimes(2);
  });

  it('rejects a second concurrent invoke across different slugs when the global bound is reached', async () => {
    const firstSpawn = pendingInvoke();
    const spawnInvoke = vi.fn<SpawnInvokeFn>(() => firstSpawn.promise);
    const dispatcher = createServiceDispatcher(makeDeps({
      bundleResolver: makeResolver([
        baseBundle({ slug: 'ollama_home' }),
        baseBundle({ slug: 'codex_home' }),
      ]),
      spawnInvoke,
      resolveInvokeLimits: () => ({
        invoke_timeout_ceiling_ms: 600_000,
        max_concurrent_invokes: 1,
        max_concurrent_invokes_per_instance: 10,
      }),
    }));

    const firstInvoke = dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });
    await flushInvokeStart();
    expect(spawnInvoke).toHaveBeenCalledTimes(1);

    await expect(dispatcher.invoke({
      slug: 'codex_home',
      op: 'pull',
      inputs: { model: 'mistral' },
    })).rejects.toMatchObject({
      code: 'SERVICE_INVOKE_CONCURRENCY',
      name: 'ServiceDispatcherError',
    });
    expect(spawnInvoke).toHaveBeenCalledTimes(1);

    firstSpawn.resolve(successResult());
    await expect(firstInvoke).resolves.toMatchObject({ exit_code: 0 });
  });

  it('releases the invoke slot when spawnInvoke rejects', async () => {
    const spawnInvoke = vi.fn<SpawnInvokeFn>()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(successResult());
    const dispatcher = createServiceDispatcher(makeDeps({
      spawnInvoke,
      resolveInvokeLimits: () => ({
        invoke_timeout_ceiling_ms: 600_000,
        max_concurrent_invokes: 1,
        max_concurrent_invokes_per_instance: 1,
      }),
    }));

    await expect(dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    })).rejects.toThrow('spawn failed');

    await expect(dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'mistral' },
    })).resolves.toMatchObject({ exit_code: 0 });
    expect(spawnInvoke).toHaveBeenCalledTimes(2);
  });

  it('leaves invokes unbounded when resolveInvokeLimits is absent', async () => {
    const firstSpawn = pendingInvoke();
    const secondSpawn = pendingInvoke();
    const pendingSpawns = [firstSpawn, secondSpawn];
    let nextSpawn = 0;
    const spawnInvoke = vi.fn<SpawnInvokeFn>(() => pendingSpawns[nextSpawn++].promise);
    const dispatcher = createServiceDispatcher(makeDeps({ spawnInvoke }));

    const firstInvoke = dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'llama3' },
    });
    await flushInvokeStart();

    const secondInvoke = dispatcher.invoke({
      slug: 'ollama_home',
      op: 'pull',
      inputs: { model: 'mistral' },
    });
    await flushInvokeStart();

    expect(spawnInvoke).toHaveBeenCalledTimes(2);

    firstSpawn.resolve(successResult(11));
    secondSpawn.resolve(successResult(12));
    await expect(firstInvoke).resolves.toMatchObject({ duration_ms: 11 });
    await expect(secondInvoke).resolves.toMatchObject({ duration_ms: 12 });
  });
});
