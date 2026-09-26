/** What a pack update does to EVERY operation — the diff the owner reads before
 *  pressing Update. An owner can set each operation's risk and approval, and an
 *  update can remove, change or add operations; the review used to show only the
 *  ones the owner had ruled on, and never an added one. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  OWNER_OPERATION_SCOPE,
  operationSpecHash,
  parseBulkPackManifest,
  type BulkPackManifest,
  type CompositionIngredient,
  type IngredientManifest,
  type PackOperationRow,
} from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import {
  compositionPackCurrentAccess,
  currentPackAccess,
  diffCompositionPackForUpdate,
  diffPackOperationsForUpdate,
  packGroupKey,
  recordsPackCurrentAccess,
} from '../pack-operation-update-diff.js';
import { resolvePackBySlug } from '../pack-install-handler.js';
import { handlePacksList } from '../pack-list-handler.js';
import { recordPackInventory } from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_752_000_000_000;

const operation = (
  op: string,
  risk: PackOperationRow['risk'],
  approval: PackOperationRow['approval'],
  path = `/v1/${op}`,
): PackOperationRow => ({
  op,
  ingredient: 'acme',
  risk,
  approval,
  bind: { kind: 'rest', method: risk === 'read' ? 'GET' : 'POST', path_template: path },
});

const composition = (operations: PackOperationRow[]): CompositionIngredient => ({
  schema_version: 1,
  slug: 'acme',
  catalog_kind: 'private_byo',
  ingredients: [{ slug: 'acme', kind: 'http', http: { base: 'https://api.acme.example', connection: 'Acme' } }],
  operations,
});

const catalogOf = (body: CompositionIngredient): IngredientManifest => {
  const catalog = decomposeComposition[1](body).catalog;
  if (catalog === undefined) throw new Error('no catalog');
  return catalog;
};

const pack = (body: CompositionIngredient, version = 2): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'acme-pack',
  publisher: 'recued-core',
  name: 'Acme',
  description: 'Acme operations.',
  version,
  recipes: [],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition: body }],
});

describe('diffPackOperationsForUpdate', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  /** The owner's rule, stamped against the definition they reviewed — as
   *  `collection.operation.upsertOwnerOverride` writes it. */
  const rule = (catalog: IngredientManifest, opKey: string, policy: Record<string, unknown>): void => {
    const spec = Object.values((catalog as { operations: Record<string, { operation_id: string }> }).operations)
      .find((entry) => entry.operation_id.endsWith(opKey))!;
    store.put(OWNER_OPERATION_SCOPE, ['acme', spec.operation_id], {
      ...policy, op_hash: operationSpecHash(spec as never),
    });
  };

  it('lists every removed, changed and added operation — with the owner\'s rule where they set one', () => {
    const before = catalogOf(composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.create', 'write', 'ask'),
      operation('deal.archive', 'admin', 'ask'),
      operation('note.read', 'read', 'never'),
    ]));
    const after = catalogOf(composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.create', 'destructive', 'always'),
      operation('note.read', 'read', 'never'),
      operation('deal.export', 'read', 'never'),
    ]));
    rule(before, 'deal.archive', { approval: 'always' });
    rule(before, 'deal.create', { risk: 'admin' });

    const diff = diffPackOperationsForUpdate({
      store, installed: new Map([['acme', before]]), incoming: new Map([['acme', after]]),
    });
    expect(diff.unchanged, 'deal.read and note.read did not move').toBe(2);
    expect(diff.items).toEqual([
      {
        ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.archive', change: 'removed',
        installed: { risk: 'admin', approval: 'ask' }, owner_policy: { approval: 'always' },
      },
      {
        ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.create', change: 'changed',
        installed: { risk: 'write', approval: 'ask' }, incoming: { risk: 'destructive', approval: 'always' },
        owner_policy: { risk: 'admin' },
      },
      {
        ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.export', change: 'added',
        incoming: { risk: 'read', approval: 'never' },
      },
    ]);
  });

  it('⛔ a rename is NOT paired — the old operation is removed (its rule goes dark), the new one added on the pack\'s defaults', () => {
    // Same route, same risk, same arguments: only the NAME moved. Nothing durable
    // ties the two across versions, so nothing may move the owner's rule.
    // (Two operations each: a one-operation composition lowers to a simple-form
    // ingredient, which IS its operation and is keyed by the pack's slug.)
    const stays = operation('users.list', 'read', 'never');
    const before = catalogOf(composition([stays, operation('users.get_available_account_providers', 'read', 'never', '/users/account-providers')]));
    const after = catalogOf(composition([stays, operation('users.get_account_providers', 'read', 'never', '/users/account-providers')]));
    rule(before, 'users.get_available_account_providers', { approval: 'always' });
    const diff = diffPackOperationsForUpdate({
      store, installed: new Map([['acme', before]]), incoming: new Map([['acme', after]]),
    });
    expect(diff.items.map((item) => [item.change, item.operation_id.split('.').slice(-1)[0], item.owner_policy ?? null]))
      .toEqual([
        ['added', 'get_account_providers', null],
        ['removed', 'get_available_account_providers', { approval: 'always' }],
      ]);
    // …and the rule itself is untouched in the store, dark but kept.
    expect(store.scan(OWNER_OPERATION_SCOPE).map((row) => row.segments[1])).toEqual([
      'recued-core/acme.users.get_available_account_providers',
    ]);
  });

  it('an identical update is all unchanged — nothing to review', () => {
    const body = catalogOf(composition([operation('deal.read', 'read', 'never'), operation('deal.create', 'write', 'ask')]));
    expect(diffPackOperationsForUpdate({
      store, installed: new Map([['acme', body]]), incoming: new Map([['acme', body]]),
    })).toEqual({ items: [], unchanged: 2 });
  });
});

