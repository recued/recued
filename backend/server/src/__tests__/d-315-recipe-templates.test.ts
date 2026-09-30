/** D-315 §5.2 — the templates recipes bring: created at install from a
 *  recipe's starter, re-applied by its updates with the owner's settings kept,
 *  removed with it, and duplicated to edit. Over the real store; the recipes
 *  and their dishes are two small maps.
 *
 *  D-319 — a template setting is a DISH's: installing makes no dish, so it
 *  writes no setting (a new dish starts from `defaultsFor`), and everything
 *  that re-points a setting re-points every dish that holds it. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventTrigger, MailTemplateDefinition, RecipeDefinition } from '@recued/contracts';

import { createRecipeMailTemplates, type RecipeMailTemplates, type SettingsDish } from '../mail-facts/recipe-templates.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let recipes: Map<string, { publisher_id: string; definition: RecipeDefinition }>;
let dishes: Map<string, SettingsDish & { recipe_id: string }>;
let reconcile: ReturnType<typeof vi.fn<() => void>>;
let switchedOff: Array<(trigger: EventTrigger) => boolean>;
let changed: number;
let templates: RecipeMailTemplates;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-recipe-templates-'));
  db = new Database(join(dir, 'test.db'));
  store = createMailFactStore(db);
  recipes = new Map();
  dishes = new Map();
  reconcile = vi.fn<() => void>();
  switchedOff = [];
  changed = 0;
  templates = createRecipeMailTemplates({
    store,
    recipes: {
      get: (recipe_id) => recipes.get(recipe_id)?.definition ?? null,
      listStored: () => [...recipes].map(([recipe_id, row]) => ({
        recipe_id,
        publisher_id: row.publisher_id,
        recipe_json: JSON.stringify(row.definition),
      })),
    },
    settings: {
      dishesOf: (recipe_id) => [...dishes.values()].filter((dish) => dish.recipe_id === recipe_id),
      set: (dish_id, variable, value) => {
        const dish = dishes.get(dish_id)!;
        const next = { ...dish.config_overlay };
        if (value === null) delete next[variable];
        else next[variable] = value;
        dishes.set(dish_id, { ...dish, config_overlay: next });
      },
    },
    reconcileTriggers: reconcile,
    switchOffTriggers: async (match) => {
      switchedOff.push(match);
      return 0;
    },
    onTemplatesChanged: () => { changed += 1; },
    log: () => undefined,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const starter = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'Shop shipments',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
  rules: [
    { target: { variable: 'carrier' }, source: 'body', find: { kind: 'after_label', label: 'Carrier:' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } },
  ],
  html: false,
  ai: { enabled: true, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'byok_only' },
  ...over,
});

const recipe = (over: {
  id?: string;
  name?: string;
  starter?: MailTemplateDefinition | null;
  variable?: string;
} = {}): RecipeDefinition => {
  const variable = over.variable ?? 'template';
  const brought = over.starter === undefined ? starter() : over.starter;
  return {
    recipe_id: over.id ?? 'shop-shipments',
    version: 1,
    ttl: 0,
    metadata: { name: over.name ?? 'Shop shipments', description: 'x', author: 'test', supported_platforms: [] },
    variables: { [variable]: { label: 'Template', type: 'mail_template', ...(brought !== null ? { starter: brought } : {}) } },
    prefetch_steps: [],
    steps: [],
    event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'], template_variable: variable }],
    output: { render: [] },
  } as unknown as RecipeDefinition;
};

/** Save the recipe as an install does, then sync its templates. */
const install = (definition: RecipeDefinition, version = 1, choices: Parameters<RecipeMailTemplates['sync']>[1] = []) => {
  recipes.set(definition.recipe_id, { publisher_id: 'recued-core', definition });
  return templates.sync({ recipe: definition, publisher_id: 'recued-core', version, pack: 'shipments' }, choices);
};

/** A dish of a recipe — its main one unless named otherwise — holding
 *  `config_overlay`, as switching the recipe on makes it. */
