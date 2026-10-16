/** D-318 step 2 — proof (a): each provider asked whether the owner's mailbox
 *  SENT one exact message (by its RFC Message-ID).
 *
 *  ⛔ The Message-ID comes from mail anyone can send to the chat mailbox, so it
 *  is attacker-chosen. Each provider's search is wider than an exact match
 *  (Gmail's `q` operators, IMAP's substring `SEARCH HEADER`, an OData filter),
 *  so every case below that matters is one where the SEARCH returns a message
 *  and the exact compare must still refuse it. A failed read must never look
 *  like "not sent" either: the door asks again on `not_found`, and gives up on
 *  nothing the provider did not answer. */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchQueryObject, MailboxObject, SearchObject } from 'imapflow';

import { createBlobStore } from '../../../storage/blob-store.js';
import { createMailCollection } from '../mail-collection.js';
import type { MailProvider, ProviderHealth } from '../provider.js';

import { createGmailProvider, GMAIL_SEND_SCOPE, type GmailProviderConfig } from '../gmail-provider.js';
import { createGraphProvider, GRAPH_SEND_SCOPE, type GraphProviderConfig } from '../graph-provider.js';
import { createImapProvider, type ImapClient, type ImapProviderConfig } from '../imap-provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

const MESSAGE_ID = 'CAF=req-1.x7@mail.example.test';
const SENT_AT = Date.UTC(2026, 9, 14, 9, 30, 0);
const ENCODED_SUBJECT = `=?UTF-8?B?${Buffer.from('ask: café hours').toString('base64')}?=`;

const makeStore = (seed: Record<string, string>): OAuthAccountStore => {
  const data = new Map(Object.entries(seed));
  return {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
};

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return body; },
  async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
});

describe('D-318 Gmail Sent lookup by Message-ID', () => {
  const providerConfig: OAuthProviderConfig = { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid' };
  const config: GmailProviderConfig = {
    account_slug: 'me',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'],
  };
  const gmail = (fetcher: HttpFetcher) => createGmailProvider({
    slug: 'me',
    config: () => config,
    accountStore: makeStore({
      'gmail.me.access_token': 'token',
      'gmail.me.expires_at': String(Date.now() + 3_600_000),
      'gmail.me.refresh_token': 'refresh',
    }),
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
  const metadata = (id: string, headers: Record<string, string>, labelIds = ['SENT']) => ({
    id,
    threadId: 't-1',
    labelIds,
    internalDate: String(SENT_AT),
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });

  it('finds the message in one rfc822msgid search under the SENT label and reads its To and Subject', async () => {
    const calls: URL[] = [];
    const provider = gmail(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith('/messages')) {
        return response(200, { messages: [{ id: 'g-1', threadId: 't-1' }] });
      }
      if (parsed.pathname.endsWith('/messages/g-1')) {
        return response(200, metadata('g-1', {
          'Message-ID': `<${MESSAGE_ID}>`,
          To: '"Recued Chat" <Chat@Example.test>, Other <other@example.test>',
          Subject: ENCODED_SUBJECT,
        }));
      }
      return response(404, { error: 'unmapped' });
    });

    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID })).resolves.toEqual({
      status: 'found',
      matches: [{ to: ['Chat@Example.test', 'other@example.test'], subject: 'ask: café hours', sent_at: SENT_AT }],
    });
    const [search, read] = calls;
    expect(search!.searchParams.get('q')).toBe(`rfc822msgid:${MESSAGE_ID}`);
    expect(search!.searchParams.getAll('labelIds')).toEqual(['SENT']);
    expect(search!.searchParams.get('maxResults')).toBe('5');
    expect(read!.searchParams.get('format')).toBe('metadata');
    expect(read!.searchParams.getAll('metadataHeaders')).toEqual(['Message-ID', 'To', 'Subject']);
    expect(calls).toHaveLength(2);
  });

  it('refuses a hit whose Message-ID is not exactly the one asked for, or that is not SENT', async () => {
    const provider = gmail(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/messages')) {
        return response(200, { messages: [{ id: 'near' }, { id: 'unsent' }] });
      }
      if (parsed.pathname.endsWith('/messages/near')) {
        return response(200, metadata('near', { 'Message-ID': `<x${MESSAGE_ID}>`, To: 'chat@example.test', Subject: 'ask: hi' }));
      }
      if (parsed.pathname.endsWith('/messages/unsent')) {
        return response(200, metadata('unsent', { 'Message-ID': `<${MESSAGE_ID}>`, To: 'chat@example.test', Subject: 'ask: hi' }, ['INBOX']));
      }
      return response(404, { error: 'unmapped' });
    });

    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'not_found' });
  });

  it('answers not_found from an empty search without reading any message', async () => {
    const calls: string[] = [];
    const provider = gmail(async (url) => {
      calls.push(url);
      return response(200, { resultSizeEstimate: 0 });
    });
    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'not_found' });
    expect(calls).toHaveLength(1);
  });

  it('never reads a failed search as not sent', async () => {
    const provider = gmail(async () => response(500, { error: 'backend' }));
    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });

  it('never reads a failed message read as not sent', async () => {
    const provider = gmail(async (url) => new URL(url).pathname.endsWith('/messages')
      ? response(200, { messages: [{ id: 'g-1' }] })
      : response(429, { error: 'rate' }));
    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});

