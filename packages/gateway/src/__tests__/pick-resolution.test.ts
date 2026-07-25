/** Doc section 4 - >1-provider pick resolution gateway unit tests. */

import { describe, expect, it, vi } from 'vitest';

import {
  PICK_CANCEL_OPTION,
  PICK_HANDLER_KIND,
  buildPickAsk,
  createPickAnswerHandler,
  raisePickAsk,
  registerPickHandler,
  type PickAskInput,
  type PickNotifier,
  type PickRerunDispatcher,
} from '../pick-resolution.js';

const candidates = () => [
  { connection_name: 'hubspot1', catalog_slug: 'hubspot-catalog', vendor: 'hubspot' },
  {
    connection_name: 'salesforce1',
    catalog_slug: 'salesforce-catalog',
    vendor: 'salesforce',
  },
  { connection_name: 'zoho1', catalog_slug: 'zoho-catalog', vendor: 'zoho' },
];

const byIdInput = (overrides: Partial<PickAskInput> = {}): PickAskInput => ({
  pick_id: 'pick-1',
  recipe_id: 'recipe-open-deals',
  recipe_label: 'Open deals review',
  variable: 'crm',
  operations: ['deal.search', 'deal.create'],
  config: { dry_run: false, limit: 25 },
  candidates: candidates(),
  ...overrides,
});

const inlineRecipe = { recipe_id: 'inline-open-deals', steps: [] };

const answer = (option: string) => ({ option, answered_at: 1 });

const dispatcher = (): PickRerunDispatcher => ({
  dispatchPickedRun: vi.fn(async () => undefined),
});

const validPayload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  pick_id: 'pick-1',
  recipe_id: 'recipe-open-deals',
  variable: 'crm',
  config: { limit: 25 },
  candidate_names: ['hubspot1', 'salesforce1'],
  ...overrides,
});

const without = (
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const next = { ...payload };
  delete next[key];
  return next;
};

const malformedPayloads: Array<[string, Record<string, unknown>]> = [
  ['missing pick_id', without(validPayload(), 'pick_id')],
  ['empty pick_id', validPayload({ pick_id: '' })],
  ['missing variable', without(validPayload(), 'variable')],
  ['config null', validPayload({ config: null })],
  ['config array', validPayload({ config: [] })],
  ['config non-object', validPayload({ config: 'not-an-object' })],
  ['candidate_names missing', without(validPayload(), 'candidate_names')],
  [
    'candidate_names containing a non-string',
    validPayload({ candidate_names: ['hubspot1', 42] }),
  ],
  ['both recipe_id and recipe present', validPayload({ recipe: inlineRecipe })],
  ['neither recipe_id nor recipe present', without(validPayload(), 'recipe_id')],
  ['recipe_id non-string', validPayload({ recipe_id: 42 })],
];

describe('buildPickAsk', () => {
  it('builds ordered vendor-labeled candidate options, cancel last, and the by-id durable payload', () => {
    const config = { dry_run: false, limit: 25 };
    const ask = buildPickAsk(byIdInput({ config }));

    expect(ask.options).toEqual([
      { id: 'hubspot1', label: 'hubspot1 (hubspot)' },
      { id: 'salesforce1', label: 'salesforce1 (salesforce)' },
      { id: 'zoho1', label: 'zoho1 (zoho)' },
      PICK_CANCEL_OPTION,
    ]);
    expect(ask.options.at(-1)).toEqual({ id: 'cancel', label: 'Cancel' });

    expect(ask.message.text).toContain("Recipe 'Open deals review'");
    expect(ask.message.text).toContain("'crm'");
    expect(ask.message.text).toContain('(deal.create, deal.search)');
    expect(ask.message.text).not.toContain('(deal.search, deal.create)');
    for (const candidate of candidates()) {
      expect(ask.message.text).toContain(
        `'${candidate.connection_name}' (${candidate.vendor})`,
      );
    }

    expect(ask.handler.kind).toBe(PICK_HANDLER_KIND);
    expect(ask.handler.payload).toEqual({
      pick_id: 'pick-1',
      recipe_id: 'recipe-open-deals',
      variable: 'crm',
      config,
      candidate_names: ['hubspot1', 'salesforce1', 'zoho1'],
    });
    expect(ask.handler.payload).not.toHaveProperty('recipe');
    expect(ask.handler.payload.config).toBe(config);
  });

  it('embeds inline recipes with recipe_id omitted from the payload', () => {
    const ask = buildPickAsk(byIdInput({
      recipe_id: undefined,
      recipe: inlineRecipe,
      recipe_label: 'Inline open deals',
    }));

    expect(ask.message.text).toContain("Recipe 'Inline open deals'");
    expect(ask.handler.payload).toMatchObject({
      pick_id: 'pick-1',
      recipe: inlineRecipe,
      variable: 'crm',
      candidate_names: ['hubspot1', 'salesforce1', 'zoho1'],
    });
    expect(ask.handler.payload).not.toHaveProperty('recipe_id');
    expect(ask.handler.payload.recipe).toBe(inlineRecipe);
  });

  it('falls back to recipe_id when recipe_label is absent', () => {
    const ask = buildPickAsk({
      ...byIdInput({ recipe_label: undefined as unknown as string }),
    });

    expect(ask.message.text).toContain("Recipe 'recipe-open-deals'");
    expect(ask.message.text).not.toContain('undefined');
  });
});

