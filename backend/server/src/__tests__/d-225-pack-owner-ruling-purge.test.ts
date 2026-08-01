/** D-225 Slice 2 — dropping a pack's owner rulings.
 *
 *  ⛔ The gap this closes: `pack-uninstall-handler` purges inventory,
 *  pack-owned grants and connection bindings, but NOT `OWNER_OPERATION_SCOPE`.
 *  For a marketplace pack that retention is the friendly behaviour and is left
 *  alone. For a GENERATED MCP pack it is wrong: the slug is derived from
 *  `{kind, name}` and therefore stable, so deleting the connection and later
 *  enrolling a different server under the same name silently re-adopts rulings
 *  the owner made about a server that is gone.
 *
 *  ⚠ The danger is NOT privilege escalation — descriptor-hashed op ids mean a
 *  ruling can only reattach to a byte-identical tool. It is an owner believing
 *  they had a clean slate when they did not.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_OPERATION_SCOPE } from '@recued/contracts';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { removePackOwnerRulings } from '../pack-inventory.js';

const NOW = 1_700_000_000_000;
const GENERATED = 'mcp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'recued-core/hubspot';

let db: Database.Database;
let store: ContractStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContractStore(db, { now: () => NOW });
});
afterEach(() => db.close());

/** A real owner ruling. `op_hash` is required by the contract schema — it is
 *  the staleness anchor the update review compares against. */
const ruling = (ingredient: string, op: string): void => {
  store.put(OWNER_OPERATION_SCOPE, [ingredient, op], {
    risk: 'read',
    approval: 'never',
    op_hash: 'a'.repeat(64),
  });
};

const rulingsFor = (ingredient: string): string[] =>
  [...store.scan(OWNER_OPERATION_SCOPE)]
    .filter((r) => r.segments[0] === ingredient)
    .map((r) => r.segments[1]!)
    .sort();

describe('D-225 — removePackOwnerRulings', () => {
  it('drops every ruling for the named pack', async () => {
    ruling(GENERATED, 'list_a1b2c3d4');
    ruling(GENERATED, 'create_9f8e7d6c');

    expect(removePackOwnerRulings(store, [GENERATED])).toEqual({ removed_rulings: 2 });
    expect(rulingsFor(GENERATED)).toEqual([]);
  });

  it("⛔ leaves ANOTHER pack's rulings alone", async () => {
    // The isolation that makes this safe to call. A purge that swept the whole
    // scope would silently reset the owner's tuning on every installed pack.
    ruling(GENERATED, 'list_a1b2c3d4');
    ruling(OTHER, 'deal.read');
    ruling(OTHER, 'deal.create');

    removePackOwnerRulings(store, [GENERATED]);

    expect(rulingsFor(GENERATED)).toEqual([]);
    expect(rulingsFor(OTHER)).toEqual(['deal.create', 'deal.read']);
  });

  it('is idempotent and safe on a pack with no rulings', async () => {
    ruling(OTHER, 'deal.read');
    expect(removePackOwnerRulings(store, [GENERATED])).toEqual({ removed_rulings: 0 });
    // …and a second call after a real purge removes nothing more.
    ruling(GENERATED, 'x_11111111');
    expect(removePackOwnerRulings(store, [GENERATED])).toEqual({ removed_rulings: 1 });
    expect(removePackOwnerRulings(store, [GENERATED])).toEqual({ removed_rulings: 0 });
    expect(rulingsFor(OTHER)).toEqual(['deal.read']);
  });

  it('an empty target list is a no-op, not a wildcard', async () => {
    // ⛔ The failure mode this forecloses: an empty set read as "match
    // everything" would wipe every owner ruling on the server the first time a
    // caller passed a pack with no ingredient ids.
    ruling(GENERATED, 'a_11111111');
    ruling(OTHER, 'deal.read');
    expect(removePackOwnerRulings(store, [])).toEqual({ removed_rulings: 0 });
    expect(rulingsFor(GENERATED)).toEqual(['a_11111111']);
    expect(rulingsFor(OTHER)).toEqual(['deal.read']);
  });

  it('purges across several ingredient ids at once', async () => {
    ruling(GENERATED, 'a_11111111');
    ruling('mcp-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'b_22222222');
    ruling(OTHER, 'deal.read');

    expect(
      removePackOwnerRulings(store, [GENERATED, 'mcp-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']),
    ).toEqual({ removed_rulings: 2 });
    expect(rulingsFor(OTHER)).toEqual(['deal.read']);
  });
});
