/** D-182 §7.1 — the install grant dialog (Access × Scope) + the end of the
 *  silent read-tier auto-grant.
 *
 *  The install path no longer silently grants a composition's DERIVED read-tier
 *  groups. Instead:
 *    - HEADLESS (no `install_scope` — boot / bulk / cron, or an install rpc that
 *      omitted it) → grant ONLY the pack's AUTHORED `composition.default_grants`
 *      that are headless-honorable: read-tier always, a higher tier only when
 *      every op carries an approval gate (`ask` / `always`). A non-read
 *      `approval: never` authored grant is NOT honored headlessly (fail-closed).
 *    - INTERACTIVE (`install_scope` present — the dialog was shown) → grant the
 *      authored-honorable set PLUS every derived group at-or-below the chosen
 *      `Access` tier ceiling (`read` → {read}; `write` → {read, write}; `all` →
 *      {read, write, admin, destructive}).
 *
 *  Exercises the real provisioner (`provisionPackCompositionForBulkInstall`,
 *  which takes the scope directly) over an in-memory contract store, plus the
 *  `ingredient.install` / `packs.install` rpc arg validation. Reception's
 *  cold-start grant (`*.write` + `approval: ask`) is the canonical headless-
 *  honorable case — its survival is covered by the d-173 e2e suites; here we
 *  pin the SHAPE with an equivalent fixture. */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  BULK_PACK_INSTALL_PERMISSION,
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type CompositionIngredient,
  type OperationApproval,
  type OperationRiskTier,
} from '@recued/contracts';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  provisionPackCompositionForBulkInstall,
  type ProvisionAuthoredDeps,
} from '../ingredient-authoring/install-composition.js';
import {
  makeIngredientAuthoringHandlers,
  type IngredientAuthoringRpcDeps,
} from '../ingredient-authoring/install-rpc.js';
import { handlePacksInstall } from '../pack-install-handler.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_700_000_000_000;
const CONNECTION = 'acme';

const readBinding = (path: string) =>
  ({ kind: 'rest' as const, method: 'GET' as const, path_template: path });
const writeBinding = (path: string) =>
  ({ kind: 'rest' as const, method: 'POST' as const, path_template: path });

type OpSpec = {
  op: string;
  risk: OperationRiskTier;
  approval: OperationApproval;
};

/** A wide (catalog-path) composition over the `acme` connection. Each op's
 *  derived group is `acme.<family>.<risk>` (family = the part before the first
 *  dot). `default_grants` names authored derived-group ids. */
const comp = (
  ops: OpSpec[],
  defaultGrants?: string[],
  slug = 'acme',
): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection: CONNECTION },
    },
  ],
  operations: ops.map((o) => ({
    op: o.op,
    ingredient: slug,
    risk: o.risk,
    approval: o.approval,
    bind: o.risk === 'read' ? readBinding(`/v3/${o.op}`) : writeBinding(`/v3/${o.op}`),
    description: `${o.op} op.`,
  })),
  ...(defaultGrants ? { default_grants: defaultGrants } : {}),
});

const appPack = (composition: CompositionIngredient, packSlug = 'acme-crm'): BulkPackManifest => ({
  manifest_version: 2,
  slug: packSlug,
  publisher: 'recued-core',
  name: 'Acme CRM',
  description: 'Acme operations.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: [],
  pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition }],
});

// Fixtures (group ids in comments) ────────────────────────────────
// read op   → acme.deal.read        (read,  never)
// write op  → acme.deal.write       (write, ask)
// sync op   → acme.sync.write       (write, never)  — distinct family
// purge op  → acme.deal.destructive (destructive, always)
const READ: OpSpec = { op: 'deal.read', risk: 'read', approval: 'never' };
const LIST: OpSpec = { op: 'deal.list', risk: 'read', approval: 'never' };
const WRITE_ASK: OpSpec = { op: 'deal.create', risk: 'write', approval: 'ask' };
const WRITE_NEVER: OpSpec = { op: 'sync.run', risk: 'write', approval: 'never' };
const DESTRUCTIVE: OpSpec = { op: 'deal.purge', risk: 'destructive', approval: 'always' };

let db: Database.Database;
let contractStore: ContractStore;
let deps: ProvisionAuthoredDeps;

