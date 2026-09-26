/** D-294 — what an update carries over: who may use the pack, the account it
 *  is bound to (and, D-293, its Access tier) — from the dialog AND from any
 *  update that brings no choice at all — and the install fan-out never
 *  overwrites what the owner or a door set one operation at a time.
 *
 *  An update REPLACES the pack's share (`clearForSourcePack`, then the dialog's
 *  audience written afresh), and the dialog started at "only you" — so pressing
 *  Update withdrew the pack from every customer and agreement. And the fan-out
 *  wrote with `set`, which replaces a row: an owner's revoke for one agreement
 *  came back as a grant, and a door's own grant was stamped as the pack's, so
 *  the next update or uninstall deleted it. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  OWNER_CONTRACT_ID,
  type BulkPackManifest,
  type InstallAudienceSelection,
} from '@recued/contracts';

import {
  applyInstallAudienceGrantIds,
  type SellerInstallAudienceStore,
} from '../ingredient-authoring/install-composition.js';
import { currentGeneratedPackChoices, currentPackAudience, currentPackConnection } from '../pack-update-carry-over.js';
import { handlePacksInstall, resolvePackBySlug } from '../pack-install-handler.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { recordPackInventory } from '../pack-inventory.js';
import { handlePacksList } from '../pack-list-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_752_000_000_000;
const PACK = 'acme-pack';
const OPS = ['recued-core/acme.deal.read', 'recued-core/acme.deal.create'];

let db: Database.Database;
let store: ContractStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
});

/** A live standing agreement (a door). */
const mintDoor = (id: string): string =>
  createContractDefinitionStore(store, { now: () => NOW, newId: () => id })
    .mint({ minted_by: 'user:1', display_name: id, scope: { channels: ['mcp'], actors: ['contracted_user'] } })
    .contract_id;

/** A live customer contract, as D-196 issue stamps it. */
const mintCustomer = (id: string): string => {
  mintDoor(id);
  const def = createContractDefinitionStore(store, { now: () => NOW }).get(id)!;
  store.put(CONTRACT_DEFINITION_SCOPE, [id], { ...def, grant_kind: 'customer_instance' });
  return id;
};

/** The Seller's customer rows: contract → package (tier). */
const seller = (tiers: Record<string, string>): SellerInstallAudienceStore => ({
  listCustomers: () => Object.entries(tiers).map(([contract_id, tier_id]) => ({ contract_id, tier_id })),
});

const share = (audience: InstallAudienceSelection, sellerStore?: SellerInstallAudienceStore): void =>
  applyInstallAudienceGrantIds(
    { contractStore: store, ...(sellerStore !== undefined ? { sellerStore } : {}), now: () => NOW },
    OPS,
    PACK,
    { access: 'write', audience },
  );

const readBack = (sellerStore?: SellerInstallAudienceStore): InstallAudienceSelection =>
  currentPackAudience({
    contractStore: store,
    ...(sellerStore !== undefined ? { sellerStore } : {}),
    sourcePack: PACK,
    now: () => NOW,
  });

/** Every (agreement, operation) the pack's share grants, as the gate sees it. */
const sharedRows = (): string[] =>
  store.scan('contract_grant', [])
    .filter((row) => (row.value as { source_pack?: string }).source_pack === PACK)
    .map((row) => `${row.segments[0]} ${row.segments[1]} ${String((row.value as { granted: boolean }).granted)}`)
    .sort();

const ONLY_YOU = { owner: true, all_customers: false, all_other_contracts: false };

