/** D-194 step 3a — re-source the pack grant's connection from the owner's chosen
 *  connection.
 *
 *  The install path used to freeze a pack's grant + `connection_catalog_binding`
 *  to the composition's authored `auth.connection` literal (e.g. `'microsoft'`).
 *  Step 3a threads an optional CHOSEN connection (the install-dialog "Connect /
 *  Reuse" pick, D-194 §3/§13) through the provisioners: when present + the
 *  composition binds a connection, the grant + binding bind to the CHOSEN name
 *  instead — so dispatch (via the connection→catalog binding, which is keyed on
 *  connection_name) resolves the pack's ops on the reused connection. A
 *  connection-less (cli) composition has nothing to re-target; an absent/empty
 *  pick keeps today's authored-literal behavior (back-compat).
 *
 *  Exercises the real provisioner (`provisionPackCompositionForBulkInstall`) over
 *  an in-memory contract store, plus the pure `reSourceGrantConnection` seam. The
 *  rpc→dialog wiring that PRODUCES the pick is D-194 step 2b. */

import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type CompositionIngredient,
} from '@recued/contracts';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  provisionAuthoredArtifact,
  provisionPackCompositionForBulkInstall,
  reSourceGrantConnection,
  type ProvisionAuthoredDeps,
} from '../ingredient-authoring/install-composition.js';
import { handlePacksInstall } from '../pack-install-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';

const NOW = 1_700_000_000_000;
// The composition's authored `auth.connection` literal. Derived group ids are
// `<slug>.<family>.<risk>` (family = op segment before the first dot), so op
// `deal.read` on slug `acme` → group `acme.deal.read` (the d-182 proven shape).
const AUTHORED = 'acme';
const CHOSEN = 'work-onedrive'; // the owner's reuse pick (a differently-named row)

/** A read-only catalog composition over the AUTHORED connection, carrying one
 *  headless-honorable authored read-tier default_grant so a grant is written even
 *  without an install_scope (mirrors d-182's proven fixture — a 2-op catalog).
 *  `catalogSlug` lets a second, distinct catalog be built for the cross-pack
 *  conflict test. */
const comp = (catalogSlug = 'acme'): CompositionIngredient => ({
  schema_version: 1,
  slug: catalogSlug,
  catalog_kind: 'private_byo',
  ingredients: [
    { slug: catalogSlug, kind: 'http', http: { base: 'https://api.acme.example', connection: AUTHORED } },
  ],
  operations: [
    {
      op: 'deal.read',
      ingredient: catalogSlug,
      risk: 'read',
      approval: 'never',
      bind: { kind: 'rest', method: 'GET', path_template: '/v3/deal.read' },
      description: 'deal.read op.',
    },
    {
      op: 'deal.create',
      ingredient: catalogSlug,
      risk: 'write',
      approval: 'ask',
      bind: { kind: 'rest', method: 'POST', path_template: '/v3/deal.create' },
      description: 'deal.create op.',
    },
  ],
  default_grants: [`${catalogSlug}.deal.read`],
});

const appPack = (packSlug = 'acme-crm', catalogSlug = 'acme'): BulkPackManifest => ({
  manifest_version: 2,
  slug: packSlug, // pack slug distinct from the composition/catalog slug
  publisher: 'recued-core',
  name: 'Acme CRM',
  description: 'Acme operations.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: [],
  pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition: comp(catalogSlug) }],
});

let db: Database.Database;
let contractStore: ContractStore;
let deps: ProvisionAuthoredDeps;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  deps = {
    localManifestStore: createLocalManifestStore(db),
    contractStore,
    registry: createManifestRegistry('/nonexistent-d194-test-dir'),
    now: () => NOW,
  };
});

/** connection_name (grant segment index 2) of every written pack grant, unique + sorted. */
const grantConnections = (): string[] =>
  [...new Set(
    contractStore.scan('grant', [])
      .map((r) => r.segments[2])
      .filter((c): c is string => typeof c === 'string'),
  )].sort();

/** connection_name (binding segment index 0 — the binding is keyed on it) of every
 *  connection→catalog binding, sorted. */
const bindingConnections = (): string[] =>
  contractStore.scan('connection_catalog_binding', [])
    .map((r) => r.segments[0])
    .filter((c): c is string => typeof c === 'string')
    .sort();