const makeDeps = (store: ContractStore): ProvisionAuthoredDeps => ({
  localManifestStore: createLocalManifestStore(db),
  contractStore: store,
  registry: createManifestRegistry('/nonexistent-d182-test-dir'),
  now: () => NOW,
});

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  deps = makeDeps(contractStore);
});

/** The group ids actually granted (segment 3 of each `grant` row), sorted. */
const grantedGroups = (): string[] =>
  contractStore
    .scan('grant', [])
    .map((r) => r.segments[3])
    .filter((g): g is string => typeof g === 'string')
    .sort();

// ── D-182 §7.2 fan-out helpers ────────────────────────────────────
/** Mint a LIVE governing door (standing contract, active, no expiry). `newId` is
 *  seamed to `id` so the door's contract_id is predictable. Its `operation_ids`
 *  scope is irrelevant to fan-out targeting (the fan-out targets by liveness only)
 *  but pins a mint-fold-style row set when needed. */
const mintDoor = (id: string, operationIds?: string[]): string =>
  createContractDefinitionStore(contractStore, { now: () => NOW, newId: () => id })
    .mint({
      minted_by: 'user:1',
      display_name: id,
      scope: {
        channels: ['mcp'],
        actors: ['contracted_user'],
        ...(operationIds ? { operation_ids: operationIds } : {}),
      },
    })
    .contract_id;

/** Stamp the same live bound row shape D-196 issue creates. This must not use a
 *  standing-door surrogate: install audiences explicitly opt customer instances
 *  into the otherwise standing-only fan-out target set. */
const mintCustomerDoor = (id: string, operationIds?: string[]): string => {
  const contractId = mintDoor(id, operationIds);
  const definitionStore = createContractDefinitionStore(contractStore, { now: () => NOW });
  const def = definitionStore.get(contractId);
  if (def === null) throw new Error(`missing test contract '${contractId}'`);
  contractStore.put(CONTRACT_DEFINITION_SCOPE, [contractId], {
    ...def,
    grant_kind: 'customer_instance',
  });
  return contractId;
};

const revokeDoor = (id: string): void => {
  createContractDefinitionStore(contractStore, { now: () => NOW }).revoke(id, 'test');
};

/** The op-admission (B) rows a door holds that were written by a pack FAN-OUT
 *  (i.e. carry a `source_pack`), as `entry_key`s sorted. */
const fanoutRows = (doorId: string): string[] =>
  createContractGrantEntryStore(contractStore)
    .listForContract(doorId)
    .filter((r) => typeof r.source_pack === 'string')
    .map((r) => r.entry_key)
    .sort();

const sellerStoreForCustomerContracts = (
  contractIds: readonly string[],
): ProvisionAuthoredDeps['sellerStore'] => ({
  listCustomers: () =>
    contractIds.map((contract_id, idx) => ({
      contract_id,
      customer_id: `seller_customer_${idx}`,
      tier_id: idx === 0 ? 'tier-pro' : 'tier-basic',
    })),
});

/** Every operation_id declared on the installed catalog body (the fully-qualified
 *  ids the op-admission gate keys on) whose op risk is `read`. */
const readOperationIds = (catalogSlug = 'acme'): string[] => {
  const body = deps.localManifestStore.getManifest(catalogSlug);
  const ops = body?.operations ?? {};
  return Object.values(ops)
    .filter((o) => o.risk_tier === 'read')
    .map((o) => o.operation_id)
    .sort();
};

describe('D-182 §7.1 — headless install (no install_scope) fails closed', () => {
  it('does NOT silently grant a derived read-tier group (the auto-grant is removed)', () => {
    // A read+write composition with NO authored default_grants, installed
    // headlessly → the derived read group `acme.deal.read` is NOT written.
    const r = provisionPackCompositionForBulkInstall(deps, appPack(comp([READ, WRITE_ASK])), []);
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual([]);
  });

  it('honors an AUTHORED read-tier default_grant headlessly', () => {
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK], ['acme.deal.read'])),
      [],
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.read']);
  });

  it('honors an AUTHORED write + approval:ask default_grant headlessly (the reception cold-start shape)', () => {
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK], ['acme.deal.write'])),
      [],
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.write']);
  });

  it('does NOT honor an authored write + approval:never default_grant headlessly (fail-closed)', () => {
    // `sync.run` is write-tier but `approval: never` — granting it headlessly
    // would hand silent unattended write authority. It is dropped.
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_NEVER], ['acme.sync.write'])),
      [],
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual([]);
  });

  it('does NOT honor an authored destructive default_grant unless every op is approval-gated', () => {
    // `deal.purge` is destructive + approval: always → it IS approval-gated, so
    // an authored destructive default_grant survives headlessly (the per-action
    // gate still fires). Pins that `always` (not just `ask`) qualifies.
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, DESTRUCTIVE], ['acme.deal.destructive'])),
      [],
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.destructive']);
  });
});

