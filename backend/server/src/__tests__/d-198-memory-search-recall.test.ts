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
  return res as {
    ok: boolean;
    result: {
      memories: any[];
      budget: any;
      next_cursor?: string;
      hint?: string;
      match?: 'exact' | 'relaxed' | 'loose';
      top_margin?: number;
    };
  };
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

/* The relaxation ladder, driven through the REAL handler + REAL FTS5 store.
 *
 * ⚠ These are the SEAM cases. The rungs themselves are unit-tested in
 * `packages/fts` — but a ladder nothing calls still passes its own tests, and
 * the defect being fixed was precisely that the store called `toFtsMatch` and
 * stopped. Reverting `search()` to the single-expression form must kill these. */
describe('memory.search — a whole natural-language question retrieves (relaxation ladder)', () => {
  /** A product-knowledge pool: the use case the pool exists for. */
  const qaPool = async () => {
    const store = newPool();
    await store.create({
      kind: 'note',
      summary: 'Refund policy',
      body: 'Customers may request a refund within 30 days of purchase.',
    });
    await store.create({
      kind: 'note',
      summary: 'Pro plan billing',
      body: 'The Pro plan bills monthly and can be cancelled at any time.',
    });
    return store;
  };

  it('THE FIX — "What is your refund policy?" finds the entry (the all-words AND matched nothing)', async () => {
    // The premise — that AND-ing every word matches nothing, because no entry
    // contains "what" / "is" / "your" — is pinned in `packages/fts` against a
    // raw `toFtsMatch` expression. It cannot be pinned here: this store now
    // walks the whole ladder by construction, which IS the fix.
    const store = await qaPool();

    const res = await call(store, { query: 'What is your refund policy?' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.memories[0].summary).toBe('Refund policy');
    expect(res.result.memories[0].body).toContain('30 days');
  });

  it('an EXACT match is NOT diluted — the looser rungs never run once one matches', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'refunds within 30 days' });
    await store.create({ kind: 'note', summary: 'Refund address', body: 'mail refunds to HQ' });

    // Both entries carry "refund"; only the first carries "policy" too. Rung 1
    // answers, so the OR rung — which WOULD return both — is never reached.
    const res = await call(store, { query: 'refund policy' });
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.memories[0].summary).toBe('Refund policy');
  });

  it('terms spanning two entries fall through to the OR rung and return both', async () => {
    const store = await qaPool();
    const res = await call(store, { query: 'refund policy and billing' });
    expect(res.result.memories.map((m) => m.summary).sort()).toEqual(
      ['Pro plan billing', 'Refund policy'],
    );
  });

  it('⛔ an all-stopword question returns EMPTY, not the whole pool', async () => {
    const store = await qaPool();
    // "what is it" has no content words. OR-ing function words would hand the
    // agent the entire pool as if it were an answer; a guided empty is honest.
    const res = await call(store, { query: 'what is it' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toBeTruthy();
  });

  it('relaxing still cannot resurrect a genuinely absent term (anti-loop empty holds)', async () => {
    const store = await qaPool();
    const res = await call(store, { query: 'what is the zzzabsent policy' });
    expect(res.ok).toBe(true);
    // "policy" IS in the pool, so the OR rung legitimately surfaces that entry
    // and only that entry — relaxation widens the query, it does not widen to
    // everything.
    expect(res.result.memories.map((m) => m.summary)).toEqual(['Refund policy']);

    const none = await call(store, { query: 'zzzabsent qqqmissing' });
    expect(none.ok).toBe(true);
    expect(none.result.memories).toEqual([]);
  });

  it('the no-db harness walks the SAME rungs as the real store', async () => {
    // A harness that relaxed differently would make every test written against
    // it describe something that does not ship.
    const dir = mkdtempSync(join(tmpdir(), 'mem-nodb-'));
    dirs.push(dir);
    const db = new Database(join(dir, 'w.db'));
    const store = createUserMemoryStore(
      createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
      createBlobStore(join(dir, 'memory_blobs')),
      // no `db` → the substring path
    );
    await store.create({
      kind: 'note',
      summary: 'Refund policy',
      body: 'Customers may request a refund within 30 days.',
    });

    expect((await store.search('What is your refund policy?', 10)).hits).toHaveLength(1);
    expect((await store.search('what is it', 10)).hits).toEqual([]);
    expect((await store.search('zzzabsent qqqmissing', 10)).hits).toEqual([]);
  });
});

