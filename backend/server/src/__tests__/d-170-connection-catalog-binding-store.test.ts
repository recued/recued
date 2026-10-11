/** D-170 gap #2 — the `contract.connection_catalog_binding` store.
 *
 *  Proves the binding storage in isolation: bind / resolve / list / per-pack
 *  removal, several catalogs on one connection (D-320 ruling 10) in bind order,
 *  rows written under the old one-segment key, the defensive malformed-row read,
 *  and that another pack's bindings survive a removeForPack. This is the substrate
 *  the profile seed + the grant gate resolve a private/local composition catalog
 *  connection through (a local catalog has no `config.vendor`).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createConnectionCatalogBindingStore,
  type ConnectionCatalogBindingStore,
} from '../storage/connection-catalog-binding-store.js';

const NOW = 1_700_000_000_000;
const SCOPE = 'connection_catalog_binding';

let db: Database.Database;
let contractStore: ContractStore;
let bindings: ConnectionCatalogBindingStore;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  bindings = createConnectionCatalogBindingStore(contractStore);
});

afterEach(() => {
  db.close();
});

describe('connection-catalog-binding-store — bind / resolve', () => {
  it('binds a connection to a catalog, then resolves it', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    expect(bindings.resolveCatalogSlug('support')).toBe('acme-tickets');
  });

  it('resolveCatalogSlug returns undefined for an unbound connection', () => {
    expect(bindings.resolveCatalogSlug('never-bound')).toBeUndefined();
  });

  it('writes the row keyed by connection_name AND catalog_slug with the exact value shape', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    const row = contractStore.get(SCOPE, ['support', 'acme-tickets']);
    expect(row?.segments).toEqual(['support', 'acme-tickets']);
    expect(row?.value).toEqual({ catalog_slug: 'acme-tickets', installed_pack_id: 'acme-pack' });
    expect(contractStore.get(SCOPE, ['support'])).toBeNull();
  });

  it('isolates bindings by connection name', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    bindings.bind('billing', 'acme-invoices', 'acme-pack');
    expect(bindings.resolveCatalogSlug('support')).toBe('acme-tickets');
    expect(bindings.resolveCatalogSlug('billing')).toBe('acme-invoices');
  });
});

describe('connection-catalog-binding-store — list', () => {
  it('lists every binding with its connection, catalog, and owning pack', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    bindings.bind('crm', 'beta-crm', 'beta-pack');
    expect(bindings.list()).toEqual(
      expect.arrayContaining([
        { connection_name: 'support', catalog_slug: 'acme-tickets', installed_pack_id: 'acme-pack' },
        { connection_name: 'crm', catalog_slug: 'beta-crm', installed_pack_id: 'beta-pack' },
      ]),
    );
    expect(bindings.list()).toHaveLength(2);
  });

  it('is empty on a fresh store', () => {
    expect(bindings.list()).toEqual([]);
  });

  it('rejects a malformed binding write at the store boundary (value_shape validated)', () => {
    // The contract store validates writes against `catalog_binding_info`, so a row
    // missing `installed_pack_id` can never land — the store's own value-shape gate
    // backstops the store's defensive readBinding. (A direct `contractStore.put` of an
    // incomplete value throws, not the binding wrapper.)
    expect(() => contractStore.put(SCOPE, ['broken', 'x'], { catalog_slug: 'x' })).toThrow();
  });
});

describe('connection-catalog-binding-store — several catalogs on one connection (D-320 ruling 10)', () => {
  /** A clock that moves, so bind order is observable. */
  const ticking = (): ConnectionCatalogBindingStore => {
    let t = NOW;
    return createConnectionCatalogBindingStore(createContractStore(db, { now: () => (t += 1) }));
  };

  it('a second catalog bound to a connection sits beside the first, which stays first', () => {
    const store = ticking();
    store.bind('wise', 'wise-quotes', 'wise-quotes');
    store.bind('wise', 'wise-core', 'wise-core');
    expect(store.catalogsForConnection('wise')).toEqual(['wise-quotes', 'wise-core']);
    expect(store.resolveCatalogSlug('wise')).toBe('wise-quotes');
    expect(store.list()).toHaveLength(2);
  });

  it('re-binding a pair for its own pack writes nothing, so a reinstall does not reorder', () => {
    const store = ticking();
    store.bind('wise', 'wise-core', 'wise-core');
    store.bind('wise', 'wise-quotes', 'wise-quotes');
    store.bind('wise', 'wise-core', 'wise-core');
    expect(store.catalogsForConnection('wise')).toEqual(['wise-core', 'wise-quotes']);
  });

  it('unbind drops one pair and leaves the connection\'s other catalogs', () => {
    bindings.bind('wise', 'wise-core', 'wise-core');
    bindings.bind('wise', 'wise-quotes', 'wise-quotes');
    bindings.unbind('wise', 'wise-core');
    expect(bindings.catalogsForConnection('wise')).toEqual(['wise-quotes']);
  });

  it('lists the connections bound to a catalog', () => {
    bindings.bind('wise-business', 'wise-core', 'wise-core');
    bindings.bind('wise-personal', 'wise-core', 'wise-core');
    bindings.bind('wise-business', 'wise-quotes', 'wise-quotes');
    expect(bindings.connectionsForCatalog('wise-core')).toEqual(['wise-business', 'wise-personal']);
    expect(bindings.connectionsForCatalog('nothing')).toEqual([]);
  });
});

