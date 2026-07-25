/** D-192 Slice 6b — container-pick re-run dispatcher wiring. Mirrors
 *  pick-server-wiring.test.ts; the tests cover the guards BEFORE `handleExecute`
 *  (anchor idempotency, the store.select gate, the transient executeDeps throw)
 *  + the boot registration. */

import { buildAuditEntry, type AuditEntry, type AuditLogStore } from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CONTAINER_PICK_RERUN_PREFIX,
  createContainerPickRerunDispatcher,
  registerContainerPickResolution,
} from '../work-entity-container-pick-wiring.js';
import {
  CONTAINER_PICK_HANDLER_KIND,
  type ContainerPickNotifier,
  type ContainerPickRerunRef,
} from '../work-entity-container-pick.js';
import type { SourceDependencyEntityStore } from '../storage/source-dependency-entity-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

// The dispatcher's re-run runs the ORIGINAL request through `handleExecute`; mock
// it to assert the request it builds (config-verbatim, owner source, run_id)
// without a full engine harness. The guard tests above never reach it.
vi.mock('../execute-handler.js', () => ({ handleExecute: vi.fn() }));
// eslint-disable-next-line import/first
import { handleExecute } from '../execute-handler.js';

const EVENT_AT = Date.parse('2026-07-07T10:00:00.000Z');

const auditAnchor = (commit_status: AuditEntry['commit_status']): AuditEntry =>
  buildAuditEntry({
    recipe_id: 'run-ingredient',
    recipe_hash: 'hash-1',
    commit_status,
    duration_ms: 0,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: null,
    instance_id: null,
    run_id: `${CONTAINER_PICK_RERUN_PREFIX}run-1`,
    now: EVENT_AT,
  });

const auditLog = (getImpl: AuditLogStore['get']): AuditLogStore =>
  ({ get: getImpl }) as unknown as AuditLogStore;

/** A store stub whose `select` returns the scripted boolean and records its args. */
const selectStore = (result: boolean) => {
  const select = vi.fn((): boolean => result);
  return { store: { select } as unknown as Pick<SourceDependencyEntityStore, 'select'>, select };
};

