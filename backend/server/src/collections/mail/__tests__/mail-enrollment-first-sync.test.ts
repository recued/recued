import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  createWebclientRpcConn,
  WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS,
  type WebclientRpcRequestEnvelope,
} from '../../../../../../apps/webclient/src/realtime/rpc-conn.js';
import type { WebclientWsClient } from '../../../../../../apps/webclient/src/realtime/ws-client.js';
import { handleCollectionEnrollOAuth } from '../../collection-handler.js';
import { createCollectionRegistry } from '../../registry.js';
import { composeMailStack } from '../compose.js';
import { handleMailDelete, handleMailList } from '../enroll.js';
import type { HttpFetcher, OAuthAccountStore } from '../oauth.js';

const response = (body: unknown, status = 200): Awaited<ReturnType<HttpFetcher>> => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.useRealTimers(); }
});

/** Real OAuth exchange, Gmail provider, SQLite instance store, and collection
 * lifecycle. Only Google's HTTP responses and the WS delivery are fixtures. */
const setup = (opts: { vaultLocked?: boolean; emptyFirstPage?: boolean; backfillDays?: number } = {}) => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();
  const credentials = new Map<string, string>();
  const accountStore: OAuthAccountStore = {
    async get(key) { return credentials.get(key) ?? null; },
    async set(key, value) { credentials.set(key, value); },
    async delete(key) { credentials.delete(key); },
  };
  let releaseScan!: (status: number) => void;
  const scan = new Promise<number>((resolve) => { releaseScan = resolve; });
  let scanStatus = 200;
  let scanRequests = 0;
  const scanQueries: string[] = [];
  let historyRequests = 0;
  let exchanges = 0;
  let vaultUnlocked = opts.vaultLocked !== true;
  const fetcher: HttpFetcher = async (url) => {
    const parsed = new URL(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      exchanges += 1;
      return response({ access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    }
    if (parsed.pathname.endsWith('/profile')) {
      return response({ emailAddress: 'owner@example.com', historyId: '100' });
    }
    if (parsed.pathname.endsWith('/messages')) {
      scanRequests += 1;
      scanQueries.push(parsed.searchParams.get('q') ?? '');
      if (opts.emptyFirstPage && !parsed.searchParams.has('pageToken')) {
        return response({ messages: [], nextPageToken: 'second-page' });
      }
      scanStatus = await scan;
      return response(scanStatus === 200 ? { messages: [] } : { error: {
        message: 'Mailbox unavailable', errors: [{ reason: scanStatus === 403 ? 'insufficientPermissions' : 'backendError' }],
      } }, scanStatus);
    }
    if (parsed.pathname.endsWith('/history')) {
      historyRequests += 1;
      return response(scanStatus === 200 ? { history: [], historyId: '101' } : { error: { message: 'Mailbox temporarily unavailable' } }, scanStatus);
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const stack = composeMailStack(db, {
    blobs: { async put() { return 'blob:fixture'; }, async get() { return null; }, async delete() {} } as never,
    getGate: () => createStorageGate({ quota: 1024 * 1024, reservePct: 0, surface: 'mail:work' }),
    bus,
  }, {
    accountStore,
    getCollectionRegistry: () => registry,
    isVaultUnlocked: () => vaultUnlocked,
    oauthConfig: () => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret', tokenUrl: 'https://oauth2.googleapis.com/token' }),
    fetcher,
  });
  const enroll = () => handleCollectionEnrollOAuth({ registry, mailEnroll: stack.enrollDeps }, {
    provider: 'gmail', account_slug: 'work', code: 'fixture-code', redirect_uri: 'https://fixture.example/oauth',
    ...(opts.backfillDays !== undefined ? { backfill_days: opts.backfillDays } : {}),
  });
  const listeners = new Set<(message: unknown) => void>();
  const ws: WebclientWsClient = {
    state: () => 'connected', queuedSends: () => 0, clearSendQueue() {},
    async connect() {}, async disconnect() {}, applyRotatedBearer() {},
    onState: () => () => {},
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async send(message) {
      const request = message as WebclientRpcRequestEnvelope;
      const handling = request.method === 'collection.mail.enrollOAuth'
        ? enroll() : Promise.resolve(handleMailList(stack.enrollDeps));
      void handling.then((result) => {
        for (const listener of listeners) listener({ type: 'rpc_result', request_id: request.request_id, result });
      }, (error: unknown) => {
        const rpc = error instanceof RpcError ? error : new RpcError('internal_error', String(error));
        for (const listener of listeners) listener({ type: 'rpc_result', request_id: request.request_id,
          error: { code: rpc.code, message: rpc.message } });
      });
    },
  };
  const conn = createWebclientRpcConn({ ws });
  cleanups.push(async () => {
    releaseScan(200);
    conn.dispose();
    await stack.disposeAll();
    bus.dispose();
    db.close();
  });
  return { stack, registry, credentials, conn, enroll, scanQueries,
    releaseScan, unlock: () => { vaultUnlocked = true; },
    counts: () => ({ scanRequests, historyRequests, exchanges }),
  };
};

describe('Mail enrollment does not wait for the first sync', () => {
  it('D-325 carries the chosen history window through the RPC bridge into the actual Gmail scan', async () => {
    const h = setup({ backfillDays: 400 });
    await h.enroll();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stack.instances.get('mail', 'work')?.config.backfill_days).toBe(400);
    expect(h.scanQueries).toEqual(['newer_than:400d']);
    h.releaseScan(200);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('answers the OAuth RPC before a slow Gmail backfill reaches the webclient deadline', async () => {
    const h = setup();
    const received: unknown[] = [];
    const reply = h.conn.call('collection.mail.enrollOAuth', {
      provider: 'gmail', account_slug: 'work', code: 'fixture-code', redirect_uri: 'https://fixture.example/oauth',
    }).then((result) => { received.push(result); }, (error: unknown) => { received.push(error); });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.counts()).toMatchObject({ scanRequests: 1, exchanges: 1 });
    expect(h.registry.get('mail', 'work')).toBe(h.stack.listLive()[0]);
    expect(received).toEqual([{ ok: true, account_key_prefix: 'gmail.work' }]);
    expect(h.conn.pendingCount()).toBe(0);
    expect(h.stack.instances.get('mail', 'work')).toMatchObject({ last_synced_at: null, backfill_complete: false });
    expect(h.credentials.get('gmail.work.refresh_token')).toBe('fixture-refresh');
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]?.sync_status).toEqual({
      access_verified: false, initial_sync_complete: false,
    });

    await vi.advanceTimersByTimeAsync(WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS + 5_000);
    expect(received).toEqual([{ ok: true, account_key_prefix: 'gmail.work' }]);
    await expect(h.conn.call('collection.mail.list', undefined)).resolves.toMatchObject({
      instances: [expect.objectContaining({ slug: 'work', last_synced_at: null })],
    });
    expect(h.counts().scanRequests).toBe(1);

    h.releaseScan(200);
    await vi.advanceTimersByTimeAsync(0);
    await reply;
    expect(h.stack.instances.get('mail', 'work')).toMatchObject({ auth_state: 'healthy', backfill_complete: true });
    expect(h.stack.instances.get('mail', 'work')?.last_synced_at).toBeGreaterThan(0);
    expect(h.counts().historyRequests).toBe(1);
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]?.sync_status).toEqual({
      access_verified: true, initial_sync_complete: true,
    });
  });

  it('returns from authentication restart while a large mailbox still syncs, and drains it on stop', async () => {
    const h = setup({ vaultLocked: true }); await h.enroll();
    await h.stack.enrollDeps.authenticationChange!.stop('work'); h.unlock();
    let restarted = false;
    const restarting = h.stack.enrollDeps.authenticationChange!.restart('work').then(() => { restarted = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.counts().scanRequests).toBe(1); expect(restarted).toBe(true);
    await vi.advanceTimersByTimeAsync(WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS + 5_000);
    expect(h.stack.instances.get('mail', 'work')?.backfill_complete).toBe(false);
    let stopped = false;
    const stopping = h.stack.enrollDeps.authenticationChange!.stop('work').then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(false);
    h.releaseScan(200); await restarting; await stopping;
    expect(h.stack.listLive()).toEqual([]); expect(h.counts().historyRequests).toBe(0);
    expect(h.credentials.get('gmail.work.refresh_token')).toBe('fixture-refresh');
    expect(h.stack.instances.get('mail', 'work')?.backfill_complete).toBe(false);
  });

  it('verifies access on an empty first page while the remaining backfill runs in the background', async () => {
    const h = setup({ emptyFirstPage: true });
    await expect(h.enroll()).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.counts().scanRequests).toBe(2);
    expect(h.stack.instances.get('mail', 'work')?.last_synced_at).toBeNull();
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]?.sync_status).toEqual({
      access_verified: true, initial_sync_complete: false,
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.stack.instances.get('mail', 'work')?.backfill_complete).toBe(false);
    h.releaseScan(200);
    await vi.advanceTimersByTimeAsync(0);
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]?.sync_status).toEqual({
      access_verified: true, initial_sync_complete: true,
    });
  });

  it('keeps a later permission refusal separate from verified access and never calls the import complete', async () => {
    const h = setup({ emptyFirstPage: true });
    await h.enroll();
    await vi.advanceTimersByTimeAsync(0);
    h.releaseScan(403);
    await vi.advanceTimersByTimeAsync(0);
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]).toMatchObject({
      auth_state: 'expired', sync_status: { access_verified: true, initial_sync_complete: false },
    });
    expect(h.stack.instances.get('mail', 'work')?.backfill_complete).toBe(false);
    expect(h.credentials.get('gmail.work.refresh_token')).toBe('fixture-refresh');
    expect(h.counts().historyRequests).toBe(0);
  });

  it('reports a background sync failure through the mailbox without losing the saved sign-in', async () => {
    const h = setup();
    let enrolled = false;
    void h.enroll().then(() => { enrolled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(enrolled).toBe(true);

    h.releaseScan(503);
    await vi.advanceTimersByTimeAsync(0);
    expect((await handleMailList(h.stack.enrollDeps)).instances[0]).toMatchObject({
      slug: 'work', auth_state: 'degraded', last_synced_at: null,
    });
    expect(h.credentials.get('gmail.work.refresh_token')).toBe('fixture-refresh');
  });

  it('drains a background scan before deleting its mailbox and credentials', async () => {
    const h = setup();
    let enrolled = false;
    void h.enroll().then(() => { enrolled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(enrolled).toBe(true);
    const collection = h.stack.listLive()[0]!;
    let deleted = false;
    const deleting = handleMailDelete(h.stack.enrollDeps, { slug: 'work' }).then(() => { deleted = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toBe(false);

    h.releaseScan(200);
    await deleting;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stack.instances.get('mail', 'work')).toBeNull();
    expect(h.registry.get('mail', 'work')).toBeUndefined();
    expect(h.credentials.has('gmail.work.refresh_token')).toBe(false);
    expect(h.counts().historyRequests).toBe(0);
    expect(collection.mailboxAccessVerified).toBe(false);
  });

  it('keeps shutdown responsible for a scan after the enrollment RPC has returned', async () => {
    const h = setup();
    let enrolled = false;
    void h.enroll().then(() => { enrolled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(enrolled).toBe(true);
    let disposed = false;
    const disposing = h.stack.disposeAll().then(() => { disposed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toBe(false);

    h.releaseScan(200);
    await disposing;
    expect(h.stack.listLive()).toEqual([]);
    expect(h.stack.instances.get('mail', 'work')).toMatchObject({ last_synced_at: null, backfill_complete: false });
    expect(h.counts().historyRequests).toBe(0);
  });

  it('still defers all provider sync while the vault is locked', async () => {
    const h = setup({ vaultLocked: true });
    await expect(h.enroll()).resolves.toMatchObject({ ok: true });
    expect(h.registry.get('mail', 'work')).toBeDefined();
    expect(h.counts().scanRequests).toBe(0);

    h.unlock();
    const resuming = h.stack.resumeSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.counts().scanRequests).toBe(1);
    h.releaseScan(200);
    await resuming;
    expect(h.stack.instances.get('mail', 'work')?.backfill_complete).toBe(true);
  });
});
