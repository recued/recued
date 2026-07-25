/** D-192 Slice 6c — create-plan approve dispatcher wiring. Mirrors the container-
 *  pick wiring test: the guards BEFORE `handleExecute` (anchor idempotency, the
 *  null-executor transient throw, the executeCreatePlan-failure short-circuit) +
 *  the re-run request shape + the boot registration. */

import { buildAuditEntry, type AuditEntry, type AuditLogStore } from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PlannedDependencyCreate } from '@recued/contracts';

import {
  CREATE_PLAN_RERUN_PREFIX,
  createCreatePlanApprovedDispatcher,
  registerCreatePlanResolution,
} from '../work-entity-create-plan-wiring.js';
import {
  CREATE_PLAN_HANDLER_KIND,
  type CreatePlanNotifier,
  type CreatePlanRerunRef,
} from '../work-entity-create-plan.js';
import type { WorkEntitySourceWriteExecutor } from '../work-entity-write-executor.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

vi.mock('../execute-handler.js', () => ({ handleExecute: vi.fn() }));
// eslint-disable-next-line import/first
import { handleExecute } from '../execute-handler.js';

const EVENT_AT = Date.parse('2026-07-07T10:00:00.000Z');

const PLAN: PlannedDependencyCreate = {
  ref: 'project', create_op: 'project.create', name: 'Roadmap',
  args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
};

const auditAnchor = (commit_status: AuditEntry['commit_status']): AuditEntry =>
  buildAuditEntry({
    recipe_id: 'run-ingredient', recipe_hash: 'hash-1', commit_status,
    duration_ms: 0, errors: [], config_snapshot: {}, trigger_url: null,
    trigger_source: null, instance_id: null,
    run_id: `${CREATE_PLAN_RERUN_PREFIX}run-1`, now: EVENT_AT,
  });

const auditLog = (getImpl: AuditLogStore['get']): AuditLogStore =>
  ({ get: getImpl }) as unknown as AuditLogStore;

/** A write-executor stub whose `executeCreatePlan` returns the scripted outcome. */
const executorStub = (outcome: { ok: true; entity_pk: string } | { ok: false; reason: string }) => {
  const executeCreatePlan = vi.fn(
    async (_input: { source_id: string; kind: string; plan: PlannedDependencyCreate; identity?: unknown }) => outcome,
  );
  return {
    executor: { executeCreatePlan } as unknown as WorkEntitySourceWriteExecutor,
    executeCreatePlan,
  };
};