/* The pool's index is PORTER-STEMMED, unlike every other index in the codebase.
 *
 * ⛔ The half that is easy to get wrong is not the tokenizer, it is the
 * MIGRATION: `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against an existing
 * table, so without a drop the change reaches fresh installs only and is inert
 * on every server that already has the index. These drive a REAL pre-existing
 * index built the old way. */
describe('memory.search — porter stemming (and the migration that makes it reach anyone)', () => {
  /** A pool on a real db, optionally with `user_memory_fts` PRE-BUILT the old
   *  (non-stemming) way and already populated — i.e. an existing install. */
  const upgradedPool = async (seed: Array<{ summary: string; body: string }>) => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-porter-'));
    dirs.push(dir);
    const db = new Database(join(dir, 'w.db'));
    const collection = createSQLiteCollection<UserMemoryRow>(db, 'user_memory');
    const blobs = createBlobStore(join(dir, 'memory_blobs'));

    // The pre-porter world: the default tokenizer, rows written AND indexed.
    const legacy = createUserMemoryStore(collection, blobs, { db });
    for (const s of seed) await legacy.create({ kind: 'note', ...s });
    db.exec(`DROP TABLE user_memory_fts`);
    db.exec(`CREATE VIRTUAL TABLE user_memory_fts USING fts5(key UNINDEXED, blob_text)`);
    for (const row of await collection.list()) {
      db.prepare('INSERT INTO user_memory_fts (key, blob_text) VALUES (?,?)')
        .run(row.memory_id, `${row.summary ?? ''}\n${row.body_inline ?? ''}`);
    }
    expect(
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'user_memory_fts'`)
        .get() as { sql: string }).sql,
    ).not.toMatch(/porter/); // the starting state is genuinely the old one

    return { db, collection, blobs };
  };

  it('THE FIX — "cancel" finds an entry that only ever says "cancelled"', async () => {
    const store = newPool();
    await store.create({
      kind: 'note',
      summary: 'Pro plan billing',
      body: 'The Pro plan bills monthly and can be cancelled at any time.',
    });

    for (const query of ['cancel pro plan', 'cancelling the pro plan', 'how do I cancel?']) {
      const res = await call(store, { query });
      expect(res.result.memories.map((m) => m.summary), query).toEqual(['Pro plan billing']);
    }
  });

  it('⛔ MIGRATES an existing install — the index was built the OLD way and rows are re-indexed', async () => {
    const { db, collection, blobs } = await upgradedPool([
      { summary: 'Pro plan billing', body: 'The Pro plan can be cancelled at any time.' },
    ]);

    const upgraded = createUserMemoryStore(collection, blobs, { db });
    // A stem-only match proves BOTH halves: the table was re-declared with
    // porter AND every pre-existing row was re-indexed under it.
    expect((await upgraded.search('cancel', 10)).hits).toHaveLength(1);
    expect(
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'user_memory_fts'`)
        .get() as { sql: string }).sql,
    ).toContain('porter');
  });

  it('⛔ a WRITE between boot and the first search cannot strand the rest of the pool', async () => {
    // The empty-index heuristic ("something is indexed, so we are done") is
    // right for a pre-FTS pool and WRONG after a migration dropped a populated
    // one: one fresh write would make the index look done and leave every
    // migrated row permanently unsearchable.
    const { db, collection, blobs } = await upgradedPool([
      { summary: 'Refund policy', body: 'Refunds are issued within 30 days.' },
      { summary: 'Pro plan billing', body: 'The Pro plan can be cancelled at any time.' },
    ]);

    const upgraded = createUserMemoryStore(collection, blobs, { db });
    await upgraded.create({ kind: 'note', summary: 'Fresh note', body: 'written after boot' });

    expect((await upgraded.search('cancel', 10)).hits).toHaveLength(1);
    expect((await upgraded.search('refund', 10)).hits).toHaveLength(1);
    expect((await upgraded.search('fresh', 10)).hits).toHaveLength(1);
  });

  it('stemming is purely ADDITIVE — every pre-porter match still matches', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'Refunds within 30 days.' });
    await store.create({ kind: 'note', summary: 'Pro plan billing', body: 'Cancelled any time.' });

    // Exact terms that matched under unicode61 still resolve to the same entry:
    // stemming MERGES terms, so `stem(t) === stem(q)` wherever `t === q` did.
    for (const [query, summary] of [
      ['refund', 'Refund policy'],
      ['refunds', 'Refund policy'],
      ['refund policy', 'Refund policy'],
      ['cancelled', 'Pro plan billing'],
      ['billing', 'Pro plan billing'],
    ] as const) {
      const res = await call(store, { query });
      expect(res.result.memories.map((m) => m.summary), query).toEqual([summary]);
    }
  });

  it('a genuinely absent term is still empty — stemming widens matching, not reach', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'Refunds within 30 days.' });
    const res = await call(store, { query: 'zzzabsent qqqmissing' });
    expect(res.ok).toBe(true);
    expect(res.result.memories).toEqual([]);
  });
});