describe('D-318 Graph Sent lookup by Message-ID', () => {
  const providerConfig: OAuthProviderConfig = {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: 'cid',
  };
  const config: GraphProviderConfig = {
    account_slug: 'me',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GRAPH_SEND_SCOPE, 'Mail.Read'],
  };
  const graph = (fetcher: HttpFetcher) => createGraphProvider({
    slug: 'me',
    config: () => config,
    accountStore: makeStore({
      'graph.me.access_token': 'token',
      'graph.me.expires_at': String(Date.now() + 3_600_000),
      'graph.me.refresh_token': 'refresh',
    }),
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
  const sent = (internetMessageId: string) => ({
    id: 'graph-1',
    internetMessageId,
    subject: 'ask: café hours',
    sentDateTime: new Date(SENT_AT).toISOString(),
    toRecipients: [
      { emailAddress: { name: 'Recued Chat', address: 'Chat@Example.test' } },
      { emailAddress: { address: 'other@example.test' } },
    ],
  });

  it('filters Sent Items on the bracketed internetMessageId and reads To, Subject and the sent time', async () => {
    const calls: URL[] = [];
    const provider = graph(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith('/me/mailFolders/sentitems/messages')) {
        return response(200, { value: [sent(`<${MESSAGE_ID}>`)] });
      }
      return response(404, { error: 'unmapped' });
    });

    await expect(provider.lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID })).resolves.toEqual({
      status: 'found',
      matches: [{ to: ['Chat@Example.test', 'other@example.test'], subject: 'ask: café hours', sent_at: SENT_AT }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get('$filter')).toBe(`internetMessageId eq '<${MESSAGE_ID}>'`);
    expect(calls[0]!.searchParams.get('$top')).toBe('5');
    expect(calls[0]!.searchParams.get('$select')).toBe('internetMessageId,toRecipients,subject,sentDateTime');
  });

  it('doubles a quote in the id, and still refuses a hit that is not the exact id', async () => {
    // A forged message's id is its sender's to choose; one shaped to widen the
    // filter must stay a literal, and whatever the filter returns is compared.
    const forged = "x' or internetMessageId ne 'y@evil.test";
    const filters: string[] = [];
    const provider = graph(async (url) => {
      filters.push(new URL(url).searchParams.get('$filter') ?? '');
      return response(200, { value: [sent('<owner-real@example.test>')] });
    });

    await expect(provider.lookupSentByMessageId!({ rfc_message_id: forged }))
      .resolves.toEqual({ status: 'not_found' });
    expect(filters).toEqual([`internetMessageId eq '<x'' or internetMessageId ne ''y@evil.test>'`]);
  });

  it('answers not_found from an empty page, and unavailable from a failed one', async () => {
    await expect(graph(async () => response(200, { value: [] }))
      .lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID })).resolves.toEqual({ status: 'not_found' });
    await expect(graph(async () => response(503, { error: 'busy' }))
      .lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});

interface FakeSentMessage {
  uid: number;
  messageId: string;
  to: string[];
  subject: string;
}

class SentLookupImapClient extends EventEmitter implements ImapClient {
  usable = true;
  opened: Array<{ path: string; readOnly: boolean }> = [];
  searches: SearchObject[] = [];
  fetches: Array<{ range: string | number[]; query: FetchQueryObject }> = [];
  logoutCalls = 0;
  closeCalls = 0;

  constructor(
    private readonly sentMessages: FakeSentMessage[],
    private readonly options: { failConnect?: boolean; folders?: Array<{ path: string; specialUse?: string }> } = {},
  ) { super(); }

  async connect(): Promise<void> {
    if (this.options.failConnect) throw new Error('connection refused');
  }
  async logout(): Promise<void> { this.logoutCalls++; this.usable = false; }
  close(): void { this.closeCalls++; this.usable = false; }
  async mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<MailboxObject> {
    this.opened.push({ path, readOnly: options?.readOnly === true });
    return { path, delimiter: '/', flags: new Set(), exists: this.sentMessages.length } as unknown as MailboxObject;
  }
  // `SEARCH HEADER` is a substring match, as a real server's is.
  async search(query: SearchObject): Promise<number[]> {
    this.searches.push(query);
    const wanted = String((query.header as Record<string, string>)['message-id'] ?? '');
    return this.sentMessages.filter((m) => m.messageId.includes(wanted)).map((m) => m.uid);
  }
  async *fetch(range: string | number[], query: FetchQueryObject): AsyncIterable<any> {
    this.fetches.push({ range, query });
    const uids = new Set(Array.isArray(range) ? range : []);
    for (const m of this.sentMessages) {
      if (!uids.has(m.uid)) continue;
      yield {
        uid: m.uid,
        internalDate: new Date(SENT_AT),
        envelope: {
          messageId: m.messageId,
          subject: m.subject,
          to: m.to.map((address) => ({ address })),
        },
      };
    }
  }
  async idle(): Promise<boolean> { return true; }
  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return this.options.folders ?? [{ path: 'INBOX' }, { path: 'Sent Items', specialUse: '\\Sent' }];
  }
}

