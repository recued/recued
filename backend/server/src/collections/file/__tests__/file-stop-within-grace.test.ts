/** A file stack stop returns within the grace, however long a walk would take.
 *
 *  The lifecycle drain stops every folder in `pause_collections`, a step with
 *  5 s; a stop queued behind a folder's first walk (or an S3 listing) waited
 *  the whole walk out, and a step that runs out makes an update refuse to swap
 *  versions. Each case checks that the stop returns within `STOP_GRACE_MS`,
 *  that the walk or request in flight was told to stop, and that a walk cut
 *  short is not taken for a full one — its folder removes nothing it did not
 *  reach. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { STOP_GRACE_MS } from '../../../lifecycle/settle-within.js';
import { createCollectionRegistry } from '../../registry.js';
import { CollectionStoppedError } from '../../stop-signal.js';
import { createS3AdapterFactory } from '../adapters/s3/index.js';
import type { S3Fetch } from '../adapters/s3/client.js';
import { composeFileStack, type FileStack } from '../compose.js';
import { createFsWatcher } from '../fs-adapter.js';
import { isWatchedFolderCollection } from '../watched-folder-collection.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Whether a promise has settled yet, readable without awaiting it. */
const track = (work: Promise<unknown>): { readonly done: boolean } => {
  const settled = { done: false };
  void work.then(() => { settled.done = true; }, () => { settled.done = true; });
  return settled;
};

