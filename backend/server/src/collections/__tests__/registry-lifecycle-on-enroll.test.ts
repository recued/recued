import Database from 'better-sqlite3';
import type {
  CollectionInstanceRow,
  CollectionPlatform,
  FileCollectionCaps,
} from '@recued/contracts';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEventBus,
} from '@recued/warehouse-events';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mailAdapterMocks = vi.hoisted(() => ({
  createImapProvider: vi.fn(({ slug }: { slug: string }) => ({
    kind: 'imap',
    slug,
    sendCapable: false,
    accountEmail: `${slug}@example.test`,
    connect: vi.fn(async () => {}),
    initialScan: vi.fn(async () => {}),
    startSync: vi.fn(async () => async () => {}),
    close: vi.fn(async () => {}),
    health: vi.fn(() => ({
      last_successful_sync_at: 0,
      error_count_24h: 0,
      pending_queue_size: 0,
    })),
  })),
}));

vi.mock('../mail/imap-provider.js', () => ({
  createImapProvider: mailAdapterMocks.createImapProvider,
}));

import type { BlobStore } from '../../storage/blob-store.js';
import type { OAuthAccountStore } from '../mail/oauth.js';
import {
  composeMailStack,
  type MailStack,
} from '../mail/compose.js';
import {
  createCollectionRegistry,
  type CollectionRegistry,
} from '../registry.js';
import type { Collection, CollectionSyncAdapter } from '../types.js';

const MAIL_CAPS: FileCollectionCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
};

const stubCollection = (
  platform: CollectionPlatform,
  slug: string,
  overrides: Partial<Collection> = {},
): Collection => {
  const sync: CollectionSyncAdapter = {
    start: async () => {},
    stop: async () => {},
  };
  return {
    platform,
    slug,
    gate: {} as StorageGate,
    sync,
    upsert: () => {},
    delete: () => false,
    get: () => null,
    list: () => [],
    search: () => [],
    health: () => ({
      platform,
      slug,
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
    }),
    runRetention: async () => ({
      pruned_count: 0,
      bytes_freed: 0,
      blob_hashes_freed: [],
      duration_ms: 0,
    }),
    close: async () => {},
    ...overrides,
  };
};

describe('createCollectionRegistry.unregister', () => {
  it('removes the entry from both get() and list()', () => {
    const registry = createCollectionRegistry();
    const collection = stubCollection('mail', 'work');
    registry.register(collection);

    registry.unregister('mail', 'work');

    expect(registry.get('mail', 'work')).toBeUndefined();
    expect(registry.list()).not.toContain(collection);
  });

  it('returns true when present and false when absent', () => {
    const registry = createCollectionRegistry();
    registry.register(stubCollection('mail', 'work'));

    expect(registry.unregister('mail', 'work')).toBe(true);
    expect(registry.unregister('mail', 'work')).toBe(false);
  });

  it('allows the same platform and slug to be registered again', () => {
    const registry = createCollectionRegistry();
    const original = stubCollection('mail', 'work');
    const replacement = stubCollection('mail', 'work');
    registry.register(original);
    registry.unregister('mail', 'work');

    expect(() => registry.register(replacement)).not.toThrow();
    expect(registry.get('mail', 'work')).toBe(replacement);
  });

  it('does not close the unregistered collection', () => {
    const close = vi.fn(async () => {});
    const registry = createCollectionRegistry();
    registry.register(stubCollection('mail', 'work', { close }));

    registry.unregister('mail', 'work');

    expect(close).not.toHaveBeenCalled();
  });
});

const blobs = (): BlobStore =>
  ({
    root: '/test/blobs',
    put: vi.fn(async () => 'unused'),
    get: vi.fn(async () => null),
    has: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
    sizeOf: vi.fn(async () => null),
    sweepOrphans: vi.fn(async () => 0),
    totalBytes: vi.fn(async () => 0),
  }) as unknown as BlobStore;

const accountStore = (): OAuthAccountStore => ({
  get: vi.fn(async () => 'test-password'),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
});

interface MailHarness {
  db: Database.Database;
  bus: WarehouseEventBus;
  registry?: CollectionRegistry;
  stack: MailStack;
}

const harnesses: MailHarness[] = [];

