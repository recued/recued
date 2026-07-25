import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngredientManifest, OperationSpec } from '@recued/contracts';

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
import {
  createConnectionCatalogBindingStore,
  type ConnectionCatalogBindingStore,
} from '../storage/connection-catalog-binding-store.js';

// D-182 §7.1 inc 5c — DENY UNTIL GRANTED. Enrollment no longer auto-seeds read
// ops; a connection's profile is derived purely from its GRANTED operation
// groups. Read ops are reachable by granting their `risk_floor: 'read'` group
// (the §7.1 install dialog writes it on a pack's bound connection; the grant rpcs
// write it for a registered-vendor connection enrolled outside a pack). These
// suites grant the read group `core.read` to make the read ops effective, and
// assert the bare-enrollment-grants-nothing ratchet directly.
const NOW = 1_700_000_000_000;
const READ_OPS = ['deal.read', 'contact.read'];
// The read group whose ops are deal.read + contact.read — granting it admits the
// read ops, exactly as granting a write group admits its write op.
const READ_GROUP = 'core.read';

let db: Database.Database;
let connectionStore: ConnectionStoreSqlite;
let profileStore: ConnectionOperationProfileStore;
let contractStore: ContractStore;
let grantStore: ContractGrantStore;

const catalogManifest = (): IngredientManifest => ({
  slug: 'hubspot-catalog',
  name: 'HubSpot catalog',
  description: 'Test HubSpot catalog manifest',
  author: 'recued',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'deal.read': { operation_id: 'x/deal.read', risk_tier: 'read' },
    'contact.read': { operation_id: 'x/contact.read', risk_tier: 'read' },
    'note.create': { operation_id: 'x/note.create', risk_tier: 'write' },
  } satisfies Record<string, OperationSpec>,
  operation_groups: {
    [READ_GROUP]: { group_id: READ_GROUP, operations: READ_OPS, risk_floor: 'read' },
  },
});

const writeOnlyCatalogManifest = (): IngredientManifest => ({
  ...catalogManifest(),
  operations: {
    'note.create': { operation_id: 'x/note.create', risk_tier: 'write' },
  } satisfies Record<string, OperationSpec>,
  operation_groups: {},
});

// §5 tool-op pack seam (brick 2) — the entity-less Exa tool catalog. `exa` is a
// registered catalog vendor (CATALOG_VENDOR_SLUGS) so an `exa`-vendor connection
// seeds its profile from this manifest once its read group is granted.
const EXA_READ_GROUP = 'web.read';
const exaCatalogManifest = (): IngredientManifest => ({
  slug: 'exa-catalog',
  name: 'Exa catalog',
  description: 'Test Exa tool catalog manifest',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'web.search': { operation_id: 'recued-core/exa.web.search', risk_tier: 'read' },
  } satisfies Record<string, OperationSpec>,
  operation_groups: {
    [EXA_READ_GROUP]: { group_id: EXA_READ_GROUP, operations: ['web.search'], risk_floor: 'read' },
  },
});

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

const wire = (
  getManifest: (slug: string) => IngredientManifest | null | undefined =
    () => catalogManifest(),
): void => {
  wireCatalogOperationProfiles({ connectionStore, profileStore, getManifest, contractGrantStore: grantStore });
};

/** Grant the read group on a connection so its read ops are effective — the §7.1
 *  consent the gateway now requires before any read admits. */
const grantReads = (name: string, slug = 'hubspot-catalog', group = READ_GROUP): void => {
  grantStore.grantUserGroup(slug, name, group);
};

