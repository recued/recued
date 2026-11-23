import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repositoryFixture } from './d-261-fixtures.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'preapproval-outbox-claims-'));
  const file = join(directory, 'realm.sqlite');
  const clock = { now: 1000, locked: false };
  const connections: Database.Database[] = [];
  const connect = () => {
    const db = new Database(file);
    connections.push(db);
    db.pragma('journal_mode=WAL');
    return { db, repository: repositoryFixture(db, clock).repository };
  };
  const first = connect();
  disposers.push(() => {
    for (const db of connections) if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...first, clock, connect };
};
const rows = (db: Database.Database) => db.prepare('SELECT * FROM preapproval_outbox ORDER BY event_id').all();

it('claims only due events in event order across references and preserves expiry and acknowledgment ownership', () => {
  const f = fixture();
  const insert = f.db.prepare(`INSERT INTO preapproval_outbox(event_id,future_ref,kind,payload_json,state,worker_id,lease_until)
    VALUES(?,?,'execution_finished',?, ?,?,?)`);
  for (const [id, ref, state, worker, lease] of [
    ['00-done', 'future-z-done', 'done', 'previous', 0],
    ['05-unknown', 'future-unknown', 'blocked', null, 0],
    ['10-pending', 'future-z', 'pending', null, 0],
    ['20-expired', 'future-y', 'leased', 'previous', 999],
    ['30-boundary', 'future-m', 'leased', 'previous', 1000],
    ['40-unexpired', 'future-b', 'leased', 'previous', 1001],
    ['50-pending', 'future-a', 'pending', null, 0],
  ] as const) insert.run(id, ref, JSON.stringify({ label: id }), state, worker, lease);
  const before = rows(f.db) as Array<Record<string, unknown>>;
  const first = f.repository.takeOutbox('worker-a', 2);
  expect(first).toEqual(before.filter(row => ['10-pending', '20-expired'].includes(row.event_id as string))
    .map(row => ({ ...row, state: 'leased', worker_id: 'worker-a', lease_until: 61000 })));
  const second = f.repository.takeOutbox('worker-b', 2);
  expect(second.map(row => row.event_id)).toEqual(['30-boundary', '50-pending']);
  expect(f.repository.finishOutbox('30-boundary', 'worker-a')).toBe(false);
  for (const id of ['00-done', '05-unknown', '40-unexpired']) {
    expect(f.db.prepare('SELECT * FROM preapproval_outbox WHERE event_id=?').get(id))
      .toEqual(before.find(row => row.event_id === id));
  }

  f.clock.now = 61000;
  const reclaimed = f.repository.takeOutbox('worker-c', 2);
  expect(reclaimed.map(row => row.event_id)).toEqual(['10-pending', '20-expired']);
  expect(reclaimed.every(row => row.worker_id === 'worker-c' && row.lease_until === 121000)).toBe(true);
  expect(f.repository.finishOutbox('10-pending', 'worker-a')).toBe(false);
  expect(f.repository.finishOutbox('10-pending', 'worker-c')).toBe(true);
  expect(f.repository.finishOutbox('10-pending', 'worker-c')).toBe(false);
  // Expiry makes an event reclaimable; it does not itself change its owner.
  expect(f.repository.finishOutbox('30-boundary', 'worker-b')).toBe(true);
  expect(f.repository.takeOutbox('worker-d', 100).map(row => row.event_id)).toEqual(['40-unexpired', '50-pending']);
});

it('rolls back a failed batch completely and persists disjoint claims across connections and reopen', () => {
  const f = fixture();
  for (const id of ['10-first', '20-second', '30-third']) f.db.prepare(`INSERT INTO preapproval_outbox
    (event_id,future_ref,kind,payload_json) VALUES(?,?,'execution_finished','{}')`).run(id, 'future-' + id);
  const peer = f.connect();
  const before = rows(peer.db);
  f.db.exec(`CREATE TRIGGER fail_outbox_claim BEFORE UPDATE OF state ON preapproval_outbox
    WHEN NEW.state='leased' AND OLD.event_id='20-second'
    BEGIN SELECT RAISE(ABORT,'outbox claim fault'); END`);
  expect(() => f.repository.takeOutbox('worker-a', 2)).toThrow('outbox claim fault');
  expect(rows(peer.db)).toEqual(before);
  f.db.exec('DROP TRIGGER fail_outbox_claim');

  expect(f.repository.takeOutbox('worker-a', 2).map(row => row.event_id)).toEqual(['10-first', '20-second']);
  expect(peer.repository.takeOutbox('worker-b', 2).map(row => row.event_id)).toEqual(['30-third']);
  f.db.close();
  const reopened = f.connect();
  expect(reopened.repository.takeOutbox('worker-c', 100)).toEqual([]);
  expect(reopened.repository.finishOutbox('10-first', 'worker-b')).toBe(false);
  expect(reopened.repository.finishOutbox('10-first', 'worker-a')).toBe(true);
  expect(rows(peer.db)).toMatchObject([
    { event_id: '10-first', state: 'done', worker_id: 'worker-a' },
    { event_id: '20-second', state: 'leased', worker_id: 'worker-a', lease_until: 61000 },
    { event_id: '30-third', state: 'leased', worker_id: 'worker-b', lease_until: 61000 },
  ]);
});
