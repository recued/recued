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

/** D-273 — a row we cannot trust is worth exactly as much as no row.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). `get()` was `JSON.parse(row.data) as
 *  PortMappingRecord` — a CAST, not a read. The declared return type was a
 *  promise the store did not keep, and nothing tested it.
 *
 *  ⛔ IT IS NOT AN ACADEMIC TYPE HOLE. `store.get()` feeds `planPortMapping`
 *  directly (`port-mapping-supervisor.ts:214`). A `{}` whose gateway happens to
 *  match the desired one skips `gateway_changed`, fails `isSameMapping`, and
 *  lands on `params_changed` with `releaseReachable: true` — so `undefined`
 *  ports reach `actuator.unmap()` and go on into a NAT-PMP packet or an IGD
 *  SOAP body. This table's entire purpose is that only what we wrote down tells
 *  us a mapping is ours to take away; half a record cannot say that. */
describe('D-273 — the store refuses a row that is not a record', () => {
  const withRawRow = (data: string) => {
    const db = new Database(':memory:');
    createPortMappingStore(db);
    db.prepare('INSERT INTO port_mapping (id, data) VALUES (?, ?)').run('current', data);
    return createPortMappingStore(db);
  };

  it('⛔⛔ a row that PARSES but is not a record reads as absent', () => {
    for (const data of ['{}', '[]', '123', '"str"', 'true', 'null', '[{"protocol":"tcp"}]']) {
      expect(withRawRow(data).get(), `${data} was returned as a record`).toBeNull();
    }
  });

  it('⛔ a record missing ANY required field reads as absent', () => {
    // ⚠ ONE FIELD REMOVED AT A TIME, from a row that is otherwise valid — so
    // each check is the only thing that can decide. A single all-fields-missing
    // fixture would pass with five of the six checks deleted.
    for (const key of [
      'protocol', 'internalIp', 'internalPort', 'externalPort', 'createdAt', 'lifetimeSeconds',
    ] as const) {
      const partial: Record<string, unknown> = { ...RECORD };
      delete partial[key];
      expect(
        withRawRow(JSON.stringify(partial)).get(),
        `a record with no ${key} was accepted`,
      ).toBeNull();
    }
  });

  it('⛔ a field of the WRONG TYPE reads as absent', () => {
    const bad: ReadonlyArray<[string, unknown]> = [
      ['protocol', 'sctp'], ['protocol', 6], ['protocol', null],
      ['internalIp', 42], ['internalPort', '443'], ['externalPort', null],
      ['createdAt', '2026-01-01'], ['lifetimeSeconds', true],
      ['gateway', 7],
    ];
    for (const [key, value] of bad) {
      expect(
        withRawRow(JSON.stringify({ ...RECORD, [key]: value })).get(),
        `${key}=${JSON.stringify(value)} was accepted`,
      ).toBeNull();
    }
  });

  it('⛔ a non-finite port reads as absent — NaN encodes into a packet too', () => {
    // JSON cannot carry NaN or Infinity, but `1e999` parses to Infinity, and a
    // `typeof === "number"` check would wave it through into a port field.
    for (const data of [
      '{"protocol":"tcp","internalIp":"192.168.1.42","internalPort":1e999,'
      + '"externalPort":443,"createdAt":1,"lifetimeSeconds":7200}',
      '{"protocol":"tcp","internalIp":"192.168.1.42","internalPort":443,'
      + '"externalPort":-1e999,"createdAt":1,"lifetimeSeconds":7200}',
    ]) {
      expect(withRawRow(data).get(), 'a non-finite port was accepted').toBeNull();
    }
  });

  it('⛔ BOTH protocols round-trip — the fixture is tcp, and udp is not a typo', () => {
    // ⚠ Every fixture in this file is `tcp`, so narrowing the protocol check to
    // tcp-only was invisible — and it would silently drop every UDP record,
    // which reads downstream as "no record" and re-maps on every reconcile.
    for (const protocol of ['tcp', 'udp'] as const) {
      const rec = { ...RECORD, protocol };
      expect(withRawRow(JSON.stringify(rec)).get(), `${protocol} was rejected`).toEqual(rec);
    }
  });

  it('a valid record still round-trips, and `gateway` stays optional', () => {
    // The complement: the gate must not be so strict it rejects what `set()`
    // writes. `gateway` is genuinely optional — absent is how a record predating
    // a known gateway reads — so it is checked only when present.
    expect(withRawRow(JSON.stringify(RECORD)).get()).toEqual(RECORD);
    const noGateway: Record<string, unknown> = { ...RECORD };
    delete noGateway.gateway;
    expect(withRawRow(JSON.stringify(noGateway)).get()).toEqual(noGateway);
  });
});

/* ─── Mutation sweep of `network/port-mapping-store.ts`, 2026-09-18 ─────────
 *  26 mutations across two passes (11 on the store as it stood, 15 on the shape
 *  gate added here). The survivors below are EQUIVALENT, recorded with why:
 *
 *  1. `if (row === undefined) return null` → `=== null`. better-sqlite3 returns
 *     `undefined` for a missing row, so the mutant falls through to
 *     `row.data`, which THROWS — into the same `catch` that exists for a
 *     corrupt row, returning the same `null`. The guard is a fast path, not a
 *     behaviour.
 *
 *  2. `clear()`'s `WHERE id = ?` dropped. Equivalent under the table's
 *     one-row-by-construction invariant: nothing but `set()` writes it, and
 *     `set()` only ever writes `ROW_ID`. A test would have to insert a foreign
 *     row by raw SQL to see a difference, i.e. assert something the design says
 *     cannot happen.
 *
 *  3. The `typeof value !== 'object' || value === null || Array.isArray(value)`
 *     line, deleted or weakened. Every such value fails the NEXT check anyway
 *     (`[].protocol` and `(123).protocol` are `undefined`), and `null.gateway`
 *     throws into `get()`'s catch. Kept because a gate that says what it means
 *     beats one that leans on a downstream throw being swallowed — but no test
 *     can distinguish it.
 * ────────────────────────────────────────────────────────────────────────── */

