/** The audit gate reports the truth even when a deleter never tells it.
 *
 *  ⛔ THE DEFECT. The gate's `used` was maintained by CALLERS — `addUsed` on
 *  write, `setUsed` on re-anchor. `housekeeping/tasks/audit-compaction.ts`
 *  deletes audit rows through raw SQL and reports nothing, so the gate
 *  over-reported by whatever compaction reclaimed until the hourly retention
 *  pass re-anchored it. Once the server-control popover started rendering
 *  `used_bytes`, that stale number became something the owner could see.
 *
 *  ⛔ WHY A PROVIDER RATHER THAN THREADING A GATE INTO COMPACTION. Passing the
 *  gate to the deleter RELOCATES the obligation — the next task that deletes
 *  audit rows forgets in exactly the same way, and nothing below it fails. The
 *  provider removes the obligation: the gate asks the source of truth, so no
 *  writer anywhere has to remember. Same principle as the triggers that
 *  maintain the counter it reads.
 *
 *  ⚠ The test deletes with RAW SQL and never touches the gate — that is the
 *  whole scenario. A test that called `subUsed` would be testing the path that
 *  already worked. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIN_RESERVE_BYTES, createStorageGate } from '@recued/storage-gate';

import { ensureAuditIndexes } from '../audit-indexes.js';
import { readAuditUsageBytes } from '../audit-usage-counter.js';

const mkDb = (rows: number): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_entries    (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  ensureAuditIndexes(db);
  const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
  for (let i = 0; i < rows; i++) {
    ins.run(`k-${i}`, JSON.stringify({ i, pad: 'x'.repeat(200) }));
  }
  return db;
};

/** ⚠ QUOTA MUST EXCEED `MIN_RESERVE_BYTES` (10 MB). The first cut used 100 KB;
 *  `reserve = max(MIN_RESERVE_BYTES, quota × pct)` then swallowed the whole
 *  quota, `available` was 0, and the gate sat in `writes_blocked` from the
 *  first byte — so three state assertions failed for a fixture reason with
 *  nothing to do with the provider. */
const QUOTA = 12 * 1024 * 1024;
const PRESSURE_AT = Math.floor((QUOTA - MIN_RESERVE_BYTES) * 0.8);

const mkGate = (db: Database.Database) =>
  createStorageGate({
    quota: QUOTA,
    reservePct: 4,
    surface: 'audit',
    usageProvider: () => readAuditUsageBytes(db),
  });

/** Rows sized so `count` of them lands just past a given byte target. */
const fill = (db: Database.Database, prefix: string, targetBytes: number): void => {
  const row = JSON.stringify({ pad: 'y'.repeat(4000) });
  const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
  const n = Math.ceil(targetBytes / row.length);
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`${prefix}-${i}`, row);
  })();
};

describe('audit gate usage provider', () => {
  it('⛔ a RAW DELETE the gate was never told about still lowers used_bytes', () => {
    const db = mkDb(100);
    const gate = mkGate(db);
    const before = gate.info().used;
    expect(before).toBe(readAuditUsageBytes(db));
    expect(before).toBeGreaterThan(0);

    // Exactly what `audit-compaction` does: raw SQL, no gate call.
    db.prepare(`DELETE FROM audit_entries WHERE key LIKE 'k-1%'`).run();

    expect(gate.info().used).toBe(readAuditUsageBytes(db));
    expect(gate.info().used).toBeLessThan(before);
    db.close();
  });

  it('⛔ state follows the provider — a delete RELIEVES pressure without a call', () => {
    // The number being right is not enough: the gate's STATE drives the
    // eviction cascade and the pill's colour, so it has to move too.
    const db = mkDb(0);
    const gate = mkGate(db);
    // ⚠ Valid JSON: `ensureAuditIndexes` builds `json_extract` expression
    // indexes over `data`, so a bare string throws "malformed JSON" at INSERT.
    fill(db, 'p', PRESSURE_AT + 50_000);

    expect(gate.info().state).not.toBe('running');   // pressured on writes alone
    db.prepare(`DELETE FROM audit_entries`).run();   // raw, unreported
    expect(gate.info().state).toBe('running');       // ...and it recovers
    db.close();
  });

  it('⛔ a write still EMITS the transition — the cascade push path survives', () => {
    // `addUsed` is the signal `eviction-cascade` subscribes to. Making it a
    // no-op under a provider would leave a surface transitioning only when
    // something happened to read it, delaying reclaim.
    const db = mkDb(0);
    const gate = mkGate(db);
    const seen: string[] = [];
    gate.onStateChange((e) => seen.push(e.next));

    const row = JSON.stringify({ pad: 'z'.repeat(4000) });
    const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
    const n = Math.ceil((PRESSURE_AT + 50_000) / row.length);
    for (let i = 0; i < n; i++) {
      ins.run(`q-${i}`, row);
      gate.addUsed(row.length); // what `onBytesChanged` does on every write
    }
    expect(seen).toContain('pressure_managed');
    db.close();
  });

  it('canWrite projects from the provider, not a stale counter', () => {
    const db = mkDb(0);
    const gate = mkGate(db);
    fill(db, 'r', QUOTA);            // past the blocked ceiling
    expect(gate.canWrite(1).ok).toBe(false);

    db.prepare(`DELETE FROM audit_entries`).run(); // raw, unreported
    expect(gate.canWrite(1).ok).toBe(true);
    db.close();
  });

  it('⛔ a THROWING provider does not take the gate down, and never reads 0', () => {
    // A 0 would read as "empty" — the most dangerous wrong answer, since it
    // clears pressure and unblocks writes on a full surface.
    const gate = createStorageGate({
      quota: QUOTA,
      reservePct: 4,
      surface: 'audit',
      usageProvider: () => { throw new Error('db gone'); },
    });
    // ⛔ THE FALLBACK MUST BE THE PUSHED COUNTER, NOT 0. First cut skipped
    // `setUsed` under a provider, so `used` was permanently 0 and the fallback
    // reported an EMPTY surface — which clears pressure and unblocks writes on
    // a full disk. A mutation replacing the fallback with a literal 0 passed
    // every test, because the fixture made both branches agree.
    gate.setUsed(50_000);
    expect(() => gate.info()).not.toThrow();
    expect(gate.info().used).toBe(50_000);

    // A provider returning garbage falls back rather than propagating it.
    let bad: unknown = Number.NaN;
    const g2 = createStorageGate({
      quota: QUOTA, reservePct: 4, surface: 'audit',
      usageProvider: () => bad as number,
    });
    g2.setUsed(4_242);
    expect(g2.info().used).toBe(4_242);   // NaN → fall back
    bad = -5;
    expect(g2.info().used).toBe(4_242);   // negative → fall back
    bad = 1234;
    expect(g2.info().used).toBe(1234);    // valid → provider wins
  });

  it('a gate WITHOUT a provider is unchanged — pushed counters still work', () => {
    // The provider is opt-in per surface; every other gate must behave exactly
    // as before, including `info()` not recomputing state on read.
    const gate = createStorageGate({ quota: QUOTA, reservePct: 4, surface: 'cache' });
    expect(gate.info().used).toBe(0);
    gate.addUsed(500);
    expect(gate.info().used).toBe(500);
    gate.setUsed(20);
    expect(gate.info().used).toBe(20);
    gate.subUsed(5);
    expect(gate.info().used).toBe(15);
  });
});
