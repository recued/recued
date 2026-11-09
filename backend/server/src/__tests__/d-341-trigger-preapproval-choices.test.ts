/** D-341 slice B2b — what a trigger's own page may grant (`collection.contract.triggerPreapprovalChoices`,
 *  `trigger-preapproval-rpc.ts`): each recipe the trigger starts, the writes its steps make in the
 *  owner's words and whether a pre-approval may name each (`recipeStepWrites`,
 *  `trigger-preapproval-ops.ts`), the steps that ask an AI, and this trigger's pre-approvals for it.
 *
 *  A write is offered only where the gates would consult a pre-approval: not a destructive one, not
 *  one that always asks, read as the gates read them (the owner's own ruling on the op first, D-211).
 *  A recipe that asks an AI is offered its writes too, and its steps that ask one are named (ruling 8).
 *  The recipes are stored LOWERED, as an install stores them. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { grantSwitchText, kernelOpForBackingSlug } from '@recued/contracts';
import type {
  IngredientManifest,
  OwnerOverridePolicy,
  RecipeDefinition,
  TriggerPreapprovalChoice,
  TriggerPreapprovalTrigger,
} from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createRecipeStore } from '../recipe-store.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { createTriggerPreapprovalRpcHandlers, createTriggerPreapprovalTargets } from '../trigger-preapproval-rpc.js';
import { recipeStepOpLabels, recipeStepWrites } from '../trigger-preapproval-ops.js';

const CATALOG = 'records-0123456789abcdef0123456789abcdef';
const BATCH = 'recued-core.body-signals.daily_metric.batch';
const SEARCH = 'recued-core.body-signals.daily_metric.search';
const REMOVE = 'recued-core.body-signals.daily_metric.delete';
const RESET = 'recued-core.body-signals.totals.reset';
const catalogManifest = {
  slug: CATALOG, name: 'Body signals', description: '', author: 'recued-core', kind: 'connection', category: 'action',
  risk_tier: 'read', input: {}, output: {},
  operations: {
    'daily_metric.batch': { operation_id: BATCH, risk_tier: 'write', groups: ['g'],
      description: 'Save up to 100 daily readings in one transaction, all or none. Upserts only: read the rows first.' },
    'daily_metric.search': { operation_id: SEARCH, risk_tier: 'read', groups: ['g'], description: 'Page a Body\'s daily readings.' },
    'daily_metric.delete': { operation_id: REMOVE, risk_tier: 'destructive', groups: ['g'],
      description: 'Delete one daily reading.' },
    'totals.reset': { operation_id: RESET, risk_tier: 'write', approval: 'always', groups: ['g'],
      description: 'Reset the running totals! They are rebuilt overnight.' },
  },
} as unknown as IngredientManifest;
const postManifest = {
  slug: 'post-note', kind: 'action', risk_tier: 'write', description: 'Post a note to the team. It goes to everyone.',
} as unknown as IngredientManifest;
const aiManifest = { slug: 'summarize-pack', kind: 'ai', risk_tier: 'read' } as unknown as IngredientManifest;
const manifestOf = (slug: string): IngredientManifest | null =>
  ({ [CATALOG]: catalogManifest, 'post-note': postManifest, 'summarize-pack': aiManifest } as Record<string, IngredientManifest>)[slug] ?? null;
const PACKS: PackOpResolution = new Map([['recued-core.body-signals', { catalog_slug: CATALOG,
  operations: new Set(['daily_metric.batch', 'daily_metric.search', 'daily_metric.delete', 'totals.reset']) }]]);
const installed = (id: string, operation: string) => ({ id, ingredient: CATALOG, input: { operation, args: {} } });

const recipeOf = (recipe_id: string, name: string, steps: Array<Record<string, unknown>>): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 60,
  metadata: { name, description: 'Test.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps, output: { sidebar: [] },
} as unknown as RecipeDefinition);

const SAVE_STEPS = [
  installed('read', 'daily_metric.search'),
  installed('save', 'daily_metric.batch'),
  { id: 'tell', ingredient: 'post-note', input: {} },
  installed('tidy', 'daily_metric.delete'),
  installed('reset', 'totals.reset'),
  installed('save_again', 'daily_metric.batch'),
];

const WEBHOOK: TriggerPreapprovalTrigger = { kind: 'webhook', ingress_id: 'whi_1' };
const SCHEDULE: TriggerPreapprovalTrigger = { kind: 'schedule', schedule_id: 'sch_1' };
const EVENT: TriggerPreapprovalTrigger = { kind: 'event_trigger', trigger_id: 'trg_1' };
const DAY = 86_400_000;

const fixture = (opts: { overrides?: Record<string, OwnerOverridePolicy>; webhookList?: boolean } = {}) => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipeOf('save-readings', 'Save readings', SAVE_STEPS));
  recipeStore.register(recipeOf('note-readings', 'Note readings', [{ id: 'tell', ingredient: 'post-note', input: {} }]));
  recipeStore.register(recipeOf('summarize-readings', 'Summarize readings', [
    { id: 'sum', ingredient: 'summarize-pack', input: {} }, installed('save', 'daily_metric.batch'),
  ]));
  // Bound to whi_1: two recipes. Bound to whi_2: one this server no longer has installed.
  const bound = (binding_id: string, ingress_id: string, recipe_id: string) => [{ snapshot: {
    bindings: [{ binding_id, ingress_id }],
    triggers: [{ binding_id, recipe_id, contract_id: `door-${recipe_id}` }],
  } }];
  const consumers: Record<string, ReturnType<typeof bound>> = {
    'note-readings': bound('b2', 'whi_1', 'note-readings'),
    'save-readings': bound('b1', 'whi_1', 'save-readings'),
    'gone-recipe': bound('b3', 'whi_2', 'gone-recipe'),
  };
  const schedules = new Map([['sch_1', { recipe_id: 'save-readings' }], ['sch_ai', { recipe_id: 'summarize-readings' }]]);
  const triggers = new Map([['trg_1', { recipe_id: 'note-readings' }]]);
  const store = createTriggerPreapprovalStore(new Database(':memory:'));
  let at = Date.UTC(2026, 10, 8);
  const rpc = createTriggerPreapprovalRpcHandlers({
    store, recipeStore, now: () => at, manifestOf, packs: () => PACKS,
    ...(opts.overrides !== undefined
      ? { ownerOverrideOf: (ingredient_id: string, operation_id: string) => opts.overrides![`${ingredient_id} ${operation_id}`] }
      : {}),
    targets: createTriggerPreapprovalTargets({
      webhooks: {
        // The store lists every recipe a webhook trigger row starts, by id.
        ...(opts.webhookList !== false ? { recipesWithTriggers: () => Object.keys(consumers).sort() } : {}),
        consumersOfRecipe: (id) => consumers[id] ?? [],
      },
      schedules: { get: (id) => schedules.get(id) ?? null },
      triggers: { get: (id) => triggers.get(id) ?? null },
      // B1b — the dish dsh_1's timer runs the summary, which no webhook runs; dsh_off's recipe does
      // not run on its own.
      timers: { recipeOf: (dish_id) => (dish_id === 'dsh_1' ? 'summarize-readings' : undefined) },
      // B4 — the form -ep_1 is paired with the note recipe; ep_new's pairing has no door yet.
      receptions: { pairOf: (endpoint_id) => (endpoint_id === '-ep_1' ? { recipe_id: 'note-readings', contract_id: 'door-r1' }
        : endpoint_id === 'ep_new' ? { recipe_id: 'note-readings', contract_id: null } : null) },
    }),
  });
  const choices = async (trigger: unknown): Promise<TriggerPreapprovalChoice[]> =>
    (await rpc['collection.contract.triggerPreapprovalChoices']({ trigger })).recipes;
  return { rpc, choices, store, advance: (ms: number) => { at += ms; } };
};

describe('D-341 slice B2b — the writes a trigger\'s page offers', () => {
  it('lists each write once, in step order, in the owner\'s words; reads are not listed', async () => {
    const [save] = await fixture().choices(SCHEDULE);
    expect(save).toMatchObject({ recipe_id: 'save-readings', recipe_name: 'Save readings', ai_steps: [] });
    expect(save!.writes.map((write) => write.op)).toEqual([BATCH, 'post-note', REMOVE, RESET]);
    expect(save!.writes.map((write) => write.label)).toEqual([
      'Save up to 100 daily readings in one transaction, all or none',
      'Post a note to the team',
      'Delete one daily reading',
      'Reset the running totals',
    ]);
  });

  it('offers a write the gates would ask about; lists, not offers, a destructive one and one that always asks', async () => {
    const [save] = await fixture().choices(SCHEDULE);
    expect(save!.writes).toEqual([
      { op: BATCH, label: expect.any(String), offerable: true },
      { op: 'post-note', label: expect.any(String), offerable: true },
      { op: REMOVE, label: expect.any(String), offerable: false, reason: 'It deletes or can\'t be undone.' },
      { op: RESET, label: expect.any(String), offerable: false, reason: 'It\'s set to ask every time.' },
    ]);
  });

  it('reads the owner\'s own ruling on an op first, as the gates do (D-211)', async () => {
    const [save] = await fixture({ overrides: {
      // The owner asks every time about the batch save, made the note a delete, and let the delete be a write.
      [`${CATALOG} ${BATCH}`]: { approval: 'always' },
      'post-note post-note': { risk: 'destructive' },
      [`${CATALOG} ${REMOVE}`]: { risk: 'write' },
      // And made the reset a read: it never asks, so it is not listed.
      [`${CATALOG} ${RESET}`]: { risk: 'read' },
    } }).choices(SCHEDULE);
    expect(save!.writes.map(({ op, offerable }) => [op, offerable])).toEqual([
      [BATCH, false], ['post-note', false], [REMOVE, true],
    ]);
  });

  it('names the steps that ask an AI, and offers its writes all the same (ruling 8)', async () => {
    const [summary] = await fixture().choices({ kind: 'schedule', schedule_id: 'sch_ai' });
    expect(summary).toMatchObject({ recipe_id: 'summarize-readings', ai_steps: ['sum'],
      writes: [{ op: BATCH, label: 'Save up to 100 daily readings in one transaction, all or none', offerable: true }] });
  });

  it('as a function, leaves out a step that calls no op or whose op the run decides', () => {
    const recipe = recipeOf('x', 'X', [
      { id: 'shape', transform: 'map', input: {} },
      { id: 'which', ingredient: CATALOG, input: { operation: '{{config.op}}', args: {} } },
      installed('save', 'daily_metric.batch'),
    ]);
    expect(recipeStepWrites(recipe, { manifestOf, packs: PACKS }).map((write) => write.op)).toEqual([BATCH]);
  });
});

describe('D-341 slice B2b — the recipes a trigger starts', () => {
  it('a schedule\'s and an event trigger\'s one; a gone one\'s none', async () => {
    const { choices } = fixture();
    expect((await choices(SCHEDULE)).map((choice) => choice.recipe_id)).toEqual(['save-readings']);
    expect((await choices(EVENT)).map((choice) => choice.recipe_id)).toEqual(['note-readings']);
    expect(await choices({ kind: 'schedule', schedule_id: 'sch_gone' })).toEqual([]);
    expect(await choices({ kind: 'event_trigger', trigger_id: 'trg_gone' })).toEqual([]);
  });

  it('every recipe a webhook\'s bindings run, and only those; one no longer installed is left out', async () => {
    const { choices } = fixture();
    expect((await choices(WEBHOOK)).map((choice) => choice.recipe_id)).toEqual(['note-readings', 'save-readings']);
    expect(await choices({ kind: 'webhook', ingress_id: 'whi_2' })).toEqual([]);
    expect(await choices({ kind: 'webhook', ingress_id: 'whi_none' })).toEqual([]);
  });

  it('an auto-run\'s, by its dish: the recipe its timer runs; a dish with no timer, none (B1b)', async () => {
    const { choices, rpc } = fixture();
    const timer = { kind: 'auto_run', dish_id: 'dsh_1' } as const;
    expect((await choices(timer)).map((choice) => choice.recipe_id)).toEqual(['summarize-readings']);
    expect(await choices({ kind: 'auto_run', dish_id: 'dsh_off' })).toEqual([]);
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: timer, recipe_id: 'summarize-readings',
      writes: [BATCH] });
    expect(preapproval).toMatchObject({ trigger: timer, state: 'live' });
    expect(preapproval.description).toContain('Summarize readings, when it runs on its own, may do this without asking');
    expect((await choices(timer))[0]!.preapprovals.map((row) => row.id)).toEqual([preapproval.id]);
    await expect(rpc['collection.contract.grantTriggerPreapproval']({ trigger: { kind: 'auto_run', dish_id: 'dsh_off' },
      recipe_id: 'summarize-readings', writes: [BATCH] })).rejects.toThrow(/that auto-run does not start Summarize readings/u);
  });

  it('a form\'s, by its endpoint: the recipe it is paired with; an unpaired form, none (B4)', async () => {
    const { choices, rpc } = fixture();
    const form = { kind: 'reception', endpoint_id: '-ep_1' } as const;
    expect((await choices(form)).map((choice) => choice.recipe_id)).toEqual(['note-readings']);
    expect(await choices({ kind: 'reception', endpoint_id: 'ep_gone' })).toEqual([]);
    // A pairing with no door yet still lists its recipe; a grant says why it cannot be given.
    expect((await choices({ kind: 'reception', endpoint_id: 'ep_new' })).map((choice) => choice.recipe_id)).toEqual(['note-readings']);
    const [write] = (await choices(form))[0]!.writes.filter((w) => w.offerable);
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: form, recipe_id: 'note-readings',
      writes: [write!.op] });
    expect(preapproval).toMatchObject({ trigger: form, door_contract_id: 'door-r1', state: 'live' });
    expect((await choices(form))[0]!.preapprovals.map((row) => row.id)).toEqual([preapproval.id]);
    await expect(rpc['collection.contract.grantTriggerPreapproval']({ trigger: { kind: 'reception', endpoint_id: 'ep_new' },
      recipe_id: 'note-readings', writes: [write!.op] })).rejects.toThrow(/pair it with the recipe again/u);
  });

  it('a webhook store that cannot list its recipes offers none', async () => {
    expect(await fixture({ webhookList: false }).choices(WEBHOOK)).toEqual([]);
  });
});

describe('D-341 slice B2b — this trigger\'s pre-approvals, beside what it may grant', () => {
  it('lists this trigger\'s own for the recipe, newest first, each with its state; not another trigger\'s', async () => {
    const { rpc, choices, advance } = fixture();
    const grant = (trigger: TriggerPreapprovalTrigger, recipe_id: string, writes: string[]) =>
      rpc['collection.contract.grantTriggerPreapproval']({ trigger, recipe_id, writes });
    const first = (await grant(SCHEDULE, 'save-readings', [BATCH])).preapproval;
    advance(1_000);
    const second = (await grant(SCHEDULE, 'save-readings', ['post-note'])).preapproval;
    await grant(WEBHOOK, 'save-readings', [BATCH]);
    const [save] = await choices(SCHEDULE);
    expect(save!.preapprovals.map((row) => [row.id, row.state])).toEqual([[second.id, 'live'], [first.id, 'live']]);
    expect(save!.preapprovals[0]).toMatchObject({ write_labels: ['Post a note to the team'], recipe_name: 'Save readings' });
    const [viaNote, viaWebhook] = await choices(WEBHOOK);
    expect(viaWebhook!.preapprovals.map((row) => row.trigger)).toEqual([WEBHOOK]);
    // Each recipe lists its own: the webhook's other recipe has none.
    expect(viaNote).toMatchObject({ recipe_id: 'note-readings', preapprovals: [] });
    // One the owner ended is still returned, with its state: the page decides what it shows. A year on,
    // the other is still on: it has no end of its own (ruling 10).
    await rpc['collection.contract.revokeTriggerPreapproval']({ id: first.id });
    advance(365 * DAY);
    expect((await choices(SCHEDULE))[0]!.preapprovals.map((row) => row.state)).toEqual(['live', 'revoked']);
  });

  it('refuses a request that names no trigger, an unknown kind or an empty id', async () => {
    const { rpc } = fixture();
    for (const args of [undefined, {}, { trigger: null }, { trigger: { kind: 'reception_form', door: 'x' } },
      { trigger: { kind: 'schedule', schedule_id: '' } }, { trigger: { kind: 'webhook', schedule_id: 'sch_1' } }]) {
      await expect(rpc['collection.contract.triggerPreapprovalChoices'](args), JSON.stringify(args))
        .rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('answers not_configured without the triggers or the store', async () => {
    const recipeStore = createRecipeStore('/nonexistent');
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    await expect(createTriggerPreapprovalRpcHandlers({ store, recipeStore, manifestOf })
      ['collection.contract.triggerPreapprovalChoices']({ trigger: SCHEDULE })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(createTriggerPreapprovalRpcHandlers({ recipeStore, manifestOf,
      targets: createTriggerPreapprovalTargets({}) })['collection.contract.triggerPreapprovalChoices']({ trigger: SCHEDULE }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('D-341 — a write the gate always reviews is listed, not offered (D-192 F1)', () => {
  const kernel = (slug: string): IngredientManifest | null => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null;

  it('a proposed commitment always asks; an unattended send and a plain task may be pre-approved', () => {
    const recipe = recipeOf('propose-and-tell', 'Propose and tell', [
      { id: 'propose', op: 'core.work-entity.commitment.propose', input: {} },
      { id: 'tell', op: 'core.mail.send', input: {} },
      { id: 'note', op: 'core.work-entity.task.create', input: {} },
    ]);
    expect(recipeStepWrites(recipe, { manifestOf: kernel }).map(({ op, offerable, reason }) => ({ op, offerable, reason }))).toEqual([
      { op: 'commitment-propose', offerable: false, reason: 'Each one needs your review.' },
      { op: 'mail-send', offerable: true },
      { op: 'task-create', offerable: true },
    ]);
  });
});

describe('D-341 — Recued\'s own writes, named as their switches are', () => {
  const kernel = (slug: string): IngredientManifest | null => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null;

  it('names them in the owner\'s words, not by what their manifests tell the AI', () => {
    const recipe = recipeOf('keep-and-tell', 'Keep and tell', [
      { id: 'keep', op: 'core.storage.shared.write', input: {} },
      { id: 'tell', op: 'core.mail.send', input: {} },
      { id: 'note', op: 'core.work-entity.task.create', input: {} },
      { id: 'propose', op: 'core.work-entity.commitment.propose', input: {} },
    ]);
    expect(recipeStepWrites(recipe, { manifestOf: kernel }).map((write) => write.label))
      .toEqual(['Save a value', 'Send an email', 'Create a task', 'Suggest a commitment']);
    // The pre-approval's own card and Contracts read the same words.
    expect(Object.fromEntries(recipeStepOpLabels(recipe, { manifestOf: kernel }))).toEqual({
      'shared-write': 'Save a value', 'mail-send': 'Send an email', 'task-create': 'Create a task',
      'commitment-propose': 'Suggest a commitment',
    });
  });

  it('names every write of Recued\'s own a step can call by its switch\'s title', () => {
    const named = KERNEL_MANIFESTS.filter((manifest) => manifest.operations === undefined
      && (manifest.risk_tier === 'write' || manifest.risk_tier === 'destructive')
      && kernelOpForBackingSlug(manifest.slug) !== undefined);
    // Not vacuous: nearly every built-in write is one (2026-11-08: 94 of 98).
    expect(named.length).toBeGreaterThan(90);
    for (const manifest of named) {
      const [write] = recipeStepWrites(recipeOf('one', 'One', [{ id: 'step', ingredient: manifest.slug, input: {} }]),
        { manifestOf: kernel });
      expect(write?.label, manifest.slug).toBe(grantSwitchText(kernelOpForBackingSlug(manifest.slug)!)?.title);
    }
  });
});