describe('D-182 §7.1 — interactive install (install_scope present) grants by Access tier', () => {
  it('access: read grants only the derived read-tier group(s)', () => {
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST, WRITE_ASK, DESTRUCTIVE])),
      [],
      { access: 'read' },
    );
    expect(r.ok).toBe(true);
    // READ + LIST share the `acme.deal.read` group; write/destructive excluded.
    expect(grantedGroups()).toEqual(['acme.deal.read']);
  });

  it('access: write grants read + write groups, not admin/destructive', () => {
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK, DESTRUCTIVE])),
      [],
      { access: 'write' },
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.read', 'acme.deal.write']);
  });

  it('access: all grants every tier (read + write + destructive)', () => {
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK, DESTRUCTIVE])),
      [],
      { access: 'all' },
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.destructive', 'acme.deal.read', 'acme.deal.write']);
  });

  it('UNIONs the access tier with the pack’s authored honorable defaults', () => {
    // Owner picks Read; the pack ALSO authored a write/ask default (its declared
    // cold-start minimum). Both are written — the authored write/ask survives the
    // narrower Read selection.
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK], ['acme.deal.write'])),
      [],
      { access: 'read' },
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.read', 'acme.deal.write']);
  });

  it('scope: all_contracts leaves the CONNECTION-level (A) write set unchanged (fan-out is the per-contract (B) axis)', () => {
    // With NO doors present, `all_contracts` writes no per-door (B) rows, and the
    // connection-level (A) group grant is identical to the `owner` case.
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual(['acme.deal.read']);
  });
});

