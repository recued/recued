/* D-198 — `memory.search` becomes RECALL.
 *
 * Before: the tool did NOT search. It took `recipe_id` + `limit` and returned
 * the N most RECENT audit rows (its descriptor promised "by entity, timeframe,
 * or actor" and had none of those args). The pool was unioned in by recency too.
 *
 * After: pool-only, FTS5 query-matched, bodies filled greedily under a server
 * byte budget, `memory_id` re-fetches one in full. The audit half is GONE — it
 * bypassed `core.memory.audit.read` (the grant the MCP door enforces) and, being
 * recency-dumped, crowded the budget with the noisiest feed.
 *
 * Driven through the REAL user-memory store on a REAL SQLite db (so the FTS5
 * index is exercised, not mocked) + the REAL handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

/** A real SQLite-backed pool (so `search` runs the FTS5 index, not the fallback). */
const newPool = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-recall-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'w.db'));
  return createUserMemoryStore(
    createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
    createBlobStore(join(dir, 'memory_blobs')),
    { db },
  );
};

/** Handlers with the pool wired + `core.memory.read` granted (the owner case). */
const handlersFor = (
  store: ReturnType<typeof newPool>,
  opts: { granted?: boolean } = {},
) =>
  buildChatTier1Handlers({
    getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
    getUserMemoryStore: () => store,
    getOpAdmissionGate: () => ({ isOpGranted: () => opts.granted !== false }) as never,
  } as never);

const ctx = () => ({ channel: 'internal_function_call', execution_source: { actor: 'user_self' } }) as never;

const call = async (store: ReturnType<typeof newPool>, args: object, opts = {}) => {
  const h = handlersFor(store, opts);
  const res = await h['memory.search']!(args, ctx());
  return res as { ok: boolean; result: { memories: any[]; budget: any; next_cursor?: string; hint?: string } };
};

describe('memory.search — it actually SEARCHES now (FTS5)', () => {
  it('matches on the BODY, not just the summary — a long doc is findable by its contents', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Pricing policy', body: 'Enterprise discount caps at 20 percent.' });
    await store.create({ kind: 'note', summary: 'Office plants', body: 'Water the ficus on Fridays.' });

    const res = await call(store, { query: 'discount' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.memories[0].summary).toBe('Pricing policy');
    // The body came back inline (it fits the budget) — recall is usable in ONE call.
    expect(res.result.memories[0].body).toContain('20 percent');
    expect(res.result.memories[0].truncated).toBe(false);
  });

  it('a non-matching query returns a guided EMPTY, never ok:false (anti-loop)', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Pricing policy', body: 'caps at 20 percent' });
    const res = await call(store, { query: 'zzz-nothing-matches-this' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toBeTruthy();
  });

  it('a JUNK query returns empty, never throws (FTS5 syntax must not reach the agent)', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'x', body: 'y' });
    const res = await call(store, { query: '"""((( AND AND' });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.result.memories)).toBe(true);
  });

  it('NO query still answers — most recent (the anti-loop fallback the log cites)', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'older', body: 'a' });
    await store.create({ kind: 'note', summary: 'newer', body: 'b' });
    const res = await call(store, {});
    expect(res.ok).toBe(true);
    expect(res.result.memories.length).toBe(2);
  });
});

describe('memory.search — the FTS5 index is real (not the fallback)', () => {
  it('the index is populated on write, and a token match is a genuine FTS5 hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-fts-'));
    dirs.push(dir);
    const db = new Database(join(dir, 'w.db'));
    const store = createUserMemoryStore(
      createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
      createBlobStore(join(dir, 'memory_blobs')),
      { db },
    );
    return store.create({ kind: 'note', summary: 's', body: 'indexedtoken' }).then(async () => {
      // The FTS5 vtable exists AND carries the row — so `search` above ran the
      // real index, never the substring fallback (that path needs `db` absent).
      const n = (db.prepare('SELECT count(*) AS n FROM user_memory_fts').get() as { n: number }).n;
      expect(n).toBe(1);
      expect(await store.search('indexedtoken', 10)).toHaveLength(1);
      // Deleting the row un-indexes it (the index never drifts from the pool).
      const rows = await store.list();
      await store.delete(rows[0]!.memory_id);
      expect(await store.search('indexedtoken', 10)).toHaveLength(0);
    });
  });

  it('BACKFILLS a pool written before the index existed (lazy, on first search)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backfill-'));
    dirs.push(dir);
    const db = new Database(join(dir, 'w.db'));
    const collection = createSQLiteCollection<UserMemoryRow>(db, 'user_memory');
    const blobs = createBlobStore(join(dir, 'memory_blobs'));

    // A pool written with NO index (the pre-FTS world): rows land, nothing indexes.
    const legacy = createUserMemoryStore(collection, blobs);
    await legacy.create({ kind: 'note', summary: 'legacy', body: 'oldtoken lives here' });

    // A new store over the SAME db. Its first search must self-heal the index.
    const upgraded = createUserMemoryStore(collection, blobs, { db });
    expect(await upgraded.search('oldtoken', 10)).toHaveLength(1);
  });
});