const expectAllowedOperations = (name: string): void => {
  const profile = profileStore.get(name);
  expect(profile).not.toBeNull();
  expect([...profile!.allowed_operations].sort()).toEqual([...READ_OPS].sort());
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

describe('wireCatalogOperationProfiles', () => {
  it('seeds an already-enrolled HubSpot connection’s read ops once the read group is granted', () => {
    upsertApiConnection('hubspot-prod', 'hubspot');
    grantReads('hubspot-prod');

    wire();

    expectAllowedOperations('hubspot-prod');
    expect(profileStore.get('hubspot-prod')!.allowed_operations).not.toContain(
      'note.create', // write group not granted
    );
  });

  it('seeds NOTHING for a HubSpot connection with no grant (deny until granted — inc 5c ratchet)', () => {
    // Bare enrollment grants nothing: the derived set is empty → the profile is
    // dropped → the gateway denies every op (`no_connection_profile`).
    upsertApiConnection('hubspot-ungranted', 'hubspot');

    wire();

    expect(profileStore.get('hubspot-ungranted')).toBeNull();
  });

  it('does not seed an api connection whose vendor has no registered catalog', () => {
    // 'unknownvendor' is not in CATALOG_VENDOR_SLUGS — no catalog, no profile.
    // (HubSpot + Salesforce ARE catalog vendors and seed; see the SF suite.)
    upsertApiConnection('unknown-prod', 'unknownvendor');

    wire();

    expect(profileStore.get('unknown-prod')).toBeNull();
  });

  it('seeds a new HubSpot connection enrolled after wiring (read group granted)', () => {
    wire();
    grantReads('hubspot-later');

    upsertApiConnection('hubspot-later', 'hubspot');

    expectAllowedOperations('hubspot-later');
  });

  it('drops the profile when a seeded HubSpot connection flips to a non-catalog vendor', () => {
    wire();
    grantReads('morph');
    upsertApiConnection('morph', 'hubspot');
    expectAllowedOperations('morph');

    // Flip away to a vendor with no catalog → stale grant must be revoked.
    // (A flip to another CATALOG vendor re-seeds instead; covered in the SF suite.)
    upsertApiConnection('morph', 'unknownvendor', { updated_at: NOW + 1 });

    expect(profileStore.get('morph')).toBeNull();
  });

  it('drops the profile when a seeded HubSpot connection is deleted', () => {
    wire();
    grantReads('delete-me');
    upsertApiConnection('delete-me', 'hubspot');
    expectAllowedOperations('delete-me');

    connectionStore.delete('api', 'delete-me');

    expect(profileStore.get('delete-me')).toBeNull();
  });

  it('fails closed for missing or write-only manifests and deletes any existing profile on upsert', () => {
    let manifest: IngredientManifest | null = null;
    upsertApiConnection('missing-on-boot', 'hubspot');
    grantReads('missing-on-boot'); // even granted, a null manifest derives nothing

    wire(() => manifest);

    expect(profileStore.get('missing-on-boot')).toBeNull();

    // A write-only catalog declares no read group, so a granted read group expands
    // to nothing → empty profile dropped (and any pre-existing profile cleared).
    manifest = writeOnlyCatalogManifest();
    profileStore.set('write-only-on-upsert', { allowed_operations: READ_OPS });
    grantReads('write-only-on-upsert');

    upsertApiConnection('write-only-on-upsert', 'hubspot');

    expect(profileStore.get('write-only-on-upsert')).toBeNull();
  });

  it('seeds two distinct HubSpot connections under their own names', () => {
    upsertApiConnection('alpha', 'hubspot');
    upsertApiConnection('beta', 'hubspot');
    grantReads('alpha');
    grantReads('beta');

    wire();

    expectAllowedOperations('alpha');
    expectAllowedOperations('beta');
    expect(profileStore.get('alpha')).not.toBe(profileStore.get('beta'));

    connectionStore.delete('api', 'alpha');

    expect(profileStore.get('alpha')).toBeNull();
    expectAllowedOperations('beta');
  });

  it('§5 seeds an entity-less tool (Exa) connection with web.search once its read group is granted', () => {
    // `exa` ∈ CATALOG_VENDOR_SLUGS → an `exa`-vendor api connection resolves
    // `exa-catalog`. `web.search` is reachable only via its granted read group (no
    // auto-seed under inc 5c); the profile is stamped with the tool catalog slug so
    // a colliding short key from another catalog can't be honored under it.
    upsertApiConnection('exa-prod', 'exa');
    grantReads('exa-prod', 'exa-catalog', EXA_READ_GROUP);

    wire((slug) => (slug === 'exa-catalog' ? exaCatalogManifest() : null));

    const profile = profileStore.get('exa-prod');
    expect(profile).not.toBeNull();
    expect(profile!.allowed_operations).toEqual(['web.search']);
    expect(profile!.catalog_slug).toBe('exa-catalog');
  });
});

describe('wireCatalogOperationProfiles — pack-owned grant union (D-165 P3, Path A)', () => {
  // A catalog declaring a read group + a write group so a granted group expands to
  // its operations — nothing is admitted without a grant (inc 5c).
  const catalogWithGroups = (): IngredientManifest => ({
    ...catalogManifest(),
    operation_groups: {
      [READ_GROUP]: { group_id: READ_GROUP, operations: READ_OPS, risk_floor: 'read' },
      'notes.write': { group_id: 'notes.write', operations: ['note.create'], risk_floor: 'write' },
    },
  });

  const wireWithGrants = (): void => {
    wireCatalogOperationProfiles({
      connectionStore,
      profileStore,
      getManifest: () => catalogWithGroups(),
      contractGrantStore: grantStore,
    });
  };

  it('unions a PACK-OWNED granted group’s operations into allowed_operations', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs'); // read group (user grant) makes the read ops effective
    grantStore.grantPackGroup('sales-pack', 'hubspot-catalog', 'hs', 'notes.write');

    wireWithGrants();

    // granted read group + the pack-granted write op.
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual(
      ['contact.read', 'deal.read', 'note.create'].sort(),
    );
  });

  it('unions BOTH __user__ and pack-owned grants, deduped (the effective view)', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs');
    grantStore.grantUserGroup('hubspot-catalog', 'hs', 'notes.write');
    grantStore.grantPackGroup('sales-pack', 'hubspot-catalog', 'hs', 'notes.write');

    wireWithGrants();

    // note.create appears once despite two grant owners — deriveAllowedOperations dedupes.
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual(
      ['contact.read', 'deal.read', 'note.create'].sort(),
    );
  });

  it('re-seed after pack uninstall drops the pack-granted op (the user read grant survives)', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs'); // user-owned read grant — independent of the pack
    grantStore.grantPackGroup('sales-pack', 'hubspot-catalog', 'hs', 'notes.write');
    wireWithGrants();
    expect(profileStore.get('hs')!.allowed_operations).toContain('note.create');

    // Uninstall the pack's grants; a subsequent connection upsert re-seeds from the
    // (now pack-empty) union — back to the user-granted read ops only.
    grantStore.removePackGroups('sales-pack');
    upsertApiConnection('hs', 'hubspot', { updated_at: NOW + 1 });

    expect(profileStore.get('hs')!.allowed_operations).not.toContain('note.create');
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual([...READ_OPS].sort());
  });

  it('a pack grant for a DIFFERENT connection does not leak into this one', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs');
    grantStore.grantPackGroup('sales-pack', 'hubspot-catalog', 'other-conn', 'notes.write');

    wireWithGrants();

    expect(profileStore.get('hs')!.allowed_operations).not.toContain('note.create');
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual([...READ_OPS].sort());
  });
});

