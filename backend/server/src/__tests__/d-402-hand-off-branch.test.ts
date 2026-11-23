/** D-402 slice E4c (§6.6) — the way a carried-on chat took, added to the recipe as a branch.
 *
 *  The recipe (X) and what the chat did (D) are compiled by the real compiler; the merge is checked
 *  as a recipe saved in Kitchen is, and run by the real engine on each kind of page, with each Act
 *  call standing in as the page it would read: the way the page showed runs, the other is skipped,
 *  and a page that shows neither hands off. */
import { describe, expect, it } from 'vitest';
import { executeRecipe } from '@recued/engine';
import { parseRecipe } from '@recued/recipes';
import type { RecipeDefinition, RecipeStep } from '@recued/contracts';
import type { BrowserPlanActedStep, BrowserPlanCallWithSteps } from '../bridges/browser-flow-record.js';
import { compilePlan, handOffReason } from '../plan-compiler.js';
import { validateRecipeInline } from '../recipe-save-handler.js';
import { mergeHandOffBranch } from '../hand-off-branch.js';
import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { createKitchenDraftStore } from '../kitchen-draft-store.js';
import { makeRequestRecipeDraft } from '../request-recipe.js';

let n = 0;
const call = (recipe_id: string, args: Record<string, unknown>, over: Partial<BrowserPlanCallWithSteps> = {}): BrowserPlanCallWithSteps => {
  n += 1;
  return { run_id: `run-${String(n)}`, recipe_id, args, started_at: n, finished_at: n, outcome: 'done', bridge_ids: ['work'],
    acted: [], ...over };
};
const acted = (position: number, kind: BrowserPlanActedStep['do'], url: string, role: string, label: string,
  over: Partial<BrowserPlanActedStep> = {}): BrowserPlanActedStep =>
  ({ do: kind, url, title: 'Page', element: { role, label }, at: 1, position, ...over });
const shows = (page: string, url: string) => [{ step_id: 'inspect', result: { page, url, title: 'Page', html: '<main></main>' } }];
const checked = (recipe: unknown): RecipeDefinition => {
  const parsed = parseRecipe(recipe);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  expect(validateRecipeInline(parsed.recipe).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  return parsed.recipe;
};

const PRODUCT = 'https://shop.example.com/item/7';
const T = '{{step.act_1.tabs.0.reads.0.text}}';
const page = (stock: string) => `<main><h1>Desk lamp</h1><p class="stock">${stock}</p><p>Free returns within 30 days.</p></main>`;
/** A job that read the product's page and did `label` (`selector`) on it, deciding on `stock`. */
const job = (stock: string, label: string, selector: string, criterion: string) => compilePlan({
  by: 'chat',
  calls: [
    call('inspect-web-page', { page: PRODUCT }, { results: shows('bridge:work:3:P1', PRODUCT),
      reads: [{ page: 'bridge:work:3:P1', url: PRODUCT, html: page(stock) }] }),
    call('act-on-web-page', { page: 'bridge:work:3:P1', steps: [{ do: 'click', ref: 'e1' }] }, {
      acted: [acted(1, 'click', PRODUCT, 'button', label, { element: { role: 'button', label, selector } })],
      results: [{ step_id: 'act', result: { done: 1, of: 1, page: 'bridge:work:3:P1', url: PRODUCT } }] }),
  ],
  judgements: [{ kind: 'decide', chose: stock, criterion }],
}).recipe;
const X = (): RecipeDefinition => ({ ...checked(job('In stock', 'Buy now', '#buy', 'Buy it only when it is in stock.')), recipe_id: 'buy-lamp', version: 3 });
const D = (stock = 'Out of stock', label = 'Add to wishlist', selector = '#wishlist') =>
  checked(job(stock, label, selector, 'Out of stock, so it went on the wishlist.'));

/** The merged recipe, run by the real engine on a page showing `text`: each Act call stands in as
 *  that page, and the run says which Act calls ran and how it ended. */
const runOn = async (recipe: RecipeDefinition, text: string) => {
  const steps = (recipe.steps as unknown as Array<Record<string, unknown>>).map((step) => step.op === 'core.dom.act'
    ? { id: step.id, transform: 'set', source: {}, field: 'tabs', value: [{ page: 'P1', reads: [{ step: 1, text }] }],
      ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}) }
    : step);
  const result = await executeRecipe({ recipe: { ...recipe, steps: steps as unknown as RecipeStep[] },
    stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: async () => null });
  const acts = (recipe.steps as unknown as Array<{ id: string; op?: string }>).filter((step) => step.op === 'core.dom.act').map((step) => step.id);
  const ran = result.steps.filter((step) => acts.includes(step.id) && step.skipped !== true).map((step) => step.id);
  return { ran, error: result.errors?.[0] as { code?: string; message?: string } | undefined };
};

