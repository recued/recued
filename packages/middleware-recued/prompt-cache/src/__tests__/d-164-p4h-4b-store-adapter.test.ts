import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  mkdirFailures: [] as Array<unknown>,
  readFileFailures: [] as Array<unknown>,
  writeFileFailures: [] as Array<{
    readonly error: unknown;
    readonly createPartial?: boolean;
  }>,
  renameFailures: [] as Array<unknown>,
  renamePauses: [] as Array<Promise<void>>,
  writeFilePaths: [] as Array<string>,
  renamePairs: [] as Array<{ readonly from: string; readonly to: string }>,
  unlinkPaths: [] as Array<string>,
}));

vi.mock('node:fs/promises', async (importActual) => {
  type FsPromises = typeof import('node:fs/promises');
  const actual = await importActual<FsPromises>();
  const actualMkdir = actual.mkdir as unknown as (...args: Array<unknown>) => Promise<unknown>;
  const actualReadFile = actual.readFile as unknown as (...args: Array<unknown>) => Promise<unknown>;
  const actualWriteFile = actual.writeFile as unknown as (...args: Array<unknown>) => Promise<void>;
  const actualRename = actual.rename as unknown as (...args: Array<unknown>) => Promise<void>;
  const actualUnlink = actual.unlink as unknown as (...args: Array<unknown>) => Promise<void>;

  return {
    ...actual,
    mkdir: vi.fn(async (...args: Array<unknown>) => {
      const failure = fsMockState.mkdirFailures.shift();
      if (failure !== undefined) throw failure;
      return actualMkdir(...args);
    }),
    readFile: vi.fn(async (...args: Array<unknown>) => {
      const failure = fsMockState.readFileFailures.shift();
      if (failure !== undefined) throw failure;
      return actualReadFile(...args);
    }),
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
      const pause = fsMockState.renamePauses.shift();
      if (pause !== undefined) await pause;
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
  AUDIT_GROW_POOL_NAME,
  AuditGrowPoolError,
  createStoreBackedAuditGrowFactory,
  type AuditGrowRebuildErrorListener,
  type CreateStoreBackedAuditGrowFactoryOptions,
  type StoreBackedAuditGrowFactory,
} from '../templates/audit-grow/index';
import * as auditGrowBarrel from '../templates/audit-grow/index';
import {
  AuditGrowStoreError,
  createFileAuditGrowStore,
  parseAuditGrowSnapshot,
  type AuditGrowSnapshot,
  type AuditGrowStore,
  type AuditGrowStoreErrorReason,
  type AuditGrowStoreListener,
  type CreateFileAuditGrowStoreOptions,
} from '../templates/audit-grow/store';
import {
  computeBundleEntryHash,
  createTemplateLibrary,
  type AuditGrowRebuildErrorListener as PublicAuditGrowRebuildErrorListener,
  type AuditGrowSnapshot as PublicAuditGrowSnapshot,
  type AuditGrowStore as PublicAuditGrowStore,
  type AuditGrowStoreErrorReason as PublicAuditGrowStoreErrorReason,
  type AuditGrowStoreListener as PublicAuditGrowStoreListener,
  type CreateFileAuditGrowStoreOptions as PublicCreateFileAuditGrowStoreOptions,
  type CreateStoreBackedAuditGrowFactoryOptions as PublicCreateStoreBackedAuditGrowFactoryOptions,
  type RegisteredTemplate,
  type StoreBackedAuditGrowFactory as PublicStoreBackedAuditGrowFactory,
} from '../templates/index';
import * as templatesBarrel from '../templates/index';
import type { SlotValue } from '../ner/index';
import type {
  RenderTemplate,
  SlotName,
  StructuralPlan,
  Template,
} from '../types';

const DEFAULT_SLOT_GRAMMAR: ReadonlyArray<SlotName> = ['entity.name'];
const DEFAULT_RENDER_STEP_KINDS: ReadonlyArray<string> = ['query', 'render'];
const DEFAULT_STRUCTURAL_STEP_KINDS: ReadonlyArray<string> = ['query', 'ai-extract'];

interface BuildRenderTemplateOptions {
  readonly body?: string;
  readonly locale?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
  readonly template_hash?: string;
}

interface BuildRenderEntryOptions extends BuildRenderTemplateOptions {
  readonly step_kinds?: ReadonlyArray<string>;
}

interface BuildStructuralPlanOptions {
  readonly template_hash?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
}

interface BuildStructuralEntryOptions extends BuildStructuralPlanOptions {
  readonly locale?: string;
  readonly step_kinds?: ReadonlyArray<string>;
}

interface AuditGrowEntryInput {
  readonly template: Template;
  readonly locale: string;
  readonly step_kinds: ReadonlyArray<string>;
}

const buildValidRenderTemplate = (
  opts: BuildRenderTemplateOptions = {},
): RenderTemplate => {
  const body = opts.body ?? 'Hello {{contact.name}}';
  const locale = opts.locale ?? 'en';
  const slotGrammar = [...(opts.slot_grammar ?? DEFAULT_SLOT_GRAMMAR)];

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

const buildValidRenderEntry = (
  opts: BuildRenderEntryOptions = {},
): AuditGrowEntryInput => {
  const locale = opts.locale ?? 'en';

  return {
    template: buildValidRenderTemplate({ ...opts, locale }),
    locale,
    step_kinds: opts.step_kinds ?? DEFAULT_RENDER_STEP_KINDS,
  };
};

const buildValidStructuralPlan = (
  opts: BuildStructuralPlanOptions = {},
): StructuralPlan => ({
  template_hash: opts.template_hash ?? 'structural-pinned',
  kind: 'structural_plan',
  slot_grammar: opts.slot_grammar ?? DEFAULT_SLOT_GRAMMAR,
  action_class: 'read',
  short_circuit_eligible: false,
});

const buildValidStructuralEntry = (
  opts: BuildStructuralEntryOptions = {},
): AuditGrowEntryInput => ({
  template: buildValidStructuralPlan(opts),
  locale: opts.locale ?? 'en',
  step_kinds: opts.step_kinds ?? DEFAULT_STRUCTURAL_STEP_KINDS,
});

const buildHashMismatchEntry = (
  body = 'Hello {{contact.name}}',
): AuditGrowEntryInput => buildValidRenderEntry({
  body,
  template_hash: 'declared-but-wrong',
});

const makeSnapshot = (
  entries: ReadonlyArray<AuditGrowEntryInput> = [buildValidRenderEntry()],
  version = '2026-05-25-001',
): AuditGrowSnapshot => ({
  version,
  entries,
});

const toRegisteredEntry = (
  entry: AuditGrowEntryInput,
): RegisteredTemplate => ({
  template: entry.template,
  locale: entry.locale,
});

const makeSlot = (
  kind: SlotName,
  value: string,
  position = 0,
): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const expectAuditGrowStoreError = (
  run: () => unknown,
  reason: AuditGrowStoreErrorReason,
): AuditGrowStoreError => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AuditGrowStoreError);
    const error = err as AuditGrowStoreError;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected AuditGrowStoreError ${reason}`);
};

const expectAsyncAuditGrowStoreError = async (
  run: () => Promise<unknown>,
  reason: AuditGrowStoreErrorReason,
): Promise<AuditGrowStoreError> => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AuditGrowStoreError);
    const error = err as AuditGrowStoreError;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected AuditGrowStoreError ${reason}`);
};

