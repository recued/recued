/** The durable outbox's five rules, driven through a SECOND family.
 *
 *  ⛔ WHY A FAKE FAMILY AND NOT THE MAILBOX. `mcp-recipe-callback.test.ts` already
 *  proves the loop against its first adopter — unchanged, which is what made the
 *  port provable. What that suite CANNOT show is whether the loop is general or
 *  merely renamed: every accessor it exercises is the mailbox's own. This file
 *  drives a family with different field names, a different terminal shape and a
 *  different payload, so a rule that quietly depends on the mailbox's vocabulary
 *  fails here rather than on the day the second real family (an MCP
 *  `subscriptions/listen` projection, or a peer answer) is written against it.
 *
 *  The store is the REAL SQLite shared store, because the loop's contract is
 *  with CAS: revision fences, losing writes and the ABA guard are the behaviour
 *  under test, and an in-memory map would model exactly the part that matters
 *  and get it wrong. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlobStore } from '../storage/blob-store.js';
import { createSharedStore, type SharedRecord, type SharedStore } from '../storage/shared-store.js';
import { createOutboxDelivery, type OutboxFamily } from '../durable-outbox.js';

const AUTHOR = 'kernel:test-outbox';
const PREFIX = 'test.outbox';

/** A family that shares NO field name with the recipe-callback mailbox. */
interface Memo {
  kind: 'memo';
  revision: number;
  seq: string;
  addressee: string;
  body: string;
  good_until: number;
  sent_seq?: string;
}

const memoFamily: OutboxFamily<Memo, { seq: string; body: string }> = {
  author_id: AUTHOR,
  prefix: (principal) => `${PREFIX}.${principal}`,
  parse: (record) => {
    const value = record.value as Partial<Memo> | null;
    if (
      record.author_id !== AUTHOR
      || record.cas_revision === null
      || value === null
      || typeof value !== 'object'
      || value.kind !== 'memo'
      || typeof value.seq !== 'string'
      || typeof value.addressee !== 'string'
      || typeof value.good_until !== 'number'
    ) return null;
    return value as Memo;
  },
  isRetired: (record) => {
    const value = record.value as { kind?: unknown } | null;
    return value !== null && typeof value === 'object' && value.kind === 'gone';
  },
  principalOf: (memo) => memo.addressee,
  dedupeRefOf: (memo) => memo.seq,
  deliveredRefOf: (memo) => memo.sent_seq,
  expiresAtOf: (memo) => memo.good_until,
  retiredValue: (revision, retired_at) => ({ kind: 'gone', revision, retired_at }),
  deliveredValue: (memo, revision, delivered_at) => ({
    ...memo, revision, sent_seq: memo.seq, delivered_at,
  }),
  project: (memo) => ({ seq: memo.seq, body: memo.body }),
};

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mkStore = (): SharedStore => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'realm.db'));
  dbs.push(db);
  return createSharedStore({ db, blobs: createBlobStore(join(dir, 'blobs')), now: () => 1_000 });
};

/** The shared store's CAS contract requires the stored value's own `revision`
 *  to equal the revision being written — which is why every family in this
 *  system carries one. The helper stamps it so the tests below are about the
 *  loop rather than about remembering that rule. */
const put = async (store: SharedStore, key: string, value: object): Promise<void> => {
  const existing = await store.read(key);
  const revision = (existing?.cas_revision ?? -1) + 1;
  await store.compareAndSet(
    key,
    existing?.cas_revision ?? null,
    { ...value, revision },
    { author_id: AUTHOR },
  );
};

const memo = (over: Partial<Memo> = {}): Memo => ({
  kind: 'memo', revision: 1, seq: 'a1', addressee: 'worker-7',
  body: 'a job is waiting', good_until: 9_000, ...over,
});

const drive = (store: SharedStore, opts: {
  authorize?: (memo: Memo) => boolean;
  send?: (payload: { seq: string; body: string }) => Promise<void> | void;
  now?: number;
} = {}) => {
  const sent: { seq: string; body: string }[] = [];
  const delivery = createOutboxDelivery(memoFamily, {
    store,
    principal: 'worker-7',
    authorize: opts.authorize ?? (() => true),
    send: opts.send ?? ((payload) => { sent.push(payload); }),
    now: () => opts.now ?? 1_000,
  });
  return { delivery, sent };
};