const dishOf = (recipe_id: string, config_overlay: Record<string, unknown>, dish_id = `dsh_${recipe_id}`): void => {
  dishes.set(dish_id, { dish_id, recipe_id, is_default: dish_id === `dsh_${recipe_id}`, config_overlay });
};
/** The settings of a recipe's main dish; undefined with none. */
const settingsOf = (recipe_id: string): Record<string, unknown> | undefined =>
  [...dishes.values()].find((dish) => dish.recipe_id === recipe_id && dish.is_default)?.config_overlay;

const owners = (over: Partial<MailTemplateDefinition> = {}) =>
  store.createTemplate({ definition: { ...starter(), name: 'My shop', ai: { enabled: false }, ...over }, origin: { kind: 'owner' } });

describe('install', () => {
  it('creates the recipe’s template: its origin, AI off with the prompt kept, the free pool — and no setting, which a new dish starts from', () => {
    const [outcome] = install(recipe());
    const template = store.getTemplate(outcome!.template_id)!;
    expect(template.origin).toEqual({
      kind: 'recipe', publisher: 'recued-core', recipe: 'shop-shipments', variable: 'template', version: 1, pack: 'shipments',
    });
    // Off whatever the starter says; the author's pool is not the installer's.
    expect(template.ai).toEqual({ enabled: false, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'free_only' });
    expect(template.active).toBe(true);
    // D-319 — no dish yet, so nothing to write; switching on starts from it.
    expect(dishes.size).toBe(0);
    expect(templates.defaultsFor('shop-shipments')).toEqual({ template: template.template_id });
    expect(outcome).toMatchObject({ action: 'created', active: true, name: 'Shop shipments' });
    expect(reconcile).toHaveBeenCalled();
    expect(changed).toBeGreaterThan(0);
  });

  it('⛔ the recipe’s template is the one on, by default, where the owner’s reads the same mail — and what held the owner’s holds it', () => {
    // The same conditions as they are read: case and fullwidth letters are no difference.
    const mine = owners({ entrance: { conditions: [{ field: 'from', op: 'is', value: 'ＳＨＩＰ@shop.EXAMPLE' }], variables: ['tracking_number'] } });
    dishOf('another', { template: mine.template_id });
    recipes.set('another', { publisher_id: 'local', definition: recipe({ id: 'another', starter: null }) });
    const [outcome] = install(recipe());
    expect(store.getTemplate(mine.template_id)!.active).toBe(false);
    expect(store.getTemplate(outcome!.template_id)!.active).toBe(true);
    expect(outcome!.switched_off).toEqual({ template_id: mine.template_id, name: 'My shop' });
    // A dish keeps reading the mail it read.
    expect(settingsOf('another')).toEqual({ template: outcome!.template_id });
  });

  it('keeps the owner’s on when they choose it: the recipe’s is made off, and a new dish starts from the owner’s', () => {
    const mine = owners();
    const [outcome] = install(recipe(), 1, [{ recipe_id: 'shop-shipments', variable: 'template', keep: 'existing' }]);
    expect(store.getTemplate(mine.template_id)!.active).toBe(true);
    expect(store.getTemplate(outcome!.template_id)!.active).toBe(false);
    expect(templates.defaultsFor('shop-shipments')).toEqual({ template: mine.template_id });
    expect(outcome).toMatchObject({ active: false, uses: { template_id: mine.template_id, name: 'My shop' } });
    expect(outcome!.switched_off).toBeUndefined();
  });

  it('meets no one when the conditions differ', () => {
    const mine = owners({ entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'shop.example' }], variables: ['tracking_number'] } });
    const [outcome] = install(recipe());
    expect(store.getTemplate(mine.template_id)!.active).toBe(true);
    expect(outcome!.switched_off).toBeUndefined();
  });

  it('skips a starter it cannot store, and says nothing was made', () => {
    const outcomes = install(recipe({ starter: starter({ type: 'custom_ticket' as never }) }));
    expect(outcomes).toEqual([]);
    expect(store.listTemplates()).toEqual([]);
    expect(templates.defaultsFor('shop-shipments')).toEqual({});
  });

  it('D-319 — a reinstall fills every dish whose setting names no template, and leaves a dish’s own pick', () => {
    const mine = owners({ entrance: { conditions: [{ field: 'subject', op: 'contains', value: 'shipped' }], variables: [] } });
    recipes.set('shop-shipments', { publisher_id: 'recued-core', definition: recipe() });
    dishOf('shop-shipments', {});
    dishOf('shop-shipments', { template: mine.template_id }, 'dsh_home');
    dishOf('shop-shipments', { template: 'mtpl_gone' }, 'dsh_old');
    const [outcome] = install(recipe());
    expect(dishes.get('dsh_shop-shipments')!.config_overlay).toEqual({ template: outcome!.template_id });
    expect(dishes.get('dsh_home')!.config_overlay).toEqual({ template: mine.template_id });
    expect(dishes.get('dsh_old')!.config_overlay).toEqual({ template: outcome!.template_id });
    expect(templates.usersOf(outcome!.template_id).map((user) => user.dish_id).sort())
      .toEqual(['dsh_old', 'dsh_shop-shipments']);
  });
});