// ────────────────────────────────────────────────────────────────
describe('D-194 step 3a — reSourceGrantConnection (pure)', () => {
  it('prefers the chosen connection when the composition binds one', () => {
    expect(reSourceGrantConnection(AUTHORED, CHOSEN)).toBe(CHOSEN);
  });

  it('falls back to the authored literal on an absent / empty pick', () => {
    expect(reSourceGrantConnection(AUTHORED, undefined)).toBe(AUTHORED);
    expect(reSourceGrantConnection(AUTHORED, '')).toBe(AUTHORED);
  });

  it('ignores a pick for a connection-less (cli) composition — nothing to re-target', () => {
    expect(reSourceGrantConnection(undefined, CHOSEN)).toBeUndefined();
    expect(reSourceGrantConnection(undefined, undefined)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
describe('D-194 step 3a — install re-sources grant + binding to the chosen connection', () => {
  it('binds the grant + catalog binding to the CHOSEN connection (not the authored literal)', () => {
    const r = provisionPackCompositionForBulkInstall(deps, appPack(), [], undefined, CHOSEN);
    expect(r.ok).toBe(true);
    expect(grantConnections()).toEqual([CHOSEN]);
    expect(grantConnections()).not.toContain(AUTHORED);
    expect(bindingConnections()).toEqual([CHOSEN]);
  });

  it('keeps the authored literal when no connection is chosen (back-compat)', () => {
    const r = provisionPackCompositionForBulkInstall(deps, appPack(), []);
    expect(r.ok).toBe(true);
    expect(grantConnections()).toEqual([AUTHORED]);
    expect(bindingConnections()).toEqual([AUTHORED]);
  });

  it('treats an empty chosen connection as absent (back-compat)', () => {
    const r = provisionPackCompositionForBulkInstall(deps, appPack(), [], undefined, '');
    expect(r.ok).toBe(true);
    expect(grantConnections()).toEqual([AUTHORED]);
    expect(bindingConnections()).toEqual([AUTHORED]);
  });
});

/** The catalog_slug bound to a connection (via the binding store's resolver). */
const bindingCatalogFor = (connection: string): string | undefined =>
  createConnectionCatalogBindingStore(contractStore).resolveCatalogSlug(connection);

// ────────────────────────────────────────────────────────────────
describe('D-194 step 3a — re-source edge cases (review fold)', () => {
  it('reinstall MOVES the grant + binding to a newly-chosen connection (replace, not append)', () => {
    // First install: no pick → authored 'acme'.
    expect(provisionPackCompositionForBulkInstall(deps, appPack(), []).ok).toBe(true);
    expect(grantConnections()).toEqual([AUTHORED]);
    expect(bindingConnections()).toEqual([AUTHORED]);
    // Reinstall the SAME pack, now choosing a different connection → grant +
    // binding MOVE to it (removePackGroups / removeForPack run first = replace),
    // the old connection is left with nothing.
    expect(provisionPackCompositionForBulkInstall(deps, appPack(), [], undefined, CHOSEN).ok).toBe(true);
    expect(grantConnections()).toEqual([CHOSEN]);
    expect(bindingConnections()).toEqual([CHOSEN]);
  });

  it('a chosen connection already bound by ANOTHER pack fails closed (one catalog per connection, §13)', () => {
    const SHARED = 'shared-graph';
    // Pack A binds SHARED → catalog 'acme'.
    expect(provisionPackCompositionForBulkInstall(deps, appPack('acme-crm', 'acme'), [], undefined, SHARED).ok).toBe(true);
    expect(bindingCatalogFor(SHARED)).toBe('acme');
    // Pack B (distinct pack + catalog) also chooses SHARED → its binding is NOT
    // written (A owns the connection); A's binding survives, B stays fail-closed
    // (its ops aren't dispatchable on SHARED until the conflict is resolved).
    expect(provisionPackCompositionForBulkInstall(deps, appPack('beta-crm', 'beta'), [], undefined, SHARED).ok).toBe(true);
    expect(bindingCatalogFor(SHARED)).toBe('acme'); // unchanged — B did not hijack it
  });

  it('re-sources through the provisionAuthoredArtifact (ingredient.install) entry too', () => {
    const r = provisionAuthoredArtifact(deps, appPack(), undefined, CHOSEN);
    expect(r.ok).toBe(true);
    expect(grantConnections()).toEqual([CHOSEN]);
    expect(bindingConnections()).toEqual([CHOSEN]);
  });
});

// ────────────────────────────────────────────────────────────────
// D-194 step 2b-1 — the chosen_connection RPC handler wire
// ────────────────────────────────────────────────────────────────

describe('D-194 step 2b-1 — chosen_connection through the packs.install rpc handler', () => {
  // handlePacksInstall provisions the composition through the SAME deps as above
  // (contractStore / localManifestStore / registry from the outer beforeEach) plus
  // a real recipeStore; a `recipes: []` app-pack installs no recipes but the handler
  // still provisions the composition + writes the grant, so grantConnections()
  // reflects whether the rpc arg reached the provisioner.
  let dir: string;
  let installDeps: Parameters<typeof handlePacksInstall>[0];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-d194-2b-'));
    installDeps = {
      recipeStore: createRecipeStore(dir, db),
      contractStore,
      localManifestStore: deps.localManifestStore,
      registry: deps.registry,
      now: () => NOW,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-sources the grant to the chosen connection end-to-end (rpc arg → provisioner)', async () => {
    const { result } = await handlePacksInstall(installDeps, {
      manifest: appPack(),
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      chosen_connection: CHOSEN,
    });
    expect(result.ok).toBe(true);
    // The grant landed on the owner's pick, not the composition's authored literal.
    expect(grantConnections()).toEqual([CHOSEN]);
    expect(grantConnections()).not.toContain(AUTHORED);
  });

  it('preserves the authored literal when chosen_connection is omitted (connect is optional)', async () => {
    const { result } = await handlePacksInstall(installDeps, {
      manifest: appPack(),
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
    });
    expect(result.ok).toBe(true);
    expect(grantConnections()).toEqual([AUTHORED]);
  });

  it('rejects a non-string chosen_connection as bad_request', async () => {
    await expect(
      handlePacksInstall(installDeps, {
        manifest: appPack(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        chosen_connection: 123 as never,
      }),
    ).rejects.toThrow(/chosen_connection/);
  });
});