const expectAuditGrowPoolError = (
  run: () => unknown,
): AuditGrowPoolError => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AuditGrowPoolError);
    return err as AuditGrowPoolError;
  }
  throw new Error('expected AuditGrowPoolError');
};

const resetFsMockState = (): void => {
  fsMockState.mkdirFailures.length = 0;
  fsMockState.readFileFailures.length = 0;
  fsMockState.writeFileFailures.length = 0;
  fsMockState.renameFailures.length = 0;
  fsMockState.renamePauses.length = 0;
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

const waitForCondition = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const writeSnapshotFile = async (
  path: string,
  snapshot: AuditGrowSnapshot,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
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

interface MemoryAuditGrowStore extends AuditGrowStore {
  failNextPut(error: unknown): void;
  listenerCount(): number;
  unsubscribeCalls(): number;
}

const createMemoryAuditGrowStore = (
  initial: AuditGrowSnapshot | null = null,
): MemoryAuditGrowStore => {
  let cached = initial;
  let unsubscribeCallCount = 0;
  const listeners = new Set<AuditGrowStoreListener>();
  const putFailures: unknown[] = [];

  return {
    current(): AuditGrowSnapshot | null {
      return cached;
    },
    async put(snapshot: AuditGrowSnapshot): Promise<void> {
      const failure = putFailures.shift();
      if (failure !== undefined) throw failure;
      cached = snapshot;
      for (const listener of [...listeners]) {
        try {
          listener(snapshot);
        } catch {
          // Match the file store contract: listener faults do not abort fan-out.
        }
      }
    },
    subscribe(listener: AuditGrowStoreListener): () => void {
      listeners.add(listener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        unsubscribeCallCount += 1;
        listeners.delete(listener);
      };
    },
    failNextPut(error: unknown): void {
      putFailures.push(error);
    },
    listenerCount(): number {
      return listeners.size;
    },
    unsubscribeCalls(): number {
      return unsubscribeCallCount;
    },
  };
};

let testDir: string;

beforeEach(async () => {
  resetFsMockState();
  testDir = await mkdtemp(join(tmpdir(), 'd-164-p4h-4b-'));
});

afterEach(async () => {
  resetFsMockState();
  await rm(testDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const snapshotPath = (): string => join(testDir, 'audit-grow', 'snapshot.json');

describe('D-164 P4h-4b parseAuditGrowSnapshot', () => {
  it.each([
    ['string', 'not-an-object'],
    ['array', []],
    ['null', null],
    ['number', 42],
  ])('rejects a non-object root: %s', (_name, raw) => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot(raw),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot root');
    expect(error.detail).not.toContain('snapshot.version');
  });

  it('rejects a missing version before checking missing entries', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({}),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.version');
    expect(error.detail).not.toContain('snapshot.entries');
  });

  it.each([
    ['empty', { version: '', entries: [] }],
    ['number', { version: 7, entries: [] }],
    ['null', { version: null, entries: [] }],
  ])('rejects a %s version', (_name, raw) => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot(raw),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.version');
  });

  it('rejects non-array entries', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({ version: 'v1', entries: {} }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries');
  });

  it('rejects a non-object entry', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({ version: 'v1', entries: ['bad-entry'] }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0] must be an object');
  });

  it('rejects a non-object template', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({
        version: 'v1',
        entries: [{ template: null, locale: 'en', step_kinds: ['query'] }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0].template');
  });

  it.each([
    ['missing', { template: buildValidRenderTemplate(), step_kinds: ['query'] }],
    ['empty', { template: buildValidRenderTemplate(), locale: '', step_kinds: ['query'] }],
    ['number', { template: buildValidRenderTemplate(), locale: 123, step_kinds: ['query'] }],
  ])('rejects a %s locale', (_name, entry) => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({ version: 'v1', entries: [entry] }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0].locale');
  });

  it('rejects non-array step_kinds', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({
        version: 'v1',
        entries: [{
          template: buildValidRenderTemplate(),
          locale: 'en',
          step_kinds: 'query',
        }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0].step_kinds');
  });

  it('rejects a non-string step kind with the kind index in detail', () => {
    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({
        version: 'v1',
        entries: [{
          template: buildValidRenderTemplate(),
          locale: 'en',
          step_kinds: ['query', 42],
        }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0].step_kinds[1]');
  });

  it('wraps throwing entry property access as schema_invalid', () => {
    const entry = {
      get template(): never {
        throw new Error('template getter exploded');
      },
      locale: 'en',
      step_kinds: ['query'],
    };

    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({ version: 'v1', entries: [entry] }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0]');
    expect(error.detail).toContain('property access threw');
    expect(error.detail).toContain('template getter exploded');
  });

  it('returns a typed snapshot and preserves all valid entries', () => {
    const first = buildValidRenderEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
    const second = buildValidStructuralEntry({
      template_hash: 'structural-custom',
      slot_grammar: ['date'],
    });
    const raw = { version: 'v-valid', entries: [first, second] };

    const parsed = parseAuditGrowSnapshot(raw);

    expect(parsed).toEqual(raw);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.template).toBe(first.template);
    expect(parsed.entries[1]?.template).toBe(second.template);
  });

  it('validates entry order before later entry issues', () => {
    const laterEntry = {
      get locale(): never {
        throw new Error('later locale getter should not run');
      },
      template: buildValidRenderTemplate(),
      step_kinds: ['query'],
    };

    const error = expectAuditGrowStoreError(
      () => parseAuditGrowSnapshot({
        version: 'v1',
        entries: [
          { template: null, locale: 'en', step_kinds: ['query'] },
          laterEntry,
        ],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.entries[0].template');
    expect(error.detail).not.toContain('later locale getter');
  });
});

describe('D-164 P4h-4b createFileAuditGrowStore', () => {
  it('constructs with current() null when the snapshot file is missing', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });

    expect(store.current()).toBeNull();
  });

  it('throws disk_error when parent directory creation fails', async () => {
    fsMockState.mkdirFailures.push(Object.assign(new Error('mkdir denied'), { code: 'EACCES' }));

    const error = await expectAsyncAuditGrowStoreError(
      () => createFileAuditGrowStore({ path: snapshotPath() }),
      'disk_error',
    );

    expect(error.detail).toContain('mkdir');
    expect(error.detail).toContain('mkdir denied');
  });

  it('loads an existing valid JSON snapshot into current()', async () => {
    const snapshot = makeSnapshot([buildValidRenderEntry()], 'v-existing');
    await writeSnapshotFile(snapshotPath(), snapshot);

    const store = await createFileAuditGrowStore({ path: snapshotPath() });

    expect(store.current()).toEqual(snapshot);
  });

  it('throws parse_error when the existing snapshot file is invalid JSON', async () => {
    await mkdir(dirname(snapshotPath()), { recursive: true });
    await writeFile(snapshotPath(), '{not-json', 'utf8');

    const error = await expectAsyncAuditGrowStoreError(
      () => createFileAuditGrowStore({ path: snapshotPath() }),
      'parse_error',
    );

    expect(error.detail).toContain('not valid JSON');
  });

  it('bubbles schema_invalid from parseAuditGrowSnapshot for schema-invalid JSON', async () => {
    await writeSnapshotFile(
      snapshotPath(),
      { version: '', entries: [] } as unknown as AuditGrowSnapshot,
    );

    const error = await expectAsyncAuditGrowStoreError(
      () => createFileAuditGrowStore({ path: snapshotPath() }),
      'schema_invalid',
    );

    expect(error.detail).toContain('snapshot.version');
  });

  it('throws disk_error when readFile fails with a non-ENOENT error', async () => {
    fsMockState.readFileFailures.push(Object.assign(new Error('read denied'), { code: 'EACCES' }));

    const error = await expectAsyncAuditGrowStoreError(
      () => createFileAuditGrowStore({ path: snapshotPath() }),
      'disk_error',
    );

    expect(error.detail).toContain('read');
    expect(error.detail).toContain('read denied');
  });

  it('put() writes exact JSON via temp and updates cache only after rename succeeds', async () => {
    const original = makeSnapshot([
      buildValidRenderEntry({ body: 'Original {{contact.name}}' }),
    ], 'v-original');
    const replacement = makeSnapshot([
      buildValidRenderEntry({ body: 'Replacement {{contact.name}}' }),
    ], 'v-replacement');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    await store.put(original);
    resetFsMockState();
    const listener = vi.fn<AuditGrowStoreListener>();
    store.subscribe(listener);
    const renameGate = deferred<void>();
    fsMockState.renamePauses.push(renameGate.promise);

    const pendingPut = store.put(replacement);
    await waitForCondition(() => fsMockState.renamePairs.length === 1, 'rename call');

    const tempPath = fsMockState.renamePairs[0]?.from ?? '';
    expectTempPathShape(tempPath, snapshotPath());
    expect(store.current()).toBe(original);
    expect(listener).not.toHaveBeenCalled();
    expect(await readFile(tempPath, 'utf8')).toBe(JSON.stringify(replacement));

    renameGate.resolve(undefined);
    await pendingPut;

    expect(fsMockState.renamePairs).toEqual([{ from: tempPath, to: snapshotPath() }]);
    expect(await readFile(snapshotPath(), 'utf8')).toBe(JSON.stringify(replacement));
    expect(store.current()).toBe(replacement);
    expect(listener).toHaveBeenCalledWith(replacement);
  });

  it('put() leaves no temp file after a successful rename', async () => {
    const snapshot = makeSnapshot([buildValidRenderEntry()], 'v-atomic');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });

    await store.put(snapshot);

    const tempPaths = observedTempPathsFor(snapshotPath());
    expect(tempPaths).toHaveLength(1);
    expectTempPathShape(tempPaths[0] ?? '', snapshotPath());
    expect(fsMockState.renamePairs).toEqual([{ from: tempPaths[0], to: snapshotPath() }]);
    expect(await listTempFiles(snapshotPath())).toEqual([]);
  });

  it('writeFile failure throws disk_error, unlinks temp, and preserves cache and subscribers', async () => {
    const original = makeSnapshot([
      buildValidRenderEntry({ body: 'Original {{contact.name}}' }),
    ], 'v-original');
    const failed = makeSnapshot([
      buildValidRenderEntry({ body: 'Failed {{contact.name}}' }),
    ], 'v-failed');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    await store.put(original);
    resetFsMockState();
    const listener = vi.fn<AuditGrowStoreListener>();
    store.subscribe(listener);
    fsMockState.writeFileFailures.push({
      error: Object.assign(new Error('write failed'), { code: 'EIO' }),
      createPartial: true,
    });

    const error = await expectAsyncAuditGrowStoreError(
      () => store.put(failed),
      'disk_error',
    );

    const tempPaths = observedTempPathsFor(snapshotPath());
    expect(error.detail).toContain('write');
    expect(tempPaths).toHaveLength(1);
    expect(fsMockState.unlinkPaths).toContain(tempPaths[0]);
    expect(await listTempFiles(snapshotPath())).toEqual([]);
    expect(store.current()).toBe(original);
    expect(listener).not.toHaveBeenCalled();
    expect(await readFile(snapshotPath(), 'utf8')).toBe(JSON.stringify(original));
  });

  it('rename failure throws disk_error, unlinks temp, and preserves cache and subscribers', async () => {
    const original = makeSnapshot([
      buildValidRenderEntry({ body: 'Original {{contact.name}}' }),
    ], 'v-original');
    const failed = makeSnapshot([
      buildValidRenderEntry({ body: 'Failed {{contact.name}}' }),
    ], 'v-rename-failed');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    await store.put(original);
    resetFsMockState();
    const listener = vi.fn<AuditGrowStoreListener>();
    store.subscribe(listener);
    fsMockState.renameFailures.push(Object.assign(new Error('rename failed'), { code: 'EIO' }));

    const error = await expectAsyncAuditGrowStoreError(
      () => store.put(failed),
      'disk_error',
    );

    const tempPaths = observedTempPathsFor(snapshotPath());
    expect(error.detail).toContain('rename');
    expect(tempPaths).toHaveLength(1);
    expect(fsMockState.unlinkPaths).toContain(tempPaths[0]);
    expect(await listTempFiles(snapshotPath())).toEqual([]);
    expect(store.current()).toBe(original);
    expect(listener).not.toHaveBeenCalled();
    expect(await readFile(snapshotPath(), 'utf8')).toBe(JSON.stringify(original));
  });

  it('put() fires subscribers after cache update exactly once in registration order', async () => {
    const snapshot = makeSnapshot([buildValidRenderEntry()], 'v-subscribers');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const events: string[] = [];

    store.subscribe((next) => {
      events.push(`first:${next.version}:${store.current()?.version ?? 'null'}`);
    });
    store.subscribe((next) => {
      events.push(`second:${next.version}:${store.current()?.version ?? 'null'}`);
    });

    await store.put(snapshot);

    expect(events).toEqual([
      'first:v-subscribers:v-subscribers',
      'second:v-subscribers:v-subscribers',
    ]);
  });

  it('subscribe() returns an idempotent unsubscribe', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const listener = vi.fn<AuditGrowStoreListener>();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    unsubscribe();
    await store.put(makeSnapshot([], 'v-after-unsubscribe'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('contains a throwing subscriber and still invokes sibling subscribers', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const throwing = vi.fn<AuditGrowStoreListener>(() => {
      throw new Error('subscriber failed');
    });
    const sibling = vi.fn<AuditGrowStoreListener>();
    store.subscribe(throwing);
    store.subscribe(sibling);
    const snapshot = makeSnapshot([], 'v-contained');

    await store.put(snapshot);

    expect(throwing).toHaveBeenCalledWith(snapshot);
    expect(sibling).toHaveBeenCalledWith(snapshot);
  });

  it('snapshots fan-out so a listener unsubscribed mid-put still fires for the current put', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const events: string[] = [];
    let unsubscribeSecond!: () => void;
    const first: AuditGrowStoreListener = (snapshot) => {
      events.push(`first:${snapshot.version}`);
      unsubscribeSecond();
    };
    const second: AuditGrowStoreListener = (snapshot) => {
      events.push(`second:${snapshot.version}`);
    };
    store.subscribe(first);
    unsubscribeSecond = store.subscribe(second);

    await store.put(makeSnapshot([], 'v-one'));
    await store.put(makeSnapshot([], 'v-two'));

    expect(events).toEqual(['first:v-one', 'second:v-one', 'first:v-two']);
  });

  it('snapshots fan-out so a listener subscribed mid-put fires on the next put only', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const events: string[] = [];
    let subscribedLate = false;
    const late: AuditGrowStoreListener = (snapshot) => {
      events.push(`late:${snapshot.version}`);
    };
    store.subscribe((snapshot) => {
      events.push(`first:${snapshot.version}`);
      if (!subscribedLate) {
        subscribedLate = true;
        store.subscribe(late);
      }
    });
    store.subscribe((snapshot) => {
      events.push(`second:${snapshot.version}`);
    });

    await store.put(makeSnapshot([], 'v-one'));
    await store.put(makeSnapshot([], 'v-two'));

    expect(events).toEqual([
      'first:v-one',
      'second:v-one',
      'first:v-two',
      'second:v-two',
      'late:v-two',
    ]);
  });

  it('two close puts use distinct random hex temp suffixes', async () => {
    const first = makeSnapshot([
      buildValidRenderEntry({ body: 'First {{contact.name}}' }),
    ], 'v-temp-1');
    const second = makeSnapshot([
      buildValidRenderEntry({ body: 'Second {{contact.name}}' }),
    ], 'v-temp-2');
    const store = await createFileAuditGrowStore({ path: snapshotPath() });

    await store.put(first);
    await store.put(second);

    const tempPaths = observedTempPathsFor(snapshotPath());
    expect(tempPaths).toHaveLength(2);
    tempPaths.forEach((tempPath) => expectTempPathShape(tempPath, snapshotPath()));
    expect(new Set(tempPaths).size).toBe(2);
  });

  it('ten sequential puts leave the last snapshot on disk and no orphan temps', async () => {
    const store = await createFileAuditGrowStore({ path: snapshotPath() });
    const snapshots = Array.from({ length: 10 }, (_value, index) => (
      makeSnapshot(
        [buildValidRenderEntry({ body: `Value ${index} {{contact.name}}` })],
        `v-${index}`,
      )
    ));

    for (const snapshot of snapshots) {
      await store.put(snapshot);
    }

    const last = snapshots[snapshots.length - 1];
    expect(store.current()).toBe(last);
    expect(await readFile(snapshotPath(), 'utf8')).toBe(JSON.stringify(last));
    expect(await listTempFiles(snapshotPath())).toEqual([]);
  });
});

describe('D-164 P4h-5 createStoreBackedAuditGrowFactory', () => {
  it('cold-boots from an empty store as an empty audit-grow pool', () => {
    const store = createMemoryAuditGrowStore(null);

    const factory = createStoreBackedAuditGrowFactory({ store });

    expect(factory.pool.name).toBe(AUDIT_GROW_POOL_NAME);
    expect(factory.pool.list()).toEqual([]);
  });

  it('reflects existing valid snapshot entries at construction', () => {
    const entries = [
      buildValidRenderEntry({
        body: 'Email {{contact.email}}',
        slot_grammar: ['entity.email'],
      }),
      buildValidStructuralEntry({
        template_hash: 'structural-existing',
        slot_grammar: ['date'],
      }),
    ];
    const store = createMemoryAuditGrowStore(makeSnapshot(entries, 'v-existing'));

    const factory = createStoreBackedAuditGrowFactory({ store });

    expect(factory.pool.list()).toEqual(entries.map(toRegisteredEntry));
    expect(factory.pool.list()).toHaveLength(2);
  });

  it('throws AuditGrowPoolError directly for invalid existing snapshot entries', () => {
    const store = createMemoryAuditGrowStore(
      makeSnapshot([buildHashMismatchEntry()], 'v-invalid-boot'),
    );
    const onRebuildError = vi.fn<AuditGrowRebuildErrorListener>();

    const error = expectAuditGrowPoolError(() => {
      createStoreBackedAuditGrowFactory({ store, onRebuildError });
    });

    expect(error.failures).toHaveLength(1);
    expect(error.failures[0]?.reason).toBe('hash_mismatch');
    expect(onRebuildError).not.toHaveBeenCalled();
  });

  it('refreshes pool.list() on the next call after a successful store.put()', async () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([], 'v-empty'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const nextEntry = buildValidRenderEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });

    expect(factory.pool.list()).toEqual([]);
    await store.put(makeSnapshot([nextEntry], 'v-next'));

    expect(factory.pool.list()).toEqual([toRegisteredEntry(nextEntry)]);
  });

  it('keeps the pool object identity stable across updates', async () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([], 'v-empty'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const pool = factory.pool;

    await store.put(makeSnapshot([buildValidRenderEntry({ body: 'One {{contact.name}}' })], 'v-one'));
    await store.put(makeSnapshot([buildValidRenderEntry({ body: 'Two {{contact.name}}' })], 'v-two'));

    expect(factory.pool).toBe(pool);
    expect(factory.pool.list()).toHaveLength(1);
    expect(factory.pool.list()[0]?.template).toMatchObject({ body: 'Two {{contact.name}}' });
  });

  it('leaves pool.list() unchanged when store.put() fails with disk_error', async () => {
    const original = buildValidRenderEntry({ body: 'Original {{contact.name}}' });
    const store = createMemoryAuditGrowStore(makeSnapshot([original], 'v-original'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const prior = factory.pool.list();
    const diskError = new AuditGrowStoreError({
      reason: 'disk_error',
      detail: 'write failed',
    });
    store.failNextPut(diskError);

    await expect(store.put(makeSnapshot([
      buildValidRenderEntry({ body: 'Replacement {{contact.name}}' }),
    ], 'v-failed'))).rejects.toBe(diskError);

    expect(factory.pool.list()).toBe(prior);
  });

  it('reports live validation failures through onRebuildError and keeps the prior frozen list', async () => {
    const original = buildValidRenderEntry({ body: 'Original {{contact.name}}' });
    const store = createMemoryAuditGrowStore(makeSnapshot([original], 'v-original'));
    const onRebuildError = vi.fn<AuditGrowRebuildErrorListener>();
    const factory = createStoreBackedAuditGrowFactory({ store, onRebuildError });
    const prior = factory.pool.list();

    await store.put(makeSnapshot([buildHashMismatchEntry('Invalid {{contact.name}}')], 'v-invalid'));

    expect(onRebuildError).toHaveBeenCalledTimes(1);
    expect(onRebuildError.mock.calls[0]?.[0]).toBeInstanceOf(AuditGrowPoolError);
    expect(factory.pool.list()).toBe(prior);
  });

  it('reports unexpected live rebuild errors through onRebuildError and keeps the prior list', async () => {
    const original = buildValidRenderEntry({ body: 'Original {{contact.name}}' });
    const store = createMemoryAuditGrowStore(makeSnapshot([original], 'v-original'));
    const onRebuildError = vi.fn<AuditGrowRebuildErrorListener>();
    const factory = createStoreBackedAuditGrowFactory({ store, onRebuildError });
    const prior = factory.pool.list();
    const unexpected = new Error('slot grammar exploded');
    const throwingTemplate = {
      template_hash: 'structural-throws',
      kind: 'structural_plan',
      get slot_grammar(): never {
        throw unexpected;
      },
      action_class: 'read',
      short_circuit_eligible: false,
    } as unknown as StructuralPlan;

    // The structural-plan getter throws after validation, during
    // createAuditGrowPool's freeze step, so this exercises the adapter's
    // non-AuditGrowPoolError live-rebuild path without touching disk I/O.
    await store.put(makeSnapshot([{
      template: throwingTemplate,
      locale: 'en',
      step_kinds: DEFAULT_STRUCTURAL_STEP_KINDS,
    }], 'v-unexpected'));

    expect(onRebuildError).toHaveBeenCalledWith(unexpected);
    expect(factory.pool.list()).toBe(prior);
  });

  it('contains a throwing onRebuildError and does not tear down store fan-out', async () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([], 'v-empty'));
    const onRebuildError = vi.fn<AuditGrowRebuildErrorListener>(() => {
      throw new Error('handler failed');
    });
    createStoreBackedAuditGrowFactory({ store, onRebuildError });
    const sibling = vi.fn<AuditGrowStoreListener>();
    store.subscribe(sibling);
    const invalid = makeSnapshot([buildHashMismatchEntry()], 'v-invalid');

    await store.put(invalid);

    expect(onRebuildError).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledWith(invalid);
  });

  it('stop() unsubscribes so later store.put() calls no longer refresh the pool', async () => {
    const original = buildValidRenderEntry({ body: 'Original {{contact.name}}' });
    const store = createMemoryAuditGrowStore(makeSnapshot([original], 'v-original'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const prior = factory.pool.list();

    factory.stop();
    await store.put(makeSnapshot([
      buildValidRenderEntry({ body: 'Replacement {{contact.name}}' }),
    ], 'v-replacement'));

    expect(factory.pool.list()).toBe(prior);
    expect(store.listenerCount()).toBe(0);
  });

  it('stop() is idempotent', () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([], 'v-empty'));
    const factory = createStoreBackedAuditGrowFactory({ store });

    factory.stop();
    factory.stop();

    expect(store.unsubscribeCalls()).toBe(1);
    expect(store.listenerCount()).toBe(0);
  });

  it('returns frozen arrays, entries, templates, and slot grammars through the live pool', () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([
      buildValidRenderEntry({
        body: 'Email {{contact.email}}',
        slot_grammar: ['entity.email'],
      }),
    ], 'v-frozen'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const list = factory.pool.list();
    const first = list[0];

    if (first === undefined) throw new Error('expected first pool entry');
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.template)).toBe(true);
    expect(Object.isFrozen(first.template.slot_grammar)).toBe(true);
  });

  it('makes live pool refresh visible to a library.match-like consumer', async () => {
    const store = createMemoryAuditGrowStore(makeSnapshot([], 'v-empty'));
    const factory = createStoreBackedAuditGrowFactory({ store });
    const library = createTemplateLibrary({ pools: [factory.pool] });
    const query = {
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com', 6)],
      locale: 'en',
    };
    const nextEntry = buildValidRenderEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });

    expect(library.match(query)).toBeNull();
    await store.put(makeSnapshot([nextEntry], 'v-live'));

    expect(library.match(query)).toBe(factory.pool.list()[0]?.template);
  });
});

