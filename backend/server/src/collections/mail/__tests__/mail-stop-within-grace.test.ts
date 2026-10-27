/** A mailbox stop returns within the grace, however long its servers take.
 *
 *  The lifecycle drain stops every mailbox in `pause_collections`, a step with
 *  5 s; a stop that waits out a remote party makes an update refuse to swap
 *  versions, while the process exits right after the drain anyway. Each case
 *  holds a remote call open for good and checks three things: the stop
 *  returns within `STOP_GRACE_MS`, the call in flight was told to stop (its
 *  signal aborted), and the provider's cursor did not move — the next start
 *  reads the same range again. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { STOP_GRACE_MS } from '../../../lifecycle/settle-within.js';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createCollectionRegistry } from '../../registry.js';
import { CollectionStoppedError } from '../../stop-signal.js';
import { composeMailStack } from '../compose.js';
import { handleMailDelete, handleMailEnrollSmtp } from '../enroll.js';
import { createGmailProvider, type GmailProviderConfig } from '../gmail-provider.js';
import { createGraphProvider, type GraphProviderConfig } from '../graph-provider.js';
import { createMailCollection } from '../mail-collection.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';
import type { MailProvider } from '../provider.js';
import { createSmtpProvider } from '../smtp-provider.js';
import type { SmtpMailOptions } from '../smtp.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Whether a promise has settled yet, readable without awaiting it. */
const track = (work: Promise<unknown>): { readonly done: boolean } => {
  const state = { done: false };
  void work.then(() => { state.done = true; }, () => { state.done = true; });
  return state;
};

const makeStore = (seed: Record<string, string> = {}): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async getAll() { return Object.fromEntries(data); },
  };
};

const tokens = (provider: 'gmail' | 'graph'): Record<string, string> => ({
  [`${provider}.work.access_token`]: 'at',
  [`${provider}.work.expires_at`]: String(Date.now() + 3_600_000),
  [`${provider}.work.refresh_token`]: 'rt',
});

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://login.example.test/token',
  clientId: 'cid',
  clientSecret: 'secret',
};

type Answer = { status: number; body: unknown } | 'held' | 'held-ignoring-abort';

interface HeldCall {
  url: string;
  signal: AbortSignal | undefined;
}

/** A fetcher that answers by URL. `held` never answers on its own but rejects
 *  when its signal aborts, as the bounded fetcher does; `held-ignoring-abort`
 *  never settles at all — a fetcher that ignores the signal. */
const scriptedFetcher = (route: (url: string) => Answer): { fetcher: HttpFetcher; held: HeldCall[] } => {
  const held: HeldCall[] = [];
  const fetcher: HttpFetcher = (url, init) => {
    const answer = route(url);
    if (answer === 'held' || answer === 'held-ignoring-abort') {
      held.push({ url, signal: init?.signal });
      return new Promise((_resolve, reject) => {
        if (answer === 'held') {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }
      });
    }
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      async json() { return answer.body; },
      async text() { return JSON.stringify(answer.body); },
    });
  };
  return { fetcher, held };
};

const ok = (body: unknown): Answer => ({ status: 200, body });
const missing: Answer = { status: 404, body: {} };

const gmailConfig: GmailProviderConfig = { account_slug: 'work', backfill_days: 7, poll_seconds: 30 };

const rawMessage = (id: string): string => Buffer.from([
  'From: alice@example.com',
  'To: bob@example.com',
  `Subject: ${id}`,
  `Message-ID: <${id}@example.com>`,
  'Date: Mon, 1 Jan 2024 10:00:00 +0000',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'hello',
].join('\r\n')).toString('base64url');