describe('currentPackAudience — where an update\'s "Who may use it" starts', () => {
  it('a pack shared with nobody else reads back as you alone', () => {
    mintDoor('door-a');
    share(ONLY_YOU);
    expect(readBack()).toEqual(ONLY_YOU);
  });

  it('customers only — "You" unticked — reads back without you', () => {
    mintCustomer('cust-1');
    share({ owner: false, all_customers: true, all_other_contracts: false });
    expect(readBack()).toEqual({ owner: false, all_customers: true, all_other_contracts: false });
  });

  it('⛔ a box is ticked only while EVERY live agreement of that kind has the pack — one added since comes back one by one', () => {
    for (const id of ['cust-1', 'cust-2']) mintCustomer(id);
    for (const id of ['door-a', 'door-b']) mintDoor(id);
    share({ owner: true, all_customers: true, all_other_contracts: true });
    expect(readBack()).toEqual({ owner: true, all_customers: true, all_other_contracts: true });

    // "Anyone added later starts with nothing until you share again": ticking the
    // boxes again on update would hand the pack to these two without anyone deciding to.
    mintCustomer('cust-3');
    mintDoor('door-c');
    expect(readBack()).toEqual({
      owner: true,
      all_customers: false,
      all_other_contracts: false,
      contract_ids: ['cust-1', 'cust-2', 'door-a', 'door-b'],
    });
  });

  it('a customer package is ticked when every live customer in it has the pack', () => {
    for (const id of ['gold-1', 'gold-2', 'silver-1']) mintCustomer(id);
    const tiers = seller({ 'gold-1': 'gold', 'gold-2': 'gold', 'silver-1': 'silver' });
    share({ owner: true, all_customers: false, all_other_contracts: false, customer_tier_ids: ['gold'] }, tiers);
    expect(readBack(tiers)).toEqual({ ...ONLY_YOU, customer_tier_ids: ['gold'] });
    // Without the Seller's rows the same customers come back one by one — the
    // same agreements either way.
    expect(readBack()).toEqual({ ...ONLY_YOU, contract_ids: ['gold-1', 'gold-2'] });
  });

  it('another pack\'s share is not this pack\'s', () => {
    for (const id of ['door-a', 'door-b']) mintDoor(id);
    share({ ...ONLY_YOU, contract_ids: ['door-a'] });
    applyInstallAudienceGrantIds(
      { contractStore: store, now: () => NOW },
      ['recued-core/other.thing.read'],
      'other-pack',
      { access: 'read', audience: { ...ONLY_YOU, contract_ids: ['door-b'] } },
    );
    expect(readBack()).toEqual({ ...ONLY_YOU, contract_ids: ['door-a'] });
  });

  it('an agreement that is no longer live is not carried', () => {
    for (const id of ['door-a', 'door-b', 'door-c']) mintDoor(id);
    share({ ...ONLY_YOU, contract_ids: ['door-a', 'door-b'] });
    createContractDefinitionStore(store, { now: () => NOW }).revoke('door-b', 'test');
    expect(readBack()).toEqual({ ...ONLY_YOU, contract_ids: ['door-a'] });
  });

  it('⛔⛔ re-applying what it reads back reaches EXACTLY the same agreements — the update keeps the share', () => {
    for (const id of ['gold-1', 'gold-2', 'silver-1', 'silver-2']) mintCustomer(id);
    for (const id of ['door-a', 'door-b', 'door-c']) mintDoor(id);
    const tiers = seller({ 'gold-1': 'gold', 'gold-2': 'gold', 'silver-1': 'silver', 'silver-2': 'silver' });
    share({
      owner: false,
      all_customers: false,
      all_other_contracts: false,
      customer_tier_ids: ['gold'],
      contract_ids: ['silver-1', 'door-a', 'door-c'],
    }, tiers);
    const before = sharedRows();
    // Newcomers since the install, of every kind.
    mintCustomer('gold-3');
    mintDoor('door-d');
    const moreTiers = seller({
      'gold-1': 'gold', 'gold-2': 'gold', 'gold-3': 'gold', 'silver-1': 'silver', 'silver-2': 'silver',
    });

    // What an update does: replace the share with the one the dialog sends —
    // here, what it started at, untouched.
    share(readBack(moreTiers), moreTiers);
    expect(sharedRows()).toEqual(before);
  });
});