describe('D-164 P4h-4b audit-grow export surface', () => {
  it('re-exports the store-backed adapter surface via templates/audit-grow/index', () => {
    const onRebuildError: AuditGrowRebuildErrorListener = () => undefined;
    const options: CreateStoreBackedAuditGrowFactoryOptions = {
      store: createMemoryAuditGrowStore(null),
      onRebuildError,
    };
    const factory: StoreBackedAuditGrowFactory =
      auditGrowBarrel.createStoreBackedAuditGrowFactory(options);

    expect(auditGrowBarrel.createStoreBackedAuditGrowFactory).toBe(
      createStoreBackedAuditGrowFactory,
    );
    expect(factory.pool.name).toBe(AUDIT_GROW_POOL_NAME);
    factory.stop();
  });

  it('re-exports the store-backed adapter surface via templates/index', () => {
    const onRebuildError: PublicAuditGrowRebuildErrorListener = () => undefined;
    const options: PublicCreateStoreBackedAuditGrowFactoryOptions = {
      store: createMemoryAuditGrowStore(null),
      onRebuildError,
    };
    const factory: PublicStoreBackedAuditGrowFactory =
      templatesBarrel.createStoreBackedAuditGrowFactory(options);

    expect(templatesBarrel.createStoreBackedAuditGrowFactory).toBe(
      createStoreBackedAuditGrowFactory,
    );
    expect(factory.pool.name).toBe(AUDIT_GROW_POOL_NAME);
    factory.stop();
  });

  it('re-exports the audit-grow store surface through both barrels', () => {
    const snapshot = makeSnapshot([], 'v-types');
    const auditGrowListener: AuditGrowStoreListener = vi.fn();
    const publicListener: PublicAuditGrowStoreListener = vi.fn();
    const auditGrowStore: AuditGrowStore = createMemoryAuditGrowStore(snapshot);
    const publicStore: PublicAuditGrowStore = auditGrowStore;
    const auditGrowOptions: CreateFileAuditGrowStoreOptions = { path: snapshotPath() };
    const publicOptions: PublicCreateFileAuditGrowStoreOptions = auditGrowOptions;
    const auditGrowReasons: ReadonlyArray<AuditGrowStoreErrorReason> = [
      'disk_error',
      'parse_error',
      'schema_invalid',
    ];
    const publicReasons: ReadonlyArray<PublicAuditGrowStoreErrorReason> = auditGrowReasons;
    const publicSnapshot: PublicAuditGrowSnapshot = snapshot;

    auditGrowListener(snapshot);
    publicListener(publicSnapshot);

    expect(auditGrowBarrel.AuditGrowStoreError).toBe(AuditGrowStoreError);
    expect(auditGrowBarrel.parseAuditGrowSnapshot).toBe(parseAuditGrowSnapshot);
    expect(auditGrowBarrel.createFileAuditGrowStore).toBe(createFileAuditGrowStore);
    expect(templatesBarrel.AuditGrowStoreError).toBe(AuditGrowStoreError);
    expect(templatesBarrel.parseAuditGrowSnapshot).toBe(parseAuditGrowSnapshot);
    expect(templatesBarrel.createFileAuditGrowStore).toBe(createFileAuditGrowStore);
    expect(publicStore.current()).toBe(snapshot);
    expect(auditGrowOptions.path).toBe(snapshotPath());
    expect(publicOptions.path).toBe(snapshotPath());
    expect(publicReasons).toEqual(['disk_error', 'parse_error', 'schema_invalid']);
    expect(auditGrowListener).toHaveBeenCalledWith(snapshot);
    expect(publicListener).toHaveBeenCalledWith(snapshot);
  });

  it('exports the same createStoreBackedAuditGrowFactory identity through both barrels', () => {
    expect(templatesBarrel.createStoreBackedAuditGrowFactory).toBe(
      auditGrowBarrel.createStoreBackedAuditGrowFactory,
    );
  });
});
