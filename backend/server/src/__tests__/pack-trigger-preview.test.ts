/** D-296 — the update dialog names every automation the owner has ON that an
 *  update will switch off, and names ONLY those: the preview reads the same
 *  declarations and the same pairing rule the reconcile then applies.
 *
 *  A recipe whose one trigger changes carries its armed state over
 *  (`carriedTriggerFor`), so it is not named. A changed trigger that cannot be
 *  paired — several rows — and a trigger the update removes are named.
 *
 *  D-319 — rows are made once per dish, and each dish carries its own. Here
 *  each recipe has one dish, `dsh_<recipe_id>`, unless a test says otherwise. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BULK_PACK_INSTALL_PERMISSION, type RecipeDefinition } from '@recued/contracts';

import { makePackInstallHandlers } from '../pack-install-handler.js';
import { triggersSwitchedOff } from '../pack-trigger-preview.js';
import { createRecipeStore } from '../recipe-store.js';
import { reconcileDeclarativeTriggers, type ReconcilerDish } from '../triggers/declarative-reconciler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';

const PUBLISHER = 'recued-core';

const recipe = (recipe_id: string, event_triggers: Array<{ event: string }>): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: { name: `${recipe_id} name`, description: 'x', author: PUBLISHER, supported_platforms: [], tags: [] },
  variables: {},
  steps: [{ id: 'seen', transform: 'compare', left: 'x', operator: 'is_not_empty' }],
  output: { sidebar: [] },
  event_triggers,
} as unknown as RecipeDefinition);

let db: Database.Database;
let store: EventTriggersStore;
let minted: number;
/** Extra dishes beyond each recipe's own `dsh_<recipe_id>`. */
let extraDishes: ReconcilerDish[];

beforeEach(() => {
  db = new Database(':memory:');
  store = createEventTriggersStore(db);
  minted = 0;
  extraDishes = [];
});
afterEach(() => db.close());

const dishesOf = (recipe_id: string): ReconcilerDish[] => [
  { dish_id: `dsh_${recipe_id}`, recipe_id, config_overlay: {} },
  ...extraDishes.filter((dish) => dish.recipe_id === recipe_id),
];
const installed = (recipes: RecipeDefinition[]) =>
  reconcileDeclarativeTriggers({
    store,
    listStored: () => recipes.map((r) => ({ recipe_id: r.recipe_id, publisher_id: PUBLISHER, recipe_json: JSON.stringify(r) })),
    listDishes: () => recipes.flatMap((r) => dishesOf(r.recipe_id)),
    now: () => 1,
    mintTriggerId: () => `t-${++minted}`,
  });
const armAll = () => { for (const row of store.list()) store.update(row.trigger_id, { enabled: true }); };
const previewDeps = () => ({ store, getVendorEntities: () => [], dishesOf });
const preview = (recipes: RecipeDefinition[]) =>
  triggersSwitchedOff({
    preview: previewDeps(),
    recipes: recipes.map((definition) => ({ recipe_id: definition.recipe_id, publisher_id: PUBLISHER, definition })),
  });

