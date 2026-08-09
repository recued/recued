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

const upsertMcpConnection = (name: string, updatedAt = NOW): void => {
  connectionStore.upsert({
    kind: 'mcp',
    name,
    subtype: 'sse',
    display_name: `MCP ${name}`,
    config_json: JSON.stringify({
      transport: 'sse',
      endpoint: 'https://peer.example.test/mcp',
    }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: updatedAt,
  });
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

/** ⛔ WHAT THIS ASSERTS CHANGED 2026-08-07 (owner decision), and it is worth being
 *  precise about what SURVIVED. `OPERATION_GROUP_GATE_ENABLED = false` means a bound
 *  catalog's profile holds every op the CATALOG declares, not the subset a grant
 *  unlocked — so pinning `READ_OPS` here would now be pinning the retired contract.
 *
 *  🔑 EVERY OTHER PROPERTY THESE TESTS EXIST FOR IS UNTOUCHED and still asserted by
 *  their own bodies: that a profile is SEEDED at all, under the right `catalog_slug`,
 *  for the right connection name, and DROPPED on delete / vendor-flip / missing
 *  manifest. Those are the pipeline; the op-set was only ever the payload. So the
 *  helper is re-anchored to the manifest — derived, never a literal list — and the
 *  suite keeps testing the wiring it was written to test.
 *
 *  ⚠ Anchored to the MANIFEST rather than to `profile.allowed_operations` on purpose: a
 *  helper that compared the profile to itself would pass for any value the code
 *  produced, which is how a rewritten assertion silently becomes a tautology. */
const expectAllowedOperations = (
  name: string,
  manifest: IngredientManifest | null | undefined = catalogManifest(),
): void => {
  const profile = profileStore.get(name);
  expect(profile).not.toBeNull();
  const declared = Object.keys(manifest?.operations ?? {});
  expect(declared.length, 'the catalog must declare something to admit')
    .toBeGreaterThan(0);
  expect([...profile!.allowed_operations].sort()).toEqual([...declared].sort());
  /** The reads the old contract pinned must STILL be present — the bypass widens the
   *  set, and a change that accidentally NARROWED it would otherwise slip through.
   *  ⚠ Only for the reads THIS manifest declares: the write-only catalog legitimately
   *  has none, and demanding them there would assert the fixture rather than the code. */
  for (const op of READ_OPS) {
    if (declared.includes(op)) expect(profile!.allowed_operations).toContain(op);
  }
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
  it('seeds an already-enrolled HubSpot connection’s catalog ops', () => {
    /** ⚠ Was: "…read ops once the read group is granted", with a trailing assertion
     *  that `note.create` was ABSENT because the write group was ungranted. That
     *  absence is exactly what `OPERATION_GROUP_GATE_ENABLED = false` removes, so the
     *  assertion is inverted rather than dropped — a write op MUST now be seeded, and
     *  a change that silently stopped seeding writes should redden here. The grant is
     *  still issued so this stays a fair comparison with the ungranted case below. */
    upsertApiConnection('hubspot-prod', 'hubspot');
    grantReads('hubspot-prod');

    wire();

    expectAllowedOperations('hubspot-prod');
    expect(profileStore.get('hubspot-prod')!.allowed_operations,
      'a write op is seeded now — approval, not this layer, gates it').toContain('note.create');
  });

  it('⛔⛔ seeds a HubSpot connection with NO grant — the 5c ratchet is retired', () => {
    /** ⛔ THIS TEST'S SUBJECT IS REVERSED, and that is the point of keeping it. It
     *  asserted the D-182 §7.1 inc 5c ratchet: bare enrollment granted nothing, the
     *  derived set was empty, the profile was dropped, and the gateway denied
     *  everything with `no_connection_profile`. The owner retired that layer on
     *  2026-08-07 (`OPERATION_GROUP_GATE_ENABLED = false`).
     *
     *  🔑 IT IS INVERTED IN PLACE, NOT DELETED, so the retirement is legible at the
     *  exact spot the ratchet used to be enforced — a deleted test leaves no trace that
     *  a security property was ever there, and this one was deliberate.
     *
     *  ⚠ The op set is compared against the CATALOG, so this cannot pass by seeding
     *  some arbitrary set; and the sibling test below still proves a connection with NO
     *  catalog seeds nothing, which is the fail-closed half that survived. */
    upsertApiConnection('hubspot-ungranted', 'hubspot');

    wire();

    expectAllowedOperations('hubspot-ungranted');
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

    /** ⛔⛔ THE WRITE-ONLY HALF IS WHERE THE POSTURE CHANGE HAS TEETH, so it is pinned
     *  rather than softened. A write-only catalog declares no read group; under the 5c
     *  ratchet a granted read group expanded to nothing, the profile was dropped, and
     *  the write was unreachable. Now the catalog's declared write IS seeded.
     *
     *  ⚠ This is the single most consequential line in the change: it is the case where
     *  "bypass the group layer" stops being a UI simplification and actually admits a
     *  write that was previously denied outright. It is safe only because the approval
     *  floor still pins that op at `ask` — which the E2E cases in
     *  `d-165-operation-group-grant.test.ts` assert directly. If this ever seeds a write
     *  whose approval is `never`, those tests are the ones that must catch it, and this
     *  comment is the pointer to why. */
    manifest = writeOnlyCatalogManifest();
    profileStore.set('write-only-on-upsert', { allowed_operations: READ_OPS });
    grantReads('write-only-on-upsert');

    upsertApiConnection('write-only-on-upsert', 'hubspot');

    expectAllowedOperations('write-only-on-upsert', writeOnlyCatalogManifest());
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

    /** ⚠ INVERTED 2026-08-07. This asserted that uninstalling the pack REVOKED
     *  `note.create`, leaving the user's read grant. With the group layer bypassed the
     *  seeded set follows the CATALOG, so uninstalling a pack no longer narrows what a
     *  connection can reach — a real consequence of the decision, recorded here rather
     *  than discovered later. What the uninstall still does (drop the pack's grant
     *  rows) is unchanged and asserted by the grant-store's own suite. */
    expect(profileStore.get('hs')!.allowed_operations,
      'pack uninstall no longer narrows reachability').toContain('note.create');
    expectAllowedOperations('hs');
  });

  it('a pack grant for a DIFFERENT connection does not leak into this one', () => {
    upsertApiConnection('hs', 'hubspot');
    grantReads('hs');
    grantStore.grantPackGroup('sales-pack', 'hubspot-catalog', 'other-conn', 'notes.write');

    wireWithGrants();

    /** ⚠ INVERTED 2026-08-07 — and this one is worth reading carefully, because the
     *  ORIGINAL PROPERTY IS NOW UNTESTABLE HERE. It asserted that a pack grant on
     *  `other-conn` did not leak into `hs`. Under the bypass both connections reach
     *  their catalog's ops regardless of any grant, so `hs` containing `note.create`
     *  is no longer evidence of a leak — the assertion cannot distinguish the two.
     *
     *  🔑 What still CAN be checked is that the grant landed where it was addressed, so
     *  that is what is asserted: the store's own per-connection keying. Cross-connection
     *  isolation of REACHABILITY is not a property this layer provides any more. */
    expectAllowedOperations('hs');
    expect(grantStore.listPackOwnedGroups('hubspot-catalog', 'hs'),
      'the grant was addressed to other-conn and must not be stored against hs').toEqual([]);
    expect(grantStore.listPackOwnedGroups('hubspot-catalog', 'other-conn'))
      .toContain('notes.write');
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

    /** ⚠ INVERTED 2026-08-07: the write op no longer "stays OFF". The BINDING half —
     *  that a local catalog reaches a connection through the install-recorded binding
     *  alone, with the right `catalog_slug` — is what this test exists for and is
     *  untouched; only the op-set expectation moved. */
    const profile = profileStore.get('support');
    expect(profile?.catalog_slug).toBe(LOCAL_SLUG);
    expect([...profile!.allowed_operations].sort()).toEqual(['ticket.create', 'ticket.read']);
  });

  it('⛔ seeds a bound local-catalog connection with NO grant — 5c ratchet retired', () => {
    /** The local-catalog mirror of the registered-vendor case above. Kept inverted in
     *  place for the same reason: this is where the ratchet was enforced for a private
     *  catalog, and a deleted test would leave no sign it ever was. */
    bindingStore.bind('support', LOCAL_SLUG, 'acme-pack');

    wireLocal();

    const profile = profileStore.get('support');
    expect(profile?.catalog_slug).toBe(LOCAL_SLUG);
    expect([...profile!.allowed_operations].sort()).toEqual(['ticket.create', 'ticket.read']);
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

  it('revokes and re-seeds a bound MCP connection profile across delete/re-enroll', () => {
    bindingStore.bind('peer', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('peer');
    wireLocal();

    upsertMcpConnection('peer');
    /** ⚠ Op set widened 2026-08-07 (bypass): the local catalog's declared ops, not the
     *  granted subset. The DELETE/RE-ENROL lifecycle below is what this test is for and
     *  is unchanged — profile dropped on delete, binding survives, profile re-seeded on
     *  re-enrol under the same catalog. */
    expect(profileStore.get('peer')).toMatchObject({
      catalog_slug: LOCAL_SLUG,
      allowed_operations: ['ticket.read', 'ticket.create'],
    });

    connectionStore.delete('mcp', 'peer');
    expect(profileStore.get('peer')).toBeNull();
    expect(bindingStore.resolveCatalogSlug('peer')).toBe(LOCAL_SLUG);

    upsertMcpConnection('peer', NOW + 1);
    expect(profileStore.get('peer')?.catalog_slug).toBe(LOCAL_SLUG);
  });

  it('keeps a same-name API profile when only its MCP sibling is deleted', () => {
    upsertApiConnection('shared', 'hubspot');
    upsertMcpConnection('shared');
    grantReads('shared');
    bindingStore.bind('shared', LOCAL_SLUG, 'acme-pack');
    grantLocalReads('shared');
    wireLocal();

    expect(profileStore.get('shared')?.catalog_slug).toBe('hubspot-catalog');
    connectionStore.delete('mcp', 'shared');
    expect(profileStore.get('shared')?.catalog_slug).toBe('hubspot-catalog');

    connectionStore.delete('api', 'shared');
    expect(profileStore.get('shared')).toBeNull();
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

    /** 🔑 THE PRECEDENCE IS THE POINT AND IT STILL HOLDS — `catalog_slug` resolves to
     *  the registered vendor, not the local binding. The op-set assertion moved to the
     *  hubspot catalog's full declaration (bypass), which ALSO strengthens the test:
     *  the two catalogs declare disjoint ops, so seeding `ticket.*` here would now be a
     *  visible failure rather than a subset that happened to match. */
    expect(profileStore.get('hs')?.catalog_slug).toBe('hubspot-catalog');
    expectAllowedOperations('hs');
    expect(profileStore.get('hs')!.allowed_operations,
      'the local catalog must not shadow the registered vendor').not.toContain('ticket.read');
  });
});
