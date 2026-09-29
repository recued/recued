import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBlobStore } from '../storage/blob-store.js';
import {
  createSharedStore,
  SharedCompareAndSetConflictError,
  SharedCompareAndSetRequiredError,
  SharedCompareAndSetValidationError,
  SharedCompareAndSetValueTooLargeError,
  SharedKeyInvalidError,
  SharedPatchInvalidError,
  SharedPatchValueTooLargeError,
  SubkeyWriteError,
  ValueTooLargeError,
  COMPARE_AND_SET_MAX_VALUE_BYTES,
  INLINE_CUTOFF_BYTES,
} from '../storage/shared-store.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shared-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const mkStore = () => {
  const blobs = createBlobStore(join(dir, 'blobs'));
  return { blobs, store: createSharedStore({ db, blobs }) };
};

describe('createSharedStore', () => {
  it('migrates an existing shared_store table with the store-owned revision token', async () => {
    db.exec(`
      CREATE TABLE shared_store (
        key TEXT PRIMARY KEY,
        value_inline TEXT,
        blob_hash TEXT,
        size_bytes INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        recipe_id TEXT,
        written_at INTEGER NOT NULL,
        last_read_at INTEGER
      )
    `);

    const { store } = mkStore();
    const columns = db.prepare('PRAGMA table_info(shared_store)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('cas_revision');
    await expect(store.compareAndSet(
      'state.after-migration',
      null,
      { revision: 0 },
      { author_id: 'a' },
    )).resolves.toMatchObject({ created: true, revision: 0 });
  });

  it('write + read round-trips an inline value', async () => {
    const { store } = mkStore();
    await store.write('deal.123', { stage: 'closed_won', amount: 5000 }, { author_id: 'ing' });
    const rec = await store.read('deal.123');
    expect(rec?.value).toEqual({ stage: 'closed_won', amount: 5000 });
    expect(rec?.size_bytes).toBeGreaterThan(0);
  });

  it('update replaces an existing record', async () => {
    const { store } = mkStore();
    await store.write('deal.1', { stage: 'open' }, { author_id: 'a' });
    await store.write('deal.1', { stage: 'won' }, { author_id: 'a' });
    expect((await store.read('deal.1'))?.value).toEqual({ stage: 'won' });
  });

  it('compareAndSet creates at revision 0 and advances exactly one revision', async () => {
    const { store } = mkStore();

    await expect(store.compareAndSet(
      'recipe.bundle.state.submission-1',
      null,
      { revision: 0, phase: 'awaiting_payment' },
      { author_id: 'coordinator' },
    )).resolves.toMatchObject({ revision: 0, created: true });

    await expect(store.compareAndSet(
      'recipe.bundle.state.submission-1',
      0,
      { revision: 1, phase: 'paid' },
      { author_id: 'observer' },
    )).resolves.toMatchObject({ revision: 1, created: false });

    await expect(store.read('recipe.bundle.state.submission-1')).resolves.toMatchObject({
      value: { revision: 1, phase: 'paid' },
      author_id: 'observer',
    });
  });

  it('compareAndSet create-if-absent conflicts without replacing the winner', async () => {
    const { store } = mkStore();
    await store.compareAndSet('state.1', null, { revision: 0, runner: 'first' }, { author_id: 'a' });

    await expect(
      store.compareAndSet('state.1', null, { revision: 0, runner: 'second' }, { author_id: 'b' }),
    ).rejects.toMatchObject({
      name: 'SharedCompareAndSetConflictError',
      expectedRevision: null,
      actualRevision: 0,
      found: true,
    });
    await expect(store.read('state.1')).resolves.toMatchObject({
      value: { revision: 0, runner: 'first' },
    });
  });

  it('only one duplicate start can create revision 0 across SQLite connections', async () => {
    const { store } = mkStore();
    const db2 = new Database(join(dir, 'test.db'));
    const store2 = createSharedStore({ db: db2, blobs: createBlobStore(join(dir, 'blobs')) });
    try {
      const results = await Promise.allSettled([
        store.compareAndSet('state.start-race', null, { revision: 0, runner: 'manual' }, { author_id: 'a' }),
        store2.compareAndSet('state.start-race', null, { revision: 0, runner: 'trigger' }, { author_id: 'b' }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            name: 'SharedCompareAndSetConflictError',
            expectedRevision: null,
            actualRevision: 0,
          }),
        }),
      ]);
      expect((await store.read('state.start-race'))?.value).toMatchObject({ revision: 0 });
    } finally {
      db2.close();
    }
  });

  it('only one observer can advance a revision across two SQLite connections', async () => {
    const { store } = mkStore();
    await store.compareAndSet('state.race', null, { revision: 0, runner: 'origin' }, { author_id: 'a' });

    const db2 = new Database(join(dir, 'test.db'));
    const store2 = createSharedStore({ db: db2, blobs: createBlobStore(join(dir, 'blobs')) });
    try {
      const results = await Promise.allSettled([
        store.compareAndSet('state.race', 0, { revision: 1, runner: 'observer-a' }, { author_id: 'a' }),
        store2.compareAndSet('state.race', 0, { revision: 1, runner: 'observer-b' }, { author_id: 'b' }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: expect.any(SharedCompareAndSetConflictError),
      });
      expect((await store.read('state.race'))?.value).toMatchObject({ revision: 1 });
    } finally {
      db2.close();
    }
  });

  it('rejects skipped revisions and malformed revision carriers before writing', async () => {
    const { store } = mkStore();

    await expect(
      store.compareAndSet('state.bad', null, { revision: 1 }, { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetValidationError);
    await expect(
      store.compareAndSet('state.bad', -1, { revision: 0 }, { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetValidationError);
    await expect(
      store.compareAndSet('state.bad', null, ['revision', 0], { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetValidationError);
    expect(await store.read('state.bad')).toBeNull();
  });

  it('rejects a custom serializer that changes the validated revision', async () => {
    const { store } = mkStore();
    const value = {
      revision: 0,
      toJSON: () => ({ revision: 99, phase: 'forged' }),
    };

    await expect(
      store.compareAndSet('state.to-json', null, value, { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetValidationError);
    expect(await store.read('state.to-json')).toBeNull();
  });

  it('rejects over-inline CAS values without creating an orphan blob', async () => {
    const { blobs, store } = mkStore();
    const value = {
      revision: 0,
      payload: 'x'.repeat(COMPARE_AND_SET_MAX_VALUE_BYTES),
    };

    await expect(
      store.compareAndSet('state.too-large', null, value, { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetValueTooLargeError);
    expect(await store.read('state.too-large')).toBeNull();
    expect(await blobs.totalBytes()).toBe(0);
  });

  it('ordinary writes cannot bypass a compare-and-set controlled row', async () => {
    const { blobs, store } = mkStore();
    await store.compareAndSet('state.protected', null, { revision: 0, phase: 'open' }, { author_id: 'a' });

    await expect(
      store.write('state.protected', { revision: 99, phase: 'closed' }, { author_id: 'b' }),
    ).rejects.toBeInstanceOf(SharedCompareAndSetRequiredError);
    await expect(store.read('state.protected')).resolves.toMatchObject({
      value: { revision: 0, phase: 'open' },
    });

    await expect(
      store.write(
        'state.protected',
        { payload: 'x'.repeat(INLINE_CUTOFF_BYTES + 1) },
        { author_id: 'b' },
      ),
    ).rejects.toBeInstanceOf(SharedCompareAndSetRequiredError);
    expect(await blobs.totalBytes()).toBe(0);
  });

  it('ordinary delete cannot remove a compare-and-set controlled row', async () => {
    const { store } = mkStore();
    await store.compareAndSet(
      'state.protected-delete',
      null,
      { revision: 0, phase: 'open' },
      { author_id: 'a' },
    );

    await expect(store.delete('state.protected-delete')).rejects.toMatchObject({
      name: 'SharedCompareAndSetRequiredError',
      operation: 'delete',
    });
    await expect(store.read('state.protected-delete')).resolves.toMatchObject({
      value: { revision: 0, phase: 'open' },
    });

    // The schema trigger is the final guard for any future direct SQL delete
    // path that forgets the typed store preflight.
    expect(() => db.prepare('DELETE FROM shared_store WHERE key = ?').run('state.protected-delete'))
      .toThrow(/shared_compare_and_set_required/);
  });

  it('prefix delete is all-or-nothing when one matching row is revision-controlled', async () => {
    const { store } = mkStore();
    await store.write('workflow.legacy', { value: 'keep-me-too' }, { author_id: 'legacy' });
    await store.compareAndSet(
      'workflow.state',
      null,
      { revision: 0, phase: 'open' },
      { author_id: 'coordinator' },
    );

    await expect(store.deleteByPrefix('workflow')).rejects.toMatchObject({
      name: 'SharedCompareAndSetRequiredError',
      key: 'workflow.state',
      operation: 'delete-prefix',
    });
    await expect(store.read('workflow.legacy')).resolves.toMatchObject({
      value: { value: 'keep-me-too' },
    });
    await expect(store.read('workflow.state')).resolves.toMatchObject({
      value: { revision: 0, phase: 'open' },
    });
  });

  it('does not adopt a legacy last-writer-wins row into CAS by guessing its value revision', async () => {
    const { store } = mkStore();
    await store.write('state.legacy', { revision: 0 }, { author_id: 'legacy' });

    await expect(
      store.compareAndSet('state.legacy', 0, { revision: 1 }, { author_id: 'coordinator' }),
    ).rejects.toMatchObject({
      name: 'SharedCompareAndSetConflictError',
      actualRevision: null,
      found: true,
    });
  });

  it('values over the inline cutoff route through CAS', async () => {
    const { blobs, store } = mkStore();
    const big = 'x'.repeat(INLINE_CUTOFF_BYTES + 1);
    await store.write('blob.big', big, { author_id: 'a' });
    const rec = await store.read('blob.big');
    expect(rec?.value).toBe(big);
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
  });

  it('rejects subkey writes when the parent key exists', async () => {
    const { store } = mkStore();
    await store.write('deal.123', { stage: 'open' }, { author_id: 'a' });
    await expect(
      store.write('deal.123.stage', 'closed_won', { author_id: 'a' }),
    ).rejects.toBeInstanceOf(SubkeyWriteError);
  });

  it('list returns matching records under a prefix', async () => {
    const { store } = mkStore();
    await store.write('deal.1', 'one', { author_id: 'a' });
    await store.write('deal.2', 'two', { author_id: 'a' });
    await store.write('contact.1', 'hi', { author_id: 'a' });
    const deals = await store.list('deal');
    expect(deals.map((r) => r.key).sort()).toEqual(['deal.1', 'deal.2']);
  });

  it('list accepts a trailing namespace delimiter', async () => {
    const { store } = mkStore();
    await store.write('recipe.bundle.active.1', 'one', { author_id: 'a' });
    await store.write('recipe.bundle.closed.2', 'two', { author_id: 'a' });
    await store.write('recipe.bundle.active', 'parent', { author_id: 'a' });

    const active = await store.list('recipe.bundle.active.');

    expect(active.map((r) => r.key)).toEqual(['recipe.bundle.active.1']);
  });

  it('search performs FTS across inline JSON blobs', async () => {
    const { store } = mkStore();
    await store.write('deal.1', { title: 'Acme Q3 expansion', amount: 100 }, { author_id: 'a' });
    await store.write('deal.2', { title: 'Brand-new Q4 deal', amount: 200 }, { author_id: 'a' });
    const results = await store.search('deal.*', 'Acme');
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('deal.1');
  });

  it('delete removes the row and leaves CAS reclamation to the orphan sweep', async () => {
    const { blobs, store } = mkStore();
    const big = 'y'.repeat(INLINE_CUTOFF_BYTES + 1);
    await store.write('big', big, { author_id: 'a' });
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
    await store.delete('big');
    expect(await store.read('big')).toBeNull();
    // Row deletion cannot know whether another store sharing this
    // content-addressed root still references the hash. Physical cleanup is a
    // reference-aware sweep concern, not an exact-delete side effect.
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
    expect(await blobs.sweepOrphans(new Set())).toBe(1);
    expect(await blobs.totalBytes()).toBe(0);
  });

  it('delete preserves a deduplicated CAS blob referenced by a sibling row', async () => {
    const { blobs, store } = mkStore();
    const big = 'd'.repeat(INLINE_CUTOFF_BYTES + 1);
    await store.write('duplicate.one', big, { author_id: 'a' });
    await store.write('duplicate.two', big, { author_id: 'b' });
    expect(await blobs.totalBytes()).toBeGreaterThan(0);

    await expect(store.delete('duplicate.one')).resolves.toBe(true);

    await expect(store.read('duplicate.two')).resolves.toMatchObject({ value: big });
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
  });

  it('deleteByPrefix removes every matching row', async () => {
    const { store } = mkStore();
    await store.write('deal.1', 'a', { author_id: 'x' });
    await store.write('deal.2', 'b', { author_id: 'x' });
    await store.write('contact.1', 'c', { author_id: 'x' });
    const deleted = await store.deleteByPrefix('deal');
    expect(deleted).toBe(2);
    expect(await store.read('deal.1')).toBeNull();
    expect(await store.read('contact.1')).not.toBeNull();
  });

  it('deleteByPrefix preserves CAS bytes referenced outside the prefix', async () => {
    const { blobs, store } = mkStore();
    const big = 'p'.repeat(INLINE_CUTOFF_BYTES + 1);
    await store.write('doomed.one', big, { author_id: 'a' });
    await store.write('survivor.one', big, { author_id: 'b' });

    await expect(store.deleteByPrefix('doomed')).resolves.toBe(1);

    await expect(store.read('survivor.one')).resolves.toMatchObject({ value: big });
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
  });

  it('deleteByPrefix accepts a trailing namespace delimiter', async () => {
    const { store } = mkStore();
    await store.write('recipe.bundle.closed.1', 'one', { author_id: 'x' });
    await store.write('recipe.bundle.active.2', 'two', { author_id: 'x' });
    await store.write('recipe.bundle.closed', 'parent', { author_id: 'x' });

    const deleted = await store.deleteByPrefix('recipe.bundle.closed.');

    expect(deleted).toBe(1);
    expect(await store.read('recipe.bundle.closed.1')).toBeNull();
    expect(await store.read('recipe.bundle.closed')).not.toBeNull();
    expect(await store.read('recipe.bundle.active.2')).not.toBeNull();
  });

  it('deleteByPrefix escapes `_` so it cannot delete wildcard-sibling keys', async () => {
    const { store } = mkStore();
    await store.write('a_c.1', 'target', { author_id: 'x' });
    await store.write('axc.1', 'sibling', { author_id: 'x' }); // `_`-as-wildcard match
    const deleted = await store.deleteByPrefix('a_c');
    expect(deleted).toBe(1);
    expect(await store.read('a_c.1')).toBeNull();
    expect(await store.read('axc.1')).not.toBeNull(); // must survive
  });

  it('list escapes `_` so it does not leak wildcard-sibling keys', async () => {
    const { store } = mkStore();
    await store.write('a_c.1', 'target', { author_id: 'x' });
    await store.write('axc.1', 'sibling', { author_id: 'x' });
    const rows = await store.list('a_c');
    expect(rows.map((r) => r.key)).toEqual(['a_c.1']);
  });

  it('search tolerates a punctuation (email) query instead of 500-ing', async () => {
    const { store } = mkStore();
    await store.write('c.1', { owner: 'pat.lee@example.com' }, { author_id: 'x' });
    const results = await store.search('c.*', 'pat.lee@example.com');
    expect(results.map((r) => r.key)).toEqual(['c.1']);
  });

  it('search skips a ghost FTS row that has no surviving main-table row', async () => {
    const { store } = mkStore();
    await store.write('real.1', { title: 'phantom present' }, { author_id: 'x' });
    // Simulate an FTS/main desync: an index row with no main-table backing.
    db.prepare(`INSERT INTO shared_store_fts (key, blob_text) VALUES (?, ?)`)
      .run('ghost.1', 'phantom missing');
    const results = await store.search('*', 'phantom');
    // Only the real row hydrates; the ghost is skipped, never a null-valued match.
    expect(results.map((r) => r.key)).toEqual(['real.1']);
  });

  it('rejects invalid keys', async () => {
    const { store } = mkStore();
    await expect(store.write('', null, { author_id: 'a' })).rejects.toBeInstanceOf(SharedKeyInvalidError);
    await expect(store.write('.leading', null, { author_id: 'a' })).rejects.toBeInstanceOf(SharedKeyInvalidError);
    await expect(store.write('bad space', null, { author_id: 'a' })).rejects.toBeInstanceOf(SharedKeyInvalidError);
    const long = 'a'.repeat(600);
    await expect(store.write(long, null, { author_id: 'a' })).rejects.toBeInstanceOf(SharedKeyInvalidError);
  });

  it('rejects values over the 10 MB cap', async () => {
    const { store } = mkStore();
    const too_big = 'z'.repeat(11 * 1024 * 1024);
    await expect(store.write('big', too_big, { author_id: 'a' })).rejects.toBeInstanceOf(ValueTooLargeError);
  });

  it('totalBytes accumulates across records', async () => {
    const { store } = mkStore();
    await store.write('a', 'one', { author_id: 'x' });
    await store.write('b', 'two', { author_id: 'x' });
    expect(store.totalBytes()).toBeGreaterThan(0);
  });
});

describe('patch — change some fields of one record, leave the rest', () => {
  const ROW = 'follow-up.active.thread-1';
  const seed = { status: 'watching_customer_response', order_id: 'ord-1', task_id: 'task-1' };

  it('changes the fields it names and leaves every other field as it was', async () => {
    const { store } = mkStore();
    await store.write(ROW, seed, { author_id: 'seed' });
    const out = await store.patch(ROW, { set: { status: 'response_needs_owner', reply_id: 'r-1' }, unset: ['task_id'] }, { author_id: 'w' });
    expect(out).toMatchObject({ found: true, applied: true });
    expect((await store.read(ROW))?.value).toEqual({ status: 'response_needs_owner', order_id: 'ord-1', reply_id: 'r-1' });
  });

  it('⛔ two writers of different fields both keep their change — where read-then-write keeps one', async () => {
    const { store } = mkStore();
    // The control: each writer read the row, then wrote back its whole copy.
    await store.write(ROW, seed, { author_id: 'seed' });
    const readByA = (await store.read(ROW))!.value as Record<string, unknown>;
    const readByB = (await store.read(ROW))!.value as Record<string, unknown>;
    await store.write(ROW, { ...readByA, status: 'response_needs_owner' }, { author_id: 'a' });
    await store.write(ROW, { ...readByB, task_id: 'task-2' }, { author_id: 'b' });
    expect((await store.read(ROW))?.value).toMatchObject({ status: 'watching_customer_response', task_id: 'task-2' });

    // The same two changes as patches.
    await store.write(ROW, seed, { author_id: 'seed' });
    await store.patch(ROW, { set: { status: 'response_needs_owner' } }, { author_id: 'a' });
    await store.patch(ROW, { set: { task_id: 'task-2' } }, { author_id: 'b' });
    expect((await store.read(ROW))?.value).toEqual({ ...seed, status: 'response_needs_owner', task_id: 'task-2' });
  });

  it('two patches racing across SQLite connections both land', async () => {
    const { store } = mkStore();
    await store.write(ROW, seed, { author_id: 'seed' });
    const db2 = new Database(join(dir, 'test.db'));
    const store2 = createSharedStore({ db: db2, blobs: createBlobStore(join(dir, 'blobs')) });
    try {
      await Promise.all([
        store.patch(ROW, { set: { status: 'response_needs_owner' } }, { author_id: 'a' }),
        store2.patch(ROW, { set: { task_id: 'task-2' } }, { author_id: 'b' }),
      ]);
      expect((await store.read(ROW))?.value).toEqual({ ...seed, status: 'response_needs_owner', task_id: 'task-2' });
    } finally {
      db2.close();
    }
  });

  it('an absent record is an answer, not a write', async () => {
    const { store } = mkStore();
    expect(await store.patch(ROW, { set: { status: 'x' } }, { author_id: 'a' })).toEqual({ found: false, applied: false, bytes: 0 });
    expect(await store.read(ROW)).toBeNull();
  });

  it('match applies while its fields hold, and answers applied:false once the record moved on', async () => {
    const { store } = mkStore();
    await store.write(ROW, { ...seed, reply_id: 'r-1' }, { author_id: 'seed' });
    expect(await store.patch(ROW, { set: { task_id: 'task-9' }, match: { reply_id: 'r-2' } }, { author_id: 'a' }))
      .toMatchObject({ found: true, applied: false });
    expect((await store.read(ROW))?.value).toMatchObject({ task_id: 'task-1' });
    expect(await store.patch(ROW, { set: { task_id: 'task-9' }, match: { reply_id: 'r-1' } }, { author_id: 'a' }))
      .toMatchObject({ found: true, applied: true });
    expect((await store.read(ROW))?.value).toMatchObject({ task_id: 'task-9' });
    // null (or undefined) matches a field that is absent or null.
    expect(await store.patch(ROW, { set: { order_id: 'ord-2' }, match: { never_set: null } }, { author_id: 'a' }))
      .toMatchObject({ applied: true });
    expect(await store.patch(ROW, { set: { order_id: 'ord-3' }, match: { never_set: undefined } }, { author_id: 'a' }))
      .toMatchObject({ applied: true });
    expect(await store.patch(ROW, { set: { order_id: 'ord-4' }, match: { reply_id: null } }, { author_id: 'a' }))
      .toMatchObject({ applied: false });
    expect((await store.read(ROW))?.value).toMatchObject({ order_id: 'ord-3' });
  });

  it('refuses what it cannot patch, and changes nothing', async () => {
    const { store } = mkStore();
    await store.compareAndSet('state.cas', null, { revision: 0 }, { author_id: 'a' });
    await expect(store.patch('state.cas', { set: { x: 1 } }, { author_id: 'a' }))
      .rejects.toBeInstanceOf(SharedCompareAndSetRequiredError);
    await store.write('state.list', ['not', 'fields'], { author_id: 'a' });
    await expect(store.patch('state.list', { set: { x: 1 } }, { author_id: 'a' }))
      .rejects.toBeInstanceOf(SharedPatchInvalidError);
    await store.write('state.blob', { text: 'x'.repeat(INLINE_CUTOFF_BYTES + 1) }, { author_id: 'a' });
    await expect(store.patch('state.blob', { set: { x: 1 } }, { author_id: 'a' }))
      .rejects.toBeInstanceOf(SharedPatchValueTooLargeError);
    await store.write(ROW, seed, { author_id: 'seed' });
    await expect(store.patch(ROW, { set: { text: 'x'.repeat(INLINE_CUTOFF_BYTES) } }, { author_id: 'a' }))
      .rejects.toBeInstanceOf(SharedPatchValueTooLargeError);
    expect((await store.read(ROW))?.value).toEqual(seed);
  });

  it('refuses a patch that is not one', async () => {
    const { store } = mkStore();
    await store.write(ROW, seed, { author_id: 'seed' });
    const bad = async (patch: Record<string, unknown>) =>
      expect(store.patch(ROW, patch as never, { author_id: 'a' })).rejects.toBeInstanceOf(SharedPatchInvalidError);
    await bad({});
    await bad({ set: {}, unset: [] });
    await bad({ set: { status: 'x' }, unset: ['status'] });
    await bad({ set: ['status'] });
    await bad({ unset: 'status' });
    await bad({ set: { status: 'x' }, match: ['status'] });
    await bad({ unset: [''] });
    await bad({ set: JSON.parse('{"__proto__": {"polluted": true}}') });
    await bad({ unset: ['constructor'] });
    expect((await store.read(ROW))?.value).toEqual(seed);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps search and the byte total in step, and a patch that changes nothing writes nothing', async () => {
    const blobs = createBlobStore(join(dir, 'blobs'));
    let reported = 0;
    const store = createSharedStore({ db, blobs, onBytesChanged: (delta) => { reported += delta; } });
    await store.write(ROW, seed, { author_id: 'seed' });
    await store.patch(ROW, { set: { note: 'escalated to finance' } }, { author_id: 'a' });
    expect((await store.search('follow-up.*', 'finance')).map((hit) => hit.key)).toEqual([ROW]);
    expect(reported).toBe(store.totalBytes());
    const before = (await store.read(ROW))!.written_at;
    expect(await store.patch(ROW, { set: { note: 'escalated to finance' } }, { author_id: 'a' }))
      .toMatchObject({ applied: true });
    expect((await store.read(ROW))!.written_at).toBe(before);
  });
});
