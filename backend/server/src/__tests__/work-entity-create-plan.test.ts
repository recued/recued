/** D-192 Slice 6c — create-plan ask build + answer handler + register. */

import { describe, expect, it, vi } from 'vitest';

import type { PlannedDependencyCreate } from '@recued/contracts';
import {
  CREATE_PLAN_APPROVE_OPTION,
  CREATE_PLAN_CANCEL_OPTION,
  CREATE_PLAN_HANDLER_KIND,
  buildCreatePlanAsk,
  createCreatePlanAnswerHandler,
  registerCreatePlanHandler,
  type CreatePlanApprovedDispatcher,
  type CreatePlanAskInput,
  type CreatePlanNotifier,
} from '../work-entity-create-plan.js';
import { WorkEntityCreatePlanRequiredError } from '../work-entity-ingredients.js';

const PLAN: PlannedDependencyCreate = {
  ref: 'project',
  create_op: 'project.create',
  name: 'Roadmap',
  args: { 'body.data': { name: 'Roadmap', workspace: 'w1' } },
  result_path: 'data',
  id_field: 'gid',
};

const askInput = (overrides: Partial<CreatePlanAskInput> = {}): CreatePlanAskInput => ({
  plan_id: 'run-1',
  recipe_id: 'run-ingredient',
  config: { ingredient_slug: 'task-create', input: { title: 'Ship it' } },
  source_id: 'asana.conn-1.task',
  kind: 'task',
  plans: [PLAN],
  target_summary: "task 'Ship it'",
  ...overrides,
});

const answer = (option: string) => ({ option, answered_at: 123 });

describe('buildCreatePlanAsk', () => {
  it('renders Create + Cancel and names the container(s) + the target', () => {
    const { options, message } = buildCreatePlanAsk(askInput());
    expect(options.map((o) => o.id)).toEqual([CREATE_PLAN_APPROVE_OPTION.id, CREATE_PLAN_CANCEL_OPTION.id]);
    expect(message.text).toContain("project 'Roadmap'");
    expect(message.text).toContain("task 'Ship it'");
    expect((message.title ?? '').length).toBeGreaterThan(0);
    // The no-orphan posture must survive a copy edit: declining creates nothing.
    expect(message.text.toLowerCase()).toContain('nothing is created if you decline');
  });

  it('persists the full re-run identity + the plans in the handler payload (by-id)', () => {
    const { handler } = buildCreatePlanAsk(askInput());
    expect(handler.kind).toBe(CREATE_PLAN_HANDLER_KIND);
    expect(handler.payload).toMatchObject({
      plan_id: 'run-1',
      source_id: 'asana.conn-1.task',
      kind: 'task',
      recipe_id: 'run-ingredient',
      config: { ingredient_slug: 'task-create', input: { title: 'Ship it' } },
      plans: [PLAN],
    });
    expect(handler.payload.recipe).toBeUndefined();
  });

  it('carries an inline recipe verbatim (chat Tier-3) and no recipe_id', () => {
    const recipe = { recipe_id: 'inline', steps: [] };
    const { handler } = buildCreatePlanAsk(
      askInput({ recipe_id: undefined, recipe }),
    );
    expect(handler.payload.recipe).toEqual(recipe);
    expect(handler.payload.recipe_id).toBeUndefined();
  });
});

describe('createCreatePlanAnswerHandler', () => {
  const answerHandler = (dispatchApprovedPlan = vi.fn(async () => undefined)) => ({
    dispatchApprovedPlan,
    handler: createCreatePlanAnswerHandler({ dispatchApprovedPlan }),
  });
  const payload = (over: Record<string, unknown> = {}) => ({
    plan_id: 'run-1', source_id: 'asana.conn-1.task', kind: 'task',
    recipe_id: 'run-ingredient', config: {}, plans: [PLAN], ...over,
  });

  it('approve → dispatches the plan verbatim', async () => {
    const { dispatchApprovedPlan, handler } = answerHandler();
    await handler(payload(), answer(CREATE_PLAN_APPROVE_OPTION.id));
    expect(dispatchApprovedPlan).toHaveBeenCalledWith({
      plan_id: 'run-1', source_id: 'asana.conn-1.task', kind: 'task',
      recipe_id: 'run-ingredient', config: {}, plans: [PLAN],
    });
  });

  it('cancel dispatches nothing (no container created)', async () => {
    const { dispatchApprovedPlan, handler } = answerHandler();
    await handler(payload(), answer(CREATE_PLAN_CANCEL_OPTION.id));
    expect(dispatchApprovedPlan).not.toHaveBeenCalled();
  });

  it('any non-approve option dispatches nothing (default-deny)', async () => {
    const { dispatchApprovedPlan, handler } = answerHandler();
    await handler(payload(), answer('something-else'));
    expect(dispatchApprovedPlan).not.toHaveBeenCalled();
  });

  it('throws on a malformed payload (empty plans) and dispatches nothing', async () => {
    const { dispatchApprovedPlan, handler } = answerHandler();
    await expect(handler(payload({ plans: [] }), answer(CREATE_PLAN_APPROVE_OPTION.id))).rejects.toThrow();
    expect(dispatchApprovedPlan).not.toHaveBeenCalled();
  });

  it('throws on a malformed plan entry (missing create_op)', async () => {
    const { handler } = answerHandler();
    const bad = { ...PLAN, create_op: '' };
    await expect(handler(payload({ plans: [bad] }), answer(CREATE_PLAN_APPROVE_OPTION.id))).rejects.toThrow();
  });

  it('throws when both recipe_id and recipe are absent (XOR)', async () => {
    const { handler } = answerHandler();
    await expect(
      handler(payload({ recipe_id: undefined }), answer(CREATE_PLAN_APPROVE_OPTION.id)),
    ).rejects.toThrow();
  });
});

describe('registerCreatePlanHandler', () => {
  it('registers the create-plan kind exactly once', () => {
    const registerAskHandler = vi.fn();
    const notifier = { ask: vi.fn(), registerAskHandler } as unknown as CreatePlanNotifier;
    const dispatcher: CreatePlanApprovedDispatcher = { dispatchApprovedPlan: vi.fn(async () => undefined) };
    registerCreatePlanHandler(notifier, dispatcher);
    expect(registerAskHandler).toHaveBeenCalledTimes(1);
    expect(registerAskHandler.mock.calls[0]?.[0]).toBe(CREATE_PLAN_HANDLER_KIND);
  });
});

describe('WorkEntityCreatePlanRequiredError carries the create_plan detail', () => {
  it('populates a self-contained CreatePlanDetail from the planned creates', () => {
    const err = new WorkEntityCreatePlanRequiredError('asana.conn-1.task', 'task', [PLAN], "task 'Ship it'");
    expect(err.code).toBe('WORK_ENTITY_CREATE_PLAN_REQUIRED');
    expect(err.create_plan).toEqual({
      source_id: 'asana.conn-1.task',
      kind: 'task',
      plans: [PLAN],
      target_summary: "task 'Ship it'",
    });
    // the message names the container to create + the confirm-then-finish posture
    expect(err.message).toContain("project 'Roadmap'");
  });
});
