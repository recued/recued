/** MailCollection durable sync-outcome reporting.
 *
 *  These tests keep the instance row real (SQLite-backed) and drive every
 *  transition through the provider lifecycle. In particular, provider health
 *  is not inbound-sync evidence: SEND and sent-reconciliation can advance that
 *  provider-owned clock without delivering a message to the collection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CollectionAuthState, FileCollectionCaps } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import {
  createMailCollection,
  type MailCollection,
} from '../mail-collection.js';
import { OAuthError } from '../oauth.js';
import type {
  CanonicalMessage,
  MailProvider,
  ProviderHealth,
  ProviderSyncCallback,
} from '../provider.js';

const SLUG = 'sync-outcome';
const BIG_QUOTA = 100 * 1024 * 1024;
const START_TIME = 1_700_000_000_000;

const MAIL_CAPS: FileCollectionCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
};

const message = (source_id: string): CanonicalMessage => ({
  source_id,
  rfc_message_id: `<${source_id}@example.com>`,
  from: 'alice@example.com',
  to: ['me@example.com'],
  cc: [],
  subject: `Message ${source_id}`,
  thread_id: `thread-${source_id}`,
  folder_or_label: 'INBOX',
  is_read: false,
  has_attachments: false,
  received_at: START_TIME - 1_000,
  body_text: 'hello',
});

interface FakeProviderOptions {
  connectError?: unknown;
  initialScanError?: unknown;
  initialScanWait?: Promise<void>;
  initialMessages?: CanonicalMessage[];
  startSyncError?: unknown;
  closeError?: unknown;
  healthLastSuccessfulSyncAt?: number;
}

interface FakeProviderHandle {
  provider: MailProvider;
  deliver(msg: CanonicalMessage): Promise<void>;
  closeCalls(): number;
}

const makeFakeProvider = (hooks: FakeProviderOptions = {}): FakeProviderHandle => {
  let syncCallback: ProviderSyncCallback | undefined;
  let closeCallCount = 0;

  const provider: MailProvider = {
    kind: 'gmail',
    slug: SLUG,
    sendCapable: false,
    accountEmail: 'me@example.com',
    async connect() {
      if (hooks.connectError !== undefined) throw hooks.connectError;
    },
    async initialScan(opts) {
      if (hooks.initialScanError !== undefined) throw hooks.initialScanError;
      await hooks.initialScanWait;
      for (const msg of hooks.initialMessages ?? []) {
        if (!(await opts.onMessage(msg))) break;
      }
    },
    async startSync(cb) {
      if (hooks.startSyncError !== undefined) throw hooks.startSyncError;
      syncCallback = cb;
      return async () => {};
    },
    async close() {
      closeCallCount += 1;
      if (hooks.closeError !== undefined) throw hooks.closeError;
    },
    health(): ProviderHealth {
      return {
        last_successful_sync_at: hooks.healthLastSuccessfulSyncAt ?? 0,
        error_count_24h: 0,
        pending_queue_size: 0,
      };
    },
  };

  return {
    provider,
    closeCalls: () => closeCallCount,
    async deliver(msg) {
      if (!syncCallback) throw new Error('fake provider sync callback is not registered');
      await syncCallback({ kind: 'created', source_id: msg.source_id, message: msg });
    },
  };
};

interface HarnessOptions {
  provider?: FakeProviderOptions;
  initialAuthState?: CollectionAuthState;
  withInstances?: boolean;
  failBlobPut?: boolean;
  blobPutGate?: { started(): void; wait: Promise<void> };
}

interface Harness {
  dir: string;
  db: Database.Database;
  instances: CollectionInstanceStore;
  provider: FakeProviderHandle;
  collection: MailCollection;
  advance(ms: number): void;
  close(): Promise<void>;
}

const newHarness = (opts: HarnessOptions = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-sync-outcome-'));
  const db = new Database(':memory:');
  let now = START_TIME;
  const instances = createInstanceStore({ db, now: () => now });
  instances.upsert({
    platform: 'mail',
    slug: SLUG,
    adapter_type: 'gmail',
    config: {},
    caps: MAIL_CAPS,
    auth_state: opts.initialAuthState ?? 'healthy',
    last_synced_at: null,
  });

  const provider = makeFakeProvider(opts.provider);
  const baseBlobs = createBlobStore(join(dir, 'blobs'));
  const blobs: BlobStore = opts.failBlobPut || opts.blobPutGate
    ? {
        ...baseBlobs,
        async put(bytes) {
          if (opts.failBlobPut) throw new Error('blob store unavailable');
          opts.blobPutGate?.started();
          await opts.blobPutGate?.wait;
          return baseBlobs.put(bytes);
        },
      }
    : baseBlobs;
  const collection = createMailCollection({
    db,
    blobs,
    gate: createStorageGate({
      quota: BIG_QUOTA,
      reservePct: 10,
      surface: `collection:mail:${SLUG}`,
    }),
    bus: createWarehouseEventBus(),
    slug: SLUG,
    provider: provider.provider,
    config: () => ({
      backfill_days: 30,
      retention_days: 365,
      quota_bytes: BIG_QUOTA,
    }),
    now: () => now,
    ...(opts.withInstances === false ? {} : { instances }),
  });

  return {
    dir,
    db,
    instances,
    provider,
    collection,
    advance(ms) { now += ms; },
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let harnesses: Harness[] = [];
const withHarness = (opts: HarnessOptions = {}): Harness => {
  const harness = newHarness(opts);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.close();
  }
  harnesses = [];
});

describe('MailCollection sync-outcome reporting', () => {
  it('rejects a live delivery when durable body storage fails', async () => {
    const h = withHarness({ failBlobPut: true });
    await h.collection.sync.start();

    await expect(h.provider.deliver({
      ...message('blob-failure'),
      body_text: 'x'.repeat(70 * 1024),
    })).rejects.toThrow('blob store unavailable');

    expect(h.collection.list({ platform: 'mail', slug: SLUG })).toEqual([]);
    expect(h.collection.health().error_count_24h).toBeGreaterThan(0);
  });

  it('does not acknowledge a body write that outlives its sync generation', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const h = withHarness({
      blobPutGate: { started: markStarted, wait },
    });
    await h.collection.sync.start();
    const delivering = h.provider.deliver({
      ...message('stale-generation'),
      body_text: 'x'.repeat(70 * 1024),
    });
    await started;

    await h.collection.sync.stop();
    release();

    await expect(delivering).rejects.toThrow('generation is no longer active');
    expect(h.collection.list({ platform: 'mail', slug: SLUG })).toEqual([]);
  });

  describe('connect failure classification', () => {
    it.each([
      {
        label: "OAuthError('token_refresh_failed', 401)",
        error: new OAuthError('token_refresh_failed', 401, 'refresh rejected'),
        expected: 'expired' as const,
      },
      {
        label: "OAuthError('token_refresh_failed', 429)",
        error: new OAuthError('token_refresh_failed', 429, 'refresh rate limited'),
        expected: 'degraded' as const,
      },
      {
        label: "OAuthError('token_refresh_failed', 503)",
        error: new OAuthError('token_refresh_failed', 503, 'token service unavailable'),
        expected: 'degraded' as const,
      },
      {
        label: "OAuthError('missing_refresh_token', 401)",
        error: new OAuthError('missing_refresh_token', 401, 'no refresh token'),
        expected: 'expired' as const,
      },
      {
        label: 'a non-OAuthError',
        error: new Error('network socket closed'),
        expected: 'degraded' as const,
      },
    ])('reports $label as $expected', async ({ error, expected }) => {
      const harness = withHarness({ provider: { connectError: error } });

      await expect(harness.collection.sync.start()).rejects.toBe(error);

      const row = harness.instances.get('mail', SLUG);
      expect(row?.auth_state).toBe(expected);
      expect(row?.last_synced_at).toBeNull();
    });
  });

  it('does not treat a send-advanced provider health clock as inbound sync success', async () => {
    const harness = withHarness({
      initialAuthState: 'degraded',
      provider: { healthLastSuccessfulSyncAt: START_TIME - 1 },
    });

    await harness.collection.sync.start();

    const row = harness.instances.get('mail', SLUG);
    expect(row?.auth_state).toBe('degraded');
    expect(row?.last_synced_at).toBeNull();
  });

  it('reports healthy with a real timestamp after the live sync callback delivers a message', async () => {
    const harness = withHarness({ initialAuthState: 'degraded' });
    await harness.collection.sync.start();

    await harness.provider.deliver(message('live-1'));

    const row = harness.instances.get('mail', SLUG);
    expect(row?.auth_state).toBe('healthy');
    expect(row?.last_synced_at).toBeGreaterThan(0);
  });

  it('throttles sync-clock writes to one per 60-second interval', async () => {
    const harness = withHarness({ initialAuthState: 'degraded' });
    const updateAuthState = vi.spyOn(harness.instances, 'updateAuthState');
    await harness.collection.sync.start();

    await harness.provider.deliver(message('burst-1'));
    harness.advance(10_000);
    await harness.provider.deliver(message('burst-2'));
    harness.advance(20_000);
    await harness.provider.deliver(message('burst-3'));
    harness.advance(29_999);
    await harness.provider.deliver(message('burst-4'));

    expect(updateAuthState).toHaveBeenCalledTimes(1);

    harness.advance(2);
    await harness.provider.deliver(message('after-interval'));

    expect(updateAuthState).toHaveBeenCalledTimes(2);
    expect(updateAuthState).toHaveBeenLastCalledWith('mail', SLUG, {
      auth_state: 'healthy',
      last_synced_at: START_TIME + 60_001,
    });
  });

  // `startSync` throwing is the "history backfilled, but the live poll loop
  // never came up" case — `sync.start()` swallows it (state = 'error' + a log)
  // and RESOLVES, so the durable row is the only trace a caller can see. The
  // classifier must apply here exactly as it does on connect.
  it.each([
    {
      // THE case that matters: a revoked / expired grant arrives as HTTP 400
      // with `error: invalid_grant`. Only the reason distinguishes it from the
      // four other RFC 6749 400s, and only this one is fixed by re-consenting.
      label: "OAuthError(400, 'invalid_grant')",
      error: new OAuthError('token_refresh_failed', 400, 'grant revoked', 'invalid_grant'),
      expected: 'expired' as const,
    },
    {
      // Same status, different reason: OUR client is misconfigured. Sending the
      // user to a consent screen cannot fix it, so it must not say "re-auth".
      label: "OAuthError(400, 'invalid_client')",
      error: new OAuthError('token_refresh_failed', 400, 'bad client', 'invalid_client'),
      expected: 'degraded' as const,
    },
    {
      // A token-endpoint 403 with no parseable reason stays conservative.
      label: "OAuthError(403, no reason)",
      error: new OAuthError('token_refresh_failed', 403, 'forbidden'),
      expected: 'degraded' as const,
    },
    {
      label: "OAuthError(500, no reason)",
      error: new OAuthError('token_refresh_failed', 500, 'upstream boom'),
      expected: 'degraded' as const,
    },
  ])('reports a startSync failure of $label as $expected (fallback path)', async ({ error, expected }) => {
    const harness = withHarness({ provider: { startSyncError: error } });

    // Resolves rather than rejects — the swallow is why the row matters.
    await expect(harness.collection.sync.start()).resolves.toBeUndefined();

    const row = harness.instances.get('mail', SLUG);
    expect(row?.auth_state).toBe(expected);
    expect(row?.last_synced_at).toBeNull();
  });

  it('reports an initialScan failure as degraded and recovers on a later message', async () => {
    const harness = withHarness({
      provider: { initialScanError: new Error('initial scan failed') },
    });

    await harness.collection.sync.start();
    expect(harness.instances.get('mail', SLUG)?.auth_state).toBe('degraded');
    expect(harness.instances.get('mail', SLUG)?.last_synced_at).toBeNull();

    harness.advance(1);
    await harness.provider.deliver(message('recovery'));

    const recovered = harness.instances.get('mail', SLUG);
    expect(recovered?.auth_state).toBe('healthy');
    expect(recovered?.last_synced_at).toBe(START_TIME + 1);
  });

  it('runs the reporting lifecycle without an instance store', async () => {
    const harness = withHarness({
      withInstances: false,
      provider: { initialScanError: new Error('scan unavailable') },
    });

    await expect(harness.collection.sync.start()).resolves.toBeUndefined();
    await expect(harness.provider.deliver(message('dbless-live'))).resolves.toBeUndefined();
    await expect(harness.collection.sync.stop()).resolves.toBeUndefined();
  });

  it('close invalidates an in-flight scan before it can arm live sync', async () => {
    let release!: () => void;
    const initialScanWait = new Promise<void>((resolve) => { release = resolve; });
    const harness = withHarness({ provider: { initialScanWait } });
    const starting = harness.collection.sync.start();
    await Promise.resolve();

    const closing = harness.collection.close();
    release();
    await Promise.all([starting, closing]);
    expect(harness.provider.closeCalls()).toBe(2);
    await expect(harness.provider.deliver(message('late'))).rejects.toThrow(
      /sync callback is not registered/,
    );

    expect(harness.collection.list({ platform: 'mail', slug: SLUG })).toEqual([]);
    expect(harness.instances.get('mail', SLUG)?.last_synced_at).toBeNull();
    await harness.collection.sync.start();
    expect(harness.collection.list({ platform: 'mail', slug: SLUG })).toEqual([]);
  });

  it('close reports a provider teardown failure', async () => {
    const providerOptions: FakeProviderOptions = {};
    const harness = withHarness({ provider: providerOptions });
    await harness.collection.sync.start();
    providerOptions.closeError = new Error('close boom');

    await expect(harness.collection.close()).rejects.toThrow(/failed to stop/);

    providerOptions.closeError = undefined;
  });
});
