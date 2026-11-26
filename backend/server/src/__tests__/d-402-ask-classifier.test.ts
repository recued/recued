/** D-402 slice F1 (§7.4) — one classifier for what a recipe's steps do about asking the owner, run as
 *  its caller: never, asks and can be approved ahead, or asks every time, with why. It reads what the
 *  gates read (each step at the caller's ceiling, with the owner's own rulings), a browser batch's
 *  uploads, secrets and downloads, the steps that ask an AI, and the steps of a recipe an operation
 *  runs (D-232). `recipeMayAsk` is its yes or no (`d-337-recipe-asks-owner.test.ts`). */

import { describe, expect, it } from 'vitest';
import type { ExecutionSource, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

import { classifyRecipeAsks, recipeMayAsk, type RecipeAskLookups, type RecipeStepAsk } from '../recipe-asks-owner.js';

const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local', turn_id: 't' } as ExecutionSource;
/** The Run button: the `admin` ceiling, where only what can't be approved ahead asks. */
const APP: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 't' } as ExecutionSource;

const recipe = (recipe_id: string, steps: unknown[]): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 300,
  metadata: { name: recipe_id, description: '', author: 'test', supported_platforms: [], tags: [] },
  variables: {}, steps,
}) as unknown as RecipeDefinition;

const CATALOG = {
  slug: 'crm-catalog',
  risk_tier: 'write',
  operations: {
    'deal.read': { operation_id: 'crm.deal.read', risk_tier: 'read', approval: 'never' },
    'deal.update': { operation_id: 'crm.deal.update', risk_tier: 'write', approval: 'ask' },
    'deal.close': { operation_id: 'crm.deal.close', risk_tier: 'write', approval: 'always' },
    'deal.delete': { operation_id: 'crm.deal.delete', risk_tier: 'destructive' },
  },
} as unknown as IngredientManifest;
/** A pack whose operation runs one of the owner's own recipes (D-232): an `mcp` binding, no connection. */
const LOCAL = {
  slug: 'bills-catalog',
  risk_tier: 'write',
  operations: { 'bill.file': { operation_id: 'bills.bill.file', risk_tier: 'write', approval: 'ask' } },
  surfaces: { api: { executes: { 'bill.file': { kind: 'mcp', tool: 'recued-core/file-bill' } } } },
} as unknown as IngredientManifest;

const RECIPES = new Map<string, RecipeDefinition>();
const lookups: RecipeAskLookups = {
  getManifest: (slug) => (slug === 'crm-catalog' ? CATALOG : slug === 'bills-catalog' ? LOCAL : undefined),
  packOps: () => new Map([
    ['acme.crm-pack', { catalog_slug: 'crm-catalog', operations: new Set(Object.keys(CATALOG.operations ?? {})) }],
    ['acme.bills', { catalog_slug: 'bills-catalog', operations: new Set(['bill.file']) }],
  ]) as unknown as PackOpResolution,
  recipeOf: (id) => RECIPES.get(id),
};
const op = (id: string, op: string, args: Record<string, unknown> = {}) => ({ id, op, args });
/** Each step's verdict, and its reason when it asks every time. */
const verdicts = (steps: readonly RecipeStepAsk[]) => steps.map((step) =>
  `${step.via.length > 0 ? `${step.via.join('>')}>` : ''}${step.step_id}:${step.verdict}${step.reason !== undefined ? `(${step.reason})` : ''}`);
const act = (id: string, steps: unknown[], page?: string) =>
  op(id, 'core.dom.act', { target: 'https://shop.example.com/*', steps, ...(page !== undefined ? { page } : {}) });

