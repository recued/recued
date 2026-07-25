/** D-192 Slice 6b — container-pick ask build + answer handler + register. */

import { describe, expect, it, vi } from 'vitest';

import {
  CONTAINER_PICK_CANCEL_OPTION,
  CONTAINER_PICK_HANDLER_KIND,
  buildContainerPickAsk,
  createContainerPickAnswerHandler,
  registerContainerPickHandler,
  type ContainerPickAskInput,
  type ContainerPickNotifier,
  type ContainerPickRerunDispatcher,
} from '../work-entity-container-pick.js';
import { WorkEntityContainerPickRequiredError } from '../work-entity-ingredients.js';

const OPTIONS = [
  { entity_pk: 'team-eng', label: 'Engineering' },
  { entity_pk: 'team-design', label: 'Design' },
];

const askInput = (overrides: Partial<ContainerPickAskInput> = {}): ContainerPickAskInput => ({
  pick_id: 'run-1',
  recipe_id: 'run-ingredient',
  recipe_label: 'run-ingredient',
  config: { ingredient_slug: 'task-create', input: { title: 'Ship it' } },
  source_id: 'connection:linear:conn-1',
  dependency_ref: 'team',
  kind: 'task',
  options: OPTIONS,
  ...overrides,
});

const answer = (option: string) => ({ option, answered_at: 123 });

describe('buildContainerPickAsk', () => {
  it('renders one option per container + Cancel, ids are the entity_pks', () => {
    const { options, message } = buildContainerPickAsk(askInput());
    expect(options.map((o) => o.id)).toEqual(['team-eng', 'team-design', CONTAINER_PICK_CANCEL_OPTION.id]);
    expect(options.map((o) => o.label)).toEqual(['Engineering', 'Design', 'Cancel']);
    // Body names the kind, the dependency noun, and the option labels.
    expect(message.text).toContain('task');
    expect(message.text).toContain('team');
    expect(message.text).toContain('Engineering');
    expect(message.text).toContain('Design');
    // The load-bearing posture must survive a copy edit: choosing SAVES A DEFAULT
    // and writes STILL ASK FOR APPROVAL (never "runs immediately without approval").
    expect((message.title ?? '').length).toBeGreaterThan(0);
    expect(message.text.toLowerCase()).toContain('default');
    expect(message.text.toLowerCase()).toContain('approval');
    expect(message.text.toLowerCase()).not.toContain('without approval');
  });

  it('persists the full re-run identity + option ids in the handler payload (by-id)', () => {
    const { handler } = buildContainerPickAsk(askInput());
    expect(handler.kind).toBe(CONTAINER_PICK_HANDLER_KIND);
    expect(handler.payload).toMatchObject({
      pick_id: 'run-1',
      source_id: 'connection:linear:conn-1',
      dependency_ref: 'team',
      kind: 'task',
      recipe_id: 'run-ingredient',
      config: { ingredient_slug: 'task-create', input: { title: 'Ship it' } },
      option_pks: ['team-eng', 'team-design'],
    });
    // recipe_id XOR recipe — a by-id ask carries no inline recipe.
    expect(handler.payload.recipe).toBeUndefined();
  });

  it('carries an inline recipe verbatim (chat Tier-3) and no recipe_id', () => {
    const inline = { recipe_id: 'run-ingredient', steps: [] };
    const { handler } = buildContainerPickAsk(
      askInput({ recipe_id: undefined, recipe: inline }),
    );
    expect(handler.payload.recipe).toEqual(inline);
    expect(handler.payload.recipe_id).toBeUndefined();
  });
});

