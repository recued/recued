/** D-118 Phase 7 — `collection.service.*` enroll rpc handlers tests.
 *
 *  Drives the eight handlers with stubbed templates resolver +
 *  installer dispatcher seam + supervisor + state store + audit
 *  emitter so each branch (input validation, caps gating, audit
 *  emission, durable-row round-trip) can be asserted without real
 *  subprocesses or real filesystems. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RpcError,
  type ServiceAuditEvent,
  type ServiceCollectionCaps,
} from '@recued/contracts';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../service-state-table.js';
import {
  handleServiceClearCrash,
  handleServiceDelete,
  handleServiceEnroll,
  handleServiceInstall,
  handleServiceList,
  handleServiceListTemplates,
  handleServiceRestart,
  handleServiceStart,
  handleServiceStop,
  handleServiceUninstall,
  handleServiceUpdate,
  handleServiceUpgrade,
  type ServiceEnrollDeps,
  type ServiceTemplate,
  type ServiceTemplateResolver,
} from '../enroll.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import type { InstallerContext } from '../installers/types.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const fullCaps: ServiceCollectionCaps = {
  install: 'yes',
  upgrade: 'yes',
  uninstall: 'yes',
  start: 'yes',
  stop: 'yes',
  invoke: ['pull'],
  health: 'http_ok',
  restart: 'on-crash',
};

const toolCaps: ServiceCollectionCaps = {
  install: 'yes',
  upgrade: 'no',
  uninstall: 'yes',
  start: 'no',
  stop: 'no',
  invoke: ['convert'],
  health: 'install_check',
  restart: 'never',
};

const ollamaTemplate: ServiceTemplate = {
  template_slug: 'ollama-macos@1',
  binary_version: '1.0.0',
  publisher_id: 'recued-core',
  platform: 'macos',
  variant_group: 'ollama',
  caps: fullCaps,
  install_check: { kind: 'binary_in_path', binary: 'ollama' },
  install_hint: 'brew install ollama',
  install: [{ kind: 'brew', package: 'ollama' }],
  upgrade: [{ kind: 'brew', package: 'ollama' }],
  uninstall: [{ kind: 'brew', package: 'ollama' }],
  health_check: { kind: 'http_ok', url: 'http://127.0.0.1:{{config.port}}' },
  startup_check: null,
  startup_grace_ms: 15_000,
  health_check_interval_ms: 30_000,
  config_schema: {
    port: { type: 'number', default: 11434, public: true },
    token: { type: 'vault_ref', optional: true },
  },
  exposes: {
    endpoint: { template: 'http://127.0.0.1:{{config.port}}' },
  },
  start: {
    argv: ['ollama', 'serve'],
    detach: true,
    restart_policy: 'on-crash',
    restart_on_server_start: true,
  },
  stop: { signal: 'SIGTERM', grace_ms: 5_000 },
  invoke: {
    pull: {
      argv: ['ollama', 'pull', '{{input.model}}'],
      timeout_ms: 60_000,
      input: { model: { type: 'string', required: true } },
      output: { log_lines: 'lines', exit_code: 'number', duration_ms: 'number' },
    },
  },
};

const ffmpegTemplate: ServiceTemplate = {
  template_slug: 'ffmpeg-macos@1',
  binary_version: '1.0.0',
  publisher_id: 'recued-core',
  platform: 'macos',
  variant_group: 'ffmpeg',
  caps: toolCaps,
  install_check: { kind: 'binary_in_path', binary: 'ffmpeg' },
  install_hint: 'brew install ffmpeg',
  install: [{ kind: 'brew', package: 'ffmpeg' }],
  upgrade: null,
  uninstall: [{ kind: 'brew', package: 'ffmpeg' }],
  health_check: { kind: 'install_check' },
  startup_check: null,
  startup_grace_ms: 15_000,
  health_check_interval_ms: 30_000,
  config_schema: {},
  exposes: {},
  start: null,
  stop: null,
  invoke: {
    convert: {
      argv: ['ffmpeg', '-i', '{{input.source}}'],
      timeout_ms: 300_000,
      input: { source: { type: 'file_ref', required: true } },
      output: { log_lines: 'lines', exit_code: 'number', duration_ms: 'number' },
    },
  },
};

const hintOnlyTemplate: ServiceTemplate = {
  ...ollamaTemplate,
  template_slug: 'hint-only@1',
  install: null,
  upgrade: null,
  uninstall: null,
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const makeResolver = (templates: ServiceTemplate[]): ServiceTemplateResolver => {
  const map = new Map(templates.map((t) => [t.template_slug, t]));
  return { get: (slug) => map.get(slug) ?? null };
};

const makeSupervisor = (): Supervisor & {
  startMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
  clearCrashMock: ReturnType<typeof vi.fn>;
} => {
  const startMock = vi.fn(async () => ({
    state: 'running' as const,
    pid: 10_000,
    started_at: 1_700_000_000_000,
  }));
  const stopMock = vi.fn(async () => ({ state: 'stopped' as const }));
  const clearCrashMock = vi.fn(async () => ({
    state: 'running' as const,
    pid: 10_001,
    started_at: 1_700_000_001_000,
  }));
  return {
    start: startMock as unknown as Supervisor['start'],
    stop: stopMock as unknown as Supervisor['stop'],
    clearCrash: clearCrashMock as unknown as Supervisor['clearCrash'],
    isTracked: () => false,
    trackedSlugs: () => [],
    hasPendingRestart: () => false,
    shutdown: async () => {},
    startMock,
    stopMock,
    clearCrashMock,
  };
};

interface Ctx {
  db: Database.Database;
  instances: CollectionInstanceStore;
  state: ServiceInstanceStateStore;
  supervisor: ReturnType<typeof makeSupervisor>;
  audit: ServiceAuditEvent[];
  spawnMock: ReturnType<typeof vi.fn>;
  runCheckMock: ReturnType<typeof vi.fn>;
  deps: ServiceEnrollDeps;
}

const setup = (
  templates: ServiceTemplate[] = [ollamaTemplate, ffmpegTemplate, hintOnlyTemplate],
  opts: { runCheckResult?: { passed: boolean; detail?: string }; spawnExit?: number } = {},
): Ctx => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const state = createServiceStateStore({ db });
  const supervisor = makeSupervisor();
  const audit: ServiceAuditEvent[] = [];
  const spawnMock = vi.fn(async (_argv: string[]) => ({
    exit_code: opts.spawnExit ?? 0,
    log_lines: ['installed ok'],
  }));
  const runCheckMock = vi.fn(async () => opts.runCheckResult ?? { passed: true });
  const installerCtx: InstallerContext = {
    dataPath: '/tmp/recued-test',
    slug: '',
    spawn: spawnMock as unknown as InstallerContext['spawn'],
  };
  const deps: ServiceEnrollDeps = {
    instances,
    state,
    templates: makeResolver(templates),
    supervisor,
    runCheck: runCheckMock as unknown as ServiceEnrollDeps['runCheck'],
    installerCtx,
    emitAudit: (evt) => { audit.push(evt); },
    detectOS: () => 'macos',
    now: () => 1_700_000_000_000,
  };
  return { db, instances, state, supervisor, audit, spawnMock, runCheckMock, deps };
};

const expectRpc = async (
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<RpcError> => {
  try {
    await promise;
    throw new Error(`expected throw with code '${code}'`);
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    const rpc = err as RpcError;
    expect(rpc.code).toBe(code);
    if (status !== undefined) expect(rpc.status).toBe(status);
    return rpc;
  }
};

// ────────────────────────────────────────────────────────────────
// enroll
// ────────────────────────────────────────────────────────────────

describe('handleServiceEnroll', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); });

  it('rejects invalid slugs', async () => {
    for (const bad of ['', 'UPPER', 'has space', '-leading-dash']) {
      await expectRpc(
        handleServiceEnroll(ctx.deps, {
          slug: bad,
          template_slug: 'ollama-macos@1',
          config: {},
        }),
        'bad_request',
        400,
      );
    }
  });

  it('rejects unknown templates', async () => {
    await expectRpc(
      handleServiceEnroll(ctx.deps, {
        slug: 'ollama_home',
        template_slug: 'never-published@1',
        config: {},
      }),
      'SERVICE_TEMPLATE_UNAVAILABLE',
      404,
    );
  });

  it('rejects platform mismatch', async () => {
    const linuxCtx = setup([{ ...ollamaTemplate, platform: 'linux' }]);
    try {
      await expectRpc(
        handleServiceEnroll(linuxCtx.deps, {
          slug: 'ollama_home',
          template_slug: 'ollama-macos@1',
          config: {},
        }),
        'SERVICE_PLATFORM_MISMATCH',
        400,
      );
    } finally {
      linuxCtx.db.close();
    }
  });

  it('writes the row, runs install_check, audits, returns caps', async () => {
    const onEnrolled = vi.fn(async () => {});
    ctx.deps.onEnrolled = onEnrolled;
    const res = await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    expect(res.slug).toBe('ollama_home');
    expect(res.install_check.passed).toBe(true);
    expect(res.install_available).toBe(true);
    expect(res.caps).toEqual(fullCaps);
    expect(ctx.runCheckMock).toHaveBeenCalledWith(
      ollamaTemplate.install_check,
      expect.objectContaining({ port: 11434 }),
    );
    const row = ctx.instances.get('service', 'ollama_home');
    expect(row).not.toBeNull();
    expect(row!.adapter_type).toBe('ollama-macos@1');
    expect(row!.config.port).toBe(11434);
    expect(onEnrolled).toHaveBeenCalledWith('ollama_home');
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].event_name).toBe('enrolled');
    expect(ctx.audit[0].binary).toBe('ollama');
    expect(ctx.audit[0].argv).toBeNull();
  });

  it('drops prototype-sensitive config keys before storing the row', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'safe_config',
      template_slug: 'ollama-macos@1',
      config: {
        port: 11434,
        extra: 'keep',
        ['__proto__']: 'polluted',
        constructor: 'polluted',
        prototype: 'polluted',
      },
    });

    const row = ctx.instances.get('service', 'safe_config');
    expect(row).not.toBeNull();
    expect(row!.config).toEqual({ port: 11434, extra: 'keep' });
    expect(Object.prototype.hasOwnProperty.call(row!.config, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row!.config, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row!.config, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('install_check failure surfaces in the response without blocking enroll', async () => {
    ctx.runCheckMock.mockResolvedValueOnce({ passed: false, detail: 'binary not on $PATH' });
    const res = await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    expect(res.install_check.passed).toBe(false);
    expect(res.install_check.detail).toBe('binary not on $PATH');
    expect(ctx.instances.get('service', 'ollama_home')).not.toBeNull();
  });

  it('install_check throw is caught + reported as failed', async () => {
    ctx.runCheckMock.mockRejectedValueOnce(new Error('checker boom'));
    const res = await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    expect(res.install_check.passed).toBe(false);
    expect(res.install_check.detail).toMatch(/checker boom/);
  });

  it('install_available reflects hint-only templates', async () => {
    const res = await handleServiceEnroll(ctx.deps, {
      slug: 'hint_thing',
      template_slug: 'hint-only@1',
      config: {},
    });
    expect(res.install_available).toBe(false);
  });

  it('refuses duplicate slugs', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'dup',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    await expectRpc(
      handleServiceEnroll(ctx.deps, {
        slug: 'dup',
        template_slug: 'ollama-macos@1',
        config: {},
      }),
      'conflict',
      409,
    );
  });

  it('rejects bad config types from config_schema', async () => {
    await expectRpc(
      handleServiceEnroll(ctx.deps, {
        slug: 'bad_config',
        template_slug: 'ollama-macos@1',
        config: { port: 'not-a-number' },
      }),
      'bad_request',
      400,
    );
  });

  it('seeds defaults from config_schema', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'with_defaults',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    const row = ctx.instances.get('service', 'with_defaults');
    expect(row!.config.port).toBe(11434);
  });
});

// ────────────────────────────────────────────────────────────────
// install / upgrade / uninstall
// ────────────────────────────────────────────────────────────────

describe('handleServiceInstall', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('runs every install step + emits installed audit per step', async () => {
    const res = await handleServiceInstall(ctx.deps, { slug: 'ollama_home' });
    expect(res.exit_code).toBe(0);
    expect(res.log_lines).toContain('installed ok');
    expect(ctx.spawnMock).toHaveBeenCalledTimes(1);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].event_name).toBe('installed');
    expect(ctx.audit[0].argv).toEqual(['brew', 'ollama']);
  });

  it('non-zero installer exit emits install_failed and surfaces in the response', async () => {
    ctx.spawnMock.mockResolvedValueOnce({
      exit_code: 1,
      log_lines: ['brew: package not found'],
    });
    const res = await handleServiceInstall(ctx.deps, { slug: 'ollama_home' });
    expect(res.exit_code).toBe(1);
    expect(res.log_lines).toContain('brew: package not found');
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].event_name).toBe('install_failed');
    expect(ctx.audit[0].error).toMatch(/exit 1/);
  });

  it('SERVICE_INSTALL_UNAVAILABLE for hint-only templates', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'hint_thing',
      template_slug: 'hint-only@1',
      config: {},
    });
    await expectRpc(
      handleServiceInstall(ctx.deps, { slug: 'hint_thing' }),
      'SERVICE_INSTALL_UNAVAILABLE',
      400,
    );
  });

  it('SERVICE_NOT_FOUND for unknown slug', async () => {
    await expectRpc(
      handleServiceInstall(ctx.deps, { slug: 'missing' }),
      'SERVICE_NOT_FOUND',
      404,
    );
  });

  it('dispatcher-level rejection (bad params) throws SERVICE_INSTALL_FAILED', async () => {
    // Stage a fresh enroll that uses an install entry with invalid
    // params — the dispatcher's per-kind validator throws
    // InstallerParamError, which we surface as SERVICE_INSTALL_FAILED
    // distinct from a non-zero installer exit code.
    const badTemplate: ServiceTemplate = {
      ...ollamaTemplate,
      template_slug: 'bad-template@1',
      install: [{ kind: 'brew' }], // missing 'package'
    };
    const localCtx = setup([badTemplate]);
    try {
      await handleServiceEnroll(localCtx.deps, {
        slug: 'bad_install',
        template_slug: 'bad-template@1',
        config: {},
      });
      localCtx.audit.length = 0;
      await expectRpc(
        handleServiceInstall(localCtx.deps, { slug: 'bad_install' }),
        'SERVICE_INSTALL_FAILED',
        500,
      );
      expect(localCtx.audit[0].event_name).toBe('install_failed');
    } finally {
      localCtx.db.close();
    }
  });
});

describe('handleServiceUpgrade', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('runs upgrade steps + emits upgraded audit', async () => {
    const res = await handleServiceUpgrade(ctx.deps, { slug: 'ollama_home' });
    expect(res.exit_code).toBe(0);
    expect(ctx.audit[0].event_name).toBe('upgraded');
  });

  it('non-zero upgrade exit emits upgrade_failed and surfaces in the response', async () => {
    ctx.spawnMock.mockResolvedValueOnce({
      exit_code: 2,
      log_lines: ['upgrade refused'],
    });
    const res = await handleServiceUpgrade(ctx.deps, { slug: 'ollama_home' });
    expect(res.exit_code).toBe(2);
    expect(ctx.audit[0].event_name).toBe('upgrade_failed');
  });

  it('SERVICE_INSTALL_UNAVAILABLE when template declares no upgrade[]', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'ffmpeg_local',
      template_slug: 'ffmpeg-macos@1',
      config: {},
    });
    await expectRpc(
      handleServiceUpgrade(ctx.deps, { slug: 'ffmpeg_local' }),
      'SERVICE_INSTALL_UNAVAILABLE',
      400,
    );
  });
});

describe('handleServiceUninstall', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('default (remove_binary: false) drops the row, audits uninstalled, leaves binary alone', async () => {
    const res = await handleServiceUninstall(ctx.deps, { slug: 'ollama_home' });
    expect(res.exit_code).toBe(0);
    expect(res.log_lines).toEqual([]);
    expect(ctx.spawnMock).not.toHaveBeenCalled();
    expect(ctx.instances.get('service', 'ollama_home')).toBeNull();
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].event_name).toBe('uninstalled');
    expect(ctx.audit[0].argv).toBeNull();
  });

  it('remove_binary: true runs uninstall[] before dropping the row', async () => {
    const res = await handleServiceUninstall(ctx.deps, {
      slug: 'ollama_home',
      remove_binary: true,
    });
    expect(res.exit_code).toBe(0);
    expect(ctx.spawnMock).toHaveBeenCalledTimes(1);
    expect(ctx.instances.get('service', 'ollama_home')).toBeNull();
    expect(ctx.audit[0].event_name).toBe('uninstalled');
    expect(ctx.audit[0].argv).toEqual(['brew', 'ollama']);
  });

  it('calls onDeleting before tearing down', async () => {
    const order: string[] = [];
    ctx.deps.onDeleting = async (slug) => { order.push(`onDeleting:${slug}`); };
    await handleServiceUninstall(ctx.deps, { slug: 'ollama_home' });
    expect(order).toEqual(['onDeleting:ollama_home']);
  });

  it('remove_binary: true on a template without uninstall[] errors', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'hint_thing',
      template_slug: 'hint-only@1',
      config: {},
    });
    await expectRpc(
      handleServiceUninstall(ctx.deps, { slug: 'hint_thing', remove_binary: true }),
      'SERVICE_INSTALL_UNAVAILABLE',
      400,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// update
// ────────────────────────────────────────────────────────────────

describe('handleServiceUpdate', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('merges config_patch and notifies onUpdated', async () => {
    const onUpdated = vi.fn(async () => {});
    ctx.deps.onUpdated = onUpdated;
    const res = await handleServiceUpdate(ctx.deps, {
      slug: 'ollama_home',
      config_patch: { port: 22000 },
    });
    expect(res.caps).toEqual(fullCaps);
    expect(ctx.instances.get('service', 'ollama_home')!.config.port).toBe(22000);
    expect(onUpdated).toHaveBeenCalledWith('ollama_home');
  });

  it('rejects invalid patch types', async () => {
    await expectRpc(
      handleServiceUpdate(ctx.deps, {
        slug: 'ollama_home',
        config_patch: { port: 'not-a-number' },
      }),
      'bad_request',
      400,
    );
  });

  it('SERVICE_NOT_FOUND for unknown slug', async () => {
    await expectRpc(
      handleServiceUpdate(ctx.deps, {
        slug: 'missing',
        config_patch: { port: 12345 },
      }),
      'SERVICE_NOT_FOUND',
      404,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// delete
// ────────────────────────────────────────────────────────────────

describe('handleServiceDelete', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    ctx.state.upsert('ollama_home', { pid: 1234, started_at: 1_700_000_000_000 });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('drops row + state without touching binary by default', async () => {
    const res = await handleServiceDelete(ctx.deps, { slug: 'ollama_home' });
    expect(res).toEqual({ deleted: true });
    expect(ctx.spawnMock).not.toHaveBeenCalled();
    expect(ctx.instances.get('service', 'ollama_home')).toBeNull();
    expect(ctx.state.get('ollama_home')).toBeNull();
    expect(ctx.audit[0].event_name).toBe('uninstalled');
    expect(ctx.audit[0].argv).toBeNull();
  });

  it('uninstall_binary: true also runs uninstall[]', async () => {
    await handleServiceDelete(ctx.deps, { slug: 'ollama_home', uninstall_binary: true });
    expect(ctx.spawnMock).toHaveBeenCalledTimes(1);
    expect(ctx.audit[0].event_name).toBe('uninstalled');
    expect(ctx.audit[0].argv).toEqual(['brew', 'ollama']);
  });
});

// ────────────────────────────────────────────────────────────────
// clear_crash
// ────────────────────────────────────────────────────────────────

describe('handleServiceClearCrash', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434, token: 'my_oauth_token' },
    });
    ctx.state.upsert('ollama_home', {
      last_crash_at: 1_699_999_900_000,
      consecutive_crashes: 5,
    });
    ctx.audit.length = 0;
  });
  afterEach(() => { ctx.db.close(); });

  it('delegates to supervisor.clearCrash and returns a status snapshot', async () => {
    const res = await handleServiceClearCrash(ctx.deps, { slug: 'ollama_home' });
    expect(ctx.supervisor.clearCrashMock).toHaveBeenCalledTimes(1);
    expect(res.exposes.endpoint).toBe('http://127.0.0.1:11434');
    expect(res.config.port).toBe(11434);
    // vault-typed config field never bleeds through even when a key
    // is set (decision #18 — secrets stay in vault).
    expect(res.config.token).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────

describe('handleServiceList', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await handleServiceEnroll(ctx.deps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    await handleServiceEnroll(ctx.deps, {
      slug: 'ffmpeg_local',
      template_slug: 'ffmpeg-macos@1',
      config: {},
    });
  });
  afterEach(() => { ctx.db.close(); });

  it('returns every enrolled instance with its template + state', async () => {
    ctx.state.upsert('ollama_home', { pid: 9, started_at: 1_700_000_000_000 });
    const res = await handleServiceList(ctx.deps);
    expect(res.instances).toHaveLength(2);
    const ollama = res.instances.find((r) => r.slug === 'ollama_home')!;
    expect(ollama.template_slug).toBe('ollama-macos@1');
    expect(ollama.state).toBe('running');
    expect(ollama.caps).toEqual(fullCaps);
    const ffmpeg = res.instances.find((r) => r.slug === 'ffmpeg_local')!;
    expect(ffmpeg.state).toBe('unknown');
    expect(ffmpeg.caps).toEqual(toolCaps);
  });
});

// ────────────────────────────────────────────────────────────────
// listTemplates — D-118 Phase 10 follow-up
// ────────────────────────────────────────────────────────────────

describe('handleServiceListTemplates', () => {
  const mkTemplates = (): ServiceTemplate[] => [
    ollamaTemplate, // macos / ollama
    { ...ollamaTemplate, template_slug: 'ollama-linux@1', platform: 'linux' },
    { ...ollamaTemplate, template_slug: 'ollama-win@1', platform: 'windows' },
    ffmpegTemplate, // macos / ffmpeg
    {
      ...ffmpegTemplate,
      template_slug: 'ffmpeg-linux@1',
      platform: 'linux',
    },
  ];

  const makeListingResolver = (
    templates: ServiceTemplate[],
  ): ServiceTemplateResolver => {
    const map = new Map(templates.map((t) => [t.template_slug, t]));
    return {
      get: (slug) => map.get(slug) ?? null,
      list: () => templates,
    };
  };

  it('returns empty when the resolver stub omits .list()', async () => {
    const ctx = setup();
    try {
      const res = await handleServiceListTemplates(ctx.deps, undefined);
      expect(res.templates).toEqual([]);
      expect(res.applied_platform).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  it('defaults to the detected server OS and filters cross-OS templates out', async () => {
    const ctx = setup(mkTemplates());
    ctx.deps.templates = makeListingResolver(mkTemplates());
    ctx.deps.detectOS = () => 'macos';
    try {
      const res = await handleServiceListTemplates(ctx.deps, {});
      expect(res.applied_platform).toBe('macos');
      expect(res.templates.map((t) => t.template_slug)).toEqual([
        'ffmpeg-macos@1',
        'ollama-macos@1',
      ]);
    } finally {
      ctx.db.close();
    }
  });

  it('platform: null returns every template across every OS', async () => {
    const ctx = setup(mkTemplates());
    ctx.deps.templates = makeListingResolver(mkTemplates());
    ctx.deps.detectOS = () => 'linux';
    try {
      const res = await handleServiceListTemplates(ctx.deps, { platform: null });
      expect(res.applied_platform).toBeNull();
      expect(res.templates).toHaveLength(5);
    } finally {
      ctx.db.close();
    }
  });

  it('variant_group narrows to the requested group only', async () => {
    const ctx = setup(mkTemplates());
    ctx.deps.templates = makeListingResolver(mkTemplates());
    ctx.deps.detectOS = () => 'linux';
    try {
      const res = await handleServiceListTemplates(ctx.deps, {
        platform: null,
        variant_group: 'ollama',
      });
      expect(res.templates.map((t) => t.variant_group)).toEqual([
        'ollama',
        'ollama',
        'ollama',
      ]);
    } finally {
      ctx.db.close();
    }
  });

  it('row payload carries caps + config_schema + install_hint (no second rpc needed)', async () => {
    const ctx = setup(mkTemplates());
    ctx.deps.templates = makeListingResolver(mkTemplates());
    ctx.deps.detectOS = () => 'macos';
    try {
      const res = await handleServiceListTemplates(ctx.deps, {
        variant_group: 'ollama',
      });
      const row = res.templates[0];
      expect(row.slug).toBe('ollama-macos');
      expect(row.template_slug).toBe('ollama-macos@1');
      expect(row.platform).toBe('macos');
      expect(row.variant_group).toBe('ollama');
      expect(row.caps).toEqual(fullCaps);
      expect(row.install_hint).toBe('brew install ollama');
      expect(Object.keys(row.config_schema)).toContain('port');
      expect(row.config_schema.port.type).toBe('number');
      expect(row.config_schema.port.label).toBe('port');
    } finally {
      ctx.db.close();
    }
  });

  it('stable sort: variant_group → platform → template_slug', async () => {
    const ctx = setup(mkTemplates());
    // Shuffle input to prove the handler's sort isn't relying on
    // insertion order.
    ctx.deps.templates = makeListingResolver([
      mkTemplates()[4]!, // ffmpeg-linux
      mkTemplates()[0]!, // ollama-macos
      mkTemplates()[2]!, // ollama-win
      mkTemplates()[3]!, // ffmpeg-macos
      mkTemplates()[1]!, // ollama-linux
    ]);
    ctx.deps.detectOS = () => 'macos';
    try {
      const res = await handleServiceListTemplates(ctx.deps, { platform: null });
      expect(res.templates.map((t) => t.template_slug)).toEqual([
        'ffmpeg-linux@1',
        'ffmpeg-macos@1',
        'ollama-linux@1',
        'ollama-macos@1',
        'ollama-win@1',
      ]);
    } finally {
      ctx.db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// start / stop / restart — D-118 Phase 10 follow-up rpcs
// ────────────────────────────────────────────────────────────────

describe('handleServiceStart', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); });

  it('drives supervisor.start for a service-shape template', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'my-ollama',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    const res = await handleServiceStart(ctx.deps, { slug: 'my-ollama' });
    expect(res.state).toBe('running');
    expect(res.pid).toBe(10_000);
    expect(ctx.supervisor.startMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with SERVICE_OP_NOT_SUPPORTED for tool templates', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'ff',
      template_slug: 'ffmpeg-macos@1',
      config: {},
    });
    await expectRpc(
      handleServiceStart(ctx.deps, { slug: 'ff' }),
      'SERVICE_OP_NOT_SUPPORTED',
      400,
    );
    expect(ctx.supervisor.startMock).not.toHaveBeenCalled();
  });

  it('rejects unknown slugs with bad_request', async () => {
    await expectRpc(
      handleServiceStart(ctx.deps, { slug: '' }),
      'bad_request',
      400,
    );
  });

  it('maps unhealthy supervisor outcome to unhealthy state', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'my-ollama',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    ctx.supervisor.startMock.mockResolvedValueOnce({
      state: 'unhealthy', pid: 10_001, started_at: 1_700_000_000_001,
    });
    const res = await handleServiceStart(ctx.deps, { slug: 'my-ollama' });
    expect(res.state).toBe('unhealthy');
  });
});

describe('handleServiceStop', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); });

  it('drives supervisor.stop for a service-shape template', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'my-ollama',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    const res = await handleServiceStop(ctx.deps, { slug: 'my-ollama' });
    expect(res.state).toBe('stopped');
    expect(ctx.supervisor.stopMock).toHaveBeenCalledWith('my-ollama');
  });

  it('rejects tool templates with SERVICE_OP_NOT_SUPPORTED', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'ff',
      template_slug: 'ffmpeg-macos@1',
      config: {},
    });
    await expectRpc(
      handleServiceStop(ctx.deps, { slug: 'ff' }),
      'SERVICE_OP_NOT_SUPPORTED',
      400,
    );
  });
});

describe('handleServiceRestart', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); });

  it('runs supervisor.stop then supervisor.start in order', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'my-ollama',
      template_slug: 'ollama-macos@1',
      config: {},
    });
    const sequence: string[] = [];
    ctx.supervisor.stopMock.mockImplementationOnce(async () => {
      sequence.push('stop');
      return { state: 'stopped' as const };
    });
    ctx.supervisor.startMock.mockImplementationOnce(async () => {
      sequence.push('start');
      return { state: 'running' as const, pid: 10_002, started_at: 1_700_000_000_002 };
    });
    const res = await handleServiceRestart(ctx.deps, { slug: 'my-ollama' });
    expect(sequence).toEqual(['stop', 'start']);
    expect(res.state).toBe('running');
    expect(res.pid).toBe(10_002);
  });

  it('rejects tool templates with SERVICE_OP_NOT_SUPPORTED', async () => {
    await handleServiceEnroll(ctx.deps, {
      slug: 'ff',
      template_slug: 'ffmpeg-macos@1',
      config: {},
    });
    await expectRpc(
      handleServiceRestart(ctx.deps, { slug: 'ff' }),
      'SERVICE_OP_NOT_SUPPORTED',
      400,
    );
  });
});