describe('connection-catalog-binding-store — a row written under the old key', () => {
  /** What a server wrote before ruling 10: keyed by the connection alone. */
  const legacyRow = (connection: string, catalog: string, pack: string, writtenAt = 1): void => {
    db.prepare(
      "INSERT INTO contract_store (scope, seg_key, value_inline, written_at) VALUES (?, ?, ?, ?)",
    ).run(SCOPE, connection, JSON.stringify({ catalog_slug: catalog, installed_pack_id: pack }), writtenAt);
  };

  it('is still read as the binding it always was', () => {
    legacyRow('wise', 'wise-core', 'wise-core');
    expect(bindings.resolveCatalogSlug('wise')).toBe('wise-core');
    expect(bindings.catalogsForConnection('wise')).toEqual(['wise-core']);
    expect(bindings.list()).toEqual([
      { connection_name: 'wise', catalog_slug: 'wise-core', installed_pack_id: 'wise-core' },
    ]);
  });

  it('stays first when a newer catalog is bound beside it', () => {
    legacyRow('wise', 'wise-core', 'wise-core');
    bindings.bind('wise', 'wise-quotes', 'wise-quotes');
    expect(bindings.catalogsForConnection('wise')).toEqual(['wise-core', 'wise-quotes']);
  });

  it('is replaced, not duplicated, when the same pair is bound again', () => {
    legacyRow('wise', 'wise-core', 'wise-core');
    bindings.bind('wise', 'wise-core', 'wise-core');
    expect(contractStore.get(SCOPE, ['wise'])).toBeNull();
    expect(bindings.list()).toHaveLength(1);
  });

  it('goes with unbind and with removeForPack', () => {
    legacyRow('wise', 'wise-core', 'wise-core');
    bindings.unbind('wise', 'wise-core');
    expect(bindings.list()).toEqual([]);
    legacyRow('wise', 'wise-core', 'wise-core');
    bindings.removeForPack('wise-core');
    expect(bindings.list()).toEqual([]);
  });
});

describe('connection-catalog-binding-store — removeForPack (uninstall)', () => {
  it('drops only the named pack’s bindings — another pack’s survive (per-pack isolation)', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    bindings.bind('crm', 'beta-crm', 'beta-pack');

    bindings.removeForPack('acme-pack');

    expect(bindings.resolveCatalogSlug('support')).toBeUndefined();
    expect(bindings.resolveCatalogSlug('crm')).toBe('beta-crm'); // beta-pack survives
  });

  it('drops every connection a single pack bound', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    bindings.bind('billing', 'acme-invoices', 'acme-pack');

    bindings.removeForPack('acme-pack');

    expect(bindings.list()).toEqual([]);
  });

  it('is a no-op for an unknown pack', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    expect(() => bindings.removeForPack('nope')).not.toThrow();
    expect(bindings.resolveCatalogSlug('support')).toBe('acme-tickets');
  });
});