describe('D-402 slice E4c — the chat\'s way, added to the recipe as a branch', () => {
  it('the decision knows both ways and stops only on neither; each way runs on its own page', async () => {
    const merged = mergeHandOffBranch({ recipe: X(), step_id: 'decide_1', branch: D() });
    if (!merged.ok) throw new Error(merged.why);
    const recipe = checked(merged.recipe);
    expect(merged.shown).toBe('Out of stock');
    expect(recipe.steps.map((step) => (step as { id: string }).id))
      .toEqual(['act_1', 'decide_1_met', 'decide_1', 'act_2', 'decide_1_b', 'decide_1_b_act_2']);
    const byId = Object.fromEntries((recipe.steps as unknown as Array<Record<string, unknown>>).map((step) => [step.id, step]));
    expect(byId.decide_1_met).toEqual({ id: 'decide_1_met', transform: 'any', conditions: [`${T} contains In stock`, `${T} contains Out of stock`] });
    expect(byId.decide_1).toEqual({ id: 'decide_1', guard: '{{step.decide_1_met}} equal false', hand_off: true,
      fail_reason: handOffReason('shop.example.com', ['In stock', 'Out of stock']) });
    expect(byId.act_2).toMatchObject({ skip_when: `${T} not_contains In stock` });
    expect(byId.decide_1_b).toEqual({ id: 'decide_1_b', transform: 'any', conditions: [`${T} not_contains Out of stock`, `${T} contains In stock`] });
    // The chat's click, continued on the tab the recipe's own read is on.
    expect(byId.decide_1_b_act_2).toEqual({ id: 'decide_1_b_act_2', op: 'core.dom.act', skip_when: '{{step.decide_1_b}} equal true',
      args: { target: 'https://shop.example.com/*', steps: [{ page: '{{step.act_1.tabs.0.page}}', do: 'click', selector: '#wishlist' }],
        bridge_id: '{{config.browser}}' } });
    expect(recipe.metadata.description).toMatch(/It uses no AI\. When shop\.example\.com shows “Out of stock”, it goes on the way your AI took then in the chat\.$/u);
    expect(merged.note).toBe('When shop.example.com shows “Out of stock”, the recipe now goes on the way your AI took in the chat. '
      + 'It still stops, for you to carry on, on a page that shows none of “In stock”, “Out of stock”.');

    expect(await runOn(recipe, 'Desk lamp\nIn stock\nFree returns.')).toEqual({ ran: ['act_1', 'act_2'], error: undefined });
    expect(await runOn(recipe, 'Desk lamp\nOut of stock\nFree returns.')).toEqual({ ran: ['act_1', 'decide_1_b_act_2'], error: undefined });
    // A page that shows both goes the first way.
    expect((await runOn(recipe, 'In stock at the store; Out of stock online')).ran).toEqual(['act_1', 'act_2']);
    const neither = await runOn(recipe, 'Desk lamp\nDiscontinued');
    expect(neither.ran).toEqual(['act_1']);
    expect(neither.error).toMatchObject({ code: 'RECIPE_HAND_OFF', message: handOffReason('shop.example.com', ['In stock', 'Out of stock']) });
  });

  it('a third way joins the two: the decision knows all three, and each runs only where none before it shows', async () => {
    const first = mergeHandOffBranch({ recipe: X(), step_id: 'decide_1', branch: D() });
    if (!first.ok) throw new Error(first.why);
    const second = mergeHandOffBranch({ recipe: checked(first.recipe), step_id: 'decide_1', branch: D('Pre-order', 'Pre-order now', '#preorder') });
    if (!second.ok) throw new Error(second.why);
    const recipe = checked(second.recipe);
    const byId = Object.fromEntries((recipe.steps as unknown as Array<Record<string, unknown>>).map((step) => [step.id, step]));
    expect(byId.decide_1_met).toMatchObject({ conditions: [`${T} contains In stock`, `${T} contains Out of stock`, `${T} contains Pre-order`] });
    expect(byId.decide_1_c).toEqual({ id: 'decide_1_c', transform: 'any',
      conditions: [`${T} not_contains Pre-order`, `${T} contains In stock`, `${T} contains Out of stock`] });
    expect(recipe.steps.map((step) => (step as { id: string }).id).slice(-2)).toEqual(['decide_1_c', 'decide_1_c_act_2']);
    expect((await runOn(recipe, 'Pre-order: ships in May')).ran).toEqual(['act_1', 'decide_1_c_act_2']);
    expect((await runOn(recipe, 'Out of stock')).ran).toEqual(['act_1', 'decide_1_b_act_2']);
    expect((await runOn(recipe, 'In stock')).ran).toEqual(['act_1', 'act_2']);
    expect((await runOn(recipe, 'Gone')).error).toMatchObject({ code: 'RECIPE_HAND_OFF',
      message: handOffReason('shop.example.com', ['In stock', 'Out of stock', 'Pre-order']) });
  });

  it('the chat\'s settings come with its steps; one that clashes, or an AI way, is said', () => {
    const typed = D();
    const steps = typed.steps as unknown as Array<Record<string, unknown>>;
    steps[2] = { ...steps[2]!, args: { target: 'https://shop.example.com/*', steps: [
      { page: '{{step.act_1.tabs.0.page}}', do: 'type', selector: '#note', text: '{{config.note}}' }] } };
    const withSetting = { ...typed, variables: { note: { label: 'Note', type: 'string', default: 'Back soon?' } } } as unknown as RecipeDefinition;
    const merged = mergeHandOffBranch({ recipe: X(), step_id: 'decide_1', branch: withSetting });
    expect(merged.ok && (merged.recipe.variables as Record<string, unknown>).note).toEqual({ label: 'Note', type: 'string', default: 'Back soon?' });
    const clash = mergeHandOffBranch({ recipe: { ...X(), variables: { note: { label: 'Note', type: 'string', default: 'Other' } } } as unknown as RecipeDefinition,
      step_id: 'decide_1', branch: withSetting });
    expect(clash).toEqual({ ok: false, why: 'a setting your AI\'s way needs, “note”, means something else in the recipe' });

    const ai = D();
    (ai.steps as unknown as Array<Record<string, unknown>>).push({ id: 'write_1', op: 'core.ai.prompt', args: {} });
    const withAi = mergeHandOffBranch({ recipe: X(), step_id: 'decide_1', branch: ai });
    expect(withAi.ok && withAi.recipe.metadata.description).not.toContain('It uses no AI.');
    expect(withAi.ok && withAi.recipe.metadata.description).toMatch(/in the chat\. That way uses AI\.$/u);
  });

  it('refuses what it cannot follow, saying why', () => {
    const refusal = (recipe: RecipeDefinition, branch: RecipeDefinition, step_id = 'decide_1') => {
      const merged = mergeHandOffBranch({ recipe, step_id, branch });
      return merged.ok ? 'merged' : merged.why;
    };
    expect(refusal(X(), D(), 'decide_9')).toBe('the step where it stopped is no longer in the recipe');
    expect(refusal(X(), D(), 'act_2')).toBe('the step where it stopped no longer hands off');
    const edited = X();
    (edited.steps as unknown as Array<Record<string, unknown>>)[1]!.guard = `${T} not_contains In stock now`;
    expect(refusal(edited, D('In stock now'))).toBe('the recipe already goes on when the page shows “In stock now”');
    expect(refusal(X(), D('Not In stock'))).toBe('a page that shows “Not In stock” also shows “In stock”, which the recipe goes on with first');
    const noDecision = D();
    noDecision.steps = (noDecision.steps as unknown as Array<Record<string, unknown>>).filter((step) => step.guard === undefined) as unknown as RecipeStep[];
    expect(refusal(X(), noDecision)).toBe('nothing says what the page showed when your AI took this way');
    const reachesBack = D();
    (reachesBack.steps as unknown as Array<Record<string, unknown>>).unshift({ id: 'earlier', transform: 'set', source: {}, field: 'x', value: 1 });
    (reachesBack.steps as unknown as Array<Record<string, unknown>>)[3]!.args = { target: 'https://shop.example.com/*',
      steps: [{ page: '{{step.act_1.tabs.0.page}}', do: 'type', selector: '#q', text: '{{step.earlier.x}}' }] };
    expect(refusal(X(), reachesBack)).toBe('a step your AI took uses something it read before the page showed it');
    const ownCondition = X();
    (ownCondition.steps as unknown as Array<Record<string, unknown>>)[2]!.skip_when = '{{config.x}} equal 1';
    expect(refusal(ownCondition, D())).toBe('a step after its decision already has a condition of its own');
    // A run stopped by D4's check, that the page still shows a value the recipe types: a hand-off, not a decision.
    const valueCheck = X();
    (valueCheck.steps as unknown as Array<Record<string, unknown>>)[1] = { id: 'check_1', hand_off: true,
      guard: '{{step.act_1.tabs.0.reads.0.collection.records.0.values.value}} is_empty', fail_reason: 'What this recipe types was not on shop.example.com.' };
    expect(refusal(valueCheck, D(), 'check_1')).toBe('it stopped where a page no longer showed a value the recipe types, which is not a choice between ways');
  });
});