describe('diffCompositionPackForUpdate — what the Packs list assembles for a composition pack', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  const installedAt = (packSlug: string, ingredientIds: string[]): void => {
    recordPackInventory(store, {
      pack_slug: packSlug,
      pack_version: 1,
      installed_at: NOW,
      contents: [],
      local_catalogs: ingredientIds.map((ingredient_id) => ({ ingredient_id, version: 1, catalog_kind: 'private_byo' })),
    });
  };

  it('reads the installed catalog from the local store under the inventory\'s ids, and diffs the manifest\'s compositions', () => {
    installedAt('acme-pack', ['acme']);
    const installed = catalogOf(composition([operation('deal.read', 'read', 'never'), operation('deal.archive', 'admin', 'ask')]));
    const local = { getManifest: (id: string) => (id === 'acme' ? installed : null) };
    const diff = diffCompositionPackForUpdate(store, local, pack(composition([
      operation('deal.read', 'read', 'never'), operation('deal.export', 'read', 'never'),
    ])));
    expect(diff?.unchanged).toBe(1);
    expect(diff?.items.map((item) => [item.change, item.operation_id])).toEqual([
      ['removed', 'recued-core/acme.deal.archive'],
      ['added', 'recued-core/acme.deal.export'],
    ]);
  });

  it('a catalog the update drops is "removed" only while no other installed pack still lists it', () => {
    installedAt('acme-pack', ['acme', 'shared']);
    installedAt('other-pack', ['shared']);
    const shared = catalogOf({
      schema_version: 1,
      slug: 'shared',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'shared', kind: 'http', http: { base: 'https://api.shared.example', connection: 'Shared' } }],
      operations: [
        { ...operation('thing.read', 'read', 'never'), ingredient: 'shared' },
        { ...operation('thing.list', 'read', 'never'), ingredient: 'shared' },
      ],
    });
    const acmeOps = [operation('deal.read', 'read', 'never'), operation('deal.list', 'read', 'never')];
    const acme = catalogOf(composition(acmeOps));
    const local = { getManifest: (id: string) => (id === 'acme' ? acme : id === 'shared' ? shared : null) };
    // The update drops `shared` from this pack — but other-pack still lists it,
    // so its two operations stay available: nothing here is "removed".
    const diff = diffCompositionPackForUpdate(store, local, pack(composition(acmeOps)));
    expect(diff).toEqual({ items: [], unchanged: 2 });
  });
});

