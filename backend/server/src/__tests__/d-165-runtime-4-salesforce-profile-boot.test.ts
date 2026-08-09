import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HUBSPOT_CATALOG_SLUG,
  SALESFORCE_CATALOG_SLUG,
  type IngredientManifest,
  type OperationSpec,
} from '@recued/contracts';

import {
  createInMemoryConnectionOperationProfileStore,
  type ConnectionOperationProfileStore,
} from '../connection-operation-profile.js';
import {
  deriveGroupGatedOperations,
  wireCatalogOperationProfiles,
} from '../connection-operation-profile-boot.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createContractGrantStore,
  type ContractGrantStore,
} from '../storage/contract-grant-store.js';

// ⚠ D-233 (owner decision, 2026-08-07) RETIRED THE LAYER THESE SUITES WERE
// WRITTEN AGAINST. D-182 §7.1 inc 5c's "deny until granted" is bypassed
// (`OPERATION_GROUP_GATE_ENABLED = false`) and a bound catalog's profile now
// holds EVERY operation that catalog declares. D-233 rewrote its siblings and
// missed this file, so all three cases below were left asserting the old gate;
// they are rewritten here to the new invariant, on the same terms.
//
// 🔑 THE GRANTS ARE KEPT IN THE FIXTURES ON PURPOSE. They no longer decide
// reachability, but leaving them in is what lets these cases show that they no
// longer decide it — a fixture with the grants removed could not tell a bypass
// from a coincidence.
//
// The full-catalog sets each vendor now derives. `_ALL_OPS` is the assertion
// target; `_READ_OPS` stays because the dormant gated derivation is still
// asserted alongside, and a re-enable has to have something to verify against.
const NOW = 1_700_000_000_000;
const HUBSPOT_READ_OPS = ['deal.read', 'contact.read'];
const SALESFORCE_READ_OPS = ['opportunity.read', 'contact.read'];
const HUBSPOT_READ_GROUP = 'hubspot.read';
const SALESFORCE_READ_GROUP = 'salesforce.read';
const HUBSPOT_ALL_OPS = ['deal.read', 'contact.read', 'deal.create'];
const SALESFORCE_ALL_OPS = [
  'opportunity.read',
  'contact.read',
  'opportunity.create',
  'contact.update',
];

let db: Database.Database;
let connectionStore: ConnectionStoreSqlite;
let profileStore: ConnectionOperationProfileStore;
let contractStore: ContractStore;
let grantStore: ContractGrantStore;

const catalogBase = (
  slug: string,
  name: string,
  operations: Record<string, OperationSpec>,
  operation_groups: IngredientManifest['operation_groups'],
): IngredientManifest => ({
  slug,
  name,
  description: `${name} test catalog`,
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations,
  operation_groups,
});

const hubspotManifest = (): IngredientManifest => catalogBase(
  HUBSPOT_CATALOG_SLUG,
  'HubSpot catalog',
  {
    'deal.read': { operation_id: 'recued-core/hubspot.deal.read', risk_tier: 'read' },
    'contact.read': { operation_id: 'recued-core/hubspot.contact.read', risk_tier: 'read' },
    'deal.create': { operation_id: 'recued-core/hubspot.deal.create', risk_tier: 'write' },
  },
  {
    [HUBSPOT_READ_GROUP]: {
      group_id: HUBSPOT_READ_GROUP,
      operations: HUBSPOT_READ_OPS,
      risk_floor: 'read',
    },
  },
);

const salesforceManifest = (): IngredientManifest => catalogBase(
  SALESFORCE_CATALOG_SLUG,
  'Salesforce catalog',
  {
    'opportunity.read': {
      operation_id: 'recued-core/salesforce.opportunity.read',
      risk_tier: 'read',
    },
    'contact.read': { operation_id: 'recued-core/salesforce.contact.read', risk_tier: 'read' },
    'opportunity.create': {
      operation_id: 'recued-core/salesforce.opportunity.create',
      risk_tier: 'write',
    },
    'contact.update': {
      operation_id: 'recued-core/salesforce.contact.update',
      risk_tier: 'write',
    },
  },
  {
    [SALESFORCE_READ_GROUP]: {
      group_id: SALESFORCE_READ_GROUP,
      operations: SALESFORCE_READ_OPS,
      risk_floor: 'read',
    },
  },
);

const manifests: Readonly<Record<string, IngredientManifest>> = {
  [HUBSPOT_CATALOG_SLUG]: hubspotManifest(),
  [SALESFORCE_CATALOG_SLUG]: salesforceManifest(),
};