describe('D-182 §7.2 — "Install for everyone" fans op-admission out to existing doors', () => {
  // NB: a MULTI-op composition decomposes to a catalog (with operation_groups); a
  // single-op one decomposes to a simple-form ingredient with no groups (nothing to
  // fan out). These fixtures use ≥2 ops so the catalog + read group exist. The pack
  // slug (source_pack stamp) is `appPack`'s default `acme-crm`.
  const PACK = 'acme-crm';

  it('all_contracts writes a per-door (B) grant for each connection-enabled op, stamped source_pack', () => {
    const door = mintDoor('door-a');
    const r = provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST, WRITE_ASK])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    expect(r.ok).toBe(true);
    // The door is granted EXACTLY the read-tier ops' fully-qualified operation_ids —
    // the same key space the op-admission gate + the mint-fold use (invariant 2).
    expect(fanoutRows(door)).toEqual(readOperationIds());
    // WRITE_ASK (deal.create) is write-tier → excluded at access: read (invariant 1).
    expect(fanoutRows(door)).toHaveLength(2); // deal.read + deal.list
    // Each is an explicit grant carrying the pack's source_pack stamp.
    const rows = createContractGrantEntryStore(contractStore).listForContract(door);
    for (const row of rows) {
      expect(row.granted).toBe(true);
      expect(row.source_pack).toBe(PACK);
    }
  });

  it('access: write fans out read + write ops; access ceiling is per-op', () => {
    const door = mintDoor('door-a');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK])),
      [],
      { access: 'write', scope: 'all_contracts' },
    );
    expect(fanoutRows(door)).toHaveLength(2); // deal.read + deal.create
  });

  it('all_customers targets only live seller customer-instance contracts', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const revokedCustomerDoor = mintCustomerDoor('door-customer-revoked');
    revokeDoor(revokedCustomerDoor);
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      {
        ...deps,
        sellerStore: sellerStoreForCustomerContracts([
          customerDoor,
          revokedCustomerDoor,
        ]),
      },
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_customers' },
    );
    expect(fanoutRows(customerDoor)).toHaveLength(2);
    expect(fanoutRows(revokedCustomerDoor)).toEqual([]);
    expect(fanoutRows(otherDoor)).toEqual([]);
  });

  it('all_other_contracts excludes seller customer contracts', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      {
        ...deps,
        sellerStore: sellerStoreForCustomerContracts([customerDoor]),
      },
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_other_contracts' },
    );
    expect(fanoutRows(customerDoor)).toEqual([]);
    expect(fanoutRows(otherDoor)).toHaveLength(2);
  });

  it('all_customers classifies from authoritative customer_instance kind', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_customers' },
    );
    expect(fanoutRows(customerDoor)).toHaveLength(2);
    expect(fanoutRows(otherDoor)).toEqual([]);
  });

  it('all_other_contracts never widens across a missing seller store', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_other_contracts' },
    );
    expect(fanoutRows(customerDoor)).toEqual([]);
    expect(fanoutRows(otherDoor)).toHaveLength(2);
  });

  it('ignores stale seller membership when classifying all_other_contracts', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const standingDoorWithStaleCustomerRow = mintDoor('door-standing-stale');
    provisionPackCompositionForBulkInstall(
      {
        ...deps,
        sellerStore: sellerStoreForCustomerContracts([standingDoorWithStaleCustomerRow]),
      },
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_other_contracts' },
    );
    expect(fanoutRows(customerDoor)).toEqual([]);
    expect(fanoutRows(standingDoorWithStaleCustomerRow)).toHaveLength(2);
  });

  it('supports owner-plus-customer and per-tier checklist selections', () => {
    const proCustomer = mintCustomerDoor('door-pro');
    const basicCustomer = mintCustomerDoor('door-basic');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      {
        ...deps,
        sellerStore: sellerStoreForCustomerContracts([proCustomer, basicCustomer]),
      },
      appPack(comp([READ, LIST])),
      [],
      {
        access: 'read',
        audience: {
          owner: true,
          all_customers: false,
          all_other_contracts: false,
          customer_tier_ids: ['tier-pro'],
        },
      },
    );
    expect(fanoutRows(proCustomer)).toHaveLength(2);
    expect(fanoutRows(basicCustomer)).toEqual([]);
    expect(fanoutRows(otherDoor)).toEqual([]);
  });

  it('fails a per-tier selection closed when seller membership is ambiguous', () => {
    const customerDoor = mintCustomerDoor('door-ambiguous');
    provisionPackCompositionForBulkInstall(
      {
        ...deps,
        sellerStore: {
          listCustomers: () => [
            { contract_id: customerDoor, tier_id: 'tier-pro' },
            { contract_id: customerDoor, tier_id: 'tier-pro' },
          ],
        },
      },
      appPack(comp([READ, LIST])),
      [],
      {
        access: 'read',
        audience: {
          owner: true,
          all_customers: false,
          all_other_contracts: false,
          customer_tier_ids: ['tier-pro'],
        },
      },
    );
    expect(fanoutRows(customerDoor)).toEqual([]);
  });

  it('targets an individually selected contract without widening either broad audience', () => {
    const selectedCustomer = mintCustomerDoor('door-selected-customer');
    const unselectedCustomer = mintCustomerDoor('door-unselected-customer');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      {
        access: 'read',
        audience: {
          owner: true,
          all_customers: false,
          all_other_contracts: false,
          contract_ids: [selectedCustomer],
        },
      },
    );
    expect(fanoutRows(selectedCustomer)).toHaveLength(2);
    expect(fanoutRows(unselectedCustomer)).toEqual([]);
    expect(fanoutRows(otherDoor)).toEqual([]);
  });

  it('pins an explicit owner revoke when a customer-only checklist unchecks You', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      {
        access: 'read',
        audience: {
          owner: false,
          all_customers: true,
          all_other_contracts: false,
        },
      },
    );
    const operationIds = readOperationIds();
    expect(fanoutRows(customerDoor)).toEqual(operationIds);
    for (const operationId of operationIds) {
      expect(createContractGrantEntryStore(contractStore).get('user_self', operationId))
        .toBe(false);
    }
  });

  it('legacy all_contracts remains broad across standing and customer doors', () => {
    const customerDoor = mintCustomerDoor('door-customer');
    const otherDoor = mintDoor('door-other');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    expect(fanoutRows(customerDoor)).toHaveLength(2);
    expect(fanoutRows(otherDoor)).toHaveLength(2);
  });

  it('scope: owner (default) writes NO per-door (B) rows — the owner is permissive by default', () => {
    const door = mintDoor('door-a');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, WRITE_ASK])),
      [],
      { access: 'read', scope: 'owner' },
    );
    expect(fanoutRows(door)).toEqual([]);
  });

  it('skips a REVOKED door (only live governing doors are targeted)', () => {
    const live = mintDoor('door-live');
    const dead = mintDoor('door-dead');
    revokeDoor('door-dead');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    expect(fanoutRows(live)).toHaveLength(2);
    expect(fanoutRows(dead)).toEqual([]); // fail-closed to a dead door
  });

  it('REINSTALL as owner CLEARS the prior for-everyone rows (replace, not append)', () => {
    const door = mintDoor('door-a');
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    expect(fanoutRows(door)).toHaveLength(2);
    // Reinstall the SAME pack for-you-only → the prior fan-out rows are dropped.
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'owner' },
    );
    expect(fanoutRows(door)).toEqual([]);
  });

  it('does NOT disturb a door’s OWN (non-fan-out) op-admission rows', () => {
    const door = mintDoor('door-a');
    // Simulate the door's own mint-fold grant (no source_pack) for some op.
    createContractGrantEntryStore(contractStore).set(door, 'recued-core/other.op', true, NOW);
    provisionPackCompositionForBulkInstall(
      deps,
      appPack(comp([READ, LIST])),
      [],
      { access: 'read', scope: 'all_contracts' },
    );
    // The door's own row survives; only the fan-out rows carry source_pack.
    expect(createContractGrantEntryStore(contractStore).get(door, 'recued-core/other.op')).toBe(true);
    expect(fanoutRows(door)).toHaveLength(2);
  });
});

