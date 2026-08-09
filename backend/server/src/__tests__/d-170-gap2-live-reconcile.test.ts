/** D-170 gap #2 live-reconcile — the deferred Codex HIGH from the gap #2 slice
 *  (`483da23c`).
 *
 *  A composition install/uninstall writes/drops a connection→catalog binding but
 *  leaves the connection ROW untouched, so the profile-boot `addOnUpsert` observer
 *  never fires for it. Before this follow-on a local catalog became dispatchable only
 *  on the next reconnect (the observer) or boot (Pass 1b) — fail-closed until then
 *  (the gateway denied `no_connection_profile`, never over-granted). This wires an
 *  immediate reconcile: `wireCatalogOperationProfiles` returns a
 *  `reconcileConnectionProfile(name)` the install path calls post-commit (for the
 *  bound `auth.connection`) + the uninstall path calls after the binding is dropped.
 *
 *  Three surfaces:
 *    A. the `reconcileConnectionProfile` PRIMITIVE — resolve (registered-vendor-first,
 *       else binding) → seed, or drop when nothing resolves.
 *    B. the INSTALL paths invoke it post-commit with the bound connection
 *       (`ingredient.install` + the bulk `provisionPackCompositionForBulkInstall`).
 *    C. the UNINSTALL paths capture the pack's bound connections before removeForPack
 *       and reconcile each after (`ingredient.uninstall` + `packs.uninstall`). */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type CompositionIngredient,
  type IngredientManifest,
  type OperationSpec,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  createInMemoryConnectionOperationProfileStore,
  type ConnectionOperationProfileStore,
} from '../connection-operation-profile.js';
import { wireCatalogOperationProfiles } from '../connection-operation-profile-boot.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractGrantStore,
  type ContractGrantStore,
} from '../storage/contract-grant-store.js';
import {
  createConnectionCatalogBindingStore,
  type ConnectionCatalogBindingStore,
} from '../storage/connection-catalog-binding-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { provisionPackCompositionForBulkInstall } from '../ingredient-authoring/install-composition.js';
import {
  makeIngredientAuthoringHandlers,
  type IngredientAuthoringRpcDeps,
} from '../ingredient-authoring/install-rpc.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_700_000_000_000;

// ── composition fixtures (mirrors d-170-install-integration) ─────

const readBinding = (path: string) => ({ kind: 'rest' as const, method: 'GET' as const, path_template: path });
const writeBinding = (path: string) => ({ kind: 'rest' as const, method: 'POST' as const, path_template: path });

/** A wide composition (2 ops + an entity) bound to `connection` → decomposes to a
 *  local catalog `slug`. The install records the `connection → slug` binding. */
const wideComposition = (slug = 'acme', connection = 'acme'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection },
      entities: {
        Deal: {
          fields: [
            { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
          ],
        },
      },
    },
  ],
  operations: [
    {
      op: 'deal.read',
      ingredient: slug,
      risk: 'read',
      approval: 'never',
      bind: readBinding('/v3/deals/{deal_id}'),
      description: 'Read one deal.',
    },
    {
      op: 'deal.create',
      ingredient: slug,
      risk: 'write',
      approval: 'ask',
      bind: writeBinding('/v3/deals'),
      description: 'Create a deal.',
    },
  ],
});

/** A 1×1 composition → a standalone ingredient (NO catalog, NO binding). */
const oneByOne = (slug = 'ticket-read'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.support.example', connection: 'support' },
    },
  ],
  operations: [
    {
      op: 'ticket.read',
      ingredient: slug,
      risk: 'read',
      approval: 'never',
      bind: readBinding('/v1/tickets/{ticket_id}'),
      description: 'Read one support ticket.',
    },
  ],
});

const appPack = (composition: CompositionIngredient, packSlug = 'acme-crm'): BulkPackManifest => ({
  manifest_version: 2,
  slug: packSlug,
  publisher: 'recued-core',
  name: 'Acme CRM',
  description: 'Acme operations + entity schemas.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: [],
  pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition }],
});