describe('Gmail — a stop aborts what it is waiting on', () => {
  it('aborts the poll startSync runs at once, keeps the history watermark, and starts no loop', async () => {
    const store = makeStore({ ...tokens('gmail'), 'gmail.work.history_id': '100' });
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.includes('/history?')) {
        return ok({ history: [{ id: '101', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }], historyId: '101' });
      }
      if (url.includes('/messages/m1')) return 'held';
      return missing;
    });
    const scheduler = vi.fn(() => () => undefined);
    const provider = createGmailProvider({
      slug: 'work', config: () => gmailConfig, accountStore: store, providerConfig, fetcher, scheduler,
    });
    await provider.connect();

    const starting = provider.startSync(async () => {});
    starting.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    expect(held[0]!.signal?.aborted).toBe(true);
    await expect(starting).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(store.data.get('gmail.work.history_id')).toBe('100');
    expect(scheduler).not.toHaveBeenCalled();
  });

  it('stops waiting for a scheduled poll after the grace when its request ignores the abort', async () => {
    vi.useFakeTimers();
    const store = makeStore({ ...tokens('gmail'), 'gmail.work.history_id': '100' });
    let historyReads = 0;
    const { fetcher, held } = scriptedFetcher((url) => {
      if (!url.includes('/history?')) return missing;
      historyReads += 1;
      // The poll startSync runs at once finds nothing new; the next one hangs.
      return historyReads === 1 ? ok({ historyId: '100' }) : 'held-ignoring-abort';
    });
    const provider = createGmailProvider({
      slug: 'work', config: () => ({ ...gmailConfig, poll_seconds: 1 }), accountStore: store, providerConfig, fetcher,
    });
    await provider.connect();
    await provider.startSync(async () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held).toHaveLength(1);

    const closing = track(provider.close());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(closing.done).toBe(false);
    expect(held[0]!.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(closing.done).toBe(true);
    expect(store.data.get('gmail.work.history_id')).toBe('100');
  });

  it('rejects a first scan stopped between messages, so its backfill is not marked complete', async () => {
    const store = makeStore(tokens('gmail'));
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.includes('/profile')) return ok({ historyId: '100' });
      if (url.includes('/messages?')) return ok({ messages: [{ id: 'm1', threadId: 't' }, { id: 'm2', threadId: 't' }] });
      if (url.includes('/messages/m1')) return ok({ id: 'm1', threadId: 't', labelIds: ['INBOX'], raw: rawMessage('m1') });
      if (url.includes('/messages/m2')) return 'held';
      return missing;
    });
    const provider = createGmailProvider({
      slug: 'work', config: () => gmailConfig, accountStore: store, providerConfig, fetcher, scheduler: () => () => undefined,
    });
    await provider.connect();
    const scanned: string[] = [];
    const scanning = provider.initialScan({
      backfill_days: 7,
      onMessage: async (message) => { scanned.push(message.source_id); return true; },
    });
    scanning.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(scanning).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    expect(scanned).toEqual(['m1']);
    // The boundary taken before the listing stays, for the next scan to reuse.
    expect(store.data.get('gmail.work.history_id')).toBe('100');
  });
});

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DELTA_KEY = 'graph.work.delta_link.headers_v1.inbox';
const graphConfig: GraphProviderConfig = { account_slug: 'work', backfill_days: 7, poll_seconds: 30 };