describe('D-402 slice F1 — what each step does about asking, at the caller\'s level', () => {
  it('in the owner\'s chat a write asks and can be approved ahead; from the Run button it does not ask', () => {
    const steps = [{ id: 'pick', transform: 'pick', input: '{{step.x}}' }, op('read', 'core.data.calendar.get'),
      op('add', 'core.data.calendar.create'), op('send', 'core.mail.send'), op('save', 'core.storage.shared.write')];
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), CHAT, lookups)))
      .toEqual(['pick:never', 'read:never', 'add:ahead', 'send:ahead', 'save:ahead']);
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), APP, lookups)))
      .toEqual(['pick:never', 'read:never', 'add:never', 'send:never', 'save:never']);
  });

  it('what no approval ahead stands in for asks every time, from the Run button too, saying why', () => {
    const steps = [op('remove', 'core.data.calendar.delete'), op('close', 'acme.crm-pack.deal.close'),
      op('drop', 'acme.crm-pack.deal.delete')];
    for (const source of [CHAT, APP]) {
      expect(verdicts(classifyRecipeAsks(recipe('r', steps), source, lookups)))
        .toEqual(['remove:still(destructive)', 'close:still(always)', 'drop:still(destructive)']);
    }
  });

  it('a review an op always gets asks every time', () => {
    const review = classifyRecipeAsks(recipe('r', [{ id: 'quote', ingredient: 'quote-signoff-release', input: {} }]), CHAT, {
      ...lookups, getManifest: (slug) => (slug === 'quote-signoff-release' ? { slug, risk_tier: 'write' } as IngredientManifest : undefined),
    });
    expect(verdicts(review)).toEqual(['quote:still(reviewed)']);
  });

  it('the owner\'s own ruling decides, as at run time: "always ask" asks every time; the chat\'s floor still holds a write', () => {
    const steps = [op('update', 'acme.crm-pack.deal.update')];
    const ruling = (approval: 'never' | 'always'): RecipeAskLookups => ({ ...lookups,
      ownerRuling: (ingredient, operation) => (ingredient === 'crm-catalog' && operation === 'crm.deal.update' ? { approval } : undefined) });
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), CHAT, lookups))).toEqual(['update:ahead']);
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), CHAT, ruling('always')))).toEqual(['update:still(always)']);
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), APP, ruling('always')))).toEqual(['update:still(always)']);
    // "Never ask" relaxes no write in the owner's chat: its `read` ceiling keeps it at ask (D-177 §N.15.7).
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), CHAT, ruling('never')))).toEqual(['update:ahead']);
    // Named as the gate names it, for a pre-approval to name it (D-211).
    expect(classifyRecipeAsks(recipe('r', steps), CHAT, lookups)[0]).toMatchObject({ slug: 'crm-catalog', operation_id: 'crm.deal.update' });
  });

  it('a step not readable before the run asks every time: a templated op, an op no pack serves, an undeclared operation', () => {
    const steps = [op('a', '{{config.op}}'), op('b', 'other.pack.thing.do'), op('c', 'acme.crm-pack.deal.merge'), { id: 'd' },
      { id: 'e', ingredient: 'crm-catalog', input: { operation: '{{config.op}}' } }];
    expect(verdicts(classifyRecipeAsks(recipe('r', steps), CHAT, lookups)))
      .toEqual(['a:still(unread)', 'b:still(unread)', 'c:still(unread)', 'd:still(unread)', 'e:still(unread)']);
  });

  it('a vendor-neutral write asks as its strictest CRM would; with no CRM it is not readable', () => {
    const crm: RecipeAskLookups = { ...lookups, neutralWriteTargets: (alias, verb) => [{ catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` }] };
    expect(verdicts(classifyRecipeAsks(recipe('r', [op('u', 'core.crm.deal.update'), op('s', 'core.crm.deal.search')]), CHAT, crm)))
      .toEqual(['u:ahead', 's:never']);
    expect(verdicts(classifyRecipeAsks(recipe('r', [op('c', 'core.crm.deal.close')]), CHAT, crm))).toEqual(['c:still(always)']);
    expect(verdicts(classifyRecipeAsks(recipe('r', [op('u', 'core.crm.deal.update')]), CHAT, lookups))).toEqual(['u:still(unread)']);
  });

  it('AI steps never ask and are marked; a download is saved without asking, and marked', () => {
    const steps = classifyRecipeAsks(recipe('r', [op('ai', 'core.ai.extract'), op('get', 'core.http.download', { url: 'https://x.example/a.pdf' })]), CHAT, lookups);
    expect(verdicts(steps)).toEqual(['ai:never', 'get:never']);
    expect(steps[0]).toMatchObject({ ai: true });
    expect(steps[1]).toMatchObject({ saves_files: true });
  });
});

describe('D-402 slice F1 — a browser batch, as the gates read it', () => {
  it('reads never ask, on the page it names or one it opens (a read since 2026-11-23); a click asks and can be approved ahead', () => {
    const page = 'bridge:work:3:D1';
    expect(verdicts(classifyRecipeAsks(recipe('r', [act('look', [{ do: 'read', form: 'outline' }], page)]), CHAT, lookups)))
      .toEqual(['look:never']);
    expect(verdicts(classifyRecipeAsks(recipe('r', [act('buy', [{ do: 'click', text: 'Buy', role: 'button' }], page)]), CHAT, lookups)))
      .toEqual(['buy:ahead']);
    expect(verdicts(classifyRecipeAsks(recipe('r', [act('go', [{ url: 'https://shop.example.com/', do: 'read', form: 'outline' }])]), CHAT, lookups)))
      .toEqual(['go:never']);
  });

  it('putting one of the owner\'s files into a page asks every time; its secrets and downloads are listed', () => {
    const batch = classifyRecipeAsks(recipe('r', [act('form', [
      { url: 'https://shop.example.com/login', do: 'type', text: 'Password', secret: 'password' },
      { do: 'type', text: 'Code', secret: 'sign-in code' },
      { do: 'download', text: 'Invoice' },
      { do: 'upload', text: 'Receipt', file: 'file:a9021e8eb9ceb5501e6137b8ac9ac32c' }])]), CHAT, lookups)[0]!;
    expect(batch).toMatchObject({ verdict: 'still', reason: 'upload', secrets: ['password', 'sign-in code'], saves_files: true });
    // From the Run button the batch's writes run, and its upload still never asks less than it does.
    expect(classifyRecipeAsks(recipe('r', [act('b', [{ url: 'https://shop.example.com/', do: 'click', text: 'Buy' }])]), APP, lookups)[0])
      .toMatchObject({ verdict: 'never' });
  });

  it('a batch whose steps don\'t parse is not readable before the run', () => {
    expect(verdicts(classifyRecipeAsks(recipe('r', [act('bad', [{ do: 'fly' }])]), CHAT, lookups))).toEqual(['bad:still(unread)']);
  });
});

describe('D-402 slice F1 — a recipe an operation runs (D-232) is read as its own steps', () => {
  it('its steps follow the operation\'s, by the path that ran them; one run again, or too deep, is not readable', () => {
    RECIPES.set('file-bill', recipe('file-bill', [op('note', 'core.storage.shared.write'), op('mail', 'core.mail.send'),
      op('remove', 'core.data.calendar.delete')]));
    const outer = classifyRecipeAsks(recipe('water-bill', [op('read', 'core.data.calendar.get'), op('file', 'acme.bills.bill.file')]), CHAT, lookups);
    expect(verdicts(outer)).toEqual(['read:never', 'file:ahead', 'file>note:ahead', 'file>mail:ahead', 'file>remove:still(destructive)']);
    expect(outer[2]).toMatchObject({ recipe_id: 'file-bill', via: ['file'] });
    // The recipe it runs runs it back: read once, then refused as not readable rather than read forever.
    RECIPES.set('file-bill', recipe('file-bill', [op('again', 'acme.bills.bill.file')]));
    expect(verdicts(classifyRecipeAsks(recipe('file-bill', [op('file', 'acme.bills.bill.file')]), CHAT, lookups)))
      .toEqual(['file:ahead', 'file>*:still(unread)']);
    RECIPES.delete('file-bill');
    // Not installed: the operation alone.
    expect(verdicts(classifyRecipeAsks(recipe('water-bill', [op('file', 'acme.bills.bill.file')]), CHAT, lookups))).toEqual(['file:ahead']);
  });

  it('recipeMayAsk is its yes or no: a recipe that only reads asks nothing', () => {
    expect(recipeMayAsk(recipe('r', [op('read', 'core.data.calendar.get'), act('look', [{ do: 'read', form: 'text' }], 'bridge:work:3:D1')]),
      CHAT, lookups)).toBe(false);
    expect(recipeMayAsk(recipe('r', [op('add', 'core.data.calendar.create')]), CHAT, lookups)).toBe(true);
  });
});