describe('D-182 §7.1 — connection-less composition writes no connection grant', () => {
  it('grants nothing even at access: all (cli grants flow through §7.2, not here)', () => {
    const connectionless: CompositionIngredient = {
      schema_version: 1,
      slug: 'acme',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'acme', kind: 'http', http: { base: 'https://api.acme.example' } }],
      operations: [READ, WRITE_ASK].map((o) => ({
        op: o.op,
        ingredient: 'acme',
        risk: o.risk,
        approval: o.approval,
        bind: o.risk === 'read' ? readBinding(`/v3/${o.op}`) : writeBinding(`/v3/${o.op}`),
        description: `${o.op} op.`,
      })),
    };
    const r = provisionPackCompositionForBulkInstall(deps, appPack(connectionless), [], {
      access: 'all',
    });
    expect(r.ok).toBe(true);
    expect(grantedGroups()).toEqual([]);
  });
});

describe('D-182 §7.1 — rpc arg validation rejects a malformed install_scope', () => {
  it('ingredient.install throws bad_request on a malformed install_scope', async () => {
    const rpcDeps: IngredientAuthoringRpcDeps = {
      localManifestStore: deps.localManifestStore,
      contractStore,
      registry: deps.registry,
      recipeStore: { ids: () => [], get: () => null },
      now: () => NOW,
    };
    const handlers = makeIngredientAuthoringHandlers(rpcDeps)!;
    await expect(
      handlers.handlers['ingredient.install'](
        { manifest: appPack(comp([READ, WRITE_ASK])), install_scope: { access: 'sudo' } as never },
        {} as WsClient,
      ),
    ).rejects.toThrow(/install_scope/);
  });

  it('packs.install throws bad_request on a malformed install_scope', async () => {
    // The malformed-scope reject fires in `parsePacksInstallArgs` BEFORE the
    // recipe store is touched, so a no-op stub is sufficient.
    const recipeStore = { ids: () => [], get: () => null } as unknown as
      import('../recipe-store.js').RecipeStore;
    await expect(
      handlePacksInstall(
        {
          recipeStore,
          contractStore,
          localManifestStore: deps.localManifestStore,
          registry: deps.registry,
          now: () => NOW,
        },
        {
          manifest: appPack(comp([READ, WRITE_ASK])),
          granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
          install_scope: { access: 'read', scope: 'everyone' } as never,
        },
      ),
    ).rejects.toThrow(/install_scope/);
  });
});
