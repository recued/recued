/** D-315 §5.2 — installing a recipe that brings a starter template: a pack's
 *  install and its preview, and a recipe installed on its own. Over the real
 *  recipe, dish and mail-fact stores and the real sync; only the marketplace
 *  is scripted.
 *
 *  D-319 — installing makes no dish, so it writes no setting: what the
 *  install chose is what a new dish of the recipe starts from
 *  (`defaultsFor`, behind `dishes.defaults`). */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type MailTemplateDefinition,
  type RecipeDefinition,
} from '@recued/contracts';
import type { MarketplaceRecipeResult } from '@recued/marketplace';

import { createDishStore, type DishStore } from '../dish-store.js';
import { createRecipeMailTemplates, type RecipeMailTemplates } from '../mail-facts/recipe-templates.js';
import {
  handlePacksInstall,
  installRecipeBySlug,
  makePackInstallHandlers,
  type PackInstallRpcDeps,
} from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;
let mailFacts: MailFactStore;
let dishes: DishStore;
let templates: RecipeMailTemplates;
let deps: PackInstallRpcDeps;

const starter: MailTemplateDefinition = {
  name: 'Shop parcels',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
  rules: [
    { target: { variable: 'carrier' }, source: 'body', find: { kind: 'after_label', label: 'Carrier:' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } },
  ],
  html: false,
  ai: { enabled: false },
};

const parcels = (): RecipeDefinition => ({
  recipe_id: 'shop-parcels',
  version: 1,
  ttl: 0,
  metadata: { name: 'Shop parcels', description: 'Parcels from the shop.', author: 'recued-core', supported_platforms: [], tags: [] },
  variables: { template: { label: 'Template', type: 'mail_template', starter } },
  event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'], template_variable: 'template' }],
  prefetch_steps: [],
  steps: [{ id: 'template', transform: 'coalesce', values: ['{{config.template}}'] }],
  output: { render: [{ type: 'summary', source: 'step.template' }] },
} as unknown as RecipeDefinition);

/** A recipe that starts on parcels, bringing no template of its own. */
const alerts = (): RecipeDefinition => ({
  ...parcels(),
  recipe_id: 'parcel-alerts',
  metadata: { name: 'Parcel alerts', description: 'Tells you when a parcel is out.', author: 'recued-core', supported_platforms: [], tags: [] },
  variables: {},
  event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'] }],
  steps: [{ id: 'state', transform: 'coalesce', values: ['{{context.event.payload.record.state}}'] }],
  output: { render: [{ type: 'summary', source: 'step.state' }] },
} as unknown as RecipeDefinition);

const manifest = (): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'shop-parcels-pack',
  publisher: 'recued-core',
  name: 'Shop parcels',
  description: 'fixture',
  version: 1,
  recipes: [{ slug: 'shop-parcels', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
});

const install = (extra: Record<string, unknown> = {}) =>
  handlePacksInstall(deps, { manifest: manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION], ...extra });

