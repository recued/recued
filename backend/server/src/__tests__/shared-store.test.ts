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

  it('delete removes the row and its CAS backing', async () => {
    const { blobs, store } = mkStore();
    const big = 'y'.repeat(INLINE_CUTOFF_BYTES + 1);
    await store.write('big', big, { author_id: 'a' });
    expect(await blobs.totalBytes()).toBeGreaterThan(0);
    await store.delete('big');
    expect(await store.read('big')).toBeNull();
    expect(await blobs.totalBytes()).toBe(0);
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