describe('createPickAnswerHandler', () => {
  it.each(malformedPayloads)('throws malformed-payload for %s before dispatching', async (_name, payload) => {
    const d = dispatcher();

    await expect(
      createPickAnswerHandler(d)(payload, answer('hubspot1')),
    ).rejects.toThrow(/malformed payload/);

    expect(d.dispatchPickedRun).not.toHaveBeenCalled();
  });

  it('returns on cancel without dispatching', async () => {
    const d = dispatcher();

    await createPickAnswerHandler(d)(validPayload(), answer('cancel'));

    expect(d.dispatchPickedRun).not.toHaveBeenCalled();
  });

  it('rejects an answer naming a non-offered option before dispatching', async () => {
    const d = dispatcher();

    await expect(
      createPickAnswerHandler(d)(validPayload(), answer('not-offered')),
    ).rejects.toThrow(/not one of the offered candidates/);

    expect(d.dispatchPickedRun).not.toHaveBeenCalled();
  });

  it('dispatches a selected offered candidate with recipe_id or inline recipe forwarded', async () => {
    const configById = { limit: 25 };
    const byIdDispatcher = dispatcher();
    await createPickAnswerHandler(byIdDispatcher)(
      validPayload({ config: configById }),
      answer('salesforce1'),
    );

    expect(byIdDispatcher.dispatchPickedRun).toHaveBeenCalledTimes(1);
    expect(byIdDispatcher.dispatchPickedRun).toHaveBeenCalledWith({
      pick_id: 'pick-1',
      recipe_id: 'recipe-open-deals',
      config: configById,
      variable: 'crm',
      connection_name: 'salesforce1',
    });
    expect(
      (byIdDispatcher.dispatchPickedRun as ReturnType<typeof vi.fn>).mock.calls[0][0].config,
    ).toBe(configById);

    const configInline = { threshold: 10 };
    const inlineDispatcher = dispatcher();
    await createPickAnswerHandler(inlineDispatcher)(
      {
        ...without(validPayload(), 'recipe_id'),
        recipe: inlineRecipe,
        config: configInline,
      },
      answer('hubspot1'),
    );

    expect(inlineDispatcher.dispatchPickedRun).toHaveBeenCalledTimes(1);
    expect(inlineDispatcher.dispatchPickedRun).toHaveBeenCalledWith({
      pick_id: 'pick-1',
      recipe: inlineRecipe,
      config: configInline,
      variable: 'crm',
      connection_name: 'hubspot1',
    });
    expect(
      (inlineDispatcher.dispatchPickedRun as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe,
    ).toBe(inlineRecipe);
  });
});

describe('registerPickHandler', () => {
  it('registers the answer handler under gateway.pick', () => {
    const d = dispatcher();
    const notifier: PickNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'ask-unused' })),
      registerAskHandler: vi.fn(),
    };

    registerPickHandler(notifier, d);

    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(notifier.registerAskHandler).toHaveBeenCalledWith(
      PICK_HANDLER_KIND,
      expect.any(Function),
    );
  });
});

describe('raisePickAsk', () => {
  it('forwards message, options, and handler to notifier.ask and returns ask_id', async () => {
    const input = byIdInput();
    const expected = buildPickAsk(input);
    const notifier: PickNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'ask-42' })),
      registerAskHandler: vi.fn(),
    };

    await expect(raisePickAsk(notifier, input)).resolves.toEqual({
      ask_id: 'ask-42',
    });

    expect(notifier.ask).toHaveBeenCalledTimes(1);
    expect(notifier.ask).toHaveBeenCalledWith(
      expected.message,
      expected.options,
      expected.handler,
    );
  });
});
