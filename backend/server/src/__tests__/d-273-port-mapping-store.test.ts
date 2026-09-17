/** D-273 P1 — the record of what WE mapped, against a real SQLite db. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createPortMappingStore } from '../network/port-mapping-store.js';
import type { PortMappingRecord } from '../network/port-mapping-plan.js';

const RECORD: PortMappingRecord = {
  gateway: '192.168.1.1',
  protocol: 'tcp',
  internalPort: 443,
  internalIp: '192.168.1.42',
  externalPort: 9443,
  createdAt: 1_700_000_000_000,
  lifetimeSeconds: 600,
};

const mk = () => createPortMappingStore(new Database(':memory:'));

describe('D-273 — port mapping store', () => {
  it('round-trips every field, including the ones identity depends on', () => {
    const store = mk();
    store.set(RECORD);
    // ⚠ Whole-object, not field-picked: `internalIp` and `gateway` are what the
    // reconcile compares on, and a store that quietly dropped either would make
    // every restart look "unchanged".
    expect(store.get()).toEqual(RECORD);
  });

  it('starts empty and clears back to empty', () => {
    const store = mk();
    expect(store.get()).toBeNull();
    store.set(RECORD);
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('⚠ holds ONE record — a second set replaces rather than accumulates', () => {
    // Two rows would mean two mappings and no way to say which is current.
    const store = mk();
    store.set(RECORD);
    store.set({ ...RECORD, externalPort: 8446 });
    expect(store.get()?.externalPort).toBe(8446);
  });

  it('⛔ a CORRUPT row reads as absent, and does not take the boot with it', () => {
    // The recovery for a lost record is benign: map again, and the mapping we
    // forgot expires on its own. Refusing to start over a port mapping is not a
    // trade worth making.
    const db = new Database(':memory:');
    const store = createPortMappingStore(db);
    store.set(RECORD);
    db.prepare('UPDATE port_mapping SET data = ?').run('{not json');
    expect(store.get()).toBeNull();
  });

  it('survives a second store over the same db — the table is created once', () => {
    const db = new Database(':memory:');
    createPortMappingStore(db).set(RECORD);
    expect(createPortMappingStore(db).get()).toEqual(RECORD);
  });
});
