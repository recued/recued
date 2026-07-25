import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  writeFileFailures: [] as Array<{
    readonly error: unknown;
    readonly createPartial?: boolean;
  }>,
  renameFailures: [] as Array<unknown>,
  writeFilePaths: [] as Array<string>,
  renamePairs: [] as Array<{ readonly from: string; readonly to: string }>,
  unlinkPaths: [] as Array<string>,
}));

vi.mock('node:fs/promises', async (importActual) => {
  type FsPromises = typeof import('node:fs/promises');
  const actual = await importActual<FsPromises>();
  const actualWriteFile = actual.writeFile as unknown as (...args: Array<unknown>) => Promise<void>;
  const actualRename = actual.rename as unknown as (...args: Array<unknown>) => Promise<void>;
  const actualUnlink = actual.unlink as unknown as (...args: Array<unknown>) => Promise<void>;

  return {
    ...actual,
    writeFile: vi.fn(async (...args: Array<unknown>) => {
      const path = String(args[0]);
      fsMockState.writeFilePaths.push(path);
      const failure = fsMockState.writeFileFailures.shift();
      if (failure !== undefined) {
        if (failure.createPartial === true) await actualWriteFile(...args);
        throw failure.error;
      }
      return actualWriteFile(...args);
    }),
    rename: vi.fn(async (...args: Array<unknown>) => {
      const from = String(args[0]);
      const to = String(args[1]);
      fsMockState.renamePairs.push({ from, to });
      const failure = fsMockState.renameFailures.shift();
      if (failure !== undefined) throw failure;
      return actualRename(...args);
    }),
    unlink: vi.fn(async (...args: Array<unknown>) => {
      fsMockState.unlinkPaths.push(String(args[0]));
      return actualUnlink(...args);
    }),
  };
});

import {
  BundleFetchError,
  computeBundleEntryHash,
  createFileBundleStore,
  createStoreBackedFetcher,
  loadBundlePool,
  startBundlePoller,
  type BundleEntryInput,
  type BundleFetchErrorReason,
  type BundleFetcher,
  type BundleManifest,
  type BundlePollerHandle,
  type BundleStore,
  type PollerScheduler,
} from '../templates/index';
import type { RenderTemplate, SlotName } from '../types';

interface MakeRenderTemplateOptions {
  readonly body?: string;
  readonly locale?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
  readonly template_hash?: string;
}

const makeRenderTemplate = (
  opts: MakeRenderTemplateOptions = {},
): RenderTemplate => {
  const body = opts.body ?? 'Hello {{contact.name}}';
  const locale = opts.locale ?? 'en';
  const slotGrammar = [...(opts.slot_grammar ?? [])];
  return {
    template_hash: opts.template_hash ?? computeBundleEntryHash({
      body,
      locale,
      slot_grammar: slotGrammar,
    }),
    kind: 'render_template',
    slot_grammar: slotGrammar,
    action_class: 'read',
    short_circuit_eligible: true,
    body,
  };
};

const makeBundleEntry = (
  opts: MakeRenderTemplateOptions = {},
): BundleEntryInput => {
  const locale = opts.locale ?? 'en';
  return {
    template: makeRenderTemplate({ ...opts, locale }),
    locale,
  };
};

const makeManifest = (
  entries: ReadonlyArray<BundleEntryInput> = [makeBundleEntry()],
  version = '2026-05-25-001',
): BundleManifest => ({
  version,
  entries,
});

