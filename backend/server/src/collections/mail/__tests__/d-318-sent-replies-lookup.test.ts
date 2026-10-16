/** D-318 — each provider asked whether the chat mailbox already ANSWERED one
 *  request: the messages it sent that reply to the request's Message-ID.
 *
 *  ⛔ A server restored from a backup, or a second copy of one, remembers none
 *  of the requests answered since; the chat mailbox's Sent folder does. Every
 *  case that matters is one where the provider returns a message the exact
 *  compare must still refuse: another request's answer in the same thread or
 *  conversation, an id the request's merely contains (IMAP's substring
 *  `SEARCH HEADER`), a reply someone else sent into the thread. A failed read
 *  must never look like "not answered": the request would be run again. */

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
import {
  createGraphProvider,
  GRAPH_IN_REPLY_TO_PROPERTY,
  GRAPH_SEND_SCOPE,
  type GraphProviderConfig,
} from '../graph-provider.js';
import { createImapProvider, type ImapClient, type ImapProviderConfig } from '../imap-provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

const REQUEST_ID = 'CAF=req-1.x7@mail.example.test';
const ARRIVED_AT = Date.UTC(2026, 9, 14, 9, 30, 0);
const ANSWERED_AT = ARRIVED_AT + 90_000;
const ANSWER = 'mail-chat-answer:0123456789abcdef0123456789abcdef';
const OTHER_ANSWER = 'mail-chat-answer:fedcba9876543210fedcba9876543210';

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