describe('D-402 slice E4c — "Make a recipe" in a chat that carried on a run', () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  /** The chat's plan: it read the product's page, which showed `stock`, and added the lamp to the wishlist. */
  const chatPlan = (stock = 'Out of stock'): BrowserPlanCallWithSteps[] => [
    call('inspect-web-page', { page: 'bridge:work:9:P2' }, { results: shows('bridge:work:9:P2', PRODUCT),
      reads: [{ page: 'bridge:work:9:P2', url: PRODUCT, html: page(stock) }] }),
    call('act-on-web-page', { page: 'bridge:work:9:P2', steps: [{ do: 'click', ref: 'e4' }] }, {
      acted: [acted(1, 'click', PRODUCT, 'button', 'Add to wishlist', { element: { role: 'button', label: 'Add to wishlist', selector: '#wishlist' } })],
      results: [{ step_id: 'act', result: { done: 1, of: 1, page: 'bridge:work:9:P2', url: PRODUCT } }] }),
  ];
  const stand = (over: { decided?: boolean; installed?: boolean } = {}) => {
    const db = new Database(':memory:'); databases.push(db);
    const kitchen = createKitchenDraftStore(db);
    const recipe = { ...X(), metadata: { ...X().metadata, name: 'Buy the lamp' } } as RecipeDefinition;
    const asked: Array<Record<string, unknown>> = [];
    const make = makeRequestRecipeDraft({
      flows: { planFor: () => chatPlan() },
      resolveRoot: () => 'req-1',
      kitchenDrafts: kitchen,
      labelPlan: async (input) => {
        asked.push(input as unknown as Record<string, unknown>);
        // The label in the model's own case: the draft tests the page's (slice E4d).
        return { ok: true, left_out: [], judgements: over.decided === false ? []
          : [{ kind: 'decide' as const, chose: 'out of stock', criterion: 'It was out of stock, so it went on the wishlist.' }] };
      },
      carryOn: (session_id) => (session_id === 'chat-carry' ? { recipe_id: 'buy-lamp', step_id: 'decide_1' } : undefined),
      recipes: (recipe_id) => (over.installed === false || recipe_id !== 'buy-lamp' ? undefined : recipe),
    });
    return { kitchen, make, asked };
  };

  it('drafts the way as changes to the run\'s recipe, which Kitchen opens on the recipe itself', async () => {
    const t = stand();
    const answer = await t.make({ session_id: 'chat-carry', turn_id: 't-1' });
    if (!answer.ok) throw new Error(JSON.stringify(answer));
    // Slice E4d — the labelling call knew the request carried on the run, and the ways its recipe knows.
    expect(t.asked[0]?.carried_on).toEqual({ recipe: 'Buy the lamp', went_on_when: ['In stock'] });
    expect(answer).toMatchObject({ recipe_id: 'buy-lamp', kitchen_path: '/webclient/#kitchen/recipe/buy-lamp' });
    const draft = t.kitchen.get(answer.draft_id)!;
    expect(draft).toMatchObject({ base: { recipe_id: 'buy-lamp', version: 3 }, title: 'Buy the lamp', validation: { valid: true },
      made_from: { kind: 'chat_request', session_id: 'chat-carry', turn_id: 't-1' } });
    expect(draft.notes?.[0]).toBe('When shop.example.com shows “Out of stock”, the recipe now goes on the way your AI took in the chat. '
      + 'It still stops, for you to carry on, on a page that shows none of “In stock”, “Out of stock”.');
    // The chat's own decision is the branch now, so the compiler's note on it is not kept.
    expect(draft.notes?.some((note) => note.startsWith('The job decided which way to go'))).toBe(false);
    const source = JSON.parse(draft.source) as { recipe_id: string; steps: Array<{ id: string }> };
    expect(source.recipe_id).toBe('buy-lamp');
    expect(source.steps.map((step) => step.id)).toEqual(['act_1', 'decide_1_met', 'decide_1', 'act_2', 'decide_1_b', 'decide_1_b_act_2']);
    expect(t.kitchen.listAll().find((item) => item.draft_id === answer.draft_id)).toMatchObject({ base: { recipe_id: 'buy-lamp' } });
    // One item of changes per recipe: a second is refused until these are saved or discarded.
    expect(await t.make({ session_id: 'chat-carry', turn_id: 't-1' })).toEqual({ ok: false, reason: 'changes_in_progress',
      issues: ['Changes to “Buy the lamp” are already in progress in Kitchen. Save or discard them there, then make the recipe again.'] });
  });

  it('a way it cannot add, or a recipe since removed: a recipe of its own, saying why', async () => {
    const undecided = await stand({ decided: false }).make({ session_id: 'chat-carry', turn_id: 't-1' });
    expect(undecided).toMatchObject({ ok: true, kitchen_path: expect.stringContaining('#kitchen/import/') });
    expect(undecided.ok && undecided.recipe_id).toBe(undefined);
    expect(undecided.ok && undecided.issues[0]).toBe('Recued could not add this way to “Buy the lamp”, because nothing says what the '
      + 'page showed when your AI took this way, so this is a recipe of its own.');
    const gone = await stand({ installed: false }).make({ session_id: 'chat-carry', turn_id: 't-1' });
    expect(gone.ok && gone.issues[0]).toBe('The recipe this chat carried on is no longer installed, so this is a recipe of its own.');
    // A chat that carries on nothing makes its own recipe, as before, and its labelling call is not told otherwise.
    const other = stand();
    const plain = await other.make({ session_id: 'chat-other', turn_id: 't-1' });
    expect(other.asked[0]).not.toHaveProperty('carried_on');
    expect(plain.ok && plain.recipe_id).toBe(undefined);
    expect(plain.ok && plain.issues.some((note) => note.startsWith('Recued could not add'))).toBe(false);
  });
});