/* `match` + `top_margin` — the retrieval telling the caller how much to trust it.
 *
 * The count of results was never the useful knob: the byte budget already caps
 * what comes back, and whether ONE result is THE result is a property of the
 * score DISTRIBUTION, not a constant. These two fields are the distribution,
 * and both were computed-and-discarded before — the ladder always knew its rung
 * and `Promise<string[]>` threw the bm25 ranks away. */
describe('memory.search — match quality (the rung) and top_margin', () => {
  it('an all-words hit reports match: exact', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'refunds within 30 days' });
    const res = await call(store, { query: 'refund policy' });
    expect(res.result.match).toBe('exact');
  });

  it('a hit that needed function words dropped reports match: relaxed', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'refunds within 30 days' });
    const res = await call(store, { query: 'What is your refund policy?' });
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.match).toBe('relaxed');
  });

  it('⛔ an OR-rung answer reports match: loose — the whole point of the field', async () => {
    // These results are candidates, not an answer: no entry contained all the
    // terms. Indistinguishable from an exact hit before this field existed.
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'refunds within 30 days' });
    await store.create({ kind: 'note', summary: 'Pro plan billing', body: 'bills monthly' });
    const res = await call(store, { query: 'refund policy and billing' });
    expect(res.result.memories).toHaveLength(2);
    expect(res.result.match).toBe('loose');
  });

  it('a no-query listing reports NO match quality — it is not a match', async () => {
    // "the 20 most recent" is a listing. Reporting a rung about it would be a
    // fabricated signal, which is worse than an absent one.
    const store = newPool();
    await store.create({ kind: 'note', summary: 'a', body: 'a' });
    const res = await call(store, {});
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.match).toBeUndefined();
    expect(res.result.top_margin).toBeUndefined();
  });

  it('a dominant leader scores a HIGH top_margin; interchangeable results score LOW', async () => {
    const dominant = newPool();
    // One entry saturated with the term, one that mentions it once — bm25
    // separates them sharply.
    await dominant.create({
      kind: 'note', summary: 'Refunds', body: 'refund refund refund refund refund refund refund',
    });
    await dominant.create({
      kind: 'note', summary: 'Shipping', body: 'Ships in 2 days. A refund may apply to postage.',
    });
    const sharp = await call(dominant, { query: 'refund' });
    expect(sharp.result.memories.length).toBeGreaterThan(1);
    expect(sharp.result.top_margin).toBeGreaterThan(0);

    const flat = newPool();
    // Two entries with identical text under different summaries — nothing to
    // choose between them, and the field must say so rather than imply a winner.
    await flat.create({ kind: 'note', summary: 'Copy A', body: 'refund window is thirty days' });
    await flat.create({ kind: 'note', summary: 'Copy B', body: 'refund window is thirty days' });
    const even = await call(flat, { query: 'refund' });
    expect(even.result.memories).toHaveLength(2);
    expect(even.result.top_margin).toBe(0);

    expect(sharp.result.top_margin!).toBeGreaterThan(even.result.top_margin!);
  });

  it('top_margin is absent when there is no runner-up to compare against', async () => {
    const store = newPool();
    await store.create({ kind: 'note', summary: 'Only one', body: 'solitaryword here' });
    const res = await call(store, { query: 'solitaryword' });
    expect(res.result.memories).toHaveLength(1);
    expect(res.result.top_margin).toBeUndefined();
  });

  it('top_margin stays in [0,1] and reflects the PAGE, after redaction removed the leader', async () => {
    // Computing the margin in the store would describe a ranking a redacted top
    // hit has already invalidated.
    const store = newPool();
    const top = await store.create({
      kind: 'note', summary: 'Top', body: 'marginword marginword marginword marginword',
    });
    await store.create({ kind: 'note', summary: 'Second', body: 'marginword once' });
    await store.create({ kind: 'note', summary: 'Third', body: 'marginword once too' });

    const withRedaction = buildChatTier1Handlers({
      getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
      getUserMemoryStore: () => store,
      getOpAdmissionGate: () => ({ isOpGranted: () => true }) as never,
      getMemoryRedactionStore: () => ({
        list: async () => [{ memory_id: top.memory_id }],
      }) as never,
    } as never);
    const res = (await withRedaction['memory.search']!({ query: 'marginword' }, ctx())) as any;

    expect(res.result.memories.map((m: any) => m.summary).sort()).toEqual(['Second', 'Third']);
    expect(res.result.top_margin).toBeGreaterThanOrEqual(0);
    expect(res.result.top_margin).toBeLessThanOrEqual(1);
  });

  it('the no-db harness reports the rung but NO margin — substring matching cannot rank', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-rank-'));
    dirs.push(dir);
    const db = new Database(join(dir, 'w.db'));
    const store = createUserMemoryStore(
      createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
      createBlobStore(join(dir, 'memory_blobs')),
      // no `db` → the substring path
    );
    await store.create({ kind: 'note', summary: 'Refund policy', body: 'refunds within 30 days' });
    await store.create({ kind: 'note', summary: 'Refund address', body: 'refunds go to HQ' });

    const found = await store.search('refund', 10);
    expect(found.match).toBe('exact');
    expect(found.hits).toHaveLength(2);
    // A fabricated rank would produce a fabricated margin downstream.
    expect(found.hits.every((h) => h.rank === null)).toBe(true);
  });
});