const rerun = (overrides: Partial<CreatePlanRerunRef> = {}): CreatePlanRerunRef => ({
  plan_id: 'run-1',
  source_id: 'asana.conn-1.task',
  kind: 'task',
  plans: [PLAN],
  recipe_id: 'run-ingredient',
  config: { input: { title: 'Ship it' } },
  // D-192 6c.2c — the step that raised the plan (run-ingredient's single 'call' step).
  raising_step_id: 'call',
  ...overrides,
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  (handleExecute as unknown as Mock).mockReset();
  (handleExecute as unknown as Mock).mockResolvedValue({ success: true, errors: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  warnSpy = undefined;
});

describe('createCreatePlanApprovedDispatcher', () => {
  it('skips when an anchor already exists — never creates, never dereferences the executor', async () => {
    const get = vi.fn(async () => auditAnchor('failed'));
    const { executor, executeCreatePlan } = executorStub({ ok: true, entity_pk: 'pNew' });
    const getWriteExecutor = vi.fn(() => executor);
    const getExecuteDeps = vi.fn(() => { throw new Error('must not read executeDeps on anchor skip'); });
    const dispatcher = createCreatePlanApprovedDispatcher({ auditLog: auditLog(get), getWriteExecutor, getExecuteDeps });

    await expect(dispatcher.dispatchApprovedPlan(rerun())).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledWith(`${CREATE_PLAN_RERUN_PREFIX}run-1`);
    expect(executeCreatePlan).not.toHaveBeenCalled();
    expect(getExecuteDeps).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws transiently when the write executor is not yet populated (no create attempted)', async () => {
    const get = vi.fn(async () => null);
    const getWriteExecutor = vi.fn(() => null);
    const getExecuteDeps = vi.fn(() => { throw new Error('must not read executeDeps with no executor'); });
    const dispatcher = createCreatePlanApprovedDispatcher({ auditLog: auditLog(get), getWriteExecutor, getExecuteDeps });

    await expect(dispatcher.dispatchApprovedPlan(rerun())).rejects.toThrow(/write executor not yet populated/);
    expect(getExecuteDeps).not.toHaveBeenCalled();
  });

  it('a failed container create short-circuits — no re-run', async () => {
    const get = vi.fn(async () => null);
    const { executor, executeCreatePlan } = executorStub({ ok: false, reason: 'vendor rejected' });
    const getWriteExecutor = vi.fn(() => executor);
    const getExecuteDeps = vi.fn(() => ({}) as unknown as ExecuteHandlerDeps);
    const dispatcher = createCreatePlanApprovedDispatcher({ auditLog: auditLog(get), getWriteExecutor, getExecuteDeps });

    await expect(dispatcher.dispatchApprovedPlan(rerun())).resolves.toBeUndefined();

    expect(executeCreatePlan).toHaveBeenCalledTimes(1);
    expect(handleExecute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('creates each container then re-runs the request VERBATIM under an owner source (by-id)', async () => {
    const get = vi.fn(async () => null);
    const { executor, executeCreatePlan } = executorStub({ ok: true, entity_pk: 'pNew' });
    const getWriteExecutor = vi.fn(() => executor);
    const fakeExecuteDeps = { sentinel: true } as unknown as ExecuteHandlerDeps;
    const getExecuteDeps = vi.fn(() => fakeExecuteDeps);
    const dispatcher = createCreatePlanApprovedDispatcher({ auditLog: auditLog(get), getWriteExecutor, getExecuteDeps });

    await dispatcher.dispatchApprovedPlan(rerun());

    // the container was created (with the plan) BEFORE the re-run
    expect(executeCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      source_id: 'asana.conn-1.task', kind: 'task', plan: PLAN,
    }));
    expect(executeCreatePlan.mock.invocationCallOrder[0])
      .toBeLessThan((handleExecute as unknown as Mock).mock.invocationCallOrder[0]);

    const [depsArg, requestArg, internalArg] = (handleExecute as unknown as Mock).mock.calls[0];
    expect(depsArg).toBe(fakeExecuteDeps);
    // D-192 6c.2c — the re-run pre-admits ONLY the confirmed write's step (the
    // create-plan confirm approved the container create(s) + THIS step's write);
    // scoped to the raising step id, never run-wide.
    expect(internalArg).toEqual({
      run_id: `${CREATE_PLAN_RERUN_PREFIX}run-1`,
      work_entity_write_preadmitted_step_id: 'call',
    });
    // config replayed VERBATIM (the container resolves off the store now)
    expect(requestArg.config).toEqual({ input: { title: 'Ship it' } });
    expect(requestArg.recipe_id).toBe('run-ingredient');
    expect(requestArg.recipe).toBeUndefined();
    expect(requestArg.trigger_source).toBe('manual');
    expect(requestArg.execution_source).toMatchObject({ channel: 'user', actor: 'user_self' });
  });

  it('creates ALL planned containers in order before the re-run', async () => {
    const get = vi.fn(async () => null);
    const { executor, executeCreatePlan } = executorStub({ ok: true, entity_pk: 'pNew' });
    const getWriteExecutor = vi.fn(() => executor);
    const dispatcher = createCreatePlanApprovedDispatcher({
      auditLog: auditLog(get), getWriteExecutor, getExecuteDeps: vi.fn(() => ({}) as unknown as ExecuteHandlerDeps),
    });
    const planB: PlannedDependencyCreate = { ...PLAN, ref: 'section', name: 'Backlog' };

    await dispatcher.dispatchApprovedPlan(rerun({ plans: [PLAN, planB] }));

    expect(executeCreatePlan).toHaveBeenCalledTimes(2);
    expect(executeCreatePlan.mock.calls[0]?.[0]).toMatchObject({ plan: PLAN });
    expect(executeCreatePlan.mock.calls[1]?.[0]).toMatchObject({ plan: planB });
    expect(handleExecute).toHaveBeenCalledTimes(1);
  });

  it('a legacy re-run WITHOUT a raising_step_id admits nothing (fail-closed)', async () => {
    const { executor } = executorStub({ ok: true, entity_pk: 'pNew' });
    const fakeExecuteDeps = { sentinel: true } as unknown as ExecuteHandlerDeps;
    const dispatcher = createCreatePlanApprovedDispatcher({
      auditLog: auditLog(vi.fn(async () => null)),
      getWriteExecutor: vi.fn(() => executor),
      getExecuteDeps: vi.fn(() => fakeExecuteDeps),
    });

    await dispatcher.dispatchApprovedPlan(rerun({ raising_step_id: undefined }));

    const [, , internalArg] = (handleExecute as unknown as Mock).mock.calls[0];
    // No step id → no admission threaded; the vendor write degrades like any
    // un-admitted create (never a run-wide admit).
    expect(internalArg).toEqual({ run_id: `${CREATE_PLAN_RERUN_PREFIX}run-1` });
  });
});

describe('registerCreatePlanResolution', () => {
  it('registers the create-plan kind once; a cancel answer dispatches nothing', async () => {
    const registered: Array<{ kind: unknown; handler: unknown }> = [];
    const notifier: CreatePlanNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'unused' })),
      registerAskHandler: vi.fn((kind, handler) => registered.push({ kind, handler })),
    };
    const { executor, executeCreatePlan } = executorStub({ ok: true, entity_pk: 'pNew' });

    registerCreatePlanResolution(notifier, {
      auditLog: auditLog(vi.fn(async () => null)),
      getWriteExecutor: vi.fn(() => executor),
      getExecuteDeps: vi.fn(() => undefined),
    });

    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(registered[0].kind).toBe(CREATE_PLAN_HANDLER_KIND);
    await expect(
      (registered[0].handler as (p: Record<string, unknown>, a: { option: string; answered_at: number }) => Promise<void>)(
        {
          plan_id: 'run-1', source_id: 'asana.conn-1.task', kind: 'task',
          recipe_id: 'run-ingredient', config: {}, plans: [PLAN],
        },
        { option: 'cancel', answered_at: EVENT_AT },
      ),
    ).resolves.toBeUndefined();
    expect(executeCreatePlan).not.toHaveBeenCalled();
  });
});