describe('D-318 IMAP Sent lookup by Message-ID', () => {
  const config: ImapProviderConfig = {
    host: 'imap.example.test',
    port: 993,
    secure: true,
    username: 'owner@example.test',
    password: 'secret',
    folders: ['INBOX'],
  };
  const imap = (client: SentLookupImapClient) => createImapProvider({ slug: 'me', config: () => config, clientFactory: () => client });

  it('opens the Sent folder read-only, searches the header, and keeps only the exact id', async () => {
    const client = new SentLookupImapClient([
      { uid: 7, messageId: `<${MESSAGE_ID}>`, to: ['Chat@Example.test'], subject: 'ask: café hours' },
      // Contains the asked-for id, so the server's substring search returns it.
      { uid: 8, messageId: `<a${MESSAGE_ID}>`, to: ['chat@example.test'], subject: 'ask: café hours' },
    ]);

    await expect(imap(client).lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID })).resolves.toEqual({
      status: 'found',
      matches: [{ to: ['Chat@Example.test'], subject: 'ask: café hours', sent_at: SENT_AT }],
    });
    expect(client.opened).toEqual([{ path: 'Sent Items', readOnly: true }]);
    expect(client.searches).toEqual([{ header: { 'message-id': MESSAGE_ID } }]);
    expect(client.fetches[0]!.query).toMatchObject({ envelope: true, internalDate: true });
    expect(client.fetches[0]!.query).not.toHaveProperty('source');
    expect(client.logoutCalls).toBe(1);
  });

  it('answers not_found without fetching when nothing matches', async () => {
    const client = new SentLookupImapClient([
      { uid: 9, messageId: '<other@example.test>', to: ['chat@example.test'], subject: 'hi' },
    ]);
    await expect(imap(client).lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'not_found' });
    expect(client.fetches).toEqual([]);
    expect(client.logoutCalls).toBe(1);
  });

  it('never reads a refused connection, or a mailbox with no Sent folder, as not sent', async () => {
    const refused = new SentLookupImapClient([], { failConnect: true });
    await expect(imap(refused).lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
    expect(refused.logoutCalls + refused.closeCalls).toBeGreaterThan(0);

    // No Sent folder is not an outage that passes (the audit): the request is
    // settled at once, and the owner told the mailbox cannot be checked.
    const noSent = new SentLookupImapClient([], { folders: [{ path: 'INBOX' }, { path: 'Archive' }] });
    await expect(imap(noSent).lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(noSent.searches).toEqual([]);
  });

  it('finds a Sent folder by its localized name when the server marks none (the audit)', async () => {
    for (const path of ['Gesendet', 'Gesendete Elemente', 'INBOX.Gesendet', 'Envoyés', 'Elementos enviados', 'Posta inviata', 'Skickat']) {
      const client = new SentLookupImapClient([
        { uid: 4, messageId: `<${MESSAGE_ID}>`, to: ['chat@example.test'], subject: 'ask: hi' },
      ], { folders: [{ path: 'INBOX' }, { path }] });
      const result = await imap(client).lookupSentByMessageId!({ rfc_message_id: MESSAGE_ID });
      expect(result.status, path).toBe('found');
    }
  });
});

describe('D-318 the mail collection’s Sent lookup by Message-ID', () => {
  const opened: Array<{ db: Database.Database; dir: string }> = [];
  afterEach(() => {
    for (const { db, dir } of opened.splice(0)) {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const provider = (lookup?: MailProvider['lookupSentByMessageId']): MailProvider => ({
    kind: 'imap',
    slug: 'me',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'owner@example.test',
    async connect() { /* no-op */ },
    async initialScan() { /* no-op */ },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    ...(lookup ? { lookupSentByMessageId: lookup } : {}),
  });
  const collection = (p: MailProvider) => {
    const dir = mkdtempSync(join(tmpdir(), 'd-318-lookup-'));
    const db = new Database(':memory:');
    opened.push({ db, dir });
    const quota = 10 * 1024 * 1024;
    return createMailCollection({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota, reservePct: 10, surface: 'collection:mail:me' }),
      bus: createWarehouseEventBus(),
      slug: 'me',
      provider: p,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: quota }),
    });
  };

  it('answers unsupported for a provider that cannot be asked — never not_found', async () => {
    await expect(collection(provider()).lookupSentByMessageId({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
  });

  it('passes the provider’s answer through, and reads a throw as a provider error', async () => {
    const found = { status: 'found' as const, matches: [{ to: ['chat@example.test'], subject: 's', sent_at: SENT_AT }] };
    const lookup = vi.fn(async () => found);
    await expect(collection(provider(lookup)).lookupSentByMessageId({ rfc_message_id: MESSAGE_ID })).resolves.toEqual(found);
    expect(lookup).toHaveBeenCalledWith({ rfc_message_id: MESSAGE_ID });

    const failing = collection(provider(async () => { throw new Error('boom'); }));
    await expect(failing.lookupSentByMessageId({ rfc_message_id: MESSAGE_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});
