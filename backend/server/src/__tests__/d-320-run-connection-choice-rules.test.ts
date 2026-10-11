/** D-320 slice 2d — the rules of a run's own choice of connection, one at a time
 *  (`run-connection-choice.ts`, `pack-connection-slots.ts`,
 *  `recipe-connection-choices.ts`). `d-320-run-connection-choice.test.ts` drives
 *  them through the real handler; these are the cases that need a recipe shape or
 *  a store state the shipped packs do not have. */

import { describe, expect, it } from 'vitest';

import type { BulkPackManifest, IngredientManifest, RecipeDefinition } from '@recued/contracts';

import { authoredSlotOf, catalogSlotsFrom, clearAuthoredSlotCache } from '../pack-connection-slots.js';
import { recipeConnectionChoices } from '../recipe-connection-choices.js';
import {
  applyConnectionChoices,
  assertChoicesHeld,
  assertChoicesPlaced,
  chooseForVendorNeutral,
  connectionSteps,
  inheritableConnections,
  readConnectionChoices,
  runConnectionSlots,
  settledConnections,
  type RunConnectionSlot,
} from '../run-connection-choice.js';

const SLOT: RunConnectionSlot = { slot: 'hubspot', catalogs: ['crm', 'marketing'], variables: ['hubspot'] };
const BINDINGS = [
  { connection_name: 'key', catalog_slug: 'crm' },
  { connection_name: 'key', catalog_slug: 'marketing' },
  { connection_name: 'app', catalog_slug: 'crm' },
  { connection_name: 'app', catalog_slug: 'marketing' },
  // On one catalog only: not on the slot's list.
  { connection_name: 'half', catalog_slug: 'crm' },
];
const ENROLLED = new Set(['key', 'app', 'half']);

const apply = (over: Partial<Parameters<typeof applyConnectionChoices>[0]> = {}) =>
  applyConnectionChoices({
    recipe_id: 'r',
    slots: [SLOT],
    choices: { hubspot: 'app' },
    inherited: false,
    config: {},
    callerKeys: new Set(),
    bindings: BINDINGS,
    enrolled: ENROLLED,
    owner: true,
    ...over,
  });

const refusalOf = (fn: () => unknown): { code: string; message: string; details: Record<string, unknown> } => {
  try {
    fn();
  } catch (e) {
    return e as { code: string; message: string; details: Record<string, unknown> };
  }
  throw new Error('did not refuse');
};

describe('reading a choice', () => {
  it('takes names by slot, trimmed; nothing is no choice', () => {
    expect(readConnectionChoices({ hubspot: ' app ' })).toEqual({ hubspot: 'app' });
    expect(readConnectionChoices(undefined)).toBeUndefined();
    expect(readConnectionChoices({})).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const raw of ['app', ['app'], { hubspot: '' }, { hubspot: 1 }, { '': 'app' }]) {
      expect(refusalOf(() => readConnectionChoices(raw)).details.problem).toBe('malformed');
    }
  });
});

describe('the slots a run signs in through', () => {
  const recipe = {
    recipe_id: 'r',
    variables: {
      hubspot: { type: 'connection' },
      other: { type: 'connection' },
      text: { type: 'string' },
    },
    prefetch_steps: [{ id: 'p', ingredient: 'crm', connection: '{{config.hubspot}}' }],
    steps: [
      { id: 'a', ingredient: 'marketing', connection: '{{ config.hubspot }}' },
      { id: 'b', ingredient: 'crm', connection: '{{config.text}}' },
      { id: 'c', ingredient: 'crm', connection: 'literal' },
      { id: 'd', op: 'core.crm.deal.read', connection: '{{config.other}}' },
      { id: 'e', transform: 'template', template: 'x' },
    ],
  } as unknown as RecipeDefinition;

  it('are the catalog steps reading a connection setting, grouped by slot', () => {
    expect(connectionSteps(recipe)).toEqual([
      { catalog: 'crm', variable: 'hubspot' },
      { catalog: 'marketing', variable: 'hubspot' },
    ]);
    expect(runConnectionSlots(connectionSteps(recipe), new Map([['crm', 'hubspot'], ['marketing', 'hubspot']])))
      .toEqual([{ slot: 'hubspot', catalogs: ['crm', 'marketing'], variables: ['hubspot'] }]);
  });

  it("name the binding's recorded slot, else the pack manifest's, else the catalog", () => {
    clearAuthoredSlotCache();
    const manifest = {
      contents: [{ type: 'composition', composition: { slug: 'marketing', ingredients: [{ http: { connection: 'hubspot' } }] } }],
    } as unknown as BulkPackManifest;
    expect(authoredSlotOf(manifest, 'marketing')).toBe('hubspot');
    const read: string[] = [];
    const slots = catalogSlotsFrom(
      [
        { catalog_slug: 'crm', installed_pack_id: 'p', slot: 'hubspot' },
        { catalog_slug: 'marketing', installed_pack_id: 'p' },
        { catalog_slug: 'lonely', installed_pack_id: 'q' },
      ],
      ['crm', 'marketing', 'lonely', 'unbound'],
      (pack) => { read.push(pack); return pack === 'p' ? manifest : null; },
    );
    expect(Object.fromEntries(slots)).toEqual({
      crm: 'hubspot', marketing: 'hubspot', lonely: 'lonely', unbound: 'unbound',
    });
    expect(read).toEqual(['p', 'q']);
  });
});