describe('what a new dish starts from (D-319)', () => {
  it('the recipe’s own template when it is on; the owner’s twin that kept it off; none without a starter', () => {
    const mine = owners();
    const [outcome] = install(recipe());
    expect(templates.defaultsFor('shop-shipments')).toEqual({ template: outcome!.template_id });
    // The owner switched theirs back on instead: it reads that mail now.
    store.updateTemplate(outcome!.template_id, { active: false });
    store.updateTemplate(mine.template_id, { active: true });
    expect(templates.defaultsFor('shop-shipments')).toEqual({ template: mine.template_id });
    // Neither on: the recipe's own, the one its author tested.
    store.updateTemplate(mine.template_id, { active: false });
    expect(templates.defaultsFor('shop-shipments')).toEqual({ template: outcome!.template_id });
    recipes.set('bare', { publisher_id: 'local', definition: recipe({ id: 'bare', starter: null }) });
    expect(templates.defaultsFor('bare')).toEqual({});
    expect(templates.defaultsFor('not-installed')).toEqual({});
  });
});

describe('update', () => {
  it('re-applies the rules and keeps the owner’s settings: off, the AI on, the pool', () => {
    const [first] = install(recipe());
    const id = first!.template_id;
    store.updateTemplate(id, {
      active: false,
      definition: { ...store.getTemplate(id)!, ai: { enabled: true, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'free_then_byok' } },
    });
    const revision = store.getTemplate(id)!.revision;
    const next = starter({
      rules: [
        { target: { variable: 'carrier' }, source: 'body', find: { kind: 'after_label', label: 'Shipped with:' } },
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } },
      ],
      ai: { enabled: true, prompt: 'Read the delivery window and the depot.', slots: ['data.window', 'data.depot'], pool: 'byok_only' },
    });
    const [outcome] = install(recipe({ starter: next }), 2);
    const template = store.getTemplate(id)!;
    expect(outcome).toMatchObject({ template_id: id, action: 'updated', active: false });
    expect(template.revision).toBe(revision + 1);
    expect(template.active).toBe(false);
    expect(template.rules[0]!.find).toEqual({ kind: 'after_label', label: 'Shipped with:' });
    // The recipe's prompt and slots; the owner's switch and pool.
    expect(template.ai).toEqual({
      enabled: true, prompt: 'Read the delivery window and the depot.', slots: ['data.window', 'data.depot'], pool: 'free_then_byok',
    });
    expect(template.origin).toMatchObject({ kind: 'recipe', version: 2 });
  });

  it('an update that changes nothing is no new revision — facts are not read again — but records the version', () => {
    const [first] = install(recipe());
    const before = store.getTemplate(first!.template_id)!;
    const [outcome] = install(recipe(), 2);
    const after = store.getTemplate(first!.template_id)!;
    expect(outcome!.action).toBe('unchanged');
    expect(after.revision).toBe(before.revision);
    expect(after.origin).toMatchObject({ version: 2 });
  });

  it('switches the AI off, its prompt kept, when the new rules no longer let it be on', () => {
    const [first] = install(recipe());
    const id = first!.template_id;
    store.updateTemplate(id, { definition: { ...store.getTemplate(id)!, ai: { enabled: true, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'free_only' } } });
    // A sender's domain alone is not enough for an AI that is on (§4.1); the
    // starter itself keeps its AI off, so it is one an author can ship.
    install(recipe({
      starter: starter({
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'shop.example' }], variables: [] },
        ai: { enabled: false, prompt: 'Read the delivery window.', slots: ['data.window'] },
      }),
    }), 2);
    expect(store.getTemplate(id)!.ai).toEqual({ enabled: false, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'free_only' });
  });

  it('keeps the dish’s pick in its setting, and repairs one that names no template', () => {
    const [first] = install(recipe());
    const mine = owners({ entrance: { conditions: [{ field: 'subject', op: 'contains', value: 'shipped' }], variables: [] } });
    dishOf('shop-shipments', { template: mine.template_id });
    install(recipe(), 2);
    expect(settingsOf('shop-shipments')).toEqual({ template: mine.template_id });
    dishOf('shop-shipments', { template: 'mtpl_gone' });
    install(recipe(), 3);
    expect(settingsOf('shop-shipments')).toEqual({ template: first!.template_id });
  });

  it('⛔ an update whose rules now read what the owner’s reads asks the same question, and keeps the owner’s when told', () => {
    const [first] = install(recipe());
    // Switched on since, from the recipe's own.
    dishOf('shop-shipments', { template: first!.template_id });
    const mine = owners({ entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: [] } });
    const moved = starter({ entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: ['tracking_number'] } });
    const [outcome] = install(recipe({ starter: moved }), 2, [{ recipe_id: 'shop-shipments', variable: 'template', keep: 'existing' }]);
    expect(store.getTemplate(first!.template_id)!.active).toBe(false);
    expect(store.getTemplate(mine.template_id)!.active).toBe(true);
    expect(settingsOf('shop-shipments')).toEqual({ template: mine.template_id });
    expect(outcome).toMatchObject({ active: false, uses: { template_id: mine.template_id } });
  });

  it('removes the template a new version no longer brings', async () => {
    const [first] = install(recipe());
    // The new version has no such setting at all.
    install({ ...recipe(), variables: {}, event_triggers: [] } as unknown as RecipeDefinition, 2);
    await vi.waitFor(() => expect(store.getTemplate(first!.template_id)).toBeNull());
  });

  it('leaves it, as the owner’s, when the new version still reads it: a dish holds it, with no starter now', async () => {
    const [first] = install(recipe());
    dishOf('shop-shipments', { template: first!.template_id });
    install(recipe({ starter: null }), 2);
    await vi.waitFor(() => expect(store.getTemplate(first!.template_id)!.origin).toEqual({ kind: 'owner' }));
    expect(settingsOf('shop-shipments')).toEqual({ template: first!.template_id });
  });
});