describe('createContainerPickAnswerHandler', () => {
  const validPayload = () => ({
    pick_id: 'run-1',
    source_id: 'connection:linear:conn-1',
    dependency_ref: 'team',
    kind: 'task',
    recipe_id: 'run-ingredient',
    config: { input: { title: 'Ship it' } },
    option_pks: ['team-eng', 'team-design'],
  });

  it('dispatches the chosen container with entity_pk = the answered option', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    await handler(validPayload(), answer('team-design'));
    expect(dispatchPickedCreate).toHaveBeenCalledTimes(1);
    expect(dispatchPickedCreate).toHaveBeenCalledWith({
      pick_id: 'run-1',
      source_id: 'connection:linear:conn-1',
      dependency_ref: 'team',
      entity_pk: 'team-design',
      recipe_id: 'run-ingredient',
      config: { input: { title: 'Ship it' } },
    });
  });

  it('cancel records the decision and dispatches nothing', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    await handler(validPayload(), answer(CONTAINER_PICK_CANCEL_OPTION.id));
    expect(dispatchPickedCreate).not.toHaveBeenCalled();
  });

  it('rejects an answer outside the offered option set (stale / forged)', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    await expect(handler(validPayload(), answer('team-sales'))).rejects.toThrow(
      /not one of the offered containers/,
    );
    expect(dispatchPickedCreate).not.toHaveBeenCalled();
  });

  it('throws on a malformed payload (both recipe_id and recipe absent)', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    const { recipe_id: _r, ...noRecipe } = validPayload();
    await expect(handler(noRecipe, answer('team-eng'))).rejects.toThrow(/malformed payload/);
    expect(dispatchPickedCreate).not.toHaveBeenCalled();
  });

  it('throws on a malformed payload (option_pks not a string[])', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    await expect(
      handler({ ...validPayload(), option_pks: [1, 2] }, answer('team-eng')),
    ).rejects.toThrow(/malformed payload/);
  });

  it('throws on every other malformed-payload shape, dispatching nothing', async () => {
    const dispatchPickedCreate = vi.fn(async () => undefined);
    const handler = createContainerPickAnswerHandler({ dispatchPickedCreate });
    const bad: Array<Record<string, unknown>> = [
      { ...validPayload(), recipe: { steps: [] } }, // recipe_id XOR recipe — both present
      { ...validPayload(), pick_id: '' }, // empty pick_id
      { ...validPayload(), source_id: '' }, // empty source_id
      { ...validPayload(), dependency_ref: '' }, // empty dependency_ref
      { ...validPayload(), config: null }, // config not an object
      { ...validPayload(), config: ['a'] }, // config is an array
      { ...validPayload(), recipe_id: 42 }, // non-string recipe_id
    ];
    for (const payload of bad) {
      await expect(handler(payload, answer('team-eng'))).rejects.toThrow(/malformed payload/);
    }
    expect(dispatchPickedCreate).not.toHaveBeenCalled();
  });
});

describe('registerContainerPickHandler', () => {
  it('registers the container-pick kind exactly once', () => {
    const registered: Array<{ kind: unknown }> = [];
    const notifier: ContainerPickNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'unused' })),
      registerAskHandler: vi.fn((kind) => registered.push({ kind })),
    };
    const dispatcher: ContainerPickRerunDispatcher = { dispatchPickedCreate: vi.fn(async () => undefined) };
    registerContainerPickHandler(notifier, dispatcher);
    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(registered).toEqual([{ kind: CONTAINER_PICK_HANDLER_KIND }]);
  });
});

describe('WorkEntityContainerPickRequiredError carries the container_pick detail', () => {
  it('populates a self-contained ContainerPickDetail from the prompt-dependency ask', () => {
    const err = new WorkEntityContainerPickRequiredError('connection:linear:conn-1', 'task', {
      ref: 'team',
      options: OPTIONS,
      can_create: false,
    });
    expect(err.container_pick).toEqual({
      source_id: 'connection:linear:conn-1',
      kind: 'task',
      dependency_ref: 'team',
      options: OPTIONS,
      can_create: false,
    });
    // The carrier's options must be an independent DEEP copy (it rides on
    // RecipeError details across the engine seam) — neither the array NOR the
    // option objects may alias the ask's, so a later mutation of the source can't
    // corrupt the carried choice set.
    expect(err.container_pick.options).not.toBe(OPTIONS);
    expect(err.container_pick.options[0]).not.toBe(OPTIONS[0]);
    const before = err.container_pick.options[0].label;
    OPTIONS[0].label = 'Mutated After Construction';
    expect(err.container_pick.options[0].label).toBe(before);
    OPTIONS[0].label = 'Engineering'; // restore for other tests
  });
});