// ════════════════════════════════════════════════════════════════
// A. the reconcileConnectionProfile PRIMITIVE
// ════════════════════════════════════════════════════════════════

describe('D-170 gap #2 live-reconcile — reconcileConnectionProfile primitive', () => {
  const LOCAL_SLUG = 'acme-local';
  const TICKETS_READ = 'tickets.read';
  const HS_READ = 'hs.read';
  const localCatalog = (): IngredientManifest => ({
    slug: LOCAL_SLUG,
    name: 'Acme local',
    description: 'A private/local composition catalog (no registered vendor).',
    author: 'recued',
    kind: 'http',
    category: 'data',
    risk_tier: 'read',
    input: {},
    output: {},
    operations: {
      'ticket.read': { operation_id: 'x/ticket.read', risk_tier: 'read' },
      'ticket.create': { operation_id: 'x/ticket.create', risk_tier: 'write' },
    } satisfies Record<string, OperationSpec>,
    operation_groups: {
      [TICKETS_READ]: { group_id: TICKETS_READ, operations: ['ticket.read'], risk_floor: 'read' },
      'tickets.write': { group_id: 'tickets.write', operations: ['ticket.create'], risk_floor: 'write' },
    },
  });
  const hubspotCatalog = (): IngredientManifest => ({
    ...localCatalog(),
    slug: 'hubspot-catalog',
    operations: {
      'deal.read': { operation_id: 'x/deal.read', risk_tier: 'read' },
      'contact.read': { operation_id: 'x/contact.read', risk_tier: 'read' },
    } satisfies Record<string, OperationSpec>,
    operation_groups: {
      [HS_READ]: { group_id: HS_READ, operations: ['deal.read', 'contact.read'], risk_floor: 'read' },
    },
  });
  const getManifest = (slug: string): IngredientManifest | null =>
    slug === LOCAL_SLUG ? localCatalog() : slug === 'hubspot-catalog' ? hubspotCatalog() : null;

  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;
  let contractStore: ContractStore;
  let grantStore: ContractGrantStore;
  let bindingStore: ConnectionCatalogBindingStore;
  let profileStore: ConnectionOperationProfileStore;
  let reconcile: (name: string) => void;

  const apiConnection = (name: string, vendor: string): ConnectionUpsert => ({
    kind: 'api',
    name,
    display_name: `${vendor} ${name}`,
    config_json: JSON.stringify({ vendor }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    connectionStore = createConnectionStore(db);
    contractStore = createContractStore(db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    grantStore = createContractGrantStore(contractStore);
    bindingStore = createConnectionCatalogBindingStore(contractStore);
    profileStore = createInMemoryConnectionOperationProfileStore();
    reconcile = wireCatalogOperationProfiles({
      connectionStore,
      profileStore,
      getManifest,
      contractGrantStore: grantStore,
      connectionCatalogBindingStore: bindingStore,
    }).reconcileConnectionProfile;
  });

  afterEach(() => {
    db.close();
  });

  it('seeds a connection the moment an install-time binding is written (connect-BEFORE-install)', () => {
    // The connection exists first, under a non-catalog vendor — boot seeds nothing.
    connectionStore.upsert(apiConnection('support', 'custom'));
    expect(profileStore.get('support')).toBeNull();

    // A composition install writes the binding + the §7.1 read grant (here directly) but
    // does NOT touch the connection row — the observer never fires. The explicit
    // reconcile lights it up from the granted read group.
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', TICKETS_READ);
    reconcile('support');

    /** ⚠ 2026-08-07: the write op is seeded too — the connection layer stopped gating.
     *  This test is about the RECONCILE FIRING at all (connect-before-install), which is
     *  what `catalog_slug` proves; the op set was only ever the payload. */
    const profile = profileStore.get('support');
    expect(profile?.catalog_slug).toBe(LOCAL_SLUG);
    expect([...profile!.allowed_operations].sort()).toEqual(['ticket.create', 'ticket.read']);
  });

  it('⛔ seeds the catalog even with NO group granted — 5c ratchet retired', () => {
    /** Inverted in place 2026-08-07 rather than deleted, so the retirement is legible
     *  where the ratchet used to be enforced. `catalog_slug` still proves the reconcile
     *  resolved the right catalog; what changed is that reachability no longer waits on
     *  a grant. The fail-closed half is asserted by its own sibling below: remove the
     *  BINDING and the profile is dropped. */
    connectionStore.upsert(apiConnection('support', 'custom'));
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    reconcile('support');
    const profile = profileStore.get('support');
    expect(profile?.catalog_slug).toBe(LOCAL_SLUG);
    expect([...profile!.allowed_operations].sort()).toEqual(['ticket.create', 'ticket.read']);
  });

  it('unions a pack-owned grant on the local catalog into the reconciled profile', () => {
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', TICKETS_READ);
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', 'tickets.write');

    reconcile('support');

    expect([...profileStore.get('support')!.allowed_operations].sort()).toEqual(
      ['ticket.create', 'ticket.read'].sort(),
    );
  });

  it('DROPS the profile after the binding is removed (uninstall reconcile)', () => {
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', TICKETS_READ);
    reconcile('support');
    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG);

    // Uninstall drops the binding; reconciling the formerly-bound name now resolves
    // nothing → fail-closed delete.
    bindingStore.removeForPack('acme-pack');
    reconcile('support');

    expect(profileStore.get('support')).toBeNull();
  });

  it('a registered-vendor profile SURVIVES removal of a shadowed local binding', () => {
    // A composition bound its local catalog to a name that is ALSO a hubspot api
    // connection. Registered vendor wins, so the profile resolves the vendor catalog…
    connectionStore.upsert(apiConnection('hs', 'hubspot'));
    grantStore.grantUserGroup('hubspot-catalog', 'hs', HS_READ); // owner granted vendor reads
    bindingStore.bind('hs', LOCAL_SLUG, 'acme-pack');
    reconcile('hs');
    expect(profileStore.get('hs')?.catalog_slug).toBe('hubspot-catalog');

    // …and dropping the local binding leaves the vendor profile intact (NOT deleted).
    bindingStore.removeForPack('acme-pack');
    reconcile('hs');
    expect(profileStore.get('hs')?.catalog_slug).toBe('hubspot-catalog');
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual(
      ['contact.read', 'deal.read'].sort(),
    );
  });

  it('resolves a NON-api bound connection through the binding alone', () => {
    // No api connection row at all — `connectionStore.get('api', name)` is null, so the
    // reconcile falls straight to the binding (a local catalog binds to any kind).
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', TICKETS_READ);
    reconcile('support');
    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG);
  });

  it('is a safe no-op for a name that resolves nothing', () => {
    expect(() => reconcile('never-bound')).not.toThrow();
    expect(profileStore.get('never-bound')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// B + C. install / uninstall paths invoke reconcile (wiring + payoff)
// ════════════════════════════════════════════════════════════════

interface WiredEnv {
  db: Database.Database;
  contractStore: ContractStore;
  localManifestStore: LocalManifestStore;
  registry: ManifestRegistry;
  connectionStore: ConnectionStoreSqlite;
  profileStore: ConnectionOperationProfileStore;
  bindingStore: ConnectionCatalogBindingStore;
  /** Every connection name the install/uninstall paths reconciled, in order. */
  reconciled: string[];
  /** The reconcile dep handed to the rpc deps — logs the call AND seeds for real. */
  reconcileConnectionProfile: (name: string) => void;
  deps: IngredientAuthoringRpcDeps;
  install: (
    manifest: unknown,
    install_scope?: import('@recued/contracts').InstallGrantSelection,
  ) => Promise<import('@recued/contracts').IngredientInstallResult>;
  uninstall: (
    args: import('@recued/contracts').IngredientUninstallArgs,
  ) => Promise<import('@recued/contracts').IngredientUninstallResult>;
}

const makeWiredEnv = (recipes: Record<string, RecipeDefinition> = {}): WiredEnv => {
  const db = new Database(':memory:');
  const contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  const localManifestStore = createLocalManifestStore(db);
  const registry = createManifestRegistry('/nonexistent-d170-gap2-test-dir');
  const connectionStore = createConnectionStore(db);
  const grantStore = createContractGrantStore(contractStore);
  const bindingStore = createConnectionCatalogBindingStore(contractStore);
  const profileStore = createInMemoryConnectionOperationProfileStore();
  const realReconcile = wireCatalogOperationProfiles({
    connectionStore,
    profileStore,
    // The reconcile resolves the local catalog through the SAME live registry the
    // install registers the decomposed body into (N.16) — exactly the production wire
    // (compose-execution-context getManifest === ingredientAuthoringDeps.registry).
    getManifest: (slug) => registry.get(slug),
    contractGrantStore: grantStore,
    connectionCatalogBindingStore: bindingStore,
  }).reconcileConnectionProfile;
  // Wrap so a single harness gives BOTH the call log (wiring) and the real seeding
  // (end-to-end payoff).
  const reconciled: string[] = [];
  const reconcileConnectionProfile = (name: string): void => {
    reconciled.push(name);
    realReconcile(name);
  };
  const recipeStore = {
    ids: () => Object.keys(recipes),
    get: (id: string) => recipes[id] ?? null,
  };
  const deps: IngredientAuthoringRpcDeps = {
    localManifestStore,
    contractStore,
    registry,
    recipeStore,
    now: () => NOW,
    reconcileConnectionProfile,
  };
  const handlers = makeIngredientAuthoringHandlers(deps)!;
  const client = {} as WsClient;
  return {
    db,
    contractStore,
    localManifestStore,
    registry,
    connectionStore,
    profileStore,
    bindingStore,
    reconciled,
    reconcileConnectionProfile,
    deps,
    install: (manifest, install_scope) =>
      handlers.handlers['ingredient.install']({ manifest, install_scope }, client),
    uninstall: (args) => handlers.handlers['ingredient.uninstall'](args, client),
  };
};

describe('D-170 gap #2 live-reconcile — ingredient.install invokes reconcile', () => {
  let env: WiredEnv;
  beforeEach(() => {
    env = makeWiredEnv();
  });
  afterEach(() => {
    env.db.close();
  });

  it('reconciles the composition’s bound connection exactly once on install', async () => {
    const result = await env.install(appPack(wideComposition('acme', 'acme')));
    expect(result.ok).toBe(true);
    // The binding (auth.connection = 'acme') is reconciled post-commit.
    expect(env.reconciled).toEqual(['acme']);
  });

  it('end-to-end: install with Read scope lights up a pre-existing connection’s profile', async () => {
    // The connect-BEFORE-install scenario: the connection already exists (non-catalog
    // vendor → no profile yet); installing the composition binds it + reconciles. Under
    // D-182 §7.1 inc 5c reads are NOT auto-granted — the install dialog's Read scope
    // (`install_scope: { access: 'read' }`) grants the derived read group, so the
    // gateway can dispatch its read op at once (the write op stays off — not selected).
    env.connectionStore.upsert({
      kind: 'api',
      name: 'acme',
      display_name: 'Acme custom',
      config_json: JSON.stringify({ vendor: 'custom' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(env.profileStore.get('acme')).toBeNull();

    await env.install(appPack(wideComposition('acme', 'acme')), { access: 'read' });

    /** ⚠ 2026-08-07: the Read scope no longer NARROWS the seeded set — the connection
     *  layer is open, so the write op is seeded too and the `access` tier's effect is
     *  now confined to the per-door op-admission fan-out (`applyInstallOpAdmissionFanOut`),
     *  which is where authority actually lives. The connect-BEFORE-install property this
     *  test is named for is `catalog_slug` resolving at all, and it is unchanged. */
    const profile = env.profileStore.get('acme');
    expect(profile?.catalog_slug).toBe('acme');
    expect([...profile!.allowed_operations].sort()).toEqual(['deal.create', 'deal.read']);
  });

  it('end-to-end: install WITHOUT a grant scope seeds nothing (deny until granted — inc 5c)', async () => {
    // Same connect-before-install flow, but the owner skipped the dialog (no
    // install_scope). The reconcile still fires (wiring works) — but with no granted
    // read group the derived set is empty → the profile is dropped → reads denied.
    env.connectionStore.upsert({
      kind: 'api',
      name: 'acme',
      display_name: 'Acme custom',
      config_json: JSON.stringify({ vendor: 'custom' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });

    await env.install(appPack(wideComposition('acme', 'acme')));

    /** ⚠ INVERTED 2026-08-07. This asserted that skipping the install dialog left the
     *  profile null (deny until granted). With the connection layer open the catalog is
     *  seeded regardless — an install with no scope no longer leaves a dead connection.
     *
     *  🔑 THE WIRING ASSERTION IS THE ONE THIS TEST WAS BUILT FOR and is unchanged: the
     *  reconcile FIRES on install. That is what would break if the hook were lost, and
     *  a null profile could previously mask it — the two causes are now separable. */
    expect(env.reconciled).toContain('acme');
    expect(env.profileStore.get('acme')?.catalog_slug).toBe('acme');
  });

  it('reinstall that MOVES auth.connection drops the old connection’s profile (no stale grant)', async () => {
    // First install (Read scope) binds connection 'conn-old' → catalog 'acme' and seeds
    // its read profile.
    await env.install(appPack(wideComposition('acme', 'conn-old'), 'acme-crm'), { access: 'read' });
    expect(env.profileStore.get('conn-old')?.catalog_slug).toBe('acme');

    // Reinstall the SAME pack/catalog but pointed at 'conn-new'. The commit drops the
    // 'conn-old' binding + writes 'conn-new'; the install must reconcile BOTH so the
    // displaced 'conn-old' profile is dropped (not left dispatching the local catalog).
    env.reconciled.length = 0;
    await env.install(appPack(wideComposition('acme', 'conn-new'), 'acme-crm'), { access: 'read' });

    expect(env.reconciled.sort()).toEqual(['conn-new', 'conn-old']);
    expect(env.profileStore.get('conn-old')).toBeNull(); // stale profile dropped
    expect(env.profileStore.get('conn-new')?.catalog_slug).toBe('acme'); // new one seeded
  });

  it('does NOT reconcile for a 1×1 standalone install (no connection→catalog binding)', async () => {
    const result = await env.install(oneByOne('ticket-read'));
    expect(result.ok).toBe(true);
    // The standalone path writes no binding + no grants → nothing to reconcile.
    expect(env.reconciled).toEqual([]);
  });

  it('bulk provisionPackCompositionForBulkInstall reconciles the bound connection too', () => {
    const reconciled: string[] = [];
    const provisioned = provisionPackCompositionForBulkInstall(
      {
        localManifestStore: env.localManifestStore,
        contractStore: env.contractStore,
        registry: env.registry,
        now: () => NOW,
        reconcileConnectionProfile: (name) => reconciled.push(name),
      },
      appPack(wideComposition('acme', 'acme')),
      [],
    );
    expect(provisioned.ok).toBe(true);
    expect(reconciled).toEqual(['acme']);
  });
});

describe('D-170 gap #2 live-reconcile — ingredient.uninstall invokes reconcile', () => {
  let env: WiredEnv;
  beforeEach(() => {
    env = makeWiredEnv();
  });
  afterEach(() => {
    env.db.close();
  });

  it('reconciles the formerly-bound connection after the pack is uninstalled', async () => {
    await env.install(appPack(wideComposition('acme', 'acme')));
    env.reconciled.length = 0; // ignore the install-time reconcile

    const result = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(result.ok).toBe(true);
    expect(env.reconciled).toEqual(['acme']);
  });

  it('end-to-end: uninstall drops the local connection’s now-orphan profile', async () => {
    await env.install(appPack(wideComposition('acme', 'acme')), { access: 'read' });
    expect(env.profileStore.get('acme')?.catalog_slug).toBe('acme'); // seeded by install (Read scope)

    await env.uninstall({ pack_slug: 'acme-crm' });

    // Binding gone → reconcile resolved nothing → profile dropped (fail-closed).
    expect(env.profileStore.get('acme')).toBeNull();
    expect(env.bindingStore.resolveCatalogSlug('acme')).toBeUndefined();
  });
});

describe('D-170 gap #2 live-reconcile — packs.uninstall invokes reconcile', () => {
  let db: Database.Database;
  let contractStore: ContractStore;
  let bindingStore: ConnectionCatalogBindingStore;
  let packDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    contractStore = createContractStore(db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    bindingStore = createConnectionCatalogBindingStore(contractStore);
    packDir = mkdtempSync(join(tmpdir(), 'recued-d170-gap2-reconcile-packs-'));
    writeFileSync(
      join(packDir, 'acme-crm.json'),
      JSON.stringify(appPack(wideComposition('acme-cat', 'acme'), 'acme-crm')),
    );
  });
  afterEach(() => {
    db.close();
    rmSync(packDir, { recursive: true, force: true });
  });

  it('reconciles the pack’s bound connections captured before removeForPack', async () => {
    // The pack owns a binding (connection 'acme' → local catalog). packs.uninstall must
    // capture it BEFORE dropping it, then reconcile after.
    bindingStore.bind('acme', 'acme-cat', 'acme-crm');
    const reconciled: string[] = [];
    // Minimal recipe store — packs.uninstall only touches listForPack / delete here.
    const recipeStore = { listForPack: () => [], delete: () => false } as unknown as RecipeStore;

    const { result } = await handlePacksUninstall(
      {
        recipeStore,
        contractStore,
        reconcileConnectionProfile: (name) => reconciled.push(name),
        packDir,
      },
      { pack_slug: 'acme-crm' },
    );

    expect(result.ok).toBe(true);
    expect(reconciled).toEqual(['acme']);
    // The binding is gone (dropped in the uninstall txn before the reconcile).
    expect(bindingStore.resolveCatalogSlug('acme')).toBeUndefined();
  });

  it('unions GRANT-target connections into the reconcile set (§1.6 grant-only shrink)', async () => {
    // The pack granted operation groups on a connection it did NOT bind:
    // `removePackGroups` shrinks what that connection's profile derives from, so
    // it must be re-derived too. (Today's install paths always pair a grant with
    // a binding on the SAME connection — the union covers a future
    // grant-without-binding path and keeps the live profile honest the moment
    // the rows drop.) The shared bound+granted connection reconciles ONCE.
    bindingStore.bind('acme', 'acme-cat', 'acme-crm');
    const grantStore = createContractGrantStore(contractStore);
    grantStore.grantPackGroup('acme-crm', 'acme-cat', 'acme', 'g'); // same conn as the binding
    grantStore.grantPackGroup('acme-crm', 'hubspot-catalog', 'my-hs', 'deal-write'); // grant-only conn
    const reconciled: string[] = [];
    const recipeStore = { listForPack: () => [], delete: () => false } as unknown as RecipeStore;

    const { result } = await handlePacksUninstall(
      {
        recipeStore,
        contractStore,
        reconcileConnectionProfile: (name) => reconciled.push(name),
        packDir,
      },
      { pack_slug: 'acme-crm' },
    );

    expect(result.ok).toBe(true);
    expect([...reconciled].sort()).toEqual(['acme', 'my-hs']); // deduped union
    // The pack's grant rows are gone (the reconcile re-derived against the shrink).
    expect(grantStore.listPackOwnedGroups('hubspot-catalog', 'my-hs')).toEqual([]);
  });
});