const apiConnection = (
  name: string,
  vendor: string,
  overrides: Partial<ConnectionUpsert> = {},
): ConnectionUpsert => ({
  kind: 'api',
  name,
  display_name: `${vendor} ${name}`,
  config_json: JSON.stringify({ vendor }),
  auth_ciphertext: 'CIPHER',
  enrolled_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const upsertApiConnection = (
  name: string,
  vendor: string,
  overrides: Partial<ConnectionUpsert> = {},
): void => {
  connectionStore.upsert(apiConnection(name, vendor, overrides));
};

const wire = (): void => {
  wireCatalogOperationProfiles({
    connectionStore,
    profileStore,
    getManifest: (slug) => manifests[slug],
    contractGrantStore: grantStore,
  });
};

/** Grant a catalog's read group on a connection (the §7.1 consent reads now require). */
const grantReads = (catalogSlug: string, name: string, group: string): void => {
  grantStore.grantUserGroup(catalogSlug, name, group);
};

const expectProfile = (
  name: string,
  catalog_slug: string,
  allowed_operations: string[],
): void => {
  const profile = profileStore.get(name);
  expect(profile).not.toBeNull();
  expect(profile!.catalog_slug).toBe(catalog_slug);
  expect([...profile!.allowed_operations].sort()).toEqual([...allowed_operations].sort());
};

beforeEach(() => {
  db = new Database(':memory:');
  connectionStore = createConnectionStore(db);
  profileStore = createInMemoryConnectionOperationProfileStore();
  contractStore = createContractStore(db, { now: () => NOW });
  grantStore = createContractGrantStore(contractStore);
});

afterEach(() => {
  db.close();
});

describe('D-165 RUNTIME #4 — Salesforce catalog profile boot seeding', () => {
  it('seeds each connection with its catalog\'s FULL operation set, not the granted groups', () => {
    /** REWRITTEN 2026-08-07 (D-233 owner decision). Was: "seeds ... from their own
     *  catalog slugs (read groups granted)", asserting the profile equalled exactly
     *  the granted read group. The routing half of that claim is what this case was
     *  really for — each connection resolves ITS OWN vendor's catalog, never the
     *  other's — and that is unchanged and still asserted below.
     *
     *  ⛔ What changed is the SET: the profile now follows the catalog manifest, so
     *  `opportunity.create` is present despite no write group being granted. Asserted
     *  as an exact sorted set rather than a `toContain`, so a future widening past
     *  the declared catalog still reddens this. */
    upsertApiConnection('salesforce-prod', 'salesforce');
    upsertApiConnection('hubspot-prod', 'hubspot');
    grantReads(SALESFORCE_CATALOG_SLUG, 'salesforce-prod', SALESFORCE_READ_GROUP);
    grantReads(HUBSPOT_CATALOG_SLUG, 'hubspot-prod', HUBSPOT_READ_GROUP);

    wire();

    expectProfile('salesforce-prod', SALESFORCE_CATALOG_SLUG, SALESFORCE_ALL_OPS);
    expectProfile('hubspot-prod', HUBSPOT_CATALOG_SLUG, HUBSPOT_ALL_OPS);
    // The routing claim, kept explicit: neither vendor's ops leak into the other.
    expect(profileStore.get('salesforce-prod')!.allowed_operations)
      .not.toContain('deal.read');
    expect(profileStore.get('hubspot-prod')!.allowed_operations)
      .not.toContain('opportunity.read');
    // 🔑 The dormant gated path is unchanged and would still hold the line.
    expect(
      deriveGroupGatedOperations(manifests[SALESFORCE_CATALOG_SLUG]!, [SALESFORCE_READ_GROUP]),
      'the gated derivation a re-enable would restore still stops at the read group',
    ).toEqual(SALESFORCE_READ_OPS);
  });

  it('⛔⛔ seeds an UNGRANTED connection with the full catalog — the gate is bypassed, the catalog is not', () => {
    /** REWRITTEN 2026-08-07 (D-233 owner decision). Was: "seeds NOTHING ... (deny
     *  until granted)". This is the sharpest-edged of the three and the one worth
     *  reading twice: a connection with NO group grant at all now gets a profile
     *  holding every operation its catalog declares, writes included.
     *
     *  ⛔ THAT IS THE DECISION, NOT A REGRESSION. D-233's reasoning: a connection
     *  belongs to the OWNER, and Recued governs access to it rather than
     *  re-authorising the owner against their own account. The layer being retired
     *  was also found not to do what its UI claimed — not per-pack, display ≠
     *  enforcement — i.e. assurance-shaped non-assurance.
     *
     *  🔑🔑 WHAT MUST STILL BE TRUE, AND IS ASSERTED HERE: the catalog is still the
     *  ceiling. "No grant" now means "everything this catalog declares"; it must
     *  never mean "everything". If a bypass ever widened past the manifest, the
     *  exact-set assertion below is what would catch it — a `not.toBeNull()` would
     *  not. The approval axis (`RISK_APPROVAL_FLOOR` pinning write at `ask`) is what
     *  actually stands between a reachable write and a silent one, and its Salesforce
     *  case lives in `d-165-runtime-4-salesforce-catalog-grants.test.ts`. */
    upsertApiConnection('salesforce-ungranted', 'salesforce');

    wire();

    expectProfile('salesforce-ungranted', SALESFORCE_CATALOG_SLUG, SALESFORCE_ALL_OPS);
    expect(
      deriveGroupGatedOperations(manifests[SALESFORCE_CATALOG_SLUG]!, []),
      'the dormant gated path still seeds nothing without a grant',
    ).toEqual([]);
  });

  it('re-derives the whole profile and updates catalog_slug when a connection flips vendors', () => {
    /** REWRITTEN 2026-08-07 (D-233 owner decision) — title only said "reads". The
     *  claim under test never was the SET; it is that a flip RE-DERIVES rather than
     *  accumulating, so the old vendor's ops are gone afterwards. That survives the
     *  retirement intact and is what the trailing `not.toContain('deal.read')`
     *  pins. */
    // The connection's owner granted reads on BOTH catalogs for this name (each
    // catalog's read group is keyed per-catalog), so the flip re-derives from the
    // new vendor's catalog + grants.
    grantReads(HUBSPOT_CATALOG_SLUG, 'morph', HUBSPOT_READ_GROUP);
    grantReads(SALESFORCE_CATALOG_SLUG, 'morph', SALESFORCE_READ_GROUP);
    wire();
    upsertApiConnection('morph', 'hubspot');
    expectProfile('morph', HUBSPOT_CATALOG_SLUG, HUBSPOT_ALL_OPS);

    upsertApiConnection('morph', 'salesforce', { updated_at: NOW + 1 });

    expectProfile('morph', SALESFORCE_CATALOG_SLUG, SALESFORCE_ALL_OPS);
    expect(profileStore.get('morph')!.allowed_operations).not.toContain('deal.read');
  });
});