const ownersTwin = () => mailFacts.createTemplate({
  // The same conditions, written another way.
  definition: { ...starter, name: 'My shop', entrance: { ...starter.entrance, conditions: [{ field: 'from', op: 'is', value: 'Ship@Shop.Example' }] } },
  origin: { kind: 'owner' },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-recipe-template-install-'));
  writeFileSync(join(dir, 'shop-parcels.json'), JSON.stringify(parcels()));
  writeFileSync(join(dir, 'parcel-alerts.json'), JSON.stringify(alerts()));
  db = new Database(':memory:');
  recipeStore = createRecipeStore(dir, db);
  mailFacts = createMailFactStore(db);
  dishes = createDishStore(db);
  templates = createRecipeMailTemplates({
    store: mailFacts,
    recipes: recipeStore,
    settings: {
      dishesOf: (recipe_id) => dishes.listByRecipe(recipe_id),
      set: (dish_id, variable, value) => {
        const dish = dishes.get(dish_id)!;
        const config_overlay = { ...dish.config_overlay };
        if (value === null) delete config_overlay[variable];
        else config_overlay[variable] = value;
        dishes.set({ ...dish, config_overlay });
      },
    },
    log: () => undefined,
  });
  deps = { recipeStore, getRecipeMailTemplates: () => templates };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a pack whose recipe brings a starter', () => {
  it('creates the recipe’s template on install, in its pack, and a new dish starts from it', async () => {
    const { result } = await install();
    expect(result.ok).toBe(true);
    const [template] = mailFacts.listTemplates();
    expect(template).toMatchObject({
      name: 'Shop parcels',
      active: true,
      origin: { kind: 'recipe', publisher: 'recued-core', recipe: 'shop-parcels', variable: 'template', version: 1, pack: 'shop-parcels-pack' },
    });
    expect(result.mail_templates).toEqual([expect.objectContaining({
      recipe_id: 'shop-parcels', variable: 'template', template_id: template!.template_id, action: 'created', active: true,
    })]);
    // D-319 — no dish is made by installing; none switched on.
    expect(dishes.list()).toEqual([]);
    expect(templates.defaultsFor('shop-parcels')).toEqual({ template: template!.template_id });
  });

  it('is listed by the preview before anything is installed, with the template already reading that mail', async () => {
    const mine = ownersTwin();
    const preview = await makePackInstallHandlers(deps)!.handlers['packs.install_preview']({ manifest: manifest() } as never, {} as never);
    expect(preview.mail_templates).toEqual([{
      recipe_id: 'shop-parcels',
      recipe_name: 'Shop parcels',
      variable: 'template',
      name: 'Shop parcels',
      type: 'shipment',
      conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }],
      reads: ['carrier', 'tracking_number'],
      action: 'add',
      twin: { template_id: mine.template_id, name: 'My shop' },
      trigger: true,
    }]);
    // A preview installs nothing.
    expect(mailFacts.listTemplates()).toHaveLength(1);
    // Its trigger reads its own template: where those facts come from is the starter above.
    expect(preview).not.toHaveProperty('mail_fact_sources');
  });

  it('says, for a recipe that starts on facts, where they would come from — the template the pack adds among them', async () => {
    const both = { ...manifest(), recipes: [{ slug: 'shop-parcels', version: 1 }, { slug: 'parcel-alerts', version: 1 }] };
    const preview = await makePackInstallHandlers(deps)!.handlers['packs.install_preview']({ manifest: both } as never, {} as never);
    expect(preview.mail_fact_sources).toEqual([{
      recipe_id: 'parcel-alerts',
      recipe_name: 'Parcel alerts',
      kinds: [{ type: 'shipment', name: 'Shipment', variables: ['state'], standards: true, templates: 0, brought: true }],
    }]);
  });

  it('keeps the owner’s on when the install says so, and a new dish starts from it', async () => {
    const mine = ownersTwin();
    const { result } = await install({
      mail_template_choices: [{ recipe_id: 'shop-parcels', variable: 'template', keep: 'existing' }],
    });
    expect(result.ok).toBe(true);
    const recipes = mailFacts.listTemplates().filter((template) => template.origin.kind === 'recipe');
    expect(recipes).toEqual([expect.objectContaining({ active: false })]);
    expect(mailFacts.getTemplate(mine.template_id)!.active).toBe(true);
    expect(templates.defaultsFor('shop-parcels')).toEqual({ template: mine.template_id });
  });

  it('switches the owner’s off by default, and says so', async () => {
    const mine = ownersTwin();
    const { result } = await install();
    expect(mailFacts.getTemplate(mine.template_id)!.active).toBe(false);
    expect(result.mail_templates).toEqual([expect.objectContaining({ switched_off: { template_id: mine.template_id, name: 'My shop' } })]);
  });

  it('⛔ refuses a malformed choice, rather than read it as the recipe’s', async () => {
    for (const choices of [
      'existing',
      [{ recipe_id: 'shop-parcels', variable: 'template', keep: 'mine' }],
      [{ recipe_id: 'shop-parcels', variable: 'template' }],
      [{ recipe_id: 'shop-parcels', variable: 'template', keep: 'existing', extra: 1 }],
      [
        { recipe_id: 'shop-parcels', variable: 'template', keep: 'existing' },
        { recipe_id: 'shop-parcels', variable: 'template', keep: 'recipe' },
      ],
    ]) {
      await expect(install({ mail_template_choices: choices })).rejects.toMatchObject({ code: 'bad_request' });
    }
    expect(mailFacts.listTemplates()).toEqual([]);
  });
});

describe('a recipe installed on its own', () => {
  const row = (): MarketplaceRecipeResult => ({
    recipe_id: 'shop-parcels',
    publisher_id: 'shop-author',
    version: 1,
    recipe_hash: 'sha256:fixture',
    recipe: parcels(),
  });
  const marketplaceFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const found = /\/recipes\/shop-parcels\.json/.test(url);
    return {
      status: found ? 200 : 404,
      ok: found,
      statusText: found ? 'OK' : 'Not Found',
      json: async () => (found ? { data: row(), meta: {} } : null),
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  it('brings its template too, with no pack, and says what it switched off', async () => {
    const mine = ownersTwin();
    const { result } = await installRecipeBySlug({ ...deps, marketplaceFetch }, { slug: 'shop-parcels' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const recipes = mailFacts.listTemplates().filter((template) => template.origin.kind === 'recipe');
    expect(recipes).toEqual([expect.objectContaining({
      active: true,
      origin: { kind: 'recipe', publisher: 'shop-author', recipe: 'shop-parcels', variable: 'template', version: 1 },
    })]);
    expect(result.mail_templates).toEqual([expect.objectContaining({
      action: 'created', switched_off: { template_id: mine.template_id, name: 'My shop' },
    })]);
  });

  it('follows the caller’s choice, and refuses a malformed one', async () => {
    const mine = ownersTwin();
    await expect(installRecipeBySlug({ ...deps, marketplaceFetch }, { slug: 'shop-parcels', mail_template_choices: [{ keep: 'x' }] as never }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await installRecipeBySlug({ ...deps, marketplaceFetch }, {
      slug: 'shop-parcels',
      mail_template_choices: [{ recipe_id: 'shop-parcels', variable: 'template', keep: 'existing' }],
    });
    expect(mailFacts.getTemplate(mine.template_id)!.active).toBe(true);
  });
});
