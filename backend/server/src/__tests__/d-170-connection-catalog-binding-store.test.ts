/** D-170 gap #2 — the `contract.connection_catalog_binding` store.
 *
 *  Proves the binding storage in isolation: bind / resolve / list / per-pack
 *  removal, the override (reinstall-replace) semantics, the defensive malformed-row
 *  read, and that another pack's bindings survive a removeForPack. This is the
 *  substrate the profile seed + the grant gate resolve a private/local composition
 *  catalog connection through (a local catalog has no `config.vendor`).
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

  it('writes the row keyed by connection_name with the exact value shape', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    const row = contractStore.get(SCOPE, ['support']);
    expect(row?.segments).toEqual(['support']);
    expect(row?.value).toEqual({ catalog_slug: 'acme-tickets', installed_pack_id: 'acme-pack' });
  });

  it('bind overwrites (reinstall replace) — last write wins, one row per connection', () => {
    bindings.bind('support', 'acme-tickets', 'acme-pack');
    bindings.bind('support', 'acme-tickets-v2', 'acme-pack');
    expect(bindings.resolveCatalogSlug('support')).toBe('acme-tickets-v2');
    expect(bindings.list()).toHaveLength(1);
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
    expect(() => contractStore.put(SCOPE, ['broken'], { catalog_slug: 'x' })).toThrow();
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