const rerun = (overrides: Partial<ContainerPickRerunRef> = {}): ContainerPickRerunRef => ({
  pick_id: 'run-1',
  source_id: 'connection:linear:conn-1',
  dependency_ref: 'team',
  entity_pk: 'team-eng',
  recipe_id: 'run-ingredient',
  config: { input: { title: 'Ship it' } },
  ...overrides,
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  (handleExecute as unknown as Mock).mockReset();
  (handleExecute as unknown as Mock).mockResolvedValue({ success: true, errors: [] });
});
afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('createContainerPickRerunDispatcher', () => {
  it('skips when an anchor already exists — never selects, never dereferences executeDeps', async () => {
    const get = vi.fn(async () => auditAnchor('failed'));
    const { store, select } = selectStore(true);
    const getExecuteDeps = vi.fn(() => {
      throw new Error('executeDeps must not be read on anchor skip');
    });
    const dispatcher = createContainerPickRerunDispatcher({ auditLog: auditLog(get), store, getExecuteDeps });

    await expect(dispatcher.dispatchPickedCreate(rerun())).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledWith(`${CONTAINER_PICK_RERUN_PREFIX}run-1`);
    expect(select).not.toHaveBeenCalled();
    expect(getExecuteDeps).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('skips (no dispatch) when store.select fails — the container is no longer cached', async () => {
    const get = vi.fn(async () => null);
    const { store, select } = selectStore(false);
    const getExecuteDeps = vi.fn(() => {
      throw new Error('executeDeps must not be read when the selection did not persist');
    });
    const dispatcher = createContainerPickRerunDispatcher({ auditLog: auditLog(get), store, getExecuteDeps });

    await expect(dispatcher.dispatchPickedCreate(rerun())).resolves.toBeUndefined();

    expect(select).toHaveBeenCalledWith('connection:linear:conn-1', 'team', 'team-eng');
    expect(getExecuteDeps).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('persists the selection then throws transiently when executeDeps is not yet published', async () => {
    const get = vi.fn(async () => null);
    const { store, select } = selectStore(true);
    const getExecuteDeps = vi.fn(() => undefined);
    const dispatcher = createContainerPickRerunDispatcher({ auditLog: auditLog(get), store, getExecuteDeps });

    await expect(dispatcher.dispatchPickedCreate(rerun())).rejects.toThrow(/executeDeps not yet published/);

    // Ordering: anchor read → select → executeDeps read (select persisted before
    // the throw, so the boot retry re-runs cleanly off the stored selection).
    expect(get).toHaveBeenCalledWith(`${CONTAINER_PICK_RERUN_PREFIX}run-1`);
    expect(select).toHaveBeenCalledWith('connection:linear:conn-1', 'team', 'team-eng');
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(getExecuteDeps.mock.invocationCallOrder[0]);
  });

  it('re-runs the request VERBATIM under an owner source with the deterministic run_id (by-id)', async () => {
    const get = vi.fn(async () => null);
    const { store } = selectStore(true);
    const fakeExecuteDeps = { sentinel: true } as unknown as ExecuteHandlerDeps;
    const getExecuteDeps = vi.fn(() => fakeExecuteDeps);
    const dispatcher = createContainerPickRerunDispatcher({ auditLog: auditLog(get), store, getExecuteDeps });

    await dispatcher.dispatchPickedCreate(rerun());

    expect(handleExecute).toHaveBeenCalledTimes(1);
    const [depsArg, requestArg, internalArg] = (handleExecute as unknown as Mock).mock.calls[0];
    expect(depsArg).toBe(fakeExecuteDeps);
    // Deterministic re-run id off the failed run's id. D-192 6c.2c — the pick
    // DISAMBIGUATES but never AUTHORIZES: the re-run passes NO write admission, so
    // the vendor create flows through the normal gate (leaf § "the gate is the
    // gate"). Only `run_id` rides the internal override.
    expect(internalArg).toEqual({ run_id: `${CONTAINER_PICK_RERUN_PREFIX}run-1` });
    // Config replayed VERBATIM — no merged/named binding, no added keys (the
    // container resolves off the store, not config).
    expect(requestArg.config).toEqual({ input: { title: 'Ship it' } });
    expect(requestArg.recipe_id).toBe('run-ingredient');
    expect(requestArg.recipe).toBeUndefined();
    expect(requestArg.trigger_source).toBe('manual');
    // Owner source (user_self), NOT the original channel — the owner answered.
    expect(requestArg.execution_source).toMatchObject({ channel: 'user', actor: 'user_self' });
  });

  it('rides an inline recipe verbatim (chat Tier-3) with no recipe_id', async () => {
    const get = vi.fn(async () => null);
    const { store } = selectStore(true);
    const getExecuteDeps = vi.fn(() => ({}) as unknown as ExecuteHandlerDeps);
    const dispatcher = createContainerPickRerunDispatcher({ auditLog: auditLog(get), store, getExecuteDeps });
    const inline = { recipe_id: 'run-ingredient', steps: [] };

    await dispatcher.dispatchPickedCreate(rerun({ recipe_id: undefined, recipe: inline }));

    const [, requestArg] = (handleExecute as unknown as Mock).mock.calls[0];
    expect(requestArg.recipe).toEqual(inline);
    expect(requestArg.recipe_id).toBeUndefined();
  });
});

describe('registerContainerPickResolution', () => {
  it('registers the container-pick kind once and exposes a callable cancel-safe handler', async () => {
    const registered: Array<{ kind: unknown; handler: unknown }> = [];
    const notifier: ContainerPickNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'unused' })),
      registerAskHandler: vi.fn((kind, handler) => registered.push({ kind, handler })),
    };
    const { store } = selectStore(true);

    registerContainerPickResolution(notifier, {
      auditLog: auditLog(vi.fn(async () => null)),
      store,
      getExecuteDeps: vi.fn(() => undefined),
    });

    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(registered[0].kind).toBe(CONTAINER_PICK_HANDLER_KIND);
    // A cancel answer through the registered handler dispatches nothing (so no
    // store/executeDeps access) and resolves cleanly.
    await expect(
      (registered[0].handler as (p: Record<string, unknown>, a: { option: string; answered_at: number }) => Promise<void>)(
        {
          pick_id: 'run-1', source_id: 'connection:linear:conn-1', dependency_ref: 'team',
          kind: 'task', recipe_id: 'run-ingredient', config: {}, option_pks: ['team-eng'],
        },
        { option: 'cancel', answered_at: EVENT_AT },
      ),
    ).resolves.toBeUndefined();
  });
});