describe('the fan-out never overwrites a decision made one operation at a time', () => {
  const grants = () => createContractGrantEntryStore(store);
  const row = (contract: string, op: string) =>
    grants().listForContract(contract).find((entry) => entry.entry_key === op);

  it('⛔ an owner\'s revoke for one agreement survives a share that includes it — and every update after', () => {
    mintDoor('door-a');
    grants().set('door-a', OPS[1]!, false, NOW); // the Access tab, one cell
    share({ ...ONLY_YOU, all_other_contracts: true });
    expect(row('door-a', OPS[1]!)).toEqual({ entry_key: OPS[1], granted: false, set_at: NOW });
    expect(row('door-a', OPS[0]!)?.source_pack).toBe(PACK);
    share(readBack()); // the update
    expect(row('door-a', OPS[1]!)).toEqual({ entry_key: OPS[1], granted: false, set_at: NOW });
  });

  it('⛔ a door\'s own grant is not taken over — so no update or uninstall can delete it', () => {
    mintDoor('door-a');
    grants().set('door-a', OPS[0]!, true, NOW); // minted with this op (mint-fold)
    share({ ...ONLY_YOU, all_other_contracts: true });
    expect(row('door-a', OPS[0]!)?.source_pack).toBeUndefined();
    grants().clearForSourcePack(PACK); // uninstall
    expect(row('door-a', OPS[0]!)).toEqual({ entry_key: OPS[0], granted: true, set_at: NOW });
  });

  it('an owner\'s own revoke survives a customers-only share, and the owner-inclusive update after it', () => {
    mintCustomer('cust-1');
    grants().set(OWNER_CONTRACT_ID, OPS[0]!, false, NOW);
    share({ owner: false, all_customers: true, all_other_contracts: false });
    share(ONLY_YOU); // an update that shares with the owner again
    expect(row(OWNER_CONTRACT_ID, OPS[0]!)).toEqual({ entry_key: OPS[0], granted: false, set_at: NOW });
  });

  it('setForSourcePack writes over nothing or a pack\'s stamp, never over an unstamped row', () => {
    expect(grants().setForSourcePack('door-a', OPS[0]!, true, NOW, PACK)).toBe(true);
    expect(grants().setForSourcePack('door-a', OPS[0]!, true, NOW, 'other-pack')).toBe(true);
    expect(row('door-a', OPS[0]!)?.source_pack).toBe('other-pack');
    grants().set('door-a', OPS[1]!, false, NOW);
    expect(grants().setForSourcePack('door-a', OPS[1]!, true, NOW, PACK)).toBe(false);
    expect(row('door-a', OPS[1]!)?.granted).toBe(false);
    expect(() => grants().setForSourcePack('door-a', OPS[0]!, true, NOW, '')).toThrow();
  });
});