describe('applying a choice', () => {
  it('writes the connection into the settings of its slot, over a dish value', () => {
    expect(apply({ config: { hubspot: 'key', note: 'x' } })).toEqual({
      config: { hubspot: 'app', note: 'x' },
      applied: ['hubspot'],
    });
  });

  it('leaves a slot no step of this shape uses for the later checks', () => {
    expect(apply({ choices: { salesforce: 'app' } })).toEqual({ config: {}, applied: [] });
  });

  it('refuses a connection bound to only some of the slot\'s catalogs, or not set up', () => {
    expect(refusalOf(() => apply({ choices: { hubspot: 'half' } })).message)
      .toBe("'half' is not one of the connections recipe 'r' can use for 'hubspot'. They are: app, key.");
    expect(refusalOf(() => apply({ enrolled: new Set(['key']) })).details).toEqual({ problem: 'not_on_list', slot: 'hubspot' });
  });

  it('names the list to the owner only, with aliases', () => {
    const owner = refusalOf(() => apply({ choices: { hubspot: 'half' }, displayName: (n) => (n === 'app' ? 'Sales app' : undefined) }));
    expect(owner.message).toContain('They are: app (Sales app), key.');
    const door = refusalOf(() => apply({ choices: { hubspot: 'half' }, owner: false }));
    expect(door.message).not.toMatch(/\bkey\b|\bapp\b/);
    expect(door.message).toContain("leave 'hubspot' out");
  });

  it("tells a called recipe's refusal from a caller's", () => {
    expect(refusalOf(() => apply({ choices: { hubspot: 'half' }, inherited: true })).message)
      .toContain('was called by a run that uses');
  });

  it("a dish's choice yields to a setting the run gives, and takes the slot's others", () => {
    const twoSettings: RunConnectionSlot = { slot: 'hubspot', catalogs: ['crm', 'marketing'], variables: ['a', 'b'] };
    expect(apply({
      slots: [twoSettings],
      dish: 'Main',
      config: { a: 'key' },
      callerKeys: new Set(['a']),
    })).toEqual({ config: { a: 'key', b: 'app' }, applied: ['hubspot'] });
    // Every setting given by the run: the dish's choice is not used, stale or not.
    expect(apply({
      slots: [twoSettings],
      dish: 'Main',
      choices: { hubspot: 'gone' },
      config: { a: 'key', b: 'key' },
      callerKeys: new Set(['a', 'b']),
    })).toEqual({ config: { a: 'key', b: 'key' }, applied: [] });
  });

  it("refuses the run's own values giving the setting as another connection", () => {
    expect(refusalOf(() => apply({ config: { hubspot: 'key' }, callerKeys: new Set(['hubspot']) })).details.problem)
      .toBe('conflict');
    expect(apply({ config: { hubspot: 'app' }, callerKeys: new Set(['hubspot']) }).applied).toEqual(['hubspot']);
  });
});

describe('a vendor-neutral op-step', () => {
  const choose = (over: Partial<Parameters<typeof chooseForVendorNeutral>[0]> = {}) =>
    chooseForVendorNeutral({
      recipe_id: 'r',
      variables: ['crm'],
      choices: { hubspot: 'app' },
      config: {},
      callerKeys: new Set(),
      candidatesFor: () => ['app', 'key', 'sf'],
      ...over,
    });

  it('takes the one chosen connection that can serve it', () => {
    expect(choose()).toEqual({ config: { crm: 'app' }, applied: ['hubspot'] });
    expect(choose({ candidatesFor: () => ['key'] })).toEqual({ config: {}, applied: [] });
  });

  it('refuses two that can, and the run giving it as another', () => {
    expect(refusalOf(() => choose({ choices: { hubspot: 'app', salesforce: 'sf' } })).details.problem).toBe('ambiguous');
    expect(refusalOf(() => choose({ config: { crm: 'key' }, callerKeys: new Set(['crm']) })).details.problem)
      .toBe('conflict');
  });
});