describe('the durable outbox, driven by a family that is not the mailbox', () => {
  it('delivers once, then never re-sends the same ref', async () => {
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo());
    const { delivery, sent } = drive(store);
    delivery.setReady();
    await delivery.poll();
    await delivery.poll();
    expect(sent).toEqual([{ seq: 'a1', body: 'a job is waiting' }]);
    // The durable marker, in the FAMILY's own field — the loop never imposed a name.
    const row = await store.read(`${PREFIX}.worker-7.r1`);
    expect((row?.value as Memo).sent_seq).toBe('a1');
  });

  it('⛔ SKIPS an unauthorised row and delivers it the moment authority returns', async () => {
    // Rule 1's teeth: a refusal must not retire. Authority is a live fact, and a
    // grant restored a minute later must find the message still there.
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo());
    let allowed = false;
    const { delivery, sent } = drive(store, { authorize: () => allowed });
    delivery.setReady();
    await delivery.poll();
    expect(sent).toEqual([]);
    const held = await store.read(`${PREFIX}.worker-7.r1`);
    expect((held?.value as { kind: string }).kind).toBe('memo');

    allowed = true;
    await delivery.poll();
    expect(sent).toHaveLength(1);
  });

  it('does not send before the transport is ready, and readiness is not authority', async () => {
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo());
    const { delivery, sent } = drive(store);
    await delivery.poll();
    expect(sent).toEqual([]);
    delivery.setReady();
    await delivery.poll();
    expect(sent).toHaveLength(1);
  });

  it('retries the SAME ref when the transport write rejects, leaving both markers untouched', async () => {
    // Rule 2. A send that throws must leave the row exactly as it was — the
    // at-least-once edge the receiver's dedupe token exists to absorb.
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo());
    let attempts = 0;
    const { delivery } = drive(store, {
      send: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('socket gone'));
        return Promise.resolve();
      },
    });
    delivery.setReady();
    await expect(delivery.poll()).rejects.toThrow('socket gone');
    const afterFailure = await store.read(`${PREFIX}.worker-7.r1`);
    expect((afterFailure?.value as Memo).sent_seq).toBeUndefined();

    await delivery.poll();
    expect(attempts).toBe(2);
    const afterRetry = await store.read(`${PREFIX}.worker-7.r1`);
    expect((afterRetry?.value as Memo).sent_seq).toBe('a1');
  });

  it('retires a row addressed to somebody else rather than delivering it', async () => {
    // Rule 4. A foreign row inside this principal's namespace is injected or
    // replayed, never merely stale — so it loses its content and keeps its fence.
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo({ addressee: 'worker-9' }));
    const { delivery, sent } = drive(store);
    delivery.setReady();
    await delivery.poll();
    expect(sent).toEqual([]);
    const row = await store.read(`${PREFIX}.worker-7.r1`);
    expect(row?.value).toMatchObject({ kind: 'gone' });
    expect((row?.value as { body?: string }).body).toBeUndefined();
  });

  it('retires an expired row, and leaves an already-retired one alone', async () => {
    const store = mkStore();
    await put(store, `${PREFIX}.worker-7.r1`, memo({ good_until: 500 }));
    const { delivery, sent } = drive(store, { now: 1_000 });
    delivery.setReady();
    await delivery.poll();
    expect(sent).toEqual([]);
    const retired = await store.read(`${PREFIX}.worker-7.r1`);
    expect(retired?.value).toMatchObject({ kind: 'gone' });

    // A second pass must not burn another revision rewriting the tombstone.
    const revision = retired?.cas_revision;
    await delivery.poll();
    expect((await store.read(`${PREFIX}.worker-7.r1`))?.cas_revision).toBe(revision);
  });

  it('lets a concurrent enqueue WIN over the delivery marker', async () => {
    // Rule 3. The marker must never overwrite a fresher message; the losing CAS
    // is swallowed and the next poll picks up the new ref.
    const store = mkStore();
    const key = `${PREFIX}.worker-7.r1`;
    await put(store, key, memo());
    const seen: string[] = [];
    let raced = false;
    const { delivery } = drive(store, {
      send: async (payload) => {
        seen.push(payload.seq);
        if (raced) return;
        raced = true;
        // A recipe enqueues a fresher event while the transport is writing.
        await put(store, key, memo({ seq: 'a2', body: 'a newer job' }));
      },
    });
    delivery.setReady();
    await delivery.poll();
    const row = await store.read(key);
    // The enqueue survived; no delivery marker was stamped over it.
    expect(seen).toEqual(['a1']);
    expect((row?.value as Memo).seq).toBe('a2');
    expect((row?.value as Memo).sent_seq).toBeUndefined();

    // ⇒ and the fresher message is delivered on the next pass rather than lost.
    await delivery.poll();
    expect(seen).toEqual(['a1', 'a2']);
    expect(((await store.read(key))?.value as Memo).sent_seq).toBe('a2');
  });

  it('ignores a row written by another author in the same namespace', async () => {
    const store = mkStore();
    const key = `${PREFIX}.worker-7.r1`;
    await store.compareAndSet(key, null, { ...memo(), revision: 0 }, { author_id: 'someone-else' });
    const { delivery, sent } = drive(store);
    delivery.setReady();
    await delivery.poll();
    expect(sent).toEqual([]);
    // Not ours to deliver AND not ours to retire — untouched.
    const row = await store.read(key);
    expect((row?.value as { kind: string }).kind).toBe('memo');
    expect(row?.author_id).toBe('someone-else');
  });
});