describe('an offered update carries it to the dialog', () => {
  /** v2 of an app pack whose v1 the inventory says is installed. */
  const v2: BulkPackManifest = {
    manifest_version: 2,
    slug: PACK,
    publisher: 'recued-core',
    name: 'Acme',
    description: 'Acme operations.',
    version: 2,
    recipes: [],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    pack_kind: 'app_pack',
    contents: [{
      type: 'composition',
      composition: {
        schema_version: 1,
        slug: 'acme',
        catalog_kind: 'private_byo',
        ingredients: [{ slug: 'acme', kind: 'http', http: { base: 'https://api.acme.example', connection: 'Acme' } }],
        operations: [
          { op: 'deal.read', ingredient: 'acme', risk: 'read', approval: 'never', bind: { kind: 'rest', method: 'GET', path_template: '/v1/deals' } },
          { op: 'deal.create', ingredient: 'acme', risk: 'write', approval: 'ask', bind: { kind: 'rest', method: 'POST', path_template: '/v1/deals' } },
        ],
      },
    }],
  };

  beforeEach(() => {
    mintDoor('door-a');
    mintDoor('door-b');
    share({ ...ONLY_YOU, contract_ids: ['door-a'] });
    recordPackInventory(store, {
      pack_slug: PACK, pack_version: 1, installed_at: NOW, contents: [],
      local_catalogs: [{ ingredient_id: 'acme', version: 1, catalog_kind: 'private_byo' }],
    });
    createConnectionCatalogBindingStore(store).bind('work-acme', 'acme', PACK);
  });

  it('packs.list', async () => {
    const recipes = mkdtempSync(join(tmpdir(), 'audience-recipes-'));
    const packDir = mkdtempSync(join(tmpdir(), 'audience-packs-'));
    try {
      writeFileSync(join(packDir, `${PACK}.json`), JSON.stringify(v2));
      const listed = await handlePacksList({ recipeStore: createRecipeStore(recipes, db), packDir, contractStore: store });
      const row = listed.packs.find((entry) => entry.slug === PACK)!;
      expect(row.installed_any_version && !row.installed, 'offered as an update').toBe(true);
      expect(row.current_audience).toEqual({ ...ONLY_YOU, contract_ids: ['door-a'] });
      expect(row.current_connection).toBe('work-acme');
    } finally {
      rmSync(recipes, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it('packs.resolveBySlug (a marketplace update)', async () => {
    const resolved = await resolvePackBySlug({
      recipeStore: {} as RecipeStore,
      contractStore: store,
      marketplaceFetch: (async () => ({
        ok: true, status: 200, statusText: 'OK', json: async () => v2,
      }) as unknown as Response) as typeof globalThis.fetch,
    }, { slug: PACK });
    expect(resolved.current_audience).toEqual({ ...ONLY_YOU, contract_ids: ['door-a'] });
    expect(resolved.current_connection).toBe('work-acme');
  });
});

describe('currentPackConnection — where an update\'s Connect choice starts', () => {
  const bindings = () => createConnectionCatalogBindingStore(store);

  it('the one account the pack is bound to', () => {
    bindings().bind('work-acme', 'acme', PACK);
    bindings().bind('home-other', 'other', 'other-pack');
    expect(currentPackConnection(store, PACK)).toBe('work-acme');
  });

  it('nothing when it binds none, or more than one — the dialog picks ONE, and a guess would move it', () => {
    expect(currentPackConnection(store, PACK)).toBeUndefined();
    bindings().bind('work-acme', 'acme', PACK);
    bindings().bind('work-acme-2', 'acme-extra', PACK);
    expect(currentPackConnection(store, PACK)).toBeUndefined();
  });
});

describe('⛔ an update that brings NO choice keeps the pack\'s current ones', () => {
  /** Every install writes the pack's authority from what the call carries. A call
   *  carrying nothing — a dependency re-installed below its min_version, a
   *  generated-pack re-commit, an rpc caller, the dialog before its account list
   *  loaded — got a FRESH install's answers on a pack the owner already had:
   *  authored grants only, the share withdrawn, the authored connection name. */
  const composition = (version: number) => ({
    schema_version: 1 as const,
    slug: 'acme',
    catalog_kind: 'private_byo' as const,
    ingredients: [{ slug: 'acme', kind: 'http' as const, http: { base: 'https://api.acme.example', connection: 'acme' } }],
    operations: [
      { op: 'deal.read', ingredient: 'acme', risk: 'read' as const, approval: 'never' as const, bind: { kind: 'rest' as const, method: 'GET' as const, path_template: '/v1/deals' } },
      { op: 'deal.create', ingredient: 'acme', risk: 'write' as const, approval: 'ask' as const, bind: { kind: 'rest' as const, method: 'POST' as const, path_template: '/v1/deals' } },
      ...(version > 1
        ? [{ op: 'deal.export', ingredient: 'acme', risk: 'read' as const, approval: 'never' as const, bind: { kind: 'rest' as const, method: 'GET' as const, path_template: '/v1/deals/export' } }]
        : []),
    ],
  });
  const appPack = (version: number): BulkPackManifest => ({
    manifest_version: 2,
    slug: PACK,
    publisher: 'recued-core',
    name: 'Acme',
    description: 'Acme operations.',
    version,
    recipes: [],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    pack_kind: 'app_pack',
    contents: [{ type: 'composition', composition: composition(version) }],
  });

  let dir: string;
  let installDeps: Parameters<typeof handlePacksInstall>[0];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'carry-over-'));
    installDeps = {
      recipeStore: createRecipeStore(dir, db),
      contractStore: store,
      localManifestStore: createLocalManifestStore(db),
      registry: createManifestRegistry('/nonexistent-carry-over-registry'),
      now: () => NOW,
    };
    mintDoor('door-a');
  });
  const install = async (version: number, choices: Record<string, unknown> = {}) => {
    const { result } = await handlePacksInstall(installDeps, {
      manifest: appPack(version),
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      ...choices,
    });
    expect(result.ok, JSON.stringify(result.failure ?? null)).toBe(true);
  };
  const groups = () => store.scan('grant', [PACK]).map((row) => `${row.segments[2]} ${row.segments[3]}`).sort();
  const doorShare = () => createContractGrantEntryStore(store).listForContract('door-a')
    .filter((row) => row.source_pack === PACK && row.granted).map((row) => row.entry_key).sort();
  const boundTo = () => createConnectionCatalogBindingStore(store).list()
    .filter((binding) => binding.installed_pack_id === PACK).map((binding) => binding.connection_name);

  it('Access, who may use it and the account all survive — and an added operation joins the share it falls within', async () => {
    await install(1, {
      install_scope: { access: 'write', audience: { ...ONLY_YOU, all_other_contracts: true } },
      chosen_connection: 'work-acme',
    });
    expect(groups()).toEqual(['work-acme acme.deal.read', 'work-acme acme.deal.write']);
    expect(doorShare()).toEqual(['recued-core/acme.deal.create', 'recued-core/acme.deal.read']);

    await install(2); // no choices at all
    // `deal.export` is a read: it joins `acme.deal.read`, so the group set is unchanged.
    expect(groups()).toEqual(['work-acme acme.deal.read', 'work-acme acme.deal.write']);
    expect(boundTo()).toEqual(['work-acme']);
    expect(doorShare()).toEqual([
      'recued-core/acme.deal.create', 'recued-core/acme.deal.export', 'recued-core/acme.deal.read',
    ]);
  });

  it('a choice the caller makes still wins', async () => {
    await install(1, {
      install_scope: { access: 'write', audience: { ...ONLY_YOU, all_other_contracts: true } },
      chosen_connection: 'work-acme',
    });
    await install(2, { install_scope: { access: 'read', audience: ONLY_YOU }, chosen_connection: 'home-acme' });
    expect(groups().some((g) => g.endsWith('.write'))).toBe(false);
    expect(doorShare()).toEqual([]);
    expect(boundTo()).toEqual(['home-acme']);
  });

  it('⛔ a generated pack\'s re-review reads back what it holds now (currentGeneratedPackChoices)', async () => {
    // Like a generated MCP pack, this composition authors no default grants. The review
    // used to start at a first install's answers and commit them, withdrawing the share.
    const read = () => currentGeneratedPackChoices({
      contractStore: store,
      localManifestStore: installDeps.localManifestStore!,
      packSlug: PACK,
      now: () => NOW,
    });
    expect(read(), 'not installed: a first review starts at the defaults').toBeNull();
    await install(1, { install_scope: { access: 'write', audience: { ...ONLY_YOU, all_other_contracts: true } } });
    expect(read()).toEqual({ access: 'write', audience: { ...ONLY_YOU, all_other_contracts: true } });
  });

  it('a first install still gets a fresh install\'s answers — there is nothing to carry', async () => {
    await install(1);
    expect(boundTo()).toEqual(['acme']);
    expect(groups().some((g) => g.endsWith('.write'))).toBe(false);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});
