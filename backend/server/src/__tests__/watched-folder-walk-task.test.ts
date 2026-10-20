/** `watched-folder-walk` — each watched folder walked again on the housekeeping
 *  cycle, for the changes its watch missed without a word
 *  (`housekeeping/tasks/watched-folder-walk.ts`).
 *
 *  The first cases drive the task over a stand-in list of folders. The last
 *  composes it the way the server does — the real housekeeping composer over a
 *  real file stack and folder — and runs the task that registered: a
 *  dependency the composition root supplies is only proved by running it. */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { composeFileStack } from '../collections/file/compose.js';
import { __setSharedWatchHost, HostedWatch } from '../collections/file/watch-host.js';
import { isWatchedFolderCollection } from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import {
  composeHousekeepingScheduler,
  composeHousekeepingStores,
} from '../composition/bin/wire-housekeeping-substrate.js';
import type { HousekeepingScheduler } from '../housekeeping/index.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
  type HousekeepingContext,
} from '../housekeeping/registry.js';
import {
  buildWatchedFolderWalkTask,
  WATCHED_FOLDER_WALK_EVERY_MS,
} from '../housekeeping/tasks/watched-folder-walk.js';

const NOW = 1_800_000_000_000;
const at = (clock: { t: number }): HousekeepingContext => ({ now: () => clock.t }) as unknown as HousekeepingContext;

describe('watched-folder-walk', () => {
  it('walks each folder whose last walk is due, the oldest first, and skips the rest', async () => {
    const walked: string[] = [];
    const task = buildWatchedFolderWalkTask({
      folders: {
        watchedFolderWalks: () => [
          { slug: 'recent', last_walk_at: NOW - WATCHED_FOLDER_WALK_EVERY_MS + 1 },
          { slug: 'due', last_walk_at: NOW - WATCHED_FOLDER_WALK_EVERY_MS },
          { slug: 'oldest', last_walk_at: NOW - 3 * WATCHED_FOLDER_WALK_EVERY_MS },
        ],
        walkFolderAgain: async (slug) => { walked.push(slug); },
      },
    });

    expect(await task.step(at({ t: NOW }), { kind: 'complete' }, 60_000))
      .toEqual({ status: 'complete', cursor: { kind: 'complete' } });
    expect(walked).toEqual(['oldest', 'due']);
  });

  it('leaves the rest for the next cycle once its budget is spent, never cutting a walk short', async () => {
    const clock = { t: NOW };
    const walked: string[] = [];
    let walking = 0;
    const task = buildWatchedFolderWalkTask({
      folders: {
        watchedFolderWalks: () => ['a', 'b', 'c'].map((slug, i) => ({ slug, last_walk_at: i })),
        walkFolderAgain: async (slug) => {
          walking++;
          await new Promise((r) => setTimeout(r, 1));
          clock.t += 40_000;
          walked.push(slug);
          walking--;
        },
      },
    });

    expect(await task.step(at(clock), { kind: 'complete' }, 60_000))
      .toEqual({ status: 'yield', reason: 'budget_exhausted', cursor: { kind: 'complete' } });
    // 'b' started inside the budget and finished outside it.
    expect(walked).toEqual(['a', 'b']);
    expect(walking).toBe(0);
  });

  it('is a deterministic core task, so an idle cycle runs it', () => {
    const task = buildWatchedFolderWalkTask({
      folders: { watchedFolderWalks: () => [], walkFolderAgain: async () => {} },
    });
    expect(task.meta).toMatchObject({ id: 'watched-folder-walk', kind: 'core' });
    expect(task.meta.idle_eligible).not.toBe(false);
    expect(task.is_ai_surface).not.toBe(true);
  });
});

describe('watched-folder-walk, as the server composes it', () => {
  let base: string;
  let db: Database.Database;
  beforeEach(() => {
    clearDefaultHousekeepingRegistry();
    base = mkdtempSync(join(tmpdir(), 'folder-walk-task-'));
    db = new Database(':memory:');
  });
  afterEach(() => {
    clearDefaultHousekeepingRegistry();
    __setSharedWatchHost(undefined);
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('registers over the file stack and walks a folder whose watch reported nothing', async () => {
    // On macOS a watch process that reports nothing; elsewhere the folder's own
    // watch is in this process, and the task runs before its events could land.
    __setSharedWatchHost({
      watch(_root, listener) {
        const watch = new HostedWatch(1, listener, () => {}, () => {});
        watch.receive({ id: 1, kind: 'attached' });
        return watch;
      },
      stop() {},
    });
    const folder = join(base, 'Invoices');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.txt'), 'a');
    writeFileSync(join(folder, 'gone.txt'), 'x');
    const registry = createCollectionRegistry();
    const fileStack = composeFileStack(db);
    fileStack.attachWatchedFolders({
      registry,
      bus: createWarehouseEventBus(),
      gates: {
        get: (slug) => createStorageGate({ quota: 1024 * 1024, reservePct: 1, surface: `collection:file:${slug}` }),
        release: () => {},
      },
    });
    fileStack.instances.upsert({
      platform: 'file',
      slug: 'invoices',
      adapter_type: 'fs',
      config: { path: folder },
      caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'realtime', mirror: 'optional', auth: 'none', path_style: 'posix' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await fileStack.startAll();
    let clock = Date.now();   // the start's walk has ended
    let scheduler: HousekeepingScheduler | undefined;
    try {
      ({ scheduler } = await composeHousekeepingScheduler({
        db,
        stores: composeHousekeepingStores({ db }),
        enrichmentProducers: new Map(),
        // Placeholders for everything the walk does not touch.
        enrichmentStore: {}, recipeStore: {}, collectionRegistry: registry, cacheBlobs: {},
        eventBus: { emit: () => {} }, warehouseBus: { emit: () => {} },
        auditLog: undefined,
        llmCallables: { llm: () => {}, llmWithMeta: () => {}, embed: () => {}, probeAiPath: () => {} },
        watchedFolders: fileStack,
      } as never));
      const task = getHousekeepingTask('watched-folder-walk');
      expect(task).toBeDefined();

      writeFileSync(join(folder, 'new.txt'), 'new');
      unlinkSync(join(folder, 'gone.txt'));
      const files = () => {
        const collection = registry.get('file', 'invoices');
        if (!collection || !isWatchedFolderCollection(collection)) throw new Error('no watched folder collection');
        return collection.list({ platform: 'file', slug: 'invoices', limit: 10 }).map((r) => r.hot_fields.path).sort();
      };
      // Walked at the start: not due yet.
      await task!.step(at({ t: clock }), { kind: 'complete' }, 60_000);
      expect(files()).toEqual(['a.txt', 'gone.txt']);

      clock += WATCHED_FOLDER_WALK_EVERY_MS;
      await task!.step(at({ t: clock }), { kind: 'complete' }, 60_000);
      expect(files()).toEqual(['a.txt', 'new.txt']);
    } finally {
      await scheduler?.stop();
      await fileStack.disposeAll();
    }
  });
});