const expectAsyncBundleFetchError = async (
  run: () => Promise<unknown>,
  reason: BundleFetchErrorReason,
): Promise<BundleFetchError> => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(BundleFetchError);
    const error = err as BundleFetchError;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected BundleFetchError ${reason}`);
};

const resetFsMockState = (): void => {
  fsMockState.writeFileFailures.length = 0;
  fsMockState.renameFailures.length = 0;
  fsMockState.writeFilePaths.length = 0;
  fsMockState.renamePairs.length = 0;
  fsMockState.unlinkPaths.length = 0;
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

const writeManifestFile = async (
  path: string,
  manifest: BundleManifest,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest), 'utf8');
};

const listTempFiles = async (path: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dirname(path)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  const prefix = `${basename(path)}.tmp.`;
  return entries.filter((entry) => entry.startsWith(prefix));
};

const observedTempPathsFor = (path: string): ReadonlyArray<string> => (
  fsMockState.writeFilePaths.filter((writtenPath) => writtenPath.startsWith(`${path}.tmp.`))
);

const expectTempPathShape = (tempPath: string, path: string): void => {
  expect(tempPath.startsWith(`${path}.tmp.`)).toBe(true);
  expect(tempPath.slice(`${path}.tmp.`.length)).toMatch(/^[0-9a-f]{16}$/);
};

const makePollerStore = (
  putImpl: (manifest: BundleManifest) => Promise<void> = async () => undefined,
) => {
  const current = vi.fn((): BundleManifest | null => null);
  const put = vi.fn(async (manifest: BundleManifest): Promise<void> => putImpl(manifest));
  return { current, put } satisfies BundleStore;
};

const makeFetcher = (
  fetchImpl: () => Promise<BundleManifest>,
) => ({
  fetchManifest: vi.fn(fetchImpl),
}) satisfies BundleFetcher;

interface SyntheticScheduler extends PollerScheduler {
  readonly setCalls: ReadonlyArray<{
    readonly handler: () => void;
    readonly ms: number;
    readonly handle: unknown;
  }>;
  readonly clearCalls: ReadonlyArray<unknown>;
  fire(index?: number): void;
}

const createSyntheticScheduler = (): SyntheticScheduler => {
  const setCalls: Array<{
    readonly handler: () => void;
    readonly ms: number;
    readonly handle: unknown;
  }> = [];
  const clearCalls: Array<unknown> = [];
  return {
    setCalls,
    clearCalls,
    setInterval(handler: () => void, ms: number): unknown {
      const handle = { id: setCalls.length };
      setCalls.push({ handler, ms, handle });
      return handle;
    },
    clearInterval(handle: unknown): void {
      clearCalls.push(handle);
    },
    fire(index = 0): void {
      const call = setCalls[index];
      if (call === undefined) throw new Error(`missing interval ${index}`);
      call.handler();
    },
  };
};

let testDir: string;

beforeEach(async () => {
  resetFsMockState();
  testDir = await mkdtemp(join(tmpdir(), 'd-164-p4g-3-'));
});

afterEach(async () => {
  vi.useRealTimers();
  resetFsMockState();
  await rm(testDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const manifestPath = (): string => join(testDir, 'bundle-cache', 'manifest.json');

describe('D-164 P4g-3 createFileBundleStore', () => {
  it('constructs with current() null when the manifest file is missing', async () => {
    const store = await createFileBundleStore({ path: manifestPath() });

    expect(store.current()).toBeNull();
  });

  it('creates a missing parent directory recursively and can write through it', async () => {
    const path = join(testDir, 'missing', 'nested', 'manifest.json');
    const manifest = makeManifest([makeBundleEntry({ body: 'Hi {{account.name}}' })], 'v-parent');

    const store = await createFileBundleStore({ path });
    await store.put(manifest);

    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(manifest));
    expect(store.current()).toBe(manifest);
  });

  it('loads an existing valid manifest JSON into current()', async () => {
    const manifest = makeManifest([makeBundleEntry({ body: 'Email {{contact.email}}' })], 'v-existing');
    await writeManifestFile(manifestPath(), manifest);

    const store = await createFileBundleStore({ path: manifestPath() });

    expect(store.current()).toEqual(manifest);
  });

  it('throws parse_error when the existing cache file is invalid JSON', async () => {
    await mkdir(dirname(manifestPath()), { recursive: true });
    await writeFile(manifestPath(), '{not-json', 'utf8');

    const error = await expectAsyncBundleFetchError(
      () => createFileBundleStore({ path: manifestPath() }),
      'parse_error',
    );

    expect(error.detail).toContain('not valid JSON');
  });

  it('bubbles schema_invalid from parseBundleManifest for schema-invalid JSON', async () => {
    await mkdir(dirname(manifestPath()), { recursive: true });
    await writeFile(manifestPath(), JSON.stringify({ version: '', entries: [] }), 'utf8');

    const error = await expectAsyncBundleFetchError(
      () => createFileBundleStore({ path: manifestPath() }),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.version');
  });

  it('throws disk_error when the cache path is a directory', async () => {
    await mkdir(manifestPath(), { recursive: true });

    const error = await expectAsyncBundleFetchError(
      () => createFileBundleStore({ path: manifestPath() }),
      'disk_error',
    );

    expect(error.detail).toContain('read');
  });

  it('put() writes the exact JSON.stringify(manifest) payload to disk', async () => {
    const manifest = makeManifest([makeBundleEntry({ body: 'Name {{contact.name}}' })], 'v-write');
    const store = await createFileBundleStore({ path: manifestPath() });

    await store.put(manifest);

    expect(await readFile(manifestPath(), 'utf8')).toBe(JSON.stringify(manifest));
  });

  it('put() updates the in-memory cache only after a successful write', async () => {
    const manifest = makeManifest([makeBundleEntry({ body: 'Name {{contact.name}}' })], 'v-cache');
    const store = await createFileBundleStore({ path: manifestPath() });

    expect(store.current()).toBeNull();
    await store.put(manifest);

    expect(store.current()).toBe(manifest);
  });

  it('put() writes via a same-directory temp file and leaves no temp after rename', async () => {
    const manifest = makeManifest([makeBundleEntry()], 'v-atomic');
    const store = await createFileBundleStore({ path: manifestPath() });

    await store.put(manifest);

    const tempPaths = observedTempPathsFor(manifestPath());
    expect(tempPaths).toHaveLength(1);
    expectTempPathShape(tempPaths[0] ?? '', manifestPath());
    expect(fsMockState.renamePairs).toEqual([{ from: tempPaths[0], to: manifestPath() }]);
    expect(await listTempFiles(manifestPath())).toEqual([]);
  });

  it('writeFile failure throws disk_error and keeps the previous cached manifest', async () => {
    const original = makeManifest([makeBundleEntry({ body: 'Original {{contact.name}}' })], 'v-original');
    const failed = makeManifest([makeBundleEntry({ body: 'Failed {{contact.name}}' })], 'v-failed');
    const store = await createFileBundleStore({ path: manifestPath() });
    await store.put(original);
    resetFsMockState();
    fsMockState.writeFileFailures.push({
      error: Object.assign(new Error('write failed'), { code: 'EIO' }),
      createPartial: true,
    });

    const error = await expectAsyncBundleFetchError(
      () => store.put(failed),
      'disk_error',
    );

    expect(error.detail).toContain('write');
    expect(store.current()).toBe(original);
    expect(await readFile(manifestPath(), 'utf8')).toBe(JSON.stringify(original));
  });

  it('writeFile failure best-effort unlinks the partial temp file', async () => {
    const manifest = makeManifest([makeBundleEntry()], 'v-write-fail');
    const store = await createFileBundleStore({ path: manifestPath() });
    fsMockState.writeFileFailures.push({
      error: Object.assign(new Error('write failed'), { code: 'EIO' }),
      createPartial: true,
    });

    await expectAsyncBundleFetchError(() => store.put(manifest), 'disk_error');

    const tempPaths = observedTempPathsFor(manifestPath());
    expect(tempPaths).toHaveLength(1);
    expectTempPathShape(tempPaths[0] ?? '', manifestPath());
    expect(fsMockState.unlinkPaths).toContain(tempPaths[0]);
    expect(await listTempFiles(manifestPath())).toEqual([]);
    expect(store.current()).toBeNull();
  });

  it('rename failure throws disk_error and keeps the previous cached manifest', async () => {
    const original = makeManifest([makeBundleEntry({ body: 'Original {{contact.name}}' })], 'v-original');
    const failed = makeManifest([makeBundleEntry({ body: 'Failed {{contact.name}}' })], 'v-rename-failed');
    const store = await createFileBundleStore({ path: manifestPath() });
    await store.put(original);
    resetFsMockState();
    fsMockState.renameFailures.push(Object.assign(new Error('rename failed'), { code: 'EIO' }));

    const error = await expectAsyncBundleFetchError(
      () => store.put(failed),
      'disk_error',
    );

    expect(error.detail).toContain('rename');
    expect(store.current()).toBe(original);
    expect(await readFile(manifestPath(), 'utf8')).toBe(JSON.stringify(original));
  });

  it('rename failure best-effort unlinks the temp file and leaves no temp behind', async () => {
    const manifest = makeManifest([makeBundleEntry()], 'v-rename-fail');
    const store = await createFileBundleStore({ path: manifestPath() });
    fsMockState.renameFailures.push(Object.assign(new Error('rename failed'), { code: 'EIO' }));

    await expectAsyncBundleFetchError(() => store.put(manifest), 'disk_error');

    const tempPaths = observedTempPathsFor(manifestPath());
    expect(tempPaths).toHaveLength(1);
    expectTempPathShape(tempPaths[0] ?? '', manifestPath());
    expect(fsMockState.unlinkPaths).toContain(tempPaths[0]);
    expect(await listTempFiles(manifestPath())).toEqual([]);
    expect(store.current()).toBeNull();
  });

  it('ten sequential puts leave the last manifest on disk and no temp files', async () => {
    const store = await createFileBundleStore({ path: manifestPath() });
    const manifests = Array.from({ length: 10 }, (_value, index) => (
      makeManifest(
        [makeBundleEntry({ body: `Value ${index} {{contact.name}}` })],
        `v-${index}`,
      )
    ));

    for (const manifest of manifests) {
      await store.put(manifest);
    }

    const last = manifests[manifests.length - 1];
    expect(store.current()).toBe(last);
    expect(await readFile(manifestPath(), 'utf8')).toBe(JSON.stringify(last));
    expect(await listTempFiles(manifestPath())).toEqual([]);
  });

  it('two close puts use distinct random hex temp suffixes', async () => {
    const first = makeManifest([makeBundleEntry({ body: 'First {{contact.name}}' })], 'v-temp-1');
    const second = makeManifest([makeBundleEntry({ body: 'Second {{contact.name}}' })], 'v-temp-2');
    const store = await createFileBundleStore({ path: manifestPath() });

    await store.put(first);
    await store.put(second);

    const tempPaths = observedTempPathsFor(manifestPath());
    expect(tempPaths).toHaveLength(2);
    tempPaths.forEach((tempPath) => expectTempPathShape(tempPath, manifestPath()));
    expect(new Set(tempPaths).size).toBe(2);
  });

  it('construction makes the existing manifest current before any put()', async () => {
    const existing = makeManifest([makeBundleEntry({ body: 'Existing {{contact.name}}' })], 'v-before-put');
    const replacement = makeManifest([makeBundleEntry({ body: 'Replacement {{contact.name}}' })], 'v-after-put');
    await writeManifestFile(manifestPath(), existing);

    const store = await createFileBundleStore({ path: manifestPath() });

    expect(store.current()).toEqual(existing);
    await store.put(replacement);
    expect(store.current()).toBe(replacement);
  });
});

describe('D-164 P4g-3 startBundlePoller', () => {
  it('returns stop() and firstTick synchronously while the first fetch is still pending', async () => {
    const manifest = makeManifest([], 'v-sync-handle');
    const firstFetch = deferred<BundleManifest>();
    const fetcher = makeFetcher(() => firstFetch.promise);
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({ fetcher, store, intervalMs: 5000, scheduler });

    expect(typeof handle.stop).toBe('function');
    expect(handle.firstTick).toBeInstanceOf(Promise);
    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(1);
    expect(scheduler.setCalls).toHaveLength(1);
    handle.stop();
    firstFetch.resolve(manifest);
    await expect(handle.firstTick).resolves.toBeUndefined();
  });

  it('fires the first tick immediately and writes the fetched manifest', async () => {
    const manifest = makeManifest([], 'v-first');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore();

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      scheduler: createSyntheticScheduler(),
    });

    await handle.firstTick;

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledWith(manifest);
  });

  it('fires onUpdate only after fetch and store.put both succeed', async () => {
    const manifest = makeManifest([], 'v-update-after-put');
    const putGate = deferred<void>();
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore(async () => putGate.promise);
    const onUpdate = vi.fn();

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onUpdate,
      scheduler: createSyntheticScheduler(),
    });
    await flushAsync();

    expect(store.put).toHaveBeenCalledWith(manifest);
    expect(onUpdate).not.toHaveBeenCalled();
    putGate.resolve();
    await handle.firstTick;

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(manifest);
  });

  it('resolves firstTick and calls onError when the first fetch rejects', async () => {
    const rejection = { reason: 'upstream down' };
    const fetcher = makeFetcher(async () => {
      throw rejection;
    });
    const store = makePollerStore();
    const onError = vi.fn();

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onError,
      scheduler: createSyntheticScheduler(),
    });

    await expect(handle.firstTick).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(rejection);
    expect(store.put).not.toHaveBeenCalled();
  });

  it('resolves firstTick and calls onError when store.put rejects', async () => {
    const manifest = makeManifest([], 'v-put-fails');
    const putError = new Error('put failed');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore(async () => {
      throw putError;
    });
    const onError = vi.fn();
    const onUpdate = vi.fn();

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onError,
      onUpdate,
      scheduler: createSyntheticScheduler(),
    });

    await expect(handle.firstTick).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(putError);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('uses the default global scheduler for interval ticks when scheduler is omitted', async () => {
    vi.useFakeTimers();
    const manifest = makeManifest([], 'v-default-scheduler');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore();

    const handle = startBundlePoller({ fetcher, store, intervalMs: 250 });
    await handle.firstTick;
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await flushAsync();
    }

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(4);
    expect(store.put).toHaveBeenCalledTimes(4);
    handle.stop();
  });

  it('passes intervalMs to an injected scheduler for subsequent ticks', async () => {
    const manifest = makeManifest([], 'v-interval-ms');
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({
      fetcher: makeFetcher(async () => manifest),
      store: makePollerStore(),
      intervalMs: 1234,
      scheduler,
    });
    await handle.firstTick;

    expect(scheduler.setCalls).toHaveLength(1);
    expect(scheduler.setCalls[0]?.ms).toBe(1234);
  });

  it('stop() prevents a later interval callback from running the tick body', async () => {
    const manifest = makeManifest([], 'v-stop-next');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, scheduler });
    await handle.firstTick;
    handle.stop();
    scheduler.fire();
    await flushAsync();

    expect(scheduler.clearCalls).toEqual([scheduler.setCalls[0]?.handle]);
    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent and clears the interval only once', async () => {
    const manifest = makeManifest([], 'v-stop-idempotent');
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({
      fetcher: makeFetcher(async () => manifest),
      store: makePollerStore(),
      intervalMs: 1000,
      scheduler,
    });
    await handle.firstTick;

    handle.stop();
    handle.stop();

    expect(scheduler.clearCalls).toEqual([scheduler.setCalls[0]?.handle]);
  });

  it('stop() during an in-flight first tick suppresses store.put and onUpdate', async () => {
    const manifest = makeManifest([], 'v-stop-in-flight');
    const firstFetch = deferred<BundleManifest>();
    const fetcher = makeFetcher(() => firstFetch.promise);
    const store = makePollerStore();
    const onUpdate = vi.fn();
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onUpdate,
      scheduler,
    });
    handle.stop();
    firstFetch.resolve(manifest);
    await handle.firstTick;

    expect(store.put).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('post-fetch stop suppresses store.put, onUpdate, and onError', async () => {
    const first = makeManifest([], 'v-before-stop');
    const second = makeManifest([], 'v-after-stop');
    const scheduler = createSyntheticScheduler();
    const store = makePollerStore();
    const onUpdate = vi.fn();
    const onError = vi.fn();
    let calls = 0;
    let handle!: BundlePollerHandle;
    const fetcher = makeFetcher(async () => {
      calls += 1;
      if (calls === 2) handle.stop();
      return calls === 1 ? first : second;
    });

    handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onUpdate,
      onError,
      scheduler,
    });
    await handle.firstTick;
    scheduler.fire();
    await flushAsync();

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledWith(first);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('skips overlapping ticks while a fetch is already in flight', async () => {
    const manifest = makeManifest([], 'v-in-flight');
    const firstFetch = deferred<BundleManifest>();
    const fetcher = makeFetcher(() => firstFetch.promise);
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, scheduler });
    scheduler.fire();
    scheduler.fire();
    await flushAsync();

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(1);
    firstFetch.resolve(manifest);
    await handle.firstTick;
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('a throwing onError is swallowed and the next tick still runs', async () => {
    const manifest = makeManifest([], 'v-on-error-safe');
    const fetchError = new Error('fetch failed');
    const fetcher = makeFetcher(vi.fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce(manifest));
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();
    const onError = vi.fn(() => {
      throw new Error('handler failed');
    });

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onError,
      scheduler,
    });
    await expect(handle.firstTick).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(fetchError);
    scheduler.fire();
    await flushAsync();
    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledWith(manifest);
  });

  it('a throwing onUpdate is swallowed and the next tick still runs', async () => {
    const first = makeManifest([], 'v-update-safe-1');
    const second = makeManifest([], 'v-update-safe-2');
    const fetcher = makeFetcher(vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second));
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();
    const onUpdate = vi.fn(() => {
      throw new Error('handler failed');
    });

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onUpdate,
      scheduler,
    });
    await expect(handle.firstTick).resolves.toBeUndefined();

    scheduler.fire();
    await flushAsync();
    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenLastCalledWith(second);
  });

  it('works when onUpdate and onError are both omitted', async () => {
    const manifest = makeManifest([], 'v-no-hooks');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore();
    const scheduler = createSyntheticScheduler();

    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, scheduler });
    await handle.firstTick;
    scheduler.fire();
    await flushAsync();

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it('firstTick resolves when fetch fails and onError throws', async () => {
    const fetcher = makeFetcher(async () => {
      throw new Error('fetch failed');
    });
    const store = makePollerStore();
    const onError = vi.fn(() => {
      throw new Error('onError failed');
    });

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onError,
      scheduler: createSyntheticScheduler(),
    });

    await expect(handle.firstTick).resolves.toBeUndefined();
  });

  it('firstTick resolves when store.put fails and onError throws', async () => {
    const manifest = makeManifest([], 'v-put-and-handler-fail');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore(async () => {
      throw new Error('put failed');
    });
    const onError = vi.fn(() => {
      throw new Error('onError failed');
    });

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onError,
      scheduler: createSyntheticScheduler(),
    });

    await expect(handle.firstTick).resolves.toBeUndefined();
  });

  it('firstTick resolves when onUpdate throws after a successful put', async () => {
    const manifest = makeManifest([], 'v-update-throws');
    const fetcher = makeFetcher(async () => manifest);
    const store = makePollerStore();
    const onUpdate = vi.fn(() => {
      throw new Error('onUpdate failed');
    });

    const handle = startBundlePoller({
      fetcher,
      store,
      intervalMs: 1000,
      onUpdate,
      scheduler: createSyntheticScheduler(),
    });

    await expect(handle.firstTick).resolves.toBeUndefined();
  });

  it('interval fetch failures flow to onError without throwing from the callback', async () => {
    const fetchError = new Error('fetch failed later');
    const fetcher = makeFetcher(vi.fn()
      .mockResolvedValueOnce(makeManifest([], 'v-interval-first'))
      .mockRejectedValueOnce(fetchError));
    const store = makePollerStore();
    const onError = vi.fn();
    const scheduler = createSyntheticScheduler();
    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, onError, scheduler });
    await handle.firstTick;

    expect(() => scheduler.fire()).not.toThrow();
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(fetchError);
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('interval put failures flow to onError without throwing from the callback', async () => {
    const putError = new Error('put failed later');
    let putCalls = 0;
    const store = makePollerStore(async () => {
      putCalls += 1;
      if (putCalls === 2) throw putError;
    });
    const fetcher = makeFetcher(async () => makeManifest([], `v-put-${putCalls}`));
    const onError = vi.fn();
    const scheduler = createSyntheticScheduler();
    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, onError, scheduler });
    await handle.firstTick;

    expect(() => scheduler.fire()).not.toThrow();
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(putError);
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it('interval onError throws are contained by the tick', async () => {
    const fetcher = makeFetcher(vi.fn()
      .mockResolvedValueOnce(makeManifest([], 'v-first'))
      .mockRejectedValueOnce(new Error('fetch failed later'))
      .mockResolvedValueOnce(makeManifest([], 'v-third')));
    const store = makePollerStore();
    const onError = vi.fn(() => {
      throw new Error('onError failed');
    });
    const scheduler = createSyntheticScheduler();
    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, onError, scheduler });
    await handle.firstTick;

    expect(() => scheduler.fire()).not.toThrow();
    await flushAsync();
    scheduler.fire();
    await flushAsync();

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(3);
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it('interval onUpdate throws are contained by the tick', async () => {
    const fetcher = makeFetcher(vi.fn()
      .mockResolvedValueOnce(makeManifest([], 'v-first'))
      .mockResolvedValueOnce(makeManifest([], 'v-second'))
      .mockResolvedValueOnce(makeManifest([], 'v-third')));
    const store = makePollerStore();
    const onUpdate = vi.fn(() => {
      throw new Error('onUpdate failed');
    });
    const scheduler = createSyntheticScheduler();
    const handle = startBundlePoller({ fetcher, store, intervalMs: 1000, onUpdate, scheduler });
    await handle.firstTick;

    expect(() => scheduler.fire()).not.toThrow();
    await flushAsync();
    scheduler.fire();
    await flushAsync();

    expect(fetcher.fetchManifest).toHaveBeenCalledTimes(3);
    expect(store.put).toHaveBeenCalledTimes(3);
  });
});

describe('D-164 P4g-3 createStoreBackedFetcher', () => {
  it('returns the cached manifest from store.current()', async () => {
    const manifest = makeManifest([makeBundleEntry()], 'v-store-backed');
    const store = {
      current: vi.fn(() => manifest),
      put: vi.fn(async () => undefined),
    } satisfies BundleStore;

    const fetcher = createStoreBackedFetcher({ store });

    await expect(fetcher.fetchManifest()).resolves.toBe(manifest);
    expect(store.current).toHaveBeenCalledTimes(1);
  });

  it('throws cache_empty when store.current() is null', async () => {
    const store = {
      current: vi.fn((): BundleManifest | null => null),
      put: vi.fn(async () => undefined),
    } satisfies BundleStore;
    const fetcher = createStoreBackedFetcher({ store });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'cache_empty',
    );

    expect(error.reason).toBe('cache_empty');
  });

  it('cache_empty detail explains that the store is empty', async () => {
    const store = {
      current: vi.fn((): BundleManifest | null => null),
      put: vi.fn(async () => undefined),
    } satisfies BundleStore;
    const fetcher = createStoreBackedFetcher({ store });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'cache_empty',
    );

    expect(error.detail).toContain('store is empty');
  });

  it('reads the store dynamically after a later store.put()', async () => {
    const manifest = makeManifest([makeBundleEntry()], 'v-dynamic-cache');
    let cached: BundleManifest | null = null;
    const store = {
      current: vi.fn(() => cached),
      put: vi.fn(async (next: BundleManifest) => {
        cached = next;
      }),
    } satisfies BundleStore;
    const fetcher = createStoreBackedFetcher({ store });

    await expectAsyncBundleFetchError(() => fetcher.fetchManifest(), 'cache_empty');
    await store.put(manifest);

    await expect(fetcher.fetchManifest()).resolves.toBe(manifest);
    expect(store.current).toHaveBeenCalledTimes(2);
  });

  it('wires createFileBundleStore through loadBundlePool end to end', async () => {
    const template = makeRenderTemplate({
      body: 'Render {{contact.name}}',
      slot_grammar: ['entity.name'],
    });
    const entry = { template, locale: 'en' } satisfies BundleEntryInput;
    const manifest = makeManifest([entry], 'v-file-backed-pool');
    await writeManifestFile(manifestPath(), manifest);

    const store = await createFileBundleStore({ path: manifestPath() });
    const fetcher = createStoreBackedFetcher({ store });
    const pool = await loadBundlePool({ fetcher });

    expect(pool.name).toBe('bundle');
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({
      locale: entry.locale,
      template: {
        body: template.body,
        template_hash: template.template_hash,
      },
    });
  });
});

describe('D-164 P4g-3 BundleFetchErrorReason', () => {
  it('includes disk_error and cache_empty in the exported reason union', () => {
    const reasons: readonly BundleFetchErrorReason[] = ['disk_error', 'cache_empty'];

    expect(reasons).toEqual(['disk_error', 'cache_empty']);
  });
});
