/** The page watcher remembers the page itself (`once_per_change`, 2026-10-05).
 *
 *  Web Watch's two recipes stored the page they last saw with a shared-storage
 *  write, and their pack offers only "Read only" access, so every unattended
 *  run was held for approval at that write. The watcher now keeps the page per
 *  recipe and address, and the recipes write nothing.
 *
 *  Each case goes through the real dispatcher with the manifest's declared
 *  inputs merged in, as dispatch builds them, over a real SQLite file. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeManifestStepInput } from '@recued/ingredients';

import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import { createWatcherDispatcher } from '../index.js';
import { forgetHttpWatcherRecipe, settleHttpWatcherRun } from '../http-watcher-memory.js';

const URL_A = 'https://example.com/pricing';

const dispatched = (stepArgs: Record<string, unknown>): Record<string, unknown> => {
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'http-watcher')!;
  return mergeManifestStepInput(manifest.input, stepArgs, { trustedSurfaceDispatch: false });
};

let dir: string;
let db: Database.Database;
let page: string;
let status: number;
let watch: ReturnType<typeof createWatcherDispatcher>;
let runs: number;

/** One check, as a step of a run: the engine supplies the recipe and run ids. */
const check = async (opts: { recipe?: string; url?: string; run?: string } = {}) => {
  const run_id = opts.run ?? `run-${++runs}`;
  const out = await watch({
    slug: 'http-watcher',
    args: dispatched({
      target_url: opts.url ?? URL_A,
      once_per_change: true,
      recipe_id: opts.recipe ?? 'watch-webpage-changes',
      run_id,
    }),
  }) as Record<string, unknown>;
  return { out, run_id };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'http-watcher-memory-'));
  db = new Database(join(dir, 'recued.db'));
  page = '<p>Plan A $10</p>';
  status = 200;
  runs = 0;
  const fetchFn = (async () => new Response(page, { status })) as unknown as typeof fetch;
  watch = createWatcherDispatcher({ db, fetchFn });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('once_per_change', () => {
  it('fires on the first check, then once for each change, handing back the page as it was', async () => {
    const first = await check();
    expect(first.out).toMatchObject({ should_run: true, body: '<p>Plan A $10</p>', previous_body: null });
    settleHttpWatcherRun(db, first.run_id, 'reported');

    expect((await check()).out.should_run).toBe(false);

    page = '<p>Plan A $12</p>';
    const changed = await check();
    expect(changed.out).toMatchObject({ should_run: true, body: '<p>Plan A $12</p>', previous_body: '<p>Plan A $10</p>' });
    settleHttpWatcherRun(db, changed.run_id, 'reported');
    expect((await check()).out.should_run).toBe(false);
  });

  /** ⛔ The memory moves on only when the run completes. Moved at the check, a
   *  run that failed after the fire (the model did not answer) would lose the
   *  change: the next check would find the page unchanged. */
  it('⛔ a run that did not report the change leaves it to be reported at the next check', async () => {
    settleHttpWatcherRun(db, (await check()).run_id, 'reported');
    page = '<p>Plan A $12</p>';
    settleHttpWatcherRun(db, (await check()).run_id, 'not_reported');

    const again = await check();
    expect(again.out).toMatchObject({ should_run: true, previous_body: '<p>Plan A $10</p>' });
    settleHttpWatcherRun(db, again.run_id, 'reported');
    expect((await check()).out.should_run).toBe(false);
  });

  it('a run waiting for an answer keeps its page until it settles', async () => {
    settleHttpWatcherRun(db, (await check()).run_id, 'reported');
    page = '<p>Plan A $12</p>';
    const held = await check();
    settleHttpWatcherRun(db, held.run_id, 'waiting');
    // Its resume completes under the same run id.
    settleHttpWatcherRun(db, held.run_id, 'reported');
    expect((await check()).out.should_run).toBe(false);
  });

  it('settles only the run that reported the page', async () => {
    const first = await check();
    settleHttpWatcherRun(db, 'another-run', 'reported');
    expect((await check()).out).toMatchObject({ should_run: true, previous_body: null });
    settleHttpWatcherRun(db, first.run_id, 'reported'); // superseded by the second check's run
    expect((await check()).out.should_run).toBe(true);
  });

  it('is kept per recipe and per address', async () => {
    settleHttpWatcherRun(db, (await check()).run_id, 'reported');
    expect((await check({ recipe: 'watch-competitor-pricing' })).out)
      .toMatchObject({ should_run: true, previous_body: null });
    expect((await check({ url: 'https://example.com/other' })).out)
      .toMatchObject({ should_run: true, previous_body: null });
    expect((await check()).out.should_run).toBe(false);
  });

  it('a page that cannot be read changes nothing', async () => {
    settleHttpWatcherRun(db, (await check()).run_id, 'reported');
    status = 503;
    page = 'Service Unavailable';
    expect((await check()).out.should_run).toBe(false);
    status = 200;
    page = '<p>Plan A $10</p>';
    expect((await check()).out.should_run).toBe(false);
  });

  it('uninstall forgets the page: the next check is a first check', async () => {
    settleHttpWatcherRun(db, (await check()).run_id, 'reported');
    forgetHttpWatcherRecipe(db, 'watch-webpage-changes');
    expect((await check()).out).toMatchObject({ should_run: true, previous_body: null });
  });

  it('without it the watcher keeps nothing, as before', async () => {
    const out = await watch({
      slug: 'http-watcher',
      args: dispatched({ target_url: URL_A, recipe_id: 'r', run_id: 'run-x' }),
    }) as Record<string, unknown>;
    expect(out.should_run).toBe(true);
    expect(out).not.toHaveProperty('previous_body');
    settleHttpWatcherRun(db, 'run-x', 'reported');
    const count = db.prepare('SELECT COUNT(*) AS n FROM http_watcher_memory').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('once_per_change refuses what it cannot honour', () => {
  const refused = (args: Record<string, unknown>) =>
    watch({ slug: 'http-watcher', args: dispatched({ target_url: URL_A, ...args }) });

  it('a value that is not true or false', async () => {
    await expect(refused({ once_per_change: 'yes', recipe_id: 'r', run_id: 'u' }))
      .rejects.toThrow(/once_per_change must be true or false/);
  });

  it('a hash or etag of the recipe’s own beside it', async () => {
    await expect(refused({ once_per_change: true, previous_hash: 'abc', recipe_id: 'r', run_id: 'u' }))
      .rejects.toThrow(/leave out previous_etag and previous_hash/);
  });

  it('a check outside a recipe run', async () => {
    await expect(refused({ once_per_change: true, recipe_id: 'r' })).rejects.toThrow(/step of a recipe run/);
    await expect(refused({ once_per_change: true, run_id: 'u' })).rejects.toThrow(/step of a recipe run/);
  });

  it('a server with no database', async () => {
    const dbless = createWatcherDispatcher({ fetchFn: (async () => new Response('x')) as unknown as typeof fetch });
    await expect(dbless({
      slug: 'http-watcher',
      args: dispatched({ target_url: URL_A, once_per_change: true, recipe_id: 'r', run_id: 'u' }),
    })).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
