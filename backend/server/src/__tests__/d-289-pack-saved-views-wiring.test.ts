/** D-289 — a pack's `saved_view` contents reach the saved-view store.
 *
 *  ⛔ THIS FILE EXISTS BECAUSE THE FEATURE SHIPPED UNREACHABLE ONCE. The
 *  handler consumed `deps.savedDataViewStore` at four sites and nothing
 *  supplied it, so every unit test passed over a feature that did nothing —
 *  the same shape the D-287 audit caught in the change-review panel. Two kinds
 *  of assertion below, deliberately: the BEHAVIOUR (a view lands, survives a
 *  reinstall, and is optional) and the WIRING (the one composer that can build
 *  the store actually publishes it, to BOTH pack composers).
 *
 *  ⚠ The uninstall SWEEP is covered one layer down — `removePackViews` in
 *  `saved-data-view-store.test.ts`. What is asserted here about uninstall is
 *  only that the getter reaches its composer.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION, type BulkPackManifest, type SavedDataViewDefinition,
} from '@recued/contracts';

import { handlePacksInstall } from '../pack-install-handler.js';
import { createSavedDataViewStore } from '../saved-data-view-store.js';
import { packSavedViewId } from '../pack-saved-views.js';
import { createRecipeStore } from '../recipe-store.js';
import { stripSourceComments } from './helpers/source-guards.js';

const PACK = { publisher: 'recued-core', slug: 'invoice-desk' } as const;
const VIEW: SavedDataViewDefinition = {
  tab: 'records', owner: { publisher: 'recued-core', pack_slug: 'invoice-desk' }, entity: 'invoice',
};

const manifest = (): BulkPackManifest => ({
  manifest_version: 2, slug: PACK.slug, publisher: PACK.publisher,
  name: 'Invoice desk', description: 'Invoices, and the view to read them through.',
  version: 1, recipes: [], requires: [BULK_PACK_INSTALL_PERMISSION], tags: [],
  contents: [{ type: 'saved_view', name: 'Overdue invoices', definition: VIEW }],
} as BulkPackManifest);

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = () => { const db = new Database(':memory:'); dbs.push(db); return db; };
/** `createRecipeStore` scans a directory at construction; an empty one is
 *  enough here — this pack ships a view and no recipes. */
const recipes = (db: Database.Database) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-d289-'));
  dirs.push(dir);
  return createRecipeStore(dir, db);
};

describe('D-289 pack saved views reach the store', () => {
  it('installs the view a pack ships', async () => {
    const db = open();
    const views = createSavedDataViewStore(db);
    const { result } = await handlePacksInstall(
      { recipeStore: recipes(db), getSavedDataViewStore: () => views },
      { manifest: manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    const listed = views.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: 'Overdue invoices',
      id: packSavedViewId(PACK, 'Overdue invoices'),
      pack: { publisher: PACK.publisher, slug: PACK.slug },
    });
  });

  /** ⚠ A view is a convenience surface, never a capability — a server that
   *  cannot store one must not refuse the pack over it. */
  it('installs the pack anyway when no store is wired', async () => {
    const db = open();
    const { result } = await handlePacksInstall(
      { recipeStore: recipes(db) },
      { manifest: manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
  });

  it('re-asserts on reinstall without disturbing what the owner set', async () => {
    const db = open();
    const views = createSavedDataViewStore(db);
    const deps = { recipeStore: recipes(db), getSavedDataViewStore: () => views };
    const args = { manifest: manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] };
    await handlePacksInstall(deps, args);

    const view = views.list()[0]!;
    const hidden = views.setHidden({ id: view.id, expected_revision: view.revision, hidden: true });
    expect(hidden.hidden).toBe(true);

    await handlePacksInstall(deps, args);
    expect(views.list()).toHaveLength(1);
    // ⛔ The owner's dismissal survives the reinstall — the whole reason this
    // path is not the sibling's replace-clean.
    expect(views.list()[0]!.hidden).toBe(true);
  });
});

/** ⛔ THE HANDLER TESTS ABOVE SUPPLY THE GETTER THEMSELVES, so they prove the
 *  handler uses it and NOTHING about whether the product ever supplies one.
 *  That gap is exactly how this shipped inert the first time. The store can
 *  only be built in `compose-listeners` (its alert runtime needs the
 *  notification block), so that file publishing it is the load-bearing line. */
describe('D-289 the composer that owns the store publishes it', () => {
  const read = (rel: string): string => stripSourceComments(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8'),
  );

  it('compose-listeners hands the store it builds to the rpc context', () => {
    const source = read('serve/compose-listeners.ts');
    expect(source).toMatch(/const savedDataViewStore = createSavedDataViewStore\(/);
    expect(source).toMatch(/rpc\.publishSavedDataViewStore\(savedDataViewStore\)/);
  });

  it('the rpc context threads a getter into BOTH pack composers', () => {
    const source = read('serve/compose-rpc-context.ts');
    // Install and uninstall both need it: a view left behind after an
    // uninstall is a dead row pointing at a pack that no longer exists.
    expect(source.match(/getSavedDataViewStore,/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/publishSavedDataViewStore:/);
  });
});