describe('currentPackAccess — where an update\'s Access choice starts', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  // Groups derive as `<ingredient>.<family>.<risk>`: acme.deal.read,
  // acme.deal.write, acme.note.write, acme.deal.admin.
  const catalog = catalogOf(composition([
    operation('deal.read', 'read', 'never'),
    operation('deal.create', 'write', 'ask'),
    operation('note.create', 'write', 'ask'),
    operation('deal.archive', 'admin', 'ask'),
  ]));
  const catalogs = new Map([['acme', catalog]]);

  /** What an install at `tier` writes (`resolveInstallGrantWriteSet`): every
   *  group at or below it, under the pack's own id. */
  const TIER_GROUPS = {
    read: ['acme.deal.read'],
    write: ['acme.deal.read', 'acme.deal.write', 'acme.note.write'],
    all: ['acme.deal.read', 'acme.deal.write', 'acme.note.write', 'acme.deal.admin'],
  } as const;
  const grant = (groups: readonly string[], packId = 'acme-pack', ingredient = 'acme'): void => {
    const grants = createContractGrantStore(store);
    for (const group of groups) grants.grantPackGroup(packId, ingredient, 'Acme', group);
  };
  const access = (defaults: readonly string[] = []) => currentPackAccess({
    store, installedPackId: 'acme-pack', catalogs,
    defaults: new Set(defaults.map((group) => packGroupKey('acme', group))),
  });

  it.each(['read', 'write', 'all'] as const)('an install at %s reads back as that tier', (tier) => {
    grant(TIER_GROUPS[tier]);
    expect(access()).toBe(tier);
  });

  it('a tier with one of its groups missing was not the owner\'s choice — installing at it grants them all', () => {
    grant(['acme.deal.read', 'acme.deal.write']);
    expect(access()).toBe('read');
  });

  it('⛔ an authored default proves nothing — it is granted whatever the owner picks', () => {
    // A Read install of a pack whose authored `default_grants` names both write
    // groups: they are granted, and "Read + write" would be a lie that grants
    // every NEW write group of the update.
    grant(['acme.deal.read', 'acme.deal.write', 'acme.note.write']);
    expect(access(['acme.deal.write', 'acme.note.write'])).toBe('read');
    // One write group the defaults do not cover, granted: only the tier did that.
    expect(access(['acme.deal.write'])).toBe('write');
  });

  it('a tier that adds no group here is never claimed — the lower one grants the same', () => {
    const noAdmin = new Map([['acme', catalogOf(composition([
      operation('deal.read', 'read', 'never'), operation('deal.create', 'write', 'ask'),
    ]))]]);
    grant(['acme.deal.read', 'acme.deal.write']);
    expect(currentPackAccess({ store, installedPackId: 'acme-pack', catalogs: noAdmin, defaults: new Set() }))
      .toBe('write');
  });

  it('only THIS pack\'s grants count — not another pack\'s, not the owner\'s own', () => {
    grant(TIER_GROUPS.read);
    grant(TIER_GROUPS.all, 'other-pack');
    createContractGrantStore(store).grantUserGroup('acme', 'Acme', 'acme.deal.write');
    expect(access()).toBe('read');
  });

  it('undefined when nothing can be told: not even the read groups granted, or no groups at all', () => {
    // An install that never showed the dialog writes only authored defaults.
    expect(access()).toBeUndefined();
    grant(TIER_GROUPS.all);
    expect(currentPackAccess({ store, installedPackId: 'acme-pack', catalogs: new Map(), defaults: new Set() }))
      .toBeUndefined();
  });

  it('a composition pack: the catalogs its inventory lists, the authored defaults its manifest declares', () => {
    recordPackInventory(store, {
      pack_slug: 'acme-pack', pack_version: 1, installed_at: NOW, contents: [],
      local_catalogs: [{ ingredient_id: 'acme', version: 1, catalog_kind: 'private_byo' }],
    });
    const local = { getManifest: (id: string) => (id === 'acme' ? catalog : null) };
    grant(TIER_GROUPS.write);
    const body = composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.create', 'write', 'ask'),
      operation('note.create', 'write', 'ask'),
    ]);
    expect(compositionPackCurrentAccess(store, local, pack(body))).toBe('write');
    expect(compositionPackCurrentAccess(store, local, pack({
      ...body, default_grants: ['acme.deal.write', 'acme.note.write'],
    }))).toBe('read');
  });

  it('a Records pack: grants and catalog keyed by its derived catalog id, never its slug', () => {
    const catalogId = 'records-0123456789abcdef0123456789abcdef';
    const stamped = { ...catalog, slug: catalogId } as IngredientManifest;
    const local = { getManifest: (id: string) => (id === catalogId ? stamped : null) };
    const grants = createContractGrantStore(store);
    const target = { catalog: stamped, composition: composition([]) };
    for (const group of TIER_GROUPS.read) grants.grantPackGroup(catalogId, catalogId, catalogId, group);
    expect(recordsPackCurrentAccess(store, local, target)).toBe('read');
    for (const group of TIER_GROUPS.write) grants.grantPackGroup(catalogId, catalogId, catalogId, group);
    expect(recordsPackCurrentAccess(store, local, target)).toBe('write');
    // Its authored defaults, keyed by the catalog id too.
    expect(recordsPackCurrentAccess(store, local, {
      ...target, composition: { ...composition([]), default_grants: ['acme.deal.write', 'acme.note.write'] },
    })).toBe('read');
    // The installed catalog unreadable: no answer rather than a guess.
    expect(recordsPackCurrentAccess(store, { getManifest: () => null }, target)).toBeUndefined();
  });
});