describe('uninstall', () => {
  it('removes the recipe’s template and switches off the rows narrowed to it', async () => {
    const [first] = install(recipe());
    recipes.delete('shop-shipments');
    await templates.removeFor('shop-shipments');
    expect(store.getTemplate(first!.template_id)).toBeNull();
    expect(switchedOff).toHaveLength(1);
    expect(switchedOff[0]!({ filter: { 'record.template': first!.template_id } } as unknown as EventTrigger)).toBe(true);
  });

  it('leaves it, as the owner’s, when another recipe’s setting holds it', async () => {
    const [first] = install(recipe());
    recipes.set('another', { publisher_id: 'local', definition: recipe({ id: 'another', starter: null }) });
    dishOf('another', { template: first!.template_id });
    recipes.delete('shop-shipments');
    await templates.removeFor('shop-shipments');
    expect(store.getTemplate(first!.template_id)!.origin).toEqual({ kind: 'owner' });
    expect(switchedOff).toEqual([]);
  });
});

describe('duplicate to edit', () => {
  it('makes the owner’s copy, which reads that mail in the original’s place, and re-points every dish that held it', () => {
    const [first] = install(recipe());
    dishOf('shop-shipments', { template: first!.template_id });
    dishOf('shop-shipments', { template: first!.template_id }, 'dsh_home');
    const copy = templates.duplicate(first!.template_id)!;
    expect(copy.origin).toEqual({ kind: 'owner' });
    expect(copy.name).toBe('Shop shipments (copy)');
    expect(copy.active).toBe(true);
    expect(store.getTemplate(first!.template_id)!.active).toBe(false);
    expect(settingsOf('shop-shipments')).toEqual({ template: copy.template_id });
    expect(dishes.get('dsh_home')!.config_overlay).toEqual({ template: copy.template_id });
    // The recipe still owns and updates its own, off.
    const [outcome] = install(recipe(), 2);
    expect(outcome).toMatchObject({ template_id: first!.template_id, active: false, uses: { template_id: copy.template_id } });
    expect(settingsOf('shop-shipments')).toEqual({ template: copy.template_id });
  });
});