describe('triggersSwitchedOff — what the update dialog warns about', () => {
  it('names an armed automation the update cannot carry, and nothing else — as the reconcile then does', () => {
    const before = [
      recipe('one-trigger', [{ event: 'data.calendar.**.updated' }]),
      recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }]),
      recipe('loses-trigger', [{ event: 'data.file.**.created' }]),
      recipe('unchanged', [{ event: 'data.contact.**.created' }]),
    ];
    installed(before);
    armAll();
    const after = [
      recipe('one-trigger', [{ event: 'data.work.booking.item.updated' }]), // carried
      recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }]), // cannot pair
      recipe('loses-trigger', []), // no trigger any more
      recipe('unchanged', [{ event: 'data.contact.**.created' }]),
    ];
    expect(preview(after)).toEqual([
      { recipe_id: 'two-triggers', name: 'two-triggers name', reason: 'changed' },
      { recipe_id: 'loses-trigger', name: 'loses-trigger name', reason: 'removed' },
    ]);

    // The warning agrees with what the reconcile then does.
    installed(after);
    const armed = store.list().filter((row) => row.enabled).map((row) => `${row.recipe_id} ${row.pattern}`).sort();
    expect(armed).toEqual([
      'one-trigger data.work.booking.item.updated',
      'two-triggers data.mail.**.created',
      'unchanged data.contact.**.created',
    ]);
  });

  it('a row a reviewed execution parks is on for the owner, so its switch-off is named', () => {
    installed([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])]);
    const parked = store.list().find((row) => row.pattern === 'data.mail.**.updated')!;
    db.prepare(`INSERT INTO preapproval_activations(future_ref, target_kind, target_key, target_incarnation,
      target_revision, original_enabled, owner_mode, due_at, selector_sequence)
      VALUES ('fx_1', 'next_trigger', ?, 'inc', 1, 1, 'owner', NULL, 0)`).run(parked.trigger_id);
    expect(parked.enabled).toBe(false);
    expect(preview([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }])]))
      .toEqual([{ recipe_id: 'two-triggers', name: 'two-triggers name', reason: 'changed' }]);
  });

  it('D-319 — each dish is read on its own: one dish’s armed row is named, another’s off row is not', () => {
    extraDishes = [{ dish_id: 'dsh_home', recipe_id: 'two-triggers', config_overlay: {} }];
    installed([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])]);
    // Only the home dish is on.
    for (const row of store.list().filter((row) => row.dish_id === 'dsh_home')) store.update(row.trigger_id, { enabled: true });
    expect(preview([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }])]))
      .toEqual([{ recipe_id: 'two-triggers', name: 'two-triggers name', reason: 'changed' }]);
    // A recipe whose one trigger changes is carried on every dish: nothing named.
    installed([recipe('one', [{ event: 'data.calendar.**.updated' }])]);
    armAll();
    expect(preview([recipe('one', [{ event: 'data.work.booking.item.updated' }])])).toEqual([]);
  });

  it('another publisher\'s recipe of the same name is not this update\'s', () => {
    reconcileDeclarativeTriggers({
      store,
      listStored: () => [{
        recipe_id: 'two-triggers',
        publisher_id: 'someone-else',
        recipe_json: JSON.stringify(recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])),
      }],
      listDishes: () => dishesOf('two-triggers'),
      now: () => 1,
      mintTriggerId: () => `o-${++minted}`,
    });
    armAll();
    expect(preview([recipe('two-triggers', [{ event: 'data.mail.**.deleted' }])])).toEqual([]);
  });

  it('a change to an automation the owner never switched on is nothing to warn about', () => {
    installed([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])]);
    expect(preview([recipe('two-triggers', [{ event: 'data.mail.**.deleted' }])])).toEqual([]);
    // …even beside one that is on and that the update keeps.
    const kept = store.list().find((row) => row.pattern === 'data.mail.**.created')!;
    store.update(kept.trigger_id, { enabled: true });
    expect(preview([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }])]))
      .toEqual([]);
  });
});

describe('packs.install_preview carries the warning', () => {
  const packManifest = (over: Record<string, unknown>) => ({
    manifest_version: 1,
    publisher: PUBLISHER,
    description: 'x',
    version: 2,
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    ...over,
  });

  it('names a dependency\'s automation too, when the update re-installs that dependency', async () => {
    installed([recipe('dep-watch', [{ event: 'data.file.**.created' }])]);
    armAll();
    const dir = mkdtempSync(join(tmpdir(), 'trigger-preview-'));
    const packDir = mkdtempSync(join(tmpdir(), 'trigger-preview-packs-'));
    try {
      writeFileSync(join(dir, 'dep-watch.json'), JSON.stringify(recipe('dep-watch', [])));
      writeFileSync(join(dir, 'top.json'), JSON.stringify(recipe('top', [])));
      writeFileSync(join(packDir, 'dep-pack.json'), JSON.stringify(packManifest({
        slug: 'dep-pack', name: 'Dep pack', recipes: [{ slug: 'dep-watch', version: 1 }],
      })));
      const handlers = makePackInstallHandlers({
        recipeStore: createRecipeStore(dir, db),
        packDir,
        getTriggerPreview: () => previewDeps(),
      })!.handlers;
      const result = await handlers['packs.install_preview']!({
        manifest: packManifest({
          slug: 'top-pack', name: 'Top pack', recipes: [{ slug: 'top', version: 1 }],
          dependencies: [{ type: 'pack', slug: 'dep-pack' }],
        }),
      } as never, undefined as never) as { triggers_switched_off?: unknown };
      expect(result.triggers_switched_off).toEqual([
        { recipe_id: 'dep-watch', name: 'dep-watch name', reason: 'removed' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it('reads the incoming recipe bodies and the live trigger rows', async () => {
    installed([recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])]);
    armAll();
    const dir = mkdtempSync(join(tmpdir(), 'trigger-preview-'));
    try {
      writeFileSync(join(dir, 'two-triggers.json'), JSON.stringify(
        recipe('two-triggers', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }]),
      ));
      const handlers = makePackInstallHandlers({
        recipeStore: createRecipeStore(dir, db),
        getTriggerPreview: () => previewDeps(),
      })!.handlers;
      const result = await handlers['packs.install_preview']!({
        manifest: packManifest({ slug: 'mail-pack', name: 'Mail pack', recipes: [{ slug: 'two-triggers', version: 1 }] }),
      } as never, undefined as never) as { triggers_switched_off?: unknown };
      expect(result.triggers_switched_off).toEqual([
        { recipe_id: 'two-triggers', name: 'two-triggers name', reason: 'changed' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
