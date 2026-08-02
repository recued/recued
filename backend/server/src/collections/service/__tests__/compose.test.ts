/** D-118 Phase 8 — service composition tests.
 *
 *  Drives `composeServiceStack` with a stub manifest registry +
 *  in-memory SQLite + no-audit fallback so each integration point
 *  (template parsing, kernel-dispatcher routing, enroll → supervisor
 *  hooks, healthSnapshot, startAll/disposeAll) can be asserted
 *  end-to-end without subprocess IO.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';

import {
  composeServiceStack,
  type ServiceStack,
  type ServiceStackRuntimeConfig,
} from '../compose.js';
import {
  buildServiceTemplateResolver,
  parseServiceTemplate,
} from '../template-loader.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const ollamaManifest = {
  slug: 'ollama-macos',
  kind: 'service',
  author: 'recued-core',
  version: 1,
  category: 'data',
  risk_tier: 'write',
  name: 'Ollama (macOS)',
  description: 'local LLM runtime',
  input: {
    service: {
      platform: 'macos',
      binary_version: '1.0.0',
      variant_group: 'ollama',
      install_check: { kind: 'binary_in_path', binary: 'ollama' },
      install_hint: 'brew install ollama',
      install: [{ kind: 'brew', package: 'ollama' }],
      upgrade: [{ kind: 'brew', package: 'ollama' }],
      uninstall: [{ kind: 'brew', package: 'ollama' }],
      health_check: { kind: 'http_ok', url: 'http://127.0.0.1:11434' },
      startup_check: null,
      startup_grace_ms: 15_000,
      config_schema: {
        port: { type: 'number', default: 11434, public: true },
      },
      exposes: {
        endpoint: { template: 'http://127.0.0.1:{{config.port}}' },
      },
      lifecycle: {
        start: {
          argv: ['ollama', 'serve'],
          env: { OLLAMA_HOST: '127.0.0.1' },
          detach: true,
          restart_policy: 'on-crash',
          restart_on_server_start: false,
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
      },
    },
  },
  output: {},
};

const ffmpegManifest = {
  slug: 'ffmpeg-macos',
  kind: 'service',
  author: 'recued-core',
  version: 1,
  category: 'data',
  risk_tier: 'write',
  name: 'FFmpeg (macOS)',
  description: 'video tool',
  input: {
    service: {
      platform: 'macos',
      binary_version: '1.0.0',
      variant_group: 'ffmpeg',
      install_check: { kind: 'binary_in_path', binary: 'ffmpeg' },
      install_hint: 'brew install ffmpeg',
      install: [{ kind: 'brew', package: 'ffmpeg' }],
      uninstall: [{ kind: 'brew', package: 'ffmpeg' }],
      health_check: { kind: 'install_check' },
      startup_check: null,
      startup_grace_ms: 15_000,
      config_schema: {},
      exposes: {},
      lifecycle: {
        start: null,
        stop: null,
        invoke: {
          convert: {
            argv: ['ffmpeg', '-i', '{{input.source}}'],
            timeout_ms: 300_000,
            input: { source: { type: 'file_ref', required: true } },
            output: { log_lines: 'lines', exit_code: 'number' },
          },
        },
      },
    },
  },
  output: {},
};

const nonServiceManifest = {
  slug: 'plain-http-thing',
  category: 'data',
  risk_tier: 'read',
  author: 'recued-core',
  name: 'Plain HTTP',
  description: 'not a service template',
  input: { url: null },
  output: {},
};

const mkManifestRegistry = (manifests: unknown[]) => {
  const map = new Map<string, IngredientManifest>(
    manifests.map((m) => {
      const x = m as { slug: string };
      return [x.slug, m as IngredientManifest];
    }),
  );
  return {
    slugs: () => [...map.keys()],
    get: (slug: string) => map.get(slug) ?? null,
  };
};

const baseRuntime: ServiceStackRuntimeConfig = {
  defaultQuotaBytes: 5 * 1024 * 1024 * 1024,
  minDiskFreeBytes: 1 * 1024 * 1024 * 1024,
  invokeSlackBytes: 100 * 1024 * 1024,
  duSampleIntervalS: 30,
  invokeTimeoutCeilingMs: 600_000,
  maxConcurrentInvokes: 16,
  maxConcurrentInvokesPerInstance: 4,
};

interface Ctx {
  db: Database.Database;
  stack: ServiceStack;
  audit: Array<{ action: string; target: string; detail?: string }>;
}

const setup = (
  manifests = [ollamaManifest, ffmpegManifest, nonServiceManifest],
): Ctx => {
  const db = new Database(':memory:');
  const audit: Ctx['audit'] = [];
  const stack = composeServiceStack(db, {
    dataPath: '/tmp/recued-test',
    manifests: mkManifestRegistry(manifests),
    runtime: baseRuntime,
    auditLog: {
      logActivity: async (entry: ActivityEntry) => {
        audit.push({ action: entry.action, target: entry.target, detail: entry.detail });
      },
      listActivities: async () => audit.map((a) => ({
        activity_id: 'a',
        timestamp: 1,
        action: a.action as never,
        target: a.target,
        detail: a.detail,
      })),
    } as never,
  });
  return { db, stack, audit };
};

// ────────────────────────────────────────────────────────────────
// Template loader
// ────────────────────────────────────────────────────────────────

describe('parseServiceTemplate', () => {
  it('parses a service-shaped manifest into a ServiceTemplate', () => {
    const tpl = parseServiceTemplate(ollamaManifest);
    expect(tpl).not.toBeNull();
    expect(tpl!.platform).toBe('macos');
    expect(tpl!.variant_group).toBe('ollama');
    expect(tpl!.publisher_id).toBe('recued-core');
    expect(tpl!.template_slug).toBe('ollama-macos@1');
    expect(tpl!.binary_version).toBe('1.0.0');
    expect(tpl!.caps.install).toBe('yes');
    expect(tpl!.caps.upgrade).toBe('yes');
    expect(tpl!.caps.start).toBe('yes');
    expect(tpl!.caps.stop).toBe('yes');
    expect(tpl!.caps.invoke).toEqual(['pull']);
    expect(tpl!.caps.health).toBe('http_ok');
    expect(tpl!.caps.restart).toBe('on-crash');
  });

  it('derives tool-shaped caps from a null lifecycle.start', () => {
    const tpl = parseServiceTemplate(ffmpegManifest)!;
    expect(tpl.caps.start).toBe('no');
    expect(tpl.caps.stop).toBe('no');
    expect(tpl.caps.upgrade).toBe('no'); // no upgrade[]
    expect(tpl.caps.health).toBe('install_check');
  });

  it('returns null for non-service manifests', () => {
    expect(parseServiceTemplate(nonServiceManifest)).toBeNull();
    expect(parseServiceTemplate(null)).toBeNull();
    expect(parseServiceTemplate({ kind: 'service' })).toBeNull(); // missing input.service
  });

  it('install_hint without install[] yields hint_only cap', () => {
    const tpl = parseServiceTemplate({
      ...ollamaManifest,
      input: {
        service: {
          ...ollamaManifest.input.service,
          install: null,
        },
      },
    })!;
    expect(tpl.caps.install).toBe('hint_only');
  });

  it('drops prototype-sensitive keys from service maps', () => {
    const tpl = parseServiceTemplate({
      ...ollamaManifest,
      input: {
        service: {
          ...ollamaManifest.input.service,
          config_schema: {
            safe: { type: 'string', default: 'ok', public: true },
            ['__proto__']: { type: 'string', default: 'polluted', public: true },
            constructor: { type: 'string', default: 'polluted', public: true },
            prototype: { type: 'string', default: 'polluted', public: true },
          },
          exposes: {
            endpoint: { template: 'http://127.0.0.1/{{config.safe}}' },
            ['__proto__']: { template: 'polluted' },
            constructor: { template: 'polluted' },
            prototype: { template: 'polluted' },
          },
          lifecycle: {
            ...ollamaManifest.input.service.lifecycle,
            start: {
              argv: ['ollama', 'serve'],
              env: {
                SAFE: 'ok',
                ['__proto__']: 'polluted',
                constructor: 'polluted',
                prototype: 'polluted',
              },
            },
            invoke: {
              run: {
                argv: ['tool', '{{input.safe}}'],
                env: {
                  SAFE: '{{input.safe}}',
                  ['__proto__']: 'polluted',
                  constructor: 'polluted',
                  prototype: 'polluted',
                },
                input: {
                  safe: { type: 'string', required: true },
                  ['__proto__']: { type: 'string', required: true },
                  constructor: { type: 'string', required: true },
                  prototype: { type: 'string', required: true },
                },
                output: {
                  safe: 'value',
                  ['__proto__']: 'polluted',
                  constructor: 'polluted',
                  prototype: 'polluted',
                },
              },
              ['__proto__']: { argv: ['polluted'] },
              constructor: { argv: ['polluted'] },
              prototype: { argv: ['polluted'] },
            },
          },
        },
      },
    });

    expect(tpl).not.toBeNull();
    expect(Object.keys(tpl!.config_schema)).toEqual(['safe']);
    expect(Object.keys(tpl!.exposes)).toEqual(['endpoint']);
    expect(tpl!.start!.env).toEqual({ SAFE: 'ok' });
    expect(Object.keys(tpl!.invoke)).toEqual(['run']);
    expect(tpl!.caps.invoke).toEqual(['run']);
    expect(Object.keys(tpl!.invoke.run.input)).toEqual(['safe']);
    expect(tpl!.invoke.run.env).toEqual({ SAFE: '{{input.safe}}' });
    expect(tpl!.invoke.run.output).toEqual({ safe: 'value' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('buildServiceTemplateResolver', () => {
  it('strips @<version> pin and returns the cached template', () => {
    const reg = buildServiceTemplateResolver(
      mkManifestRegistry([ollamaManifest, nonServiceManifest]),
    );
    const tpl = reg.get('ollama-macos@2.0.0');
    expect(tpl).not.toBeNull();
    // Echoes the requested pin verbatim.
    expect(tpl!.template_slug).toBe('ollama-macos@2.0.0');
  });

  it('returns null for unknown templates', () => {
    const reg = buildServiceTemplateResolver(mkManifestRegistry([ollamaManifest]));
    expect(reg.get('never-published@1')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Compose
// ────────────────────────────────────────────────────────────────

describe('composeServiceStack', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(async () => {
    await ctx.stack.disposeAll();
    ctx.db.close();
  });

  it('healthSnapshot returns one row per enrolled instance', async () => {
    ctx.stack.instances.upsert({
      platform: 'service',
      slug: 'ollama_home',
      adapter_type: 'ollama-macos@1',
      config: { port: 11434 },
      caps: ctx.stack.templates.get('ollama-macos@1')!.caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const rows = ctx.stack.healthSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe('service');
    expect(rows[0].slug).toBe('ollama_home');
    expect(rows[0].state).toBe('disconnected'); // 'unknown' service_state → disconnected
    expect(rows[0].service_state).toBe('unknown');
    expect(rows[0].pid).toBeNull();
  });

  it('healthSnapshot maps running state → connected with pid + uptime', async () => {
    ctx.stack.instances.upsert({
      platform: 'service',
      slug: 'ollama_home',
      adapter_type: 'ollama-macos@1',
      config: { port: 11434 },
      caps: ctx.stack.templates.get('ollama-macos@1')!.caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    ctx.stack.state.upsert('ollama_home', { pid: 9999, started_at: Date.now() - 60_000 });
    const rows = ctx.stack.healthSnapshot();
    expect(rows[0].state).toBe('connected');
    expect(rows[0].service_state).toBe('running');
    expect(rows[0].pid).toBe(9999);
    expect(rows[0].uptime_s).toBeGreaterThanOrEqual(60);
  });

  it('healthSnapshot maps crashed state → error', async () => {
    ctx.stack.instances.upsert({
      platform: 'service',
      slug: 'ollama_home',
      adapter_type: 'ollama-macos@1',
      config: {},
      caps: ctx.stack.templates.get('ollama-macos@1')!.caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    ctx.stack.state.upsert('ollama_home', {
      last_crash_at: Date.now(),
      consecutive_crashes: 5,
    });
    const rows = ctx.stack.healthSnapshot();
    expect(rows[0].state).toBe('error');
    expect(rows[0].service_state).toBe('permanently_crashed');
  });

  it('audit emitter writes service_event entries on enrollDeps callbacks', async () => {
    // Manually fire a service_event through the emitter wired into the stack
    // by using the enroll handler — `enrolled` is the simplest path.
    const { handleServiceEnroll } = await import('../enroll.js');
    await handleServiceEnroll(ctx.stack.enrollDeps, {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1',
      config: { port: 11434 },
    });
    // logActivity is fire-and-forget — flush the microtask queue so the
    // promise body runs before we assert.
    await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].action).toBe('service_event');
    expect(ctx.audit[0].target).toBe('ollama_home');
    const detail = JSON.parse(ctx.audit[0].detail!);
    expect(detail.event_name).toBe('enrolled');
    expect(detail.binary).toBe('ollama');
  });

  it('startAll() wipes runtime state then rehydrates supervised rows', async () => {
    // Seed a stale state row from a prior process lifetime.
    ctx.stack.state.upsert('ghost', { pid: 12_345, started_at: 1 });
    expect(ctx.stack.state.get('ghost')).not.toBeNull();
    await ctx.stack.startAll();
    expect(ctx.stack.state.get('ghost')).toBeNull();
  });

  it('disposeAll() is idempotent', async () => {
    await ctx.stack.disposeAll();
    await ctx.stack.disposeAll();
    // No throws — passing the test reaches here.
    expect(true).toBe(true);
  });

  it('disposeAll closes audit admission and drains admitted writes', async () => {
    const db = new Database(':memory:');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const logActivity = vi.fn(() => held);
    const stack = composeServiceStack(db, {
      dataPath: '/tmp/recued-test',
      manifests: mkManifestRegistry([ollamaManifest]),
      runtime: baseRuntime,
      auditLog: { logActivity } as never,
    });
    const event = {
      type: 'service_event' as const,
      slug: 'ollama_home',
      binary: 'ollama',
      event_name: 'started' as const,
      argv: ['ollama', 'serve'],
      error: null,
      timestamp: 1,
    };
    stack.enrollDeps.emitAudit(event);

    let disposed = false;
    const disposing = stack.disposeAll().then(() => { disposed = true; });
    stack.enrollDeps.emitAudit({ ...event, event_name: 'stopped' });
    await Promise.resolve();

    expect(disposed).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1);

    release();
    await disposing;
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Audit log reader
// ────────────────────────────────────────────────────────────────

describe('serviceLogs reader', () => {
  it('filters audit rows by target slug + event_names + since', async () => {
    const db = new Database(':memory:');
    // Stub AuditLogStore — listActivities returns the seed rows
    // directly so the compose reader's filter logic is the only
    // thing under test.
    const seed = [
      {
        activity_id: '1',
        timestamp: 100,
        action: 'service_event' as const,
        target: 'ollama_home',
        detail: JSON.stringify({
          binary: 'ollama',
          event_name: 'started',
          argv: ['ollama', 'serve'],
          error: null,
        }),
      },
      {
        activity_id: '2',
        timestamp: 200,
        action: 'service_event' as const,
        target: 'ollama_home',
        detail: JSON.stringify({
          binary: 'ollama',
          event_name: 'crashed',
          argv: ['ollama', 'serve'],
          error: 'exit -9',
        }),
      },
      {
        activity_id: '3',
        timestamp: 300,
        action: 'service_event' as const,
        target: 'other_slug',
        detail: JSON.stringify({
          binary: 'other',
          event_name: 'started',
          argv: null,
          error: null,
        }),
      },
    ];
    const stack = composeServiceStack(db, {
      dataPath: '/tmp/recued-test',
      manifests: mkManifestRegistry([ollamaManifest]),
      runtime: baseRuntime,
      auditLog: {
        logActivity: async () => {},
        listActivities: async () => seed,
      } as never,
    });
    stack.instances.upsert({
      platform: 'service',
      slug: 'ollama_home',
      adapter_type: 'ollama-macos@1',
      config: {},
      caps: stack.templates.get('ollama-macos@1')!.caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    // since=0 disables the default 24h window so the seed rows
    // (timestamps 100 / 200 / 300) flow through.
    const all = await stack.dispatcher.logs({ slug: 'ollama_home', since: 0, limit: 10 });
    expect(all.events.map((e) => e.event_name)).toEqual(['started', 'crashed']);
    const since = await stack.dispatcher.logs({ slug: 'ollama_home', since: 150, limit: 10 });
    expect(since.events.map((e) => e.event_name)).toEqual(['crashed']);
    const filtered = await stack.dispatcher.logs({
      slug: 'ollama_home',
      since: 0,
      event_names: ['crashed'],
      limit: 10,
    });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].event_name).toBe('crashed');
    await stack.disposeAll();
    db.close();
  });
});
