/** Supervision feature — `supervision.*` rpc handler.
 *
 *  Covers the owner gate, the `supervision.list` discovery + merge (an
 *  un-enrolled `detached.supervision` op surfaces as `mode:'off'` with its
 *  required args + declared policy; an enrolled op merges live state; an
 *  enrolled op whose ingredient is gone still lists), and `supervision.set`
 *  keyed `(ingredient_slug, op)` (manual/auto mapping, the missing-required-arg
 *  reject, off un-enrol). */

import { describe, expect, it, vi } from 'vitest';

import {
  makeSupervisionHandlers,
  type SupervisionRpcDeps,
} from '../supervision-handler.js';
import type {
  SupervisedDaemonConfig,
  SupervisedDaemonStore,
} from '../supervision/supervised-daemon-store.js';
import type {
  CliDaemonSupervisor,
  SupervisedDaemonStatus,
} from '../supervision/cli-daemon-supervisor.js';
import type {
  IngredientManifest,
  SupervisionDaemonRow,
  SupervisionListResponse,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';

const REG = { instance_id: 'web-1' };

type Slice = NonNullable<ReturnType<typeof makeSupervisionHandlers>>;
const call = (slice: Slice, method: string, args: unknown, client: unknown = REG): Promise<unknown> =>
  (slice.handlers[method as keyof Slice['handlers']] as (a: unknown, c: unknown) => Promise<unknown>)(args, client);

/** cloudflared manifest with one supervised daemon op (`tunnel.run_detached`,
 *  requires `tunnel_name`, declared on-crash + boot-persist). */
const cloudflaredManifest = (): IngredientManifest =>
  ({
    slug: 'cloudflared',
    surfaces: {
      connector: {
        executes: {
          'tunnel.run_detached': {
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

const makeStore = (seed: SupervisedDaemonConfig[] = []): SupervisedDaemonStore => {
  const map = new Map<string, SupervisedDaemonConfig>();
  const k = (i: string, o: string): string => `${i}::${o}`;
  for (const c of seed) map.set(k(c.ingredient_slug, c.op), c);
  return {
    list: () => [...map.values()],
    get: (i, o) => map.get(k(i, o)) ?? null,
    upsert: (c) => { map.set(k(c.ingredient_slug, c.op), c); },
    delete: (i, o) => map.delete(k(i, o)),
  };
};

const makeSupervisor = (status: SupervisedDaemonStatus | null = null): CliDaemonSupervisor => ({
  start: vi.fn(async () => status ?? ({} as SupervisedDaemonStatus)),
  stop: vi.fn(async () => ({} as SupervisedDaemonStatus)),
  status: vi.fn(() => status),
  list: vi.fn(() => []),
  isTracked: vi.fn(() => false),
  startAll: vi.fn(async () => {}),
  disposeAll: vi.fn(async () => {}),
});

const makeDeps = (over: Partial<SupervisionRpcDeps> = {}): SupervisionRpcDeps => ({
  store: makeStore(),
  supervisor: makeSupervisor(),
  getManifest: (slug) => (slug === 'cloudflared' ? cloudflaredManifest() : undefined),
  getManifests: () => [cloudflaredManifest()],
  ...over,
});

/** Minimal AuditLogStore stub — only `logActivity` is exercised. Typed so the
 *  recorded entry's fields (action / target / detail) survive typecheck:tests. */
const auditLogStub = (): { auditLog: AuditLogStore; logActivity: ReturnType<typeof vi.fn> } => {
  const logActivity = vi.fn(async (_entry: ActivityEntry) => {});
  return { auditLog: { logActivity } as unknown as AuditLogStore, logActivity };
};

const seedManual = (enabled: boolean): SupervisedDaemonConfig => ({
  ingredient_slug: 'cloudflared',
  op: 'tunnel.run_detached',
  restart_policy: 'never', // 'never' ⇒ mode 'manual'
  restart_on_server_start: false,
  enabled,
  args: { tunnel_name: 'prod' },
});

describe('makeSupervisionHandlers — presence + owner gate', () => {
  it('returns undefined without deps', () => {
    expect(makeSupervisionHandlers(undefined)).toBeUndefined();
  });

  it('rejects an unregistered client', async () => {
    const slice = makeSupervisionHandlers(makeDeps())!;
    await expect(call(slice, 'supervision.list', undefined, { instance_id: null })).rejects.toThrow(/registered/);
  });
});

describe('supervision.list — discovery + merge', () => {
  it('surfaces an un-enrolled daemon op as mode:off with required args + declared policy', async () => {
    const slice = makeSupervisionHandlers(makeDeps())!;
    const res = (await call(slice, 'supervision.list', undefined)) as SupervisionListResponse;
    expect(res.daemons).toHaveLength(1);
    const row = res.daemons[0];
    expect(row).toMatchObject({
      ingredient_slug: 'cloudflared',
      op: 'tunnel.run_detached',
      mode: 'off',
      enabled: false,
      restart_policy: 'on-crash',
      restart_on_server_start: true,
      state: 'unknown',
      required_args: ['tunnel_name'],
    });
  });

  it('merges an enrolled op with live supervisor state (manual derived from never)', async () => {
    const deps = makeDeps({
      store: makeStore([
        { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', restart_policy: 'never', restart_on_server_start: false, enabled: true, args: { tunnel_name: 'prod' } },
      ]),
      supervisor: makeSupervisor({
        ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', state: 'running', pid: 4242,
        readiness: 'legacy', readiness_detail: null, ready_at: null,
        health: 'unknown', health_detail: null, last_health_at: null,
        started_at: 1, consecutive_crashes: 0, last_crash_at: null, last_exit_code: null,
        launch_receipt: null,
      }),
    });
    const slice = makeSupervisionHandlers(deps)!;
    const res = (await call(slice, 'supervision.list', undefined)) as SupervisionListResponse;
    expect(res.daemons).toHaveLength(1); // discovered + enrolled = ONE (not double-counted)
    expect(res.daemons[0]).toMatchObject({ mode: 'manual', enabled: true, state: 'running', pid: 4242 });
  });

  it('still lists an enrolled op whose ingredient is gone (binding-less, required_args empty)', async () => {
    const deps = makeDeps({
      store: makeStore([
        { ingredient_slug: 'removed', op: 'serve.run_detached', restart_policy: 'always', restart_on_server_start: true, enabled: false, args: {} },
      ]),
      // getManifests still only knows cloudflared → 'removed' is not discovered
    });
    const slice = makeSupervisionHandlers(deps)!;
    const res = (await call(slice, 'supervision.list', undefined)) as SupervisionListResponse;
    const removed = res.daemons.find((d) => d.ingredient_slug === 'removed');
    expect(removed).toBeDefined();
    expect(removed!.required_args).toEqual([]); // binding gone → no args resolvable
    expect(res.daemons).toHaveLength(2); // cloudflared (off) + removed (enrolled)
  });
});

describe('supervision.set — re-key + arg gate', () => {
  it('enrols manual: upserts + starts, mode→restart_policy never', async () => {
    const store = makeStore();
    const upsert = vi.spyOn(store, 'upsert');
    const supervisor = makeSupervisor();
    const slice = makeSupervisionHandlers(makeDeps({ store, supervisor }))!;
    const row = (await call(slice, 'supervision.set', {
      ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'manual', enabled: true, args: { tunnel_name: 'prod' },
    })) as SupervisionDaemonRow;
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ ingredient_slug: 'cloudflared', restart_policy: 'never', restart_on_server_start: false }));
    expect(supervisor.start).toHaveBeenCalledTimes(1);
    expect(row.mode).toBe('manual');
  });

  it('rejects a manual enrol missing a required arg (no upsert, no start)', async () => {
    const store = makeStore();
    const upsert = vi.spyOn(store, 'upsert');
    const supervisor = makeSupervisor();
    const slice = makeSupervisionHandlers(makeDeps({ store, supervisor }))!;
    await expect(call(slice, 'supervision.set', {
      ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'manual', enabled: true,
    })).rejects.toThrow(/missing required arg/);
    expect(upsert).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it('off un-enrols: stops + deletes, returns null', async () => {
    const store = makeStore([
      { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', restart_policy: 'never', restart_on_server_start: false, enabled: true, args: { tunnel_name: 'prod' } },
    ]);
    const del = vi.spyOn(store, 'delete');
    const supervisor = makeSupervisor();
    const slice = makeSupervisionHandlers(makeDeps({ store, supervisor }))!;
    const res = await call(slice, 'supervision.set', { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'off' });
    expect(res).toBeNull();
    expect(supervisor.stop).toHaveBeenCalledWith('cloudflared', 'tunnel.run_detached');
    expect(del).toHaveBeenCalledWith('cloudflared', 'tunnel.run_detached');
  });

  it('rejects a path-traversal ingredient_slug', async () => {
    const slice = makeSupervisionHandlers(makeDeps())!;
    await expect(call(slice, 'supervision.set', { ingredient_slug: '..', op: 'x', mode: 'manual' })).rejects.toThrow(/path separators|\.\./);
  });
});

describe('supervision.set — enrollment audit (D-120)', () => {
  it('audits supervised_daemon_enrolled on off → manual (prior_mode off)', async () => {
    const { auditLog, logActivity } = auditLogStub();
    const slice = makeSupervisionHandlers(makeDeps({ auditLog }))!;
    await call(slice, 'supervision.set', {
      ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'manual', enabled: true, args: { tunnel_name: 'prod' },
    });
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = logActivity.mock.calls[0][0] as ActivityEntry;
    expect(entry).toMatchObject({ action: 'supervised_daemon_enrolled', target: 'cloudflared/tunnel.run_detached' });
    expect(JSON.parse(entry.detail as string)).toMatchObject({
      mode: 'manual', prior_mode: 'off', enabled: true, restart_policy: 'never', restart_on_server_start: false,
    });
  });

  it('audits supervised_daemon_enrolled on a manual → auto reconfigure (prior_mode manual)', async () => {
    const { auditLog, logActivity } = auditLogStub();
    const slice = makeSupervisionHandlers(makeDeps({ auditLog, store: makeStore([seedManual(true)]) }))!;
    await call(slice, 'supervision.set', { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'auto', enabled: true });
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = logActivity.mock.calls[0][0] as ActivityEntry;
    expect(entry).toMatchObject({ action: 'supervised_daemon_enrolled' });
    expect(JSON.parse(entry.detail as string)).toMatchObject({ mode: 'auto', prior_mode: 'manual', restart_policy: 'on-crash' });
  });

  it('audits supervised_daemon_unenrolled on manual → off (prior_mode manual)', async () => {
    const { auditLog, logActivity } = auditLogStub();
    const slice = makeSupervisionHandlers(makeDeps({ auditLog, store: makeStore([seedManual(true)]) }))!;
    const res = await call(slice, 'supervision.set', { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'off' });
    expect(res).toBeNull();
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = logActivity.mock.calls[0][0] as ActivityEntry;
    expect(entry).toMatchObject({ action: 'supervised_daemon_unenrolled', target: 'cloudflared/tunnel.run_detached' });
    expect(JSON.parse(entry.detail as string)).toMatchObject({ mode: 'off', prior_mode: 'manual' });
  });

  it('does NOT audit un-enrolling an already-off daemon (no-op, like revoking an absent grant)', async () => {
    const { auditLog, logActivity } = auditLogStub();
    const slice = makeSupervisionHandlers(makeDeps({ auditLog }))!; // empty store
    await call(slice, 'supervision.set', { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'off' });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('does NOT audit a same-mode re-set (start/stop) — the autonomous lifecycle row covers it', async () => {
    const { auditLog, logActivity } = auditLogStub();
    const supervisor = makeSupervisor();
    const slice = makeSupervisionHandlers(makeDeps({ auditLog, supervisor, store: makeStore([seedManual(false)]) }))!;
    // already enrolled manual+stopped → Start (enabled:true) keeps mode 'manual'.
    await call(slice, 'supervision.set', { ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'manual', enabled: true });
    expect(supervisor.start).toHaveBeenCalledTimes(1); // the start happened
    expect(logActivity).not.toHaveBeenCalled();         // but no enrollment audit
  });

  it('a failed audit write never unwinds the set (best-effort)', async () => {
    const logActivity = vi.fn(async (_entry: ActivityEntry) => { throw new Error('audit down'); });
    const auditLog = { logActivity } as unknown as AuditLogStore;
    const store = makeStore();
    const upsert = vi.spyOn(store, 'upsert');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slice = makeSupervisionHandlers(makeDeps({ auditLog, store }))!;
    const row = await call(slice, 'supervision.set', {
      ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'manual', enabled: true, args: { tunnel_name: 'prod' },
    });
    expect(row).toBeDefined();         // the set still succeeded
    expect(upsert).toHaveBeenCalled(); // enrollment committed despite the audit throw
    warn.mockRestore();
  });
});