/* RUNG 4 — semantic fall-through, conditional on the lexical ladder finding
 * NOTHING.
 *
 * The case it exists for is the one the pilot found and no relaxation reaches:
 * a query sharing zero tokens with its answer. The gating is the design — the
 * tool is otherwise a zero-token SQL read, and rung 4 puts an LLM call in it. */
describe('memory.search — rung 4 (semantic)', () => {
  /** A deterministic stand-in for a real embedding model: a bag-of-concepts
   *  vector over a fixed axis list. Two texts that mention the same CONCEPT
   *  land close even with no shared word — which is the only property rung 4
   *  depends on, and the only one worth faking. A real provider is not needed
   *  to prove the wiring, and using one would make the test non-deterministic. */
  const CONCEPTS: Array<{ axis: string; words: string[] }> = [
    { axis: 'twofactor', words: ['2fa', 'two', 'factor', 'authenticator', 'authentication', 'otp'] },
    { axis: 'refund', words: ['refund', 'money', 'back', 'reimburse'] },
    { axis: 'enable', words: ['enable', 'turn', 'activate', 'switch'] },
    { axis: 'billing', words: ['billing', 'invoice', 'charge', 'bill'] },
  ];
  const FAKE_MODEL = 'fake-embed-v1';
  const fakeEmbedder = (calls: string[] = []) => {
    const embedder = async (text: string) => {
      calls.push(text);
      const lower = text.toLowerCase();
      const vector = CONCEPTS.map(
        (c) => c.words.filter((w) => lower.includes(w)).length,
      );
      // A non-zero floor so an all-miss text still has a direction (cosine is
      // undefined for the zero vector).
      vector.push(0.01);
      return { vector, model: FAKE_MODEL };
    };
    return { embedder, calls };
  };

  const callWith = async (
    store: ReturnType<typeof newPool>,
    args: object,
    extra: Record<string, unknown>,
  ) => {
    const h = buildChatTier1Handlers({
      getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
      getUserMemoryStore: () => store,
      getOpAdmissionGate: () => ({ isOpGranted: () => true }) as never,
      ...extra,
    } as never);
    return (await h['memory.search']!(args, ctx())) as any;
  };

  /** The pilot's real miss: query and answer share NO token. */
  const twoFactorPool = async () => {
    const store = newPool();
    await store.create({
      kind: 'faq',
      summary: 'How do I enable two-factor authentication?',
      body: 'Security settings, then scan the QR code with an authenticator app.',
    });
    await store.create({
      kind: 'faq',
      summary: 'Refund policy',
      body: 'Refunds are issued within 30 days to the original payment method.',
    });
    return store;
  };

  it('THE CASE IT EXISTS FOR — "turn on 2FA" finds "two-factor authentication"', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    // Embed the pool first — rung 4 compares against stored vectors.
    const backlog = await store.embedBacklog(embedder);
    expect(backlog.embedded).toBe(2);

    // Premise: no lexical rung reaches it. Query and answer share no token.
    const lexical = await store.search('How do I turn on 2FA?', 10);
    expect(lexical.hits).toEqual([]);
    expect(lexical.match).toBeUndefined();

    const res = await callWith(store, { query: 'How do I turn on 2FA?' }, {
      getMemoryEmbedder: () => embedder,
    });
    expect(res.ok).toBe(true);
    expect(res.result.match).toBe('semantic');
    expect(res.result.memories[0].summary).toBe('How do I enable two-factor authentication?');
  });

  it('⛔ does NOT fire when the lexical ladder answered — the read stays zero-token', async () => {
    // The whole cost argument rests on this: the ~97% of queries the ladder
    // answers must not reach a provider.
    const store = await twoFactorPool();
    const { embedder, calls } = fakeEmbedder();
    await store.embedBacklog(embedder);
    calls.length = 0;

    const res = await callWith(store, { query: 'refund policy' }, {
      getMemoryEmbedder: () => embedder,
    });
    expect(res.result.match).toBe('exact');
    expect(calls).toEqual([]); // no embedding call was made
  });

  it('⛔ an UNEMBEDDED pool says so — it does not report "nothing matches"', async () => {
    // Zero rows from "never embedded" and zero rows from "no neighbour" are the
    // same shape and opposite facts. Telling Mary her knowledge is absent when
    // it was merely never embedded is the failure this branch exists to avoid.
    const store = await twoFactorPool();
    const { embedder, calls } = fakeEmbedder();
    const res = await callWith(store, { query: 'How do I turn on 2FA?' }, {
      getMemoryEmbedder: () => embedder,
    });
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toMatch(/not been embedded/i);
    // ⛔ must NOT name a Settings control — none exists yet.
    expect(res.result.hint).not.toMatch(/settings/i);
    expect(res.result.hint).toMatch(/do not conclude the knowledge is absent/i);
    expect(calls).toEqual([]); // nothing to compare against — don't pay for a call
  });

  it('⛔ a server with NO embedder says recall is unavailable, not that the pool is empty', async () => {
    const store = await twoFactorPool();
    const res = await callWith(store, { query: 'How do I turn on 2FA?' }, {});
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toMatch(/unavailable on this server/i);
    expect(res.result.hint).toMatch(/do not conclude the knowledge is absent/i);
  });

  it('an embedder that THROWS degrades to the empty, never to an error', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    await store.embedBacklog(embedder);
    const res = await callWith(store, { query: 'How do I turn on 2FA?' }, {
      getMemoryEmbedder: () => async () => { throw new Error('AI_LLM_UNAVAILABLE'); },
    });
    expect(res.ok).toBe(true); // anti-loop: never ok:false on a read
    expect(res.result.memories).toEqual([]);
  });

  it('⛔ a COHORT MISMATCH is skipped, not compared — cross-model vectors are nonsense', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    await store.embedBacklog(embedder);
    const res = await callWith(store, { query: 'How do I turn on 2FA?' }, {
      getMemoryEmbedder: () => async (t: string) => ({
        ...(await embedder(t)), model: 'a-different-model',
      }),
    });
    expect(res.result.memories).toEqual([]);
    expect(res.result.match).toBeUndefined();
  });

  it('a below-threshold neighbour is NOT returned — relaxation has a floor', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    await store.embedBacklog(embedder);
    // Shares no concept axis with anything in the pool.
    const res = await callWith(store, { query: 'zzz unrelated quantum gardening' }, {
      getMemoryEmbedder: () => embedder,
    });
    expect(res.result.memories).toEqual([]);
    expect(res.result.hint).toMatch(/including by meaning/i);
  });

  it('semantic hits carry top_margin — `rank` keeps its cost convention', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    await store.embedBacklog(embedder);
    const hits = store.semanticSearch(await embedder('two factor authenticator otp'), 10);
    expect(hits.length).toBeGreaterThan(0);
    // Negated cosine: more negative = better, same as bm25, ascending order.
    expect(hits[0]!.rank!).toBeLessThan(0);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.rank!).toBeGreaterThanOrEqual(hits[i - 1]!.rank!);
    }
  });

  it('⛔ a WRITE drops the entry vector — absent beats stale', async () => {
    const store = await twoFactorPool();
    const { embedder } = fakeEmbedder();
    await store.embedBacklog(embedder);
    expect(store.vectorCoverage().embedded).toBe(2);

    const rows = await store.list();
    await store.update(rows[0]!.memory_id, { summary: 'completely different subject now' });
    // The old vector described text that no longer exists.
    expect(store.vectorCoverage().embedded).toBe(1);
    // …and the backlog picks it back up.
    expect((await store.embedBacklog(embedder)).embedded).toBe(1);
    expect(store.vectorCoverage().embedded).toBe(2);
  });

  it('embedBacklog is RESUMABLE and survives a per-entry failure', async () => {
    const store = newPool();
    for (let i = 0; i < 5; i++) {
      await store.create({ kind: 'faq', summary: `entry ${i}`, body: `body ${i}` });
    }
    const { embedder } = fakeEmbedder();
    const first = await store.embedBacklog(embedder, { limit: 2 });
    expect(first.embedded).toBe(2);
    expect(first.remaining).toBe(3);

    // One poisoned entry must not abandon the batch.
    let seen = 0;
    const flaky = async (t: string) => {
      seen += 1;
      if (seen === 1) throw new Error('provider hiccup');
      return embedder(t);
    };
    const second = await store.embedBacklog(flaky, { limit: 10 });
    expect(second.failed).toBe(1);
    expect(second.embedded).toBe(2);
    // The failed one is still outstanding, and a later call retries it.
    expect((await store.embedBacklog(embedder)).embedded).toBe(1);
    expect(store.vectorCoverage().embedded).toBe(5);
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
      expect((await store.search('indexedtoken', 10)).hits).toHaveLength(1);
      // Deleting the row un-indexes it (the index never drifts from the pool).
      const rows = await store.list();
      await store.delete(rows[0]!.memory_id);
      expect((await store.search('indexedtoken', 10)).hits).toHaveLength(0);
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
    expect((await upgraded.search('oldtoken', 10)).hits).toHaveLength(1);
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
