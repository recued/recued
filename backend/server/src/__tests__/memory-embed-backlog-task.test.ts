/* RUNG 4's write side — the `memory-embed-backlog` housekeeping task.
 *
 * Two properties matter and they pull in opposite directions:
 *   1. it must RUN, or rung 4 is permanently `not_embedded` (the
 *      built-and-unreachable shape it was written to close);
 *   2. it must run ONLY when the owner asks, because every entry is a paid
 *      provider call.
 *
 * The second one nearly shipped broken: `isEligibleForIdleCycle` returned a
 * bare `true` for every non-enrichment task, so `meta.idle_eligible: false` —
 * whose contract says the idle path skips the task — did nothing on a core
 * task. Latent until a core task wanted to spend money. Both halves are pinned
 * here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  memoryEmbedBacklogTask,
  MEMORY_EMBED_BACKLOG_TASK_ID,
  MEMORY_EMBED_BATCH,
} from '../housekeeping/tasks/memory-embed-backlog.js';
import { isEligibleForIdleCycle } from '../housekeeping/scheduler.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const poolWith = async (count: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'embed-task-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'w.db'));
  const store = createUserMemoryStore(
    createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
    createBlobStore(join(dir, 'memory_blobs')),
    { db },
  );
  for (let i = 0; i < count; i++) {
    await store.create({ kind: 'faq', summary: `entry ${i}`, body: `body text ${i}` });
  }
  return store;
};

/** `ctx.embed`'s shape: the ingredient-manifest executor, not the narrowed
 *  `MemoryEmbedder` — the task adapts one to the other. */
const fakeCtxEmbed = (calls: { n: number }) => async () => {
  calls.n += 1;
  return { vector: [1, 0, 0.5], dimensions: 3, model: 'fake-embed-v1' };
};

const ctxWith = (over: Partial<HousekeepingContext>): HousekeepingContext =>
  ({ now: () => 0, ...over }) as unknown as HousekeepingContext;

const CURSOR = { kind: 'init' } as never;

describe('memory-embed-backlog — MANUAL ONLY', () => {
  it('⛔ is NOT idle-eligible — the owner presses Run now or it does not fire', () => {
    // Directly the guarantee: this task spends one embedding call per entry,
    // and a pool import of 500 Q&As is 500 provider calls.
    expect(memoryEmbedBacklogTask.meta.idle_eligible).toBe(false);
    expect(
      isEligibleForIdleCycle(memoryEmbedBacklogTask, {
        ctx: ctxWith({}),
        now: 0,
      }),
      'an idle cycle must skip this task',
    ).toBe(false);
  });

  it('⛔ the idle gate still admits ordinary core maintenance', () => {
    // The scheduler fix must not turn every core task off — only the ones that
    // opt out. A regression here would silently stop audit compaction et al.
    const others = STANDALONE_TASKS.filter(
      (t) => t.meta.kind === 'core' && t.meta.id !== MEMORY_EMBED_BACKLOG_TASK_ID,
    );
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) {
      expect(
        isEligibleForIdleCycle(t, { ctx: ctxWith({}), now: 0 }),
        `${t.meta.id} should still run on idle`,
      ).toBe(true);
    }
  });

  it('is REGISTERED — a task nobody registers is the gap it exists to close', () => {
    expect(STANDALONE_TASKS.map((t) => t.meta.id)).toContain(MEMORY_EMBED_BACKLOG_TASK_ID);
  });

  it('is declared an AI surface, so the Run-Now dialog warns about spend', () => {
    expect(memoryEmbedBacklogTask.is_ai_surface).toBe(true);
  });
});

describe('memory-embed-backlog — stepping', () => {
  it('embeds a batch and YIELDS while work remains', async () => {
    const store = await poolWith(MEMORY_EMBED_BATCH + 5);
    const calls = { n: 0 };
    const res = await memoryEmbedBacklogTask.step(
      ctxWith({ userMemoryStore: store, embed: fakeCtxEmbed(calls) as never }),
      CURSOR,
      10_000,
    );
    expect(calls.n).toBe(MEMORY_EMBED_BATCH);
    expect(res.status).toBe('yield');
    expect(store.vectorCoverage().embedded).toBe(MEMORY_EMBED_BATCH);
  });

  it('COMPLETES once the pool is fully embedded', async () => {
    const store = await poolWith(3);
    const calls = { n: 0 };
    const ctx = ctxWith({ userMemoryStore: store, embed: fakeCtxEmbed(calls) as never });
    expect((await memoryEmbedBacklogTask.step(ctx, CURSOR, 10_000)).status).toBe('complete');
    expect(store.vectorCoverage().embedded).toBe(3);

    // Re-running is a no-op: nothing is missing, so nothing is paid for.
    calls.n = 0;
    expect((await memoryEmbedBacklogTask.step(ctx, CURSOR, 10_000)).status).toBe('complete');
    expect(calls.n).toBe(0);
  });

  it('⛔ COMPLETES rather than yielding when the whole batch FAILED', async () => {
    // Yielding on zero progress spins the same doomed batch for the rest of the
    // cycle — a provider outage would burn the budget re-failing. Completing
    // leaves the backlog for the next Run-Now, when the cause may be gone.
    const store = await poolWith(10);
    const res = await memoryEmbedBacklogTask.step(
      ctxWith({
        userMemoryStore: store,
        embed: (async () => { throw new Error('AI_LLM_UNAVAILABLE'); }) as never,
      }),
      CURSOR,
      10_000,
    );
    expect(res.status).toBe('complete');
    expect(store.vectorCoverage().embedded).toBe(0);
  });

  it('no embeddings path (pure-Anthropic) completes without touching the pool', async () => {
    const store = await poolWith(3);
    const res = await memoryEmbedBacklogTask.step(
      ctxWith({ userMemoryStore: store }), // no ctx.embed
      CURSOR,
      10_000,
    );
    expect(res.status).toBe('complete');
    expect(store.vectorCoverage().embedded).toBe(0);
  });

  it('no pool wired (dbless) completes without throwing', async () => {
    const calls = { n: 0 };
    const res = await memoryEmbedBacklogTask.step(
      ctxWith({ embed: fakeCtxEmbed(calls) as never }),
      CURSOR,
      10_000,
    );
    expect(res.status).toBe('complete');
    expect(calls.n).toBe(0);
  });
});
