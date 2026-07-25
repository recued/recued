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
import { wireCatalogOperationProfiles } from '../connection-operation-profile-boot.js';
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

// D-182 §7.1 inc 5c — reads are reachable only via a granted read group (no
// enrollment auto-seed). These suites grant each catalog's read group to make its
// read ops effective.
const NOW = 1_700_000_000_000;
const HUBSPOT_READ_OPS = ['deal.read', 'contact.read'];
const SALESFORCE_READ_OPS = ['opportunity.read', 'contact.read'];
const HUBSPOT_READ_GROUP = 'hubspot.read';
const SALESFORCE_READ_GROUP = 'salesforce.read';

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
  it('seeds Salesforce and HubSpot connections from their own catalog slugs (read groups granted)', () => {
    upsertApiConnection('salesforce-prod', 'salesforce');
    upsertApiConnection('hubspot-prod', 'hubspot');
    grantReads(SALESFORCE_CATALOG_SLUG, 'salesforce-prod', SALESFORCE_READ_GROUP);
    grantReads(HUBSPOT_CATALOG_SLUG, 'hubspot-prod', HUBSPOT_READ_GROUP);

    wire();

    expectProfile('salesforce-prod', SALESFORCE_CATALOG_SLUG, SALESFORCE_READ_OPS);
    expect(profileStore.get('salesforce-prod')!.allowed_operations).not.toContain(
      'opportunity.create', // write group not granted
    );
    expectProfile('hubspot-prod', HUBSPOT_CATALOG_SLUG, HUBSPOT_READ_OPS);
  });

  it('seeds NOTHING for a Salesforce connection with no grant (deny until granted)', () => {
    upsertApiConnection('salesforce-ungranted', 'salesforce');

    wire();

    expect(profileStore.get('salesforce-ungranted')).toBeNull();
  });

  it('re-seeds with Salesforce reads and updates catalog_slug when a connection flips vendors', () => {
    // The connection's owner granted reads on BOTH catalogs for this name (each
    // catalog's read group is keyed per-catalog), so the flip re-derives from the
    // new vendor's catalog + grants.
    grantReads(HUBSPOT_CATALOG_SLUG, 'morph', HUBSPOT_READ_GROUP);
    grantReads(SALESFORCE_CATALOG_SLUG, 'morph', SALESFORCE_READ_GROUP);
    wire();
    upsertApiConnection('morph', 'hubspot');
    expectProfile('morph', HUBSPOT_CATALOG_SLUG, HUBSPOT_READ_OPS);

    upsertApiConnection('morph', 'salesforce', { updated_at: NOW + 1 });

    expectProfile('morph', SALESFORCE_CATALOG_SLUG, SALESFORCE_READ_OPS);
    expect(profileStore.get('morph')!.allowed_operations).not.toContain('deal.read');
  });
});