describe('the checks before and after the steps resolve', () => {
  it('refuses a choice nothing took: a slot the run lacks, or a connection no step can use', () => {
    const placed = (over: Partial<Parameters<typeof assertChoicesPlaced>[0]>) => () => assertChoicesPlaced({
      recipe_id: 'r', choices: { hubspot: 'other' }, inherited: false, placed: [], slots: [SLOT], owner: true, ...over,
    });
    expect(refusalOf(placed({})).details).toEqual({ problem: 'unknown_slot', slot: 'hubspot' });
    expect(refusalOf(placed({ vendorNeutralCandidates: ['app', 'key'] })).message)
      .toBe("'other' cannot run recipe 'r's steps for 'hubspot'. Connections that can: app, key.");
    expect(refusalOf(placed({ vendorNeutralCandidates: ['app'], owner: false })).message).not.toMatch(/\bapp\b/);
    expect(placed({ placed: ['hubspot'] })).not.toThrow();
    expect(placed({ inherited: true })).not.toThrow();
  });

  it('refuses a resolved run whose slot is not on the named connection', () => {
    const held = (over: Partial<Parameters<typeof assertChoicesHeld>[0]>) => () => assertChoicesHeld({
      recipe_id: 'r', slots: [SLOT], choices: { hubspot: 'app' }, inherited: false, config: { hubspot: 'app' },
      variables: {}, bindings: BINDINGS, enrolled: ENROLLED, owner: true, ...over,
    });
    expect(held({})).not.toThrow();
    expect(refusalOf(held({ config: { hubspot: 'key' } })).details).toEqual({ problem: 'not_on_list', slot: 'hubspot' });
    expect(refusalOf(held({ choices: { stripe: 'app' } })).message)
      .toBe("Recipe 'r' signs in to no 'stripe'. The connections it uses: 'hubspot'.");
    expect(held({ choices: { stripe: 'app' }, inherited: true })).not.toThrow();
    expect(refusalOf(held({ config: {}, inherited: true })).message).toContain('was called by a run');
  });
});

describe("the connections a run's slots settled on", () => {
  it('are each setting\'s value, else its default; a slot reading two lists both', () => {
    const slots: RunConnectionSlot[] = [
      { slot: 'hubspot', catalogs: ['crm'], variables: ['a', 'b'] },
      { slot: 'wise', catalogs: ['w'], variables: ['w'] },
      { slot: 'empty', catalogs: ['e'], variables: ['e'] },
    ];
    const used = settledConnections(slots, { a: 'key', b: 'app' }, { w: { type: 'connection', default: 'wise-1' } } as never);
    expect(used).toEqual([
      { slot: 'hubspot', connection_name: 'app' },
      { slot: 'hubspot', connection_name: 'key' },
      { slot: 'wise', connection_name: 'wise-1' },
    ]);
    // A called recipe inherits only a slot that settled on one.
    expect(inheritableConnections(used)).toEqual({ wise: 'wise-1' });
  });
});

describe('the recipe tools offer a slot whose list has two or more', () => {
  const scan = (bindings: Array<[string, string]>) => (scope: string) =>
    scope === 'connection_catalog_binding'
      ? bindings.map(([name, catalog]) => ({
          segments: [name, catalog],
          value: { catalog_slug: catalog, installed_pack_id: 'hubspot', slot: 'hubspot' },
        }))
      : [];
  const recipe = (catalogs: string[]) => ({
    recipe_id: 'r',
    variables: { hubspot: { type: 'connection' } },
    steps: catalogs.map((catalog, i) => ({ id: `s${i}`, ingredient: catalog, connection: '{{config.hubspot}}' })),
  }) as unknown as RecipeDefinition;
  const choices = (bindings: Array<[string, string]>, catalogs: string[]) => recipeConnectionChoices({
    contractScan: scan(bindings),
    manifests: { get: () => null as IngredientManifest | null },
    enrolled: new Set(['key', 'app']),
    displayName: () => undefined,
  })(recipe(catalogs));

  it('lists both where each catalog has both', () => {
    expect(choices([['key', 'crm'], ['app', 'crm']], ['crm']).map((s) => s.connections.map((c) => c.connection_name)))
      .toEqual([['app', 'key']]);
  });

  it('offers nothing where the slot spans a catalog with one', () => {
    expect(choices([['key', 'crm'], ['app', 'crm'], ['key', 'marketing']], ['crm', 'marketing'])).toEqual([]);
  });
});