const tempFolder = (files: number): string => {
  const base = mkdtempSync(join(tmpdir(), 'file-stop-grace-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const folder = join(base, 'watched');
  mkdirSync(folder);
  for (let i = 0; i < files; i += 1) writeFileSync(join(folder, `file-${String(i).padStart(3, '0')}.txt`), `body ${i}`);
  return folder;
};

const caps = {
  read: 'yes', write: 'no', delete: 'no', watch: 'none',
  mirror: 'disabled', auth: 'none', path_style: 'posix',
} as const;

const seedRow = (stack: FileStack, slug: string, adapterType: string, config: Record<string, unknown> = {}): void => {
  stack.instances.upsert({
    platform: 'file', slug, adapter_type: adapterType, config, caps,
    auth_state: 'healthy', last_synced_at: null,
  });
};

describe('fs watcher — a stop ends the walk', () => {
  it('ends the first walk at the next file, attaches no watch, and says the walk is not complete', async () => {
    const root = tempFolder(40);
    const watchFactory = vi.fn();
    let present = 0;
    const watcher = createFsWatcher({
      root, ignore: [], watchMode: 'realtime', settleMs: -1,
      watchFactory,
      onEvent: () => {
        present += 1;
        // The drain stops the folder while its first walk runs.
        if (present === 1) void watcher.stop();
      },
    });

    await expect(watcher.start()).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(present).toBe(1);
    expect(watcher.walkErrors()).toBeGreaterThan(0);
    expect(watchFactory).not.toHaveBeenCalled();
  });

  it('waits for an event being handled at most the grace', async () => {
    const root = tempFolder(0);
    let listener: ((eventType: string, filename: string | null) => void) | undefined;
    let handling = false;
    const watcher = createFsWatcher({
      root, ignore: [], watchMode: 'realtime', settleMs: -1, debounceMs: 1,
      watchFactory: (_root, l) => {
        listener = l;
        return { close: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
      },
      // A folder on a network mount: handling the event never finishes.
      onEvent: (event) => {
        if (event.type !== 'change') return;
        handling = true;
        return new Promise<void>(() => {});
      },
    });
    await watcher.start();
    writeFileSync(join(root, 'late.txt'), 'late');
    listener!('change', 'late.txt');
    await vi.waitFor(() => expect(handling).toBe(true));

    vi.useFakeTimers();
    const stopping = track(watcher.stop());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopping.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopping.done).toBe(true);
  });
});

describe('file stack — disposeAll', () => {
  it('stops an adapter still in its first walk instead of waiting the walk out', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const stack = composeFileStack(db);
    let stops = 0;
    let walking!: () => void;
    const walkStarted = new Promise<void>((resolve) => { walking = resolve; });
    stack.adapters.register({
      type: 'long-walk',
      async probeCaps() { return caps; },
      create() {
        let endWalk!: (err: Error) => void;
        return {
          // A walk that only a stop ends, as a big folder's or bucket's would.
          start: () => new Promise<void>((_resolve, reject) => { endWalk = reject; walking(); }),
          async stop() { stops += 1; endWalk(new CollectionStoppedError()); },
        };
      },
    });
    seedRow(stack, 'big', 'long-walk');
    const starting = stack.startAll();
    await walkStarted;

    await stack.disposeAll();
    await starting;
    expect(stops).toBeGreaterThanOrEqual(1);
    // The walk was cut short: no backfill is recorded as complete.
    expect(stack.instances.get('file', 'big')!.backfill_complete).toBe(false);
    expect(stack.getLiveAdapter('big')).toBeUndefined();
  });

  it('returns within the grace when an adapter never finishes stopping', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const stack = composeFileStack(db);
    stack.adapters.register({
      type: 'stuck-stop',
      async probeCaps() { return caps; },
      create() {
        return { async start() {}, stop: () => new Promise<void>(() => {}) };
      },
    });
    seedRow(stack, 'stuck', 'stuck-stop');
    await stack.startAll();

    vi.useFakeTimers();
    const disposing = track(stack.disposeAll());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(disposing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(disposing.done).toBe(true);
  });

  it('leaves every record of a watched folder whose walk it cut short', async () => {
    const folder = tempFolder(30);
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const registry = createCollectionRegistry();
    let armed = false;
    let stopping: Promise<void> | undefined;
    let walked = 0;
    const stack: FileStack = composeFileStack(db, {
      onEvent: (_slug, event) => {
        if (!armed || event.type !== 'present') return;
        walked += 1;
        // The drain stops the stack after the restart's walk read one file.
        stopping ??= stack.disposeAll();
      },
    });
    stack.attachWatchedFolders({
      registry,
      bus: createWarehouseEventBus(),
      gates: {
        get: (slug) => createStorageGate({ quota: 512 * 1024 * 1024, reservePct: 1, surface: `collection:file:${slug}` }),
        release: () => {},
      },
    });
    stack.instances.upsert({
      platform: 'file', slug: 'invoices', adapter_type: 'fs', config: { path: folder },
      caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' },
      auth_state: 'healthy', last_synced_at: null,
    });
    const stored = stack.instances.get('file', 'invoices')!;
    const row = {
      slug: stored.slug, platform: 'file' as const, adapter_type: stored.adapter_type,
      caps: stored.caps, auth_state: stored.auth_state, last_synced_at: stored.last_synced_at,
    };
    await stack.enrollDeps.onEnrolled!(row as never);
    const collection = registry.get('file', 'invoices');
    if (!collection || !isWatchedFolderCollection(collection)) throw new Error('no watched folder collection');
    const records = (): number => collection.list({ platform: 'file', slug: 'invoices', limit: 1_000 }).length;
    expect(records()).toBe(30);

    // A restart walks the folder again; the stop comes one file in.
    armed = true;
    await stack.enrollDeps.onResync!(row as never);
    await stopping;
    expect(walked).toBeLessThan(30);
    // Read as a full walk, the 29 files it never reached would be removed.
    expect(records()).toBe(30);
  });
});

describe('S3 adapter — a stop aborts the listing', () => {
  const config = { access_key: 'ak', secret_key: 'sk', region: 'us-east-1', bucket: 'photos', poll_interval_ms: 1_000 };
  const listing = (): { fetcher: S3Fetch; signals: Array<AbortSignal | undefined> } => {
    const signals: Array<AbortSignal | undefined> = [];
    // The bucket never answers the listing; the request ends when aborted.
    const fetcher: S3Fetch = (_url, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    };
    return { fetcher, signals };
  };

  it('aborts the first listing, rejects the start, and starts no poll loop', async () => {
    vi.useFakeTimers();
    const { fetcher, signals } = listing();
    const instance = createS3AdapterFactory({ fetcher }).create({
      slug: 'photos', config, caps: { ...caps, watch: 'poll' }, onEvent: () => {},
    });
    const starting = instance.start();
    starting.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);

    const stopping = track(instance.stop());
    await vi.advanceTimersByTimeAsync(0);
    expect(stopping.done).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    await expect(starting).rejects.toBeInstanceOf(CollectionStoppedError);
    // No poll ever runs: the listing count stays at the one the stop cut off.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals).toHaveLength(1);
  });

  it('aborts a poll in flight on stop', async () => {
    vi.useFakeTimers();
    let lists = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const fetcher: S3Fetch = (_url, init) => {
      lists += 1;
      if (lists === 1) {
        // The first listing (the start's) answers with an empty bucket.
        const body = '<ListBucketResult></ListBucketResult>';
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    };
    const instance = createS3AdapterFactory({ fetcher }).create({
      slug: 'photos', config, caps: { ...caps, watch: 'poll' }, onEvent: () => {},
    });
    await instance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toHaveLength(1);

    const stopping = track(instance.stop());
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[0]?.aborted).toBe(true);
    expect(stopping.done).toBe(true);
  });
});