describe('Graph mail — a stop aborts what it is waiting on', () => {
  it('stops a delta seed between pages of the change feed and stores no delta link', async () => {
    const store = makeStore(tokens('graph'));
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.includes('$skiptoken=page2')) return 'held';
      if (url.includes('/mailFolders/inbox/messages/delta?')) {
        return ok({ value: [], '@odata.nextLink': `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=page2` });
      }
      return missing;
    });
    const provider = createGraphProvider({
      slug: 'work', config: () => graphConfig, accountStore: store, providerConfig, fetcher, scheduler: () => () => undefined,
    });
    await provider.connect();
    const scanning = provider.initialScan({ backfill_days: 7, onMessage: async () => true });
    scanning.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(scanning).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    expect(store.data.has(DELTA_KEY)).toBe(false);
  });

  it('aborts a delta poll waiting on a message\'s attachments and keeps the stored delta link', async () => {
    const before = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=before`;
    const store = makeStore({ ...tokens('graph'), [DELTA_KEY]: before });
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url === before) {
        return ok({
          value: [{ id: 'm1', subject: 'with file', hasAttachments: true, receivedDateTime: '2026-10-01T00:00:00Z' }],
          '@odata.deltaLink': `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=after`,
        });
      }
      if (url.includes('/me/messages/m1/attachments')) return 'held';
      return missing;
    });
    const provider = createGraphProvider({
      slug: 'work', config: () => graphConfig, accountStore: store, providerConfig, fetcher, scheduler: () => () => undefined,
    });
    await provider.connect();
    const delivered: unknown[] = [];
    const starting = provider.startSync(async (event) => { delivered.push(event); });
    starting.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(starting).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    expect(delivered).toEqual([]);
    expect(store.data.get(DELTA_KEY)).toBe(before);
  });
});

describe('MailCollection — a stop bounds its wait on the provider', () => {
  it('returns within the grace while the provider never finishes closing or starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-stop-grace-'));
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    let closes = 0;
    let connecting!: () => void;
    const connectStarted = new Promise<void>((resolve) => { connecting = resolve; });
    const provider: MailProvider = {
      kind: 'imap', slug: 'work', sendCapable: false, mutationCapable: false, accountEmail: '',
      // A connect and a close stuck on a server that never answers.
      connect: () => { connecting(); return new Promise<void>(() => {}); },
      async initialScan() {},
      async startSync() { return async () => {}; },
      close: () => { closes += 1; return new Promise<void>(() => {}); },
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    };
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota: 1_000_000, reservePct: 10, surface: 'collection:mail:work' }),
      bus: createWarehouseEventBus(),
      slug: 'work',
      provider,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1_000_000 }),
    });
    void collection.sync.start();
    await connectStarted;

    vi.useFakeTimers();
    const closing = track(collection.close());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(closing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closing.done).toBe(true);
    // Closing is what cancels the stuck connect, and it began at once.
    expect(closes).toBe(1);
  });
});

describe('SMTP-only mailbox — a send in flight', () => {
  const input = { name: 'smtp-only', host: 'smtp.example.test', port: 587, secure: false,
    username: 'login', password: 'smtp-fixture-secret', from: 'hello@example.test' };
  const mail = { to: ['customer@example.test'], subject: 'Your document', body_text: 'Here it is.' };

  const harness = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-stop-smtp-'));
    const db = new Database(':memory:');
    const accountStore = makeStore();
    let submitting!: () => void;
    const submitted = new Promise<void>((resolve) => { submitting = resolve; });
    // The SMTP server takes the message and never answers.
    const sendMail = vi.fn((_message: SmtpMailOptions) => { submitting(); return new Promise<never>(() => {}); });
    const factory = vi.fn(() => ({ verify: vi.fn(async () => true), sendMail, close: vi.fn() }));
    const registry = createCollectionRegistry();
    const stack = composeMailStack(db, {
      blobs: createBlobStore(join(dir, 'blobs')),
      bus: createWarehouseEventBus(),
      getGate: (slug) => createStorageGate({ quota: 100_000_000, reservePct: 10, surface: `collection:mail:${slug}` }),
    }, { accountStore, smtpFactory: factory, getCollectionRegistry: () => registry });
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { accountStore, sendMail, factory, stack, submitted };
  };

  const journal = (store: ReturnType<typeof makeStore>): Array<{ status: string }> =>
    [...store.data.entries()]
      .filter(([key]) => key.startsWith('smtp.smtp-only.outgoing.'))
      .map(([, value]) => JSON.parse(value) as { status: string });

  it('stops the stack within the grace, and keeps the send as an outcome nobody resends', async () => {
    const h = harness();
    await handleMailEnrollSmtp(h.stack.enrollDeps, input);
    await h.stack.firstScans();
    const sending = h.stack.listLive()[0]!.send(mail);
    sending.catch(() => {});
    await h.submitted;

    vi.useFakeTimers();
    const disposing = track(h.stack.disposeAll());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(disposing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(disposing.done).toBe(true);
    vi.useRealTimers();

    // Its outcome is unknown: the journal keeps it as pending, and the next
    // start's replay neither sends it again nor files it as sent.
    expect(journal(h.accountStore)).toEqual([expect.objectContaining({ status: 'pending' })]);
    const restarted = createSmtpProvider({
      slug: input.name,
      config: { host: input.host, port: input.port, secure: false, username: input.username,
        password: input.password, from: input.from },
      accountStore: h.accountStore,
      smtpFactory: h.factory,
    });
    const replayed: unknown[] = [];
    await restarted.localSent!.replay(async (message) => { replayed.push(message); });
    expect(replayed).toEqual([]);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(journal(h.accountStore)).toHaveLength(1);
  });

  it('still lets a deletion wait for the send to finish before removing its journal', async () => {
    const h = harness();
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    let submitting!: () => void;
    const submitted = new Promise<void>((resolve) => { submitting = resolve; });
    h.sendMail.mockImplementation(async () => { submitting(); await accepted; return { response: '250 accepted' } as never; });
    await handleMailEnrollSmtp(h.stack.enrollDeps, input);
    await h.stack.firstScans();
    const sending = h.stack.listLive()[0]!.send(mail);
    await submitted;

    const deleting = track(handleMailDelete(h.stack.enrollDeps, { slug: input.name }));
    // Past the stop's grace, the send is still running: nothing is deleted.
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 100));
    expect(deleting.done).toBe(false);
    expect(h.accountStore.data.has('smtp.smtp-only.password')).toBe(true);

    accept();
    await sending;
    await vi.waitFor(() => expect(deleting.done).toBe(true));
    expect([...h.accountStore.data.keys()].filter((key) => key.startsWith('smtp.smtp-only.'))).toEqual([]);
    await h.stack.disposeAll();
  });
});