const makeMailHarness = (withRegistry = true): MailHarness => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const registry = withRegistry ? createCollectionRegistry() : undefined;
  const stack = composeMailStack(
    db,
    {
      blobs: blobs(),
      getGate: (slug) => createStorageGate({
        surface: `collection:mail:${slug}`,
        quota: 1_000_000,
        reservePct: 0,
      }),
      bus,
    },
    {
      accountStore: accountStore(),
      ...(registry ? { getCollectionRegistry: () => registry } : {}),
    },
  );
  const harness = { db, bus, registry, stack };
  harnesses.push(harness);
  return harness;
};

const requireRegistry = (harness: MailHarness): CollectionRegistry => {
  if (!harness.registry) throw new Error('test harness has no shared registry');
  return harness.registry;
};

const upsertMailRow = (
  harness: MailHarness,
  slug: string,
): CollectionInstanceRow => {
  const row = harness.stack.instances.upsert({
    platform: 'mail',
    slug,
    adapter_type: 'imap',
    config: {
      host: 'imap.example.test',
      port: 993,
      secure: true,
      username: `${slug}@example.test`,
      folders: ['INBOX'],
    },
    caps: MAIL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });
  return {
    platform: row.platform,
    slug: row.slug,
    adapter_type: row.adapter_type,
    caps: row.caps,
    auth_state: row.auth_state,
    last_synced_at: row.last_synced_at,
  };
};

const enrollAfterBoot = async (
  harness: MailHarness,
  slug: string,
): Promise<void> => {
  const onEnrolled = harness.stack.enrollDeps.onEnrolled;
  if (!onEnrolled) throw new Error('mail stack did not wire onEnrolled');
  await onEnrolled(upsertMailRow(harness, slug));
};

const deleteAfterBoot = async (
  harness: MailHarness,
  slug: string,
): Promise<void> => {
  const onDeleted = harness.stack.enrollDeps.onDeleted;
  if (!onDeleted) throw new Error('mail stack did not wire onDeleted');
  harness.stack.instances.delete('mail', slug);
  await onDeleted(slug);
};

beforeEach(() => {
  mailAdapterMocks.createImapProvider.mockClear();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.stack.disposeAll();
    harness.bus.dispose();
    harness.db.close();
  }
});

describe('composeMailStack shared-registry lifecycle', () => {
  it('registers an account enrolled after stack construction', async () => {
    const harness = makeMailHarness();
    const registry = requireRegistry(harness);

    await enrollAfterBoot(harness, 'work');

    expect(registry.get('mail', 'work')).toBeDefined();
  });

  it('unregisters an account when the enrollment is deleted', async () => {
    const harness = makeMailHarness();
    const registry = requireRegistry(harness);
    await enrollAfterBoot(harness, 'work');

    await deleteAfterBoot(harness, 'work');

    expect(registry.get('mail', 'work')).toBeUndefined();
  });

  it('delete then re-enroll registers a new collection instance', async () => {
    const harness = makeMailHarness();
    const registry = requireRegistry(harness);
    await enrollAfterBoot(harness, 'work');
    const original = registry.get('mail', 'work');
    expect(original).toBeDefined();

    await deleteAfterBoot(harness, 'work');
    await enrollAfterBoot(harness, 'work');

    const replacement = registry.get('mail', 'work');
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(original);
  });

  it('startAll after an enroll is idempotent in the shared registry', async () => {
    const harness = makeMailHarness();
    const registry = requireRegistry(harness);
    await enrollAfterBoot(harness, 'work');

    await expect(harness.stack.startAll()).resolves.toBeUndefined();

    expect(
      registry
        .list()
        .filter((collection) =>
          collection.platform === 'mail' && collection.slug === 'work'),
    ).toHaveLength(1);
  });

  it('starts and stops cleanly when getCollectionRegistry is absent', async () => {
    const harness = makeMailHarness(false);
    upsertMailRow(harness, 'work');

    await expect(harness.stack.startAll()).resolves.toBeUndefined();
    expect(harness.stack.listLive()).toHaveLength(1);
    await expect(harness.stack.disposeAll()).resolves.toBeUndefined();
    expect(harness.stack.listLive()).toHaveLength(0);
  });
});