describe('memory.search — the body BUDGET', () => {
  it('fills bodies greedily and SKIPS what does not fit (a fat rank-1 cannot starve the rest)', async () => {
    const store = newPool();
    // One 20 KB body (over the 16 KB budget on its own) + two small ones, all matching.
    await store.create({ kind: 'note', summary: 'fat budgetword', body: 'budgetword '.repeat(2000) });
    await store.create({ kind: 'note', summary: 'small one budgetword', body: 'budgetword short a' });
    await store.create({ kind: 'note', summary: 'small two budgetword', body: 'budgetword short b' });

    const res = await call(store, { query: 'budgetword' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toHaveLength(3);

    const fat = res.result.memories.find((m) => m.summary === 'fat budgetword')!;
    const smalls = res.result.memories.filter((m) => m.summary.startsWith('small'));

    // The oversized one degraded to preview + id + truncated…
    expect(fat.body).toBeUndefined();
    expect(fat.truncated).toBe(true);
    expect(fat.body_preview).toBeTruthy();
    expect(fat.size_bytes).toBeGreaterThan(16 * 1024);
    expect(fat.memory_id).toBeTruthy(); // ← the escape hatch

    // …and the small ones STILL got their bodies (skip-what-doesn't-fit, not stop).
    expect(smalls).toHaveLength(2);
    for (const s of smalls) {
      expect(s.body).toContain('short');
      expect(s.truncated).toBe(false);
    }
    expect(res.result.budget.limit_bytes).toBe(16 * 1024);
    expect(res.result.budget.truncated_count).toBe(1);
  });

  it('memory_id re-fetches ONE entry in full — the truncated entry`s escape hatch', async () => {
    const store = newPool();
    const row = await store.create({ kind: 'note', summary: 'fat', body: 'X'.repeat(20 * 1024) });
    const res = await call(store, { memory_id: row.memory_id });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toHaveLength(1);
    // Full body (20 KB — over the 16 KB *search* budget, under the 64 KB fetch cap).
    expect(res.result.memories[0].body!.length).toBe(20 * 1024);
    expect(res.result.memories[0].truncated).toBe(false);
  });

  it('an unknown memory_id is a guided empty, not an error', async () => {
    const store = newPool();
    const res = await call(store, { memory_id: 'umem_does-not-exist' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toContain('umem_does-not-exist');
  });
});

describe('memory.search — redaction ("forgotten") is honored', () => {
  const withRedactions = (store: ReturnType<typeof newPool>, ids: string[]) =>
    buildChatTier1Handlers({
      getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
      getUserMemoryStore: () => store,
      getOpAdmissionGate: () => ({ isOpGranted: () => true }) as never,
      getMemoryRedactionStore: () => ({
        list: async () => ids.map((memory_id) => ({ memory_id })),
      }) as never,
    } as never);

  it('a FORGOTTEN memory is OMITTED from recall entirely — not a tombstone', async () => {
    const store = newPool();
    const keep = await store.create({ kind: 'note', summary: 'keep forgetword', body: 'forgetword ok' });
    const drop = await store.create({ kind: 'note', summary: 'drop forgetword', body: 'forgetword secret' });

    const h = withRedactions(store, [drop.memory_id]);
    const res = (await h['memory.search']!({ query: 'forgetword' }, ctx())) as any;

    expect(res.ok).toBe(true);
    const ids = res.result.memories.map((m: any) => m.memory_id);
    expect(ids).toContain(keep.memory_id);
    expect(ids).not.toContain(drop.memory_id); // gone, not content-cleared
    // …and its content never leaks through any field.
    expect(JSON.stringify(res.result)).not.toContain('secret');
  });

  it('a forgotten memory cannot be re-fetched by memory_id either (the escape hatch is closed too)', async () => {
    const store = newPool();
    const drop = await store.create({ kind: 'note', summary: 'drop', body: 'confidential-body' });
    const h = withRedactions(store, [drop.memory_id]);
    const res = (await h['memory.search']!({ memory_id: drop.memory_id }, ctx())) as any;

    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
    expect(JSON.stringify(res.result)).not.toContain('confidential-body');
  });
});

describe('memory.search — the grant now gates the WHOLE tool', () => {
  it('an ungranted caller gets NOTHING (was: audit rows flowed free)', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'secret', body: 'confidential' });
    const res = await call(store, { query: 'secret' }, { granted: false });
    expect(res.ok).toBe(true); // guided empty, not an error
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toContain('not granted');
  });

  it('checks the grant before disclosing that the memory store is unavailable', async () => {
    const getUserMemoryStore = vi.fn(() => undefined);
    const handlers = buildChatTier1Handlers({
      getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
      getUserMemoryStore,
      getOpAdmissionGate: () => ({ isOpGranted: () => false }) as never,
    } as never);

    const res = (await handlers['memory.search']!(
      { query: 'secret' },
      ctx(),
    )) as any;
    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toContain('not granted');
    expect(res.result.coverage).toBeUndefined();
    expect(getUserMemoryStore).not.toHaveBeenCalled();
  });
});

describe('memory.search — since/until + cursor', () => {
  it('since/until filter on effective time', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'old timeword', body: 'timeword', event_at: 1_000 });
    await store.create({ kind: 'note', summary: 'new timeword', body: 'timeword', event_at: 9_000 });

    const res = await call(store, { query: 'timeword', since: 5_000 });
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.memories[0].summary).toBe('new timeword');
  });

  it('pages with an opaque cursor; a malformed cursor fails OPEN to page 1 (anti-loop)', async () => {
    const store = newPool();
    for (let i = 0; i < 25; i++) {
      await store.create({ kind: 'note', summary: `pageword ${i}`, body: 'pageword' });
    }
    const p1 = await call(store, { query: 'pageword' });
    expect(p1.result.memories).toHaveLength(20); // server-fixed page size
    expect(p1.result.next_cursor).toBeTruthy();

    const p2 = await call(store, { query: 'pageword', cursor: p1.result.next_cursor });
    expect(p2.result.memories.length).toBeGreaterThan(0);
    expect(p2.result.memories[0].memory_id).not.toBe(p1.result.memories[0].memory_id);

    // Garbage cursor → page 1, NOT an error.
    const bad = await call(store, { query: 'pageword', cursor: 'not-base64-at-all!!' });
    expect(bad.ok).toBe(true);
    expect(bad.result.memories).toHaveLength(20);
  });
});