describe('D-318 Gmail: the replies the chat mailbox sent to a request', () => {
  const providerConfig: OAuthProviderConfig = { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid' };
  const config: GmailProviderConfig = {
    account_slug: 'chat',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'],
  };
  const gmail = (fetcher: HttpFetcher) => createGmailProvider({
    slug: 'chat',
    config: () => config,
    accountStore: makeStore({
      'gmail.chat.access_token': 'token',
      'gmail.chat.expires_at': String(Date.now() + 3_600_000),
      'gmail.chat.refresh_token': 'refresh',
    }),
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
  const message = (id: string, labelIds: string[], at: number, headers: Record<string, string>) => ({
    id,
    threadId: 't-1',
    labelIds,
    internalDate: String(at),
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });

  it('finds the request by its Message-ID, reads its thread, and keeps the SENT replies to exactly it', async () => {
    const calls: URL[] = [];
    const provider = gmail(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith('/messages')) return response(200, { messages: [{ id: 'req', threadId: 't-1' }] });
      if (parsed.pathname.endsWith('/threads/t-1')) {
        return response(200, {
          id: 't-1',
          messages: [
            message('req', ['INBOX'], ARRIVED_AT, {}),
            // Its answer.
            message('a1', ['SENT'], ANSWERED_AT, {
              'In-Reply-To': `<${REQUEST_ID}>`, 'x-recued-reconciliation-id': ANSWER,
            }),
            // The answer to a later request in the same conversation.
            message('a2', ['SENT'], ANSWERED_AT + 60_000, {
              'In-Reply-To': '<req-2@mail.example.test>', 'x-recued-reconciliation-id': OTHER_ANSWER,
            }),
            // An id the request's is only part of.
            message('near', ['SENT'], ANSWERED_AT, { 'In-Reply-To': `<x${REQUEST_ID}>`, 'x-recued-reconciliation-id': ANSWER }),
            // Someone else's reply into the thread: not sent by this mailbox.
            message('theirs', ['INBOX'], ANSWERED_AT, { 'In-Reply-To': `<${REQUEST_ID}>` }),
          ],
        });
      }
      return response(404, { error: 'unmapped' });
    });

    await expect(provider.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({
      status: 'found',
      matches: [{ reconciliation_id: ANSWER, sent_at: ANSWERED_AT }],
    });
    const [search, thread] = calls;
    expect(search!.searchParams.get('q')).toBe(`rfc822msgid:${REQUEST_ID}`);
    // The request is in the inbox, not the Sent record.
    expect(search!.searchParams.getAll('labelIds')).toEqual([]);
    expect(thread!.searchParams.get('format')).toBe('metadata');
    expect(thread!.searchParams.getAll('metadataHeaders')).toEqual(['In-Reply-To', 'x-recued-reconciliation-id']);
    expect(calls).toHaveLength(2);
  });

  it('a reply the owner wrote from the chat mailbox carries no reconciliation id', async () => {
    const provider = gmail(async (url) => new URL(url).pathname.endsWith('/messages')
      ? response(200, { messages: [{ id: 'req', threadId: 't-1' }] })
      : response(200, { id: 't-1', messages: [message('own', ['SENT'], ANSWERED_AT, { 'In-Reply-To': `<${REQUEST_ID}>` })] }));
    await expect(provider.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({
      status: 'found', matches: [{ reconciliation_id: null, sent_at: ANSWERED_AT }],
    });
  });

  it('answers not_found from an empty search without reading a thread, and from a thread with no reply', async () => {
    const calls: string[] = [];
    const empty = gmail(async (url) => {
      calls.push(url);
      return response(200, { resultSizeEstimate: 0 });
    });
    await expect(empty.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({ status: 'not_found' });
    expect(calls).toHaveLength(1);

    const unanswered = gmail(async (url) => new URL(url).pathname.endsWith('/messages')
      ? response(200, { messages: [{ id: 'req', threadId: 't-1' }] })
      : response(200, { id: 't-1', messages: [message('req', ['INBOX'], ARRIVED_AT, {})] }));
    await expect(unanswered.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({ status: 'not_found' });
  });

  it('never reads a failed search or a failed thread read as not answered', async () => {
    await expect(gmail(async () => response(500, { error: 'backend' }))
      .lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
    await expect(gmail(async (url) => new URL(url).pathname.endsWith('/messages')
      ? response(200, { messages: [{ id: 'req', threadId: 't-1' }] })
      : response(429, { error: 'rate' })).lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});

describe('D-318 Graph: the replies the chat mailbox sent to a request', () => {
  const providerConfig: OAuthProviderConfig = {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: 'cid',
  };
  const config: GraphProviderConfig = {
    account_slug: 'chat',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GRAPH_SEND_SCOPE, 'Mail.Read'],
  };
  const graph = (fetcher: HttpFetcher) => createGraphProvider({
    slug: 'chat',
    config: () => config,
    accountStore: makeStore({
      'graph.chat.access_token': 'token',
      'graph.chat.expires_at': String(Date.now() + 3_600_000),
      'graph.chat.refresh_token': 'refresh',
    }),
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
  const request = (internetMessageId: string, conversationId = 'conv-1') => ({
    id: 'graph-req', internetMessageId, conversationId, receivedDateTime: new Date(ARRIVED_AT).toISOString(),
  });
  // ⛔ As Graph returns a Sent item, measured on Outlook.com (2026-10-15): its
  // headers are only the `x-` ones set when it was made, and its In-Reply-To is
  // Exchange's own property. This builder first put In-Reply-To in the headers,
  // the tests passed, and the live restore check ran its request a second time.
  const sentItem = (inReplyTo: string, at: number, reconciliation?: string) => ({
    id: `sent-${at}`,
    sentDateTime: new Date(at).toISOString(),
    internetMessageHeaders: [
      ...(reconciliation !== undefined ? [{ name: 'x-recued-reconciliation-id', value: reconciliation }] : []),
      { name: 'X-Auto-Response-Suppress', value: 'OOF, AutoReply' },
    ],
    singleValueExtendedProperties: [{ id: GRAPH_IN_REPLY_TO_PROPERTY, value: inReplyTo }],
  });

  it('reads the request’s conversation in Sent Items from its arrival, oldest first, and keeps the replies to exactly it', async () => {
    const calls: URL[] = [];
    const provider = graph(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith('/me/messages')) return response(200, { value: [request(`<${REQUEST_ID}>`)] });
      if (parsed.pathname.endsWith('/me/mailFolders/sentitems/messages')) {
        return response(200, {
          value: [
            sentItem(`<${REQUEST_ID}>`, ANSWERED_AT, ANSWER),
            // The answer to a later request in the same conversation.
            sentItem('<req-2@mail.example.test>', ANSWERED_AT + 60_000, OTHER_ANSWER),
            sentItem(`<x${REQUEST_ID}>`, ANSWERED_AT, ANSWER),
          ],
        });
      }
      return response(404, { error: 'unmapped' });
    });

    await expect(provider.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({
      status: 'found',
      matches: [{ reconciliation_id: ANSWER, sent_at: ANSWERED_AT }],
    });
    expect(calls).toHaveLength(2);
    const [found, sent] = calls;
    expect(found!.searchParams.get('$filter')).toBe(`internetMessageId eq '<${REQUEST_ID}>'`);
    expect(found!.searchParams.get('$select')).toBe('internetMessageId,conversationId,receivedDateTime');
    // ⛔ A long conversation holds more answers than a page: the request's own
    // is among the first sent after it arrived.
    expect(sent!.searchParams.get('$filter'))
      .toBe(`sentDateTime ge ${new Date(ARRIVED_AT).toISOString()} and conversationId eq 'conv-1'`);
    expect(sent!.searchParams.get('$orderby')).toBe('sentDateTime asc');
    expect(sent!.searchParams.get('$top')).toBe('10');
    expect(sent!.searchParams.get('$select')).toBe('internetMessageHeaders,sentDateTime');
    expect(sent!.searchParams.get('$expand')).toBe("singleValueExtendedProperties($filter=id eq 'String 0x1042')");
  });

  it('⛔ never takes In-Reply-To from a Sent item’s headers alone when Exchange’s property names another id', async () => {
    const provider = graph(async (url) => new URL(url).pathname.endsWith('/me/messages')
      ? response(200, { value: [request(`<${REQUEST_ID}>`)] })
      : response(200, {
        value: [{
          id: 'sent-1',
          sentDateTime: new Date(ANSWERED_AT).toISOString(),
          internetMessageHeaders: [
            { name: 'In-Reply-To', value: `<${REQUEST_ID}>` },
            { name: 'x-recued-reconciliation-id', value: ANSWER },
          ],
          singleValueExtendedProperties: [{ id: GRAPH_IN_REPLY_TO_PROPERTY, value: '<req-2@mail.example.test>' }],
        }],
      }));
    await expect(provider.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({ status: 'not_found' });
  });

  it('reads a header’s In-Reply-To when Exchange returns no property for the item', async () => {
    const provider = graph(async (url) => new URL(url).pathname.endsWith('/me/messages')
      ? response(200, { value: [request(`<${REQUEST_ID}>`)] })
      : response(200, {
        value: [{
          id: 'sent-1',
          sentDateTime: new Date(ANSWERED_AT).toISOString(),
          internetMessageHeaders: [
            { name: 'In-Reply-To', value: `<${REQUEST_ID}>` },
            { name: 'x-recued-reconciliation-id', value: ANSWER },
          ],
        }],
      }));
    await expect(provider.lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({
      status: 'found', matches: [{ reconciliation_id: ANSWER, sent_at: ANSWERED_AT }],
    });
  });

  it('doubles a quote in the id, and reads no conversation for a hit that is not the exact id', async () => {
    // The request's Message-ID is its sender's to choose.
    const forged = "x' or internetMessageId ne 'y@evil.test";
    const calls: URL[] = [];
    const provider = graph(async (url) => {
      calls.push(new URL(url));
      return response(200, { value: [request('<owner-real@example.test>')] });
    });

    await expect(provider.lookupSentReplies!({ rfc_message_id: forged })).resolves.toEqual({ status: 'not_found' });
    expect(calls.map((call) => call.searchParams.get('$filter')))
      .toEqual([`internetMessageId eq '<x'' or internetMessageId ne ''y@evil.test>'`]);
  });

  it('answers not_found from no reply, and unavailable from a failed read of either list', async () => {
    await expect(graph(async (url) => new URL(url).pathname.endsWith('/me/messages')
      ? response(200, { value: [request(`<${REQUEST_ID}>`)] })
      : response(200, { value: [] })).lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'not_found' });
    await expect(graph(async () => response(503, { error: 'busy' }))
      .lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
    await expect(graph(async (url) => new URL(url).pathname.endsWith('/me/messages')
      ? response(200, { value: [request(`<${REQUEST_ID}>`)] })
      : response(429, { error: 'throttled' })).lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});

interface FakeSentMessage {
  uid: number;
  inReplyTo: string;
  /** The fetched header block, as the server returns it. */
  headers?: string;
}

class SentRepliesImapClient extends EventEmitter implements ImapClient {
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
    const wanted = String((query.header as Record<string, string>)['in-reply-to'] ?? '');
    return this.sentMessages.filter((m) => m.inReplyTo.includes(wanted)).map((m) => m.uid);
  }
  async *fetch(range: string | number[], query: FetchQueryObject): AsyncIterable<any> {
    this.fetches.push({ range, query });
    const uids = new Set(Array.isArray(range) ? range : []);
    for (const m of this.sentMessages) {
      if (!uids.has(m.uid)) continue;
      yield {
        uid: m.uid,
        internalDate: new Date(ANSWERED_AT),
        envelope: { inReplyTo: m.inReplyTo },
        ...(m.headers !== undefined ? { headers: Buffer.from(m.headers) } : {}),
      };
    }
  }
  async idle(): Promise<boolean> { return true; }
  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return this.options.folders ?? [{ path: 'INBOX' }, { path: 'Sent Items', specialUse: '\\Sent' }];
  }
}

describe('D-318 IMAP: the replies the chat mailbox sent to a request', () => {
  const config: ImapProviderConfig = {
    host: 'imap.example.test',
    port: 993,
    secure: true,
    username: 'chat@example.test',
    password: 'secret',
    folders: ['INBOX'],
  };
  const imap = (client: SentRepliesImapClient) => createImapProvider({ slug: 'chat', config: () => config, clientFactory: () => client });

  it('opens the Sent folder read-only, searches In-Reply-To, and keeps only the exact id', async () => {
    const client = new SentRepliesImapClient([
      // Its answer, the header folded as a server may send it.
      { uid: 7, inReplyTo: `<${REQUEST_ID}>`, headers: `X-Recued-Reconciliation-Id:\r\n ${ANSWER}\r\n\r\n` },
      // Contains the asked-for id, so the server's substring search returns it.
      { uid: 8, inReplyTo: `<a${REQUEST_ID}>`, headers: `x-recued-reconciliation-id: ${OTHER_ANSWER}\r\n\r\n` },
      // The owner's own reply, from their mail app: no reconciliation id.
      { uid: 9, inReplyTo: `<${REQUEST_ID}>`, headers: '\r\n' },
    ]);

    await expect(imap(client).lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({
      status: 'found',
      matches: [
        { reconciliation_id: ANSWER, sent_at: ANSWERED_AT },
        { reconciliation_id: null, sent_at: ANSWERED_AT },
      ],
    });
    expect(client.opened).toEqual([{ path: 'Sent Items', readOnly: true }]);
    expect(client.searches).toEqual([{ header: { 'in-reply-to': REQUEST_ID } }]);
    expect(client.fetches[0]!.query).toMatchObject({
      envelope: true, internalDate: true, headers: ['x-recued-reconciliation-id'],
    });
    expect(client.fetches[0]!.query).not.toHaveProperty('source');
    expect(client.logoutCalls).toBe(1);
  });

  it('answers not_found without fetching when nothing replies to it', async () => {
    const client = new SentRepliesImapClient([{ uid: 9, inReplyTo: '<other@example.test>' }]);
    await expect(imap(client).lookupSentReplies!({ rfc_message_id: REQUEST_ID })).resolves.toEqual({ status: 'not_found' });
    expect(client.fetches).toEqual([]);
    expect(client.logoutCalls).toBe(1);
  });

  it('never reads a refused connection as not answered; a mailbox with no Sent folder cannot be asked', async () => {
    const refused = new SentRepliesImapClient([], { failConnect: true });
    await expect(imap(refused).lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
    expect(refused.logoutCalls + refused.closeCalls).toBeGreaterThan(0);

    const noSent = new SentRepliesImapClient([], { folders: [{ path: 'INBOX' }, { path: 'Archive' }] });
    await expect(imap(noSent).lookupSentReplies!({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(noSent.searches).toEqual([]);
  });
});

describe('D-318 the mail collection’s lookup of the replies to a request', () => {
  const opened: Array<{ db: Database.Database; dir: string }> = [];
  afterEach(() => {
    for (const { db, dir } of opened.splice(0)) {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const provider = (lookup?: MailProvider['lookupSentReplies']): MailProvider => ({
    kind: 'imap',
    slug: 'chat',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'chat@example.test',
    async connect() { /* no-op */ },
    async initialScan() { /* no-op */ },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    ...(lookup ? { lookupSentReplies: lookup } : {}),
  });
  const collection = (p: MailProvider) => {
    const dir = mkdtempSync(join(tmpdir(), 'd-318-replies-'));
    const db = new Database(':memory:');
    opened.push({ db, dir });
    const quota = 10 * 1024 * 1024;
    return createMailCollection({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota, reservePct: 10, surface: 'collection:mail:chat' }),
      bus: createWarehouseEventBus(),
      slug: 'chat',
      provider: p,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: quota }),
    });
  };

  it('answers unsupported for a provider that cannot be asked — never not_found', async () => {
    await expect(collection(provider()).lookupSentReplies({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
  });

  it('passes the provider’s answer through, and reads a throw as a provider error', async () => {
    const found = { status: 'found' as const, matches: [{ reconciliation_id: ANSWER, sent_at: ANSWERED_AT }] };
    const lookup = vi.fn(async () => found);
    await expect(collection(provider(lookup)).lookupSentReplies({ rfc_message_id: REQUEST_ID })).resolves.toEqual(found);
    expect(lookup).toHaveBeenCalledWith({ rfc_message_id: REQUEST_ID });

    const failing = collection(provider(async () => { throw new Error('boom'); }));
    await expect(failing.lookupSentReplies({ rfc_message_id: REQUEST_ID }))
      .resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });
});