describe('wireCatalogOperationProfiles — local composition-catalog binding (D-170 gap #2)', () => {
  // A LOCAL (private_byo) catalog — NOT a registered vendor, so it has no
  // config.vendor; it resolves to a connection only through the install-recorded
  // binding. getManifest resolves it by its local slug (the live registry the local
  // install registered it into).
  const LOCAL_SLUG = 'acme-local';
  const TICKETS_READ = 'tickets.read';
  const localCatalog = (): IngredientManifest => ({
    ...catalogManifest(),
    slug: LOCAL_SLUG,
    operations: {
      'ticket.read': { operation_id: 'x/ticket.read', risk_tier: 'read' },
      'ticket.create': { operation_id: 'x/ticket.create', risk_tier: 'write' },
    } satisfies Record<string, OperationSpec>,
    operation_groups: {
      [TICKETS_READ]: { group_id: TICKETS_READ, operations: ['ticket.read'], risk_floor: 'read' },
      'tickets.write': { group_id: 'tickets.write', operations: ['ticket.create'], risk_floor: 'write' },
    },
  });

  let bindingStore: ConnectionCatalogBindingStore;

  beforeEach(() => {
    bindingStore = createConnectionCatalogBindingStore(contractStore);
  });

  // Resolve the local catalog by its slug + the hubspot catalog (for the coexist
  // case); any OTHER slug (e.g. an uninstalled binding) resolves to null → fail-closed.
  const getManifest = (slug: string): IngredientManifest | null =>
    slug === LOCAL_SLUG ? localCatalog() : slug === 'hubspot-catalog' ? catalogManifest() : null;

  const wireLocal = (): void => {
    wireCatalogOperationProfiles({
      connectionStore,
      profileStore,
      getManifest,
      contractGrantStore: grantStore,
      connectionCatalogBindingStore: bindingStore,
    });
  };

  /** Grant the local catalog's read group on a bound connection. */
  const grantLocalReads = (name: string): void => {
    grantStore.grantUserGroup(LOCAL_SLUG, name, TICKETS_READ);
  };

  it('boot seeds a bound local-catalog connection (Pass 1b) with its granted read op, write OFF', () => {
    // No registered-vendor connection at all — the binding alone drives the seed,
    // independent of the connection's kind / the api scan.
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('support');

    wireLocal();

    const profile = profileStore.get('support');
    expect(profile?.catalog_slug).toBe(LOCAL_SLUG);
    expect([...profile!.allowed_operations]).toEqual(['ticket.read']); // write op stays OFF
  });

  it('seeds NOTHING for a bound local-catalog connection with no grant (inc 5c ratchet)', () => {
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');

    wireLocal();

    expect(profileStore.get('support')).toBeNull();
  });

  it('a PACK-OWNED grant on the local catalog makes its write op effective at dispatch', () => {
    // This is the D-165 P3 payoff: the grant the §7.1 install dialog wrote becomes live.
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('support'); // the read group
    grantStore.grantPackGroup('acme-pack', LOCAL_SLUG, 'support', 'tickets.write');

    wireLocal();

    expect([...profileStore.get('support')!.allowed_operations].sort()).toEqual(
      ['ticket.create', 'ticket.read'].sort(),
    );
  });

  it('seeds on connect-AFTER-install via the binding-aware upsert observer', () => {
    wireLocal(); // observers registered; no binding / connection yet
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack'); // composition install records it
    grantLocalReads('support'); // the §7.1 dialog grant
    // The connection is created later, under a NON-catalog vendor — the upsert
    // observer resolves the local binding (not config.vendor) and seeds.
    upsertApiConnection('support', 'custom');

    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG);
  });

  it('binding SURVIVES a connection delete; profile re-seeds when the connection returns', () => {
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('support');
    upsertApiConnection('support', 'custom');
    wireLocal();
    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG);

    connectionStore.delete('api', 'support');
    expect(profileStore.get('support')).toBeNull(); // profile dropped (fail-closed)
    expect(bindingStore.resolveCatalogSlug('support')).toBe(LOCAL_SLUG); // binding is install-state

    upsertApiConnection('support', 'custom', { updated_at: NOW + 1 }); // connection returns
    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG); // re-seeded
  });

  it('does not seed when the bound local catalog no longer resolves (uninstalled)', () => {
    bindingStore.bind('support', 'uninstalled-catalog', 'gone-pack'); // getManifest → null
    grantLocalReads('support');
    wireLocal();
    expect(profileStore.get('support')).toBeNull(); // fail-closed
  });

  it('a registered-vendor connection is unaffected (no binding) — coexists with local', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs');
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('support');
    wireLocal();
    // hubspot resolves via config.vendor (catalogManifest = hubspot-catalog read ops);
    // support resolves via the binding (local catalog). Disjoint.
    expect(profileStore.get('hs')?.catalog_slug).toBe('hubspot-catalog');
    expect(profileStore.get('support')?.catalog_slug).toBe(LOCAL_SLUG);
  });

  it('registered vendor WINS over a local binding for the SAME connection name (Pass 1b precedence)', () => {
    // A composition bound its local catalog to a connection that is ALSO a registered
    // hubspot connection. Pass 1b must not let the local binding shadow the vendor
    // catalog — registered vendor wins (the `??` precedence).
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs');
    bindingStore.bind('hs', LOCAL_SLUG, 'acme-pack');

    wireLocal();

    expect(profileStore.get('hs')?.catalog_slug).toBe('hubspot-catalog');
    expect([...profileStore.get('hs')!.allowed_operations].sort()).toEqual([...READ_OPS].sort());
  });
});