describe('the install dialog', () => {
  it('lists what each starter reads, whether it adds or updates, the one it meets, and that the recipe starts on facts', () => {
    const mine = owners();
    const [entry] = templates.preview([recipe()]);
    expect(entry).toEqual({
      recipe_id: 'shop-shipments',
      recipe_name: 'Shop shipments',
      variable: 'template',
      name: 'Shop shipments',
      type: 'shipment',
      conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }],
      reads: ['carrier', 'tracking_number'],
      action: 'add',
      twin: { template_id: mine.template_id, name: 'My shop' },
      trigger: true,
    });
    store.updateTemplate(mine.template_id, { active: false });
    install(recipe());
    const [again] = templates.preview([recipe()]);
    expect(again).toMatchObject({ action: 'update' });
    expect(again).not.toHaveProperty('twin');
  });
});

describe('where a recipe’s facts come from (§5.2)', () => {
  const watching = (event_triggers: unknown[], over: { id?: string; starter?: MailTemplateDefinition | null } = {}): RecipeDefinition => ({
    ...recipe({ id: over.id ?? 'parcel-alerts', name: 'Parcel alerts', starter: over.starter ?? null }),
    event_triggers,
  } as unknown as RecipeDefinition);

  it('says, for each kind it starts on, the variables it watches and what reads them here', () => {
    owners({ entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: [] } });
    const [sources] = templates.factSources([watching([{ on: 'mail_fact.shipment', fields: ['tracking_number'] }])]);
    expect(sources).toEqual({
      recipe_id: 'parcel-alerts',
      recipe_name: 'Parcel alerts',
      kinds: [{ type: 'shipment', name: 'Shipment', variables: ['tracking_number'], standards: true, templates: 1, brought: false }],
    });
  });

  it('counts the template the install brings, and the standards pass only while it is on', () => {
    store.setStandardsOn('shipment', false);
    const bringing = watching([{ on: 'mail_fact.shipment' }], { id: 'shop', starter: starter() });
    const [sources] = templates.factSources([watching([{ on: 'mail_fact.shipment' }]), bringing]);
    expect(sources!.kinds).toEqual([
      { type: 'shipment', name: 'Shipment', variables: [], standards: false, templates: 0, brought: true },
    ]);
  });

  it('lists every kind with a watched variable for a trigger on any kind, and leaves out what its own template reads', () => {
    const [sources] = templates.factSources([watching([
      { on: 'mail_fact', fields: ['state'] },
      { on: 'mail_fact.bill', template_variable: 'template' },
    ])]);
    expect(sources!.kinds.map((kind) => kind.type)).toContain('shipment');
    expect(sources!.kinds.every((kind) => kind.variables.join() === 'state')).toBe(true);
    expect(templates.factSources([watching([{ on: 'mail_fact.bill', template_variable: 'template' }])])).toEqual([]);
    // Any kind on any change is every kind of email: too broad to say.
    expect(templates.factSources([watching([{ on: 'mail_fact' }])])).toEqual([]);
  });
});
