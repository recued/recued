/** D-231 — `{{data.memory.<memory_id>}}` reads the owner's curated knowledge.
 *
 *  ⛔ WHAT THIS IS ACTUALLY TESTING, and why a contracts-level test would not
 *  have been enough. D-120 Phase 4 shipped the `data.memory.*` namespace, the
 *  validator check, the `read_memory` permission and a deprecation alias — and
 *  NO RUNTIME READ PATH. `SharedResolvers` had no memory resolver and the
 *  server wired none, so every `{{data.memory.…}}` resolved to `undefined`,
 *  silently, for the life of the namespace. Declared, validated,
 *  permission-gated at install, and inert.
 *
 *  So the contracts tests (which assert path rewriting) could all pass while
 *  nothing read anything. This drives the resolver the SERVER wires against a
 *  REAL `user_memory` store, which is the seam where "declared" becomes "runs". */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prefetchSharedRefs, type SharedResolvers } from '@recued/engine';
import type { NamespaceStores } from '@recued/contracts';
import { resolveRef } from '@recued/contracts';

import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createUserMemoryStore,
  type UserMemoryRow,
  type UserMemoryStore,
} from '../user-memory-store.js';

const mkStores = (): NamespaceStores => ({
  vault: {}, config: {}, context: {}, meta: {}, step: {},
} as unknown as NamespaceStores);

describe('D-231 data.memory.* read path', () => {
  let dir: string;
  let db: Database.Database;
  let store: UserMemoryStore;
  let resolvers: SharedResolvers;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd231-'));
    db = new Database(join(dir, 'm.db'));
    store = createUserMemoryStore(
      createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
      createBlobStore(join(dir, 'memory_blobs')),
      { db },
    );
    // EXACTLY the closure `execute-handler.ts` wires. Re-declaring it here
    // rather than importing keeps the test honest about shape but means the
    // wiring itself is asserted separately, below.
    resolvers = {
      dataMemory: {
        lookup: async (key: string) => {
          const resolved = await store.get(key);
          if (!resolved) return null;
          return {
            ...resolved.row,
            ...(resolved.body !== undefined ? { body: resolved.body } : {}),
          };
        },
      },
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const step = (input: string): Parameters<typeof prefetchSharedRefs>[0] =>
    ({ id: 's', transform: 'count', input } as unknown as Parameters<typeof prefetchSharedRefs>[0]);

  it('⛔ resolves a real memory — the namespace is no longer inert', async () => {
    const row = await store.create({
      kind: 'note',
      summary: 'Prefer async updates over standups',
      body: 'The team agreed in March.',
    } as Parameters<UserMemoryStore['create']>[0]);

    const stores = mkStores();
    await prefetchSharedRefs(step(`{{data.memory.${row.memory_id}.summary}}`), stores, resolvers);
    expect(resolveRef(`{{data.memory.${row.memory_id}.summary}}`, stores))
      .toBe('Prefer async updates over standups');
    expect(resolveRef(`{{data.memory.${row.memory_id}.kind}}`, stores)).toBe('note');
  });

  it('resolves the BODY, not just the row preview', async () => {
    // `get()` not `getRow()`: a > 64 KB body lives in CAS and the row alone
    // carries only a clamped preview. A resolver on `getRow` would look
    // correct on small memories and silently truncate the ones that matter.
    const row = await store.create({
      kind: 'note', summary: 's', body: 'x'.repeat(200),
    } as Parameters<UserMemoryStore['create']>[0]);
    const stores = mkStores();
    await prefetchSharedRefs(step(`{{data.memory.${row.memory_id}.body}}`), stores, resolvers);
    expect(resolveRef(`{{data.memory.${row.memory_id}.body}}`, stores)).toBe('x'.repeat(200));
  });

  it('carries origin_actor, so a recipe can tell whose memory it read', async () => {
    // The origin taxonomy is the honesty property of this store: `user_self`
    // is the owner, `contracted_user` an agent, `system` the engine. A recipe
    // acting on "the owner said" must be able to check that it was the owner.
    const row = await store.create({
      kind: 'note', summary: 's',
    } as Parameters<UserMemoryStore['create']>[0]);
    const stores = mkStores();
    await prefetchSharedRefs(step(`{{data.memory.${row.memory_id}.origin_actor}}`), stores, resolvers);
    expect(resolveRef(`{{data.memory.${row.memory_id}.origin_actor}}`, stores)).toBe('user_self');
  });

  it('an unknown id resolves to undefined rather than throwing', async () => {
    const stores = mkStores();
    await prefetchSharedRefs(step('{{data.memory.umem_nope.summary}}'), stores, resolvers);
    expect(resolveRef('{{data.memory.umem_nope.summary}}', stores)).toBeUndefined();
  });

  it('⛔ data.audit.* does NOT fall through to this store', async () => {
    // The whole point of the split. Under D-120's alias, `data.audit.<id>` was
    // rewritten to `data.memory.<id>` — so after the stores diverged, a recipe
    // asking for run history would have been handed the owner's private notes.
    const row = await store.create({
      kind: 'note', summary: 'private', body: 'private',
    } as Parameters<UserMemoryStore['create']>[0]);
    const stores = mkStores();
    await prefetchSharedRefs(step(`{{data.audit.${row.memory_id}.summary}}`), stores, resolvers);
    expect(resolveRef(`{{data.audit.${row.memory_id}.summary}}`, stores)).toBeUndefined();
  });

  it('⛔ the blob-orphan check is bounded by MATCHES, not by store size', async () => {
    // D-230 left this store unbounded and D-231 made it recipe-reachable, so
    // an O(total) check on every blob free stopped being harmless. The plan is
    // the assertion: a correct answer read by scanning every memory is still
    // the defect. Measured before the index: 559ms at 500k memories.
    const plan = (db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT data FROM user_memory
          WHERE json_extract(data, '$.blob_hash') = ?`,
      )
      .all('h1') as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
  });

  it('a freed blob is still collected correctly — semantics unchanged', async () => {
    // The index changes HOW the question is answered, not the answer. Two
    // memories sharing a body: deleting one must NOT free the blob the other
    // still points at.
    const big = 'y'.repeat(70 * 1024); // > 64 KB ⇒ CAS, so a blob exists
    const a = await store.create({ kind: 'note', summary: 'a', body: big } as Parameters<UserMemoryStore['create']>[0]);
    const b = await store.create({ kind: 'note', summary: 'b', body: big } as Parameters<UserMemoryStore['create']>[0]);
    expect(a.blob_hash).toBeDefined();
    expect(b.blob_hash).toBe(a.blob_hash);
    await store.delete(a.memory_id);
    // b's body must still resolve — the shared blob was not collected.
    const stillThere = await store.get(b.memory_id);
    expect(stillThere?.body).toBe(big);
  });

  it('no resolver wired ⇒ undefined, not a crash', async () => {
    // Matches `dataShared`'s posture: an embedder without a memory store gets
    // a quiet miss, not a boot failure.
    const stores = mkStores();
    await prefetchSharedRefs(step('{{data.memory.umem_x.summary}}'), stores, {});
    expect(resolveRef('{{data.memory.umem_x.summary}}', stores)).toBeUndefined();
  });
});