describe('what an update preview carries besides the review', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it('packs.list: a bundled update carries the whole diff and the Access to start at', async () => {
    const recipesDir = mkdtempSync(join(tmpdir(), 'operation-diff-recipes-'));
    const packDir = mkdtempSync(join(tmpdir(), 'operation-diff-packs-'));
    try {
      recordPackInventory(store, {
        pack_slug: 'acme-pack', pack_version: 1, installed_at: NOW, contents: [],
        local_catalogs: [{ ingredient_id: 'acme', version: 1, catalog_kind: 'private_byo' }],
      });
      const prior = catalogOf(composition([
        operation('deal.read', 'read', 'never'), operation('deal.archive', 'admin', 'ask'),
      ]));
      const grants = createContractGrantStore(store);
      for (const group of ['acme.deal.read', 'acme.deal.admin']) grants.grantPackGroup('acme-pack', 'acme', 'Acme', group);
      writeFileSync(join(packDir, 'acme-pack.json'), JSON.stringify(pack(composition([
        operation('deal.read', 'read', 'never'), operation('deal.export', 'read', 'never'),
      ]))));

      const listed = await handlePacksList({
        recipeStore: createRecipeStore(recipesDir, db),
        packDir,
        contractStore: store,
        localManifestStore: { getManifest: (id: string) => (id === 'acme' ? prior : null) },
      });
      const row = listed.packs.find((entry) => entry.slug === 'acme-pack')!;
      expect(row.installed_any_version && !row.installed, 'offered as an update').toBe(true);
      expect(row.operation_diff).toEqual({
        unchanged: 1,
        items: [
          { ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.archive', change: 'removed',
            installed: { risk: 'admin', approval: 'ask' } },
          { ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.export', change: 'added',
            incoming: { risk: 'read', approval: 'never' } },
        ],
      });
      // Every group granted, the admin one included: the owner chose Full access.
      expect(row.current_access).toBe('all');
    } finally {
      rmSync(recipesDir, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it('packs.resolveBySlug: a marketplace update carries the whole diff and the Access to start at', async () => {
    recordPackInventory(store, {
      pack_slug: 'acme-pack', pack_version: 1, installed_at: NOW, contents: [],
      local_catalogs: [{ ingredient_id: 'acme', version: 1, catalog_kind: 'private_byo' }],
    });
    const prior = catalogOf(composition([operation('deal.read', 'read', 'never'), operation('deal.create', 'write', 'ask')]));
    const grants = createContractGrantStore(store);
    for (const group of ['acme.deal.read', 'acme.deal.write']) grants.grantPackGroup('acme-pack', 'acme', 'Acme', group);
    // deal.read gains a description and keeps its risk and approval: still a
    // change — the same test (`operationSpecHash`) that marks an owner's rule for
    // it stale. (Its route is not part of the definition: a moved route alone is
    // no change, to the diff or to a rule.)
    const incoming = pack(composition([
      { ...operation('deal.read', 'read', 'never'), description: 'Read a deal with its audit trail.' },
      operation('deal.create', 'write', 'ask'),
      operation('deal.export', 'read', 'never'),
    ]));
    const marketplaceFetch = (async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => incoming,
    }) as unknown as Response) as typeof globalThis.fetch;

    const resolved = await resolvePackBySlug({
      recipeStore: {} as RecipeStore,
      contractStore: store,
      localManifestStore: { getManifest: (id: string) => (id === 'acme' ? prior : null) } as never,
      marketplaceFetch,
    }, { slug: 'acme-pack' });

    expect(resolved.operation_diff).toEqual({
      unchanged: 1,
      items: [
        { ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.export', change: 'added',
          incoming: { risk: 'read', approval: 'never' } },
        { ingredient_id: 'acme', operation_id: 'recued-core/acme.deal.read', change: 'changed',
          installed: { risk: 'read', approval: 'never' }, incoming: { risk: 'read', approval: 'never' } },
      ],
    });
    expect(resolved.current_access).toBe('write');
  });

  it('⛔ a Records pack is never read as a composition pack — keyed by its authored slug, every operation would be "added"', () => {
    const records = parseBulkPackManifest(JSON.parse(readFileSync(
      resolve(import.meta.dirname, 'fixtures/statement-import-26.9.21/packs/statement-import.json'), 'utf8',
    )));
    if (!records.ok) throw new Error('fixture did not parse');
    const local = { getManifest: () => null };
    expect(diffCompositionPackForUpdate(store, local, records.manifest)).toBeUndefined();
    expect(compositionPackCurrentAccess(store, local, records.manifest)).toBeUndefined();
  });
});
