/** Grant-foundation slice 3 (D-187 amendment `693b7d03`) — the unified
 *  `contract_grant` store + the store-backed resolver + the `contract.grant.*` rpc
 *  handlers.
 *
 *  Pins the fail-closed grant substrate: three-state read (`true` grant / `false`
 *  explicit revoke / `undefined` no-row), an explicit `false` REVOKE is a stored row
 *  that survives (the boot-reconcile invariant), empty-id guards block the whole-scope
 *  cross-contract bleed, dotted/slashed `entry_key`s key safely without bleeding across
 *  the `.` segment boundary, the transpose `listForEntry`, and the rpc paired-client
 *  gate + validation. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import { createGrantEntryResolver } from '../contract-grant-resolve.js';
import {
  handleContractGrantRead,
  handleContractGrantReadByEntry,
  handleContractGrantWrite,
} from '../contract-grant-handler.js';

const NOW = 1_700_000_000_000;
const OWNER = 'user_self';
const DOOR = 'door';
const OP = 'core.mail.send';
const PACK_OP = 'recued-core/hubspot.deal.read';
const TOPIC_ENTRY = 'enrichment.embedding';

let db: Database.Database;
let contractStore: ContractStore;
let store: ContractGrantEntryStore;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  store = createContractGrantEntryStore(contractStore);
});

afterEach(() => {
  db.close();
});

describe('contract_grant store — three-state read', () => {
  it('absent ⇒ undefined; grant ⇒ true; revoke ⇒ false', () => {
    expect(store.get(DOOR, OP)).toBeUndefined();
    store.set(DOOR, OP, true, NOW);
    expect(store.get(DOOR, OP)).toBe(true);
    store.set(DOOR, OP, false, NOW);
    expect(store.get(DOOR, OP)).toBe(false);
  });

  it('an explicit false REVOKE is a STORED row (survives — the boot-reconcile invariant)', () => {
    store.set(OWNER, OP, false, NOW);
    // Not absence: it appears in the contract's row set so a reconcile never re-grants it.
    expect(store.listForContract(OWNER)).toEqual([{ entry_key: OP, granted: false, set_at: NOW }]);
    expect(store.get(OWNER, OP)).toBe(false);
  });

  it('clear removes the row (idempotent return)', () => {
    store.set(DOOR, OP, true, NOW);
    expect(store.clear(DOOR, OP)).toBe(true);
    expect(store.get(DOOR, OP)).toBeUndefined();
    expect(store.clear(DOOR, OP)).toBe(false);
  });
});

describe('contract_grant store — empty-id guards (no whole-scope bleed)', () => {
  it('every method refuses an empty id', () => {
    expect(store.get('', OP)).toBeUndefined();
    expect(store.get(DOOR, '')).toBeUndefined();
    expect(() => store.set('', OP, true, NOW)).toThrow(/contract_id_required/);
    expect(() => store.set(DOOR, '', true, NOW)).toThrow(/entry_key_required/);
    expect(store.clear('', OP)).toBe(false);
    expect(store.listForContract('')).toEqual([]);
    expect(store.listForEntry('')).toEqual([]);
  });
});

describe('contract_grant store — dotted/slashed entry_key keys safely', () => {
  it('op ids with dots + a slash round-trip and do not bleed', () => {
    store.set(DOOR, OP, true, NOW);
    store.set(DOOR, PACK_OP, false, NOW);
    store.set(DOOR, TOPIC_ENTRY, true, NOW);
    expect(store.get(DOOR, OP)).toBe(true);
    expect(store.get(DOOR, PACK_OP)).toBe(false);
    expect(store.get(DOOR, TOPIC_ENTRY)).toBe(true);
    expect(store.listForContract(DOOR)).toHaveLength(3);
  });

  it('a contract_id prefix does NOT bleed across the . segment boundary', () => {
    store.set('door', OP, true, NOW);
    store.set('doorway', OP, false, NOW);
    expect(store.get('doorway', OP)).toBe(false); // not the 'door' row
    expect(store.listForContract('door')).toEqual([{ entry_key: OP, granted: true, set_at: NOW }]);
  });
});

describe('contract_grant store — listForEntry (transpose / column)', () => {
  it('returns which contracts hold an entry, across contracts, sorted', () => {
    store.set(DOOR, OP, true, NOW);
    store.set(OWNER, OP, false, NOW);
    store.set(DOOR, PACK_OP, true, NOW); // a different entry — excluded
    expect(store.listForEntry(OP)).toEqual([
      { contract_id: DOOR, granted: true, set_at: NOW },
      { contract_id: OWNER, granted: false, set_at: NOW },
    ]);
    expect(store.listForEntry(PACK_OP)).toEqual([{ contract_id: DOOR, granted: true, set_at: NOW }]);
  });
});

describe('contract_grant resolver — explicit ?? authorDefault', () => {
  it('absent falls to authorDefault; an explicit revoke beats a permissive default', () => {
    const resolver = createGrantEntryResolver(store);
    expect(resolver.isGranted(DOOR, OP, true)).toBe(true); // absent → author default
    expect(resolver.isGranted(DOOR, OP, false)).toBe(false);
    store.set(DOOR, OP, false, NOW);
    expect(resolver.isGranted(DOOR, OP, true)).toBe(false); // revoke beats permissive default
    store.set(DOOR, OP, true, NOW);
    expect(resolver.isGranted(DOOR, OP, false)).toBe(true);
  });
});

describe('contract.grant rpc handlers', () => {
  const PAIRED = { instance_id: 'inst-1' };

  it('write requires a paired client (D-121)', () => {
    expect(() =>
      handleContractGrantWrite({ store, now: () => NOW }, { contract_id: DOOR, entry_key: OP, granted: true }, undefined),
    ).toThrow(/paired client/);
  });

  it('write true/false/null persists / revokes / clears; false SURVIVES as a stored row', () => {
    const deps = { store, now: () => NOW };
    expect(handleContractGrantWrite(deps, { contract_id: DOOR, entry_key: OP, granted: true }, PAIRED)).toEqual({
      ok: true,
      granted: true,
    });
    expect(store.get(DOOR, OP)).toBe(true);

    // false must persist as an explicit revoke row (codex no-ship guard).
    expect(handleContractGrantWrite(deps, { contract_id: DOOR, entry_key: OP, granted: false }, PAIRED)).toEqual({
      ok: true,
      granted: false,
    });
    expect(store.get(DOOR, OP)).toBe(false);

    expect(handleContractGrantWrite(deps, { contract_id: DOOR, entry_key: OP, granted: null }, PAIRED)).toEqual({
      ok: true,
      granted: null,
    });
    expect(store.get(DOOR, OP)).toBeUndefined();
  });

  it('write rejects bad args', () => {
    const deps = { store, now: () => NOW };
    expect(() => handleContractGrantWrite(deps, { entry_key: OP, granted: true }, PAIRED)).toThrow(/contract_id/);
    expect(() => handleContractGrantWrite(deps, { contract_id: DOOR, granted: true }, PAIRED)).toThrow(/entry_key/);
    expect(() =>
      handleContractGrantWrite(deps, { contract_id: DOOR, entry_key: OP, granted: 'yes' }, PAIRED),
    ).toThrow(/boolean or null/);
  });

  it('read returns the contract row; read_by_entry returns the entry column', () => {
    const deps = { store, now: () => NOW };
    store.set(DOOR, OP, true, NOW);
    store.set(OWNER, OP, false, NOW);
    expect(handleContractGrantRead(deps, { contract_id: DOOR })).toEqual({
      grants: [{ entry_key: OP, granted: true, set_at: NOW }],
    });
    expect(handleContractGrantReadByEntry(deps, { entry_key: OP })).toEqual({
      contracts: [
        { contract_id: DOOR, granted: true, set_at: NOW },
        { contract_id: OWNER, granted: false, set_at: NOW },
      ],
    });
    expect(() => handleContractGrantRead(deps, {})).toThrow(/contract_id/);
    expect(() => handleContractGrantReadByEntry(deps, {})).toThrow(/entry_key/);
  });
});

describe('contract_grant store — D-182 §7.2 source_pack provenance', () => {
  const PACK = 'recued-core.acme-crm';
  const OTHER_PACK = 'recued-core.other';

  it('set stamps source_pack; listForContract + listForEntry surface it (absent when omitted)', () => {
    store.set(DOOR, OP, true, NOW, PACK);
    store.set(DOOR, PACK_OP, true, NOW); // no source_pack (a mint-fold / owner row)
    expect(store.listForContract(DOOR)).toEqual([
      { entry_key: OP, granted: true, set_at: NOW, source_pack: PACK },
      { entry_key: PACK_OP, granted: true, set_at: NOW },
    ]);
    expect(store.listForEntry(OP)).toEqual([
      { contract_id: DOOR, granted: true, set_at: NOW, source_pack: PACK },
    ]);
  });

  it('clearForSourcePack removes ONLY the pack’s stamped rows — mint-fold / owner / other-pack rows survive (isolation)', () => {
    // A door with: a fan-out row (PACK), its OWN mint-fold row (no source_pack),
    // and a row from a DIFFERENT pack. Plus an owner row (no source_pack).
    store.set(DOOR, OP, true, NOW, PACK);
    store.set(DOOR, PACK_OP, true, NOW); // door's own scope grant — must survive
    store.set(DOOR, TOPIC_ENTRY, true, NOW, OTHER_PACK); // another pack — must survive
    store.set(OWNER, OP, true, NOW); // owner row — must survive

    expect(store.clearForSourcePack(PACK)).toBe(1); // exactly the one PACK-stamped row

    expect(store.get(DOOR, OP)).toBeUndefined(); // the fan-out row is gone
    expect(store.get(DOOR, PACK_OP)).toBe(true); // the mint-fold row SURVIVES
    expect(store.get(DOOR, TOPIC_ENTRY)).toBe(true); // the other pack SURVIVES
    expect(store.get(OWNER, OP)).toBe(true); // the owner row SURVIVES
  });

  it('clearForSourcePack across contracts drops every row of this pack + returns the count', () => {
    const DOOR_B = 'door-b';
    store.set(DOOR, OP, true, NOW, PACK);
    store.set(DOOR, PACK_OP, true, NOW, PACK);
    store.set(DOOR_B, OP, true, NOW, PACK);
    expect(store.clearForSourcePack(PACK)).toBe(3);
    expect(store.listForContract(DOOR)).toEqual([]);
    expect(store.listForContract(DOOR_B)).toEqual([]);
  });

  it('clearForSourcePack("") is a no-op — an empty stamp never degenerates into a whole-scope wipe', () => {
    store.set(DOOR, OP, true, NOW, PACK);
    store.set(OWNER, PACK_OP, true, NOW); // no source_pack
    expect(store.clearForSourcePack('')).toBe(0);
    expect(store.get(DOOR, OP)).toBe(true);
    expect(store.get(OWNER, PACK_OP)).toBe(true);
  });
});
