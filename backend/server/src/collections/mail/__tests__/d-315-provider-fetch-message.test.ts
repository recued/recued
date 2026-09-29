/** D-315 §4.4 — each provider reads one message again, whole: the HTML, the
 *  headers and the sender's name the stored row drops. Gone is `null`; a read
 *  that failed throws, so a caller can tell the two apart. */

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { FetchQueryObject, MailboxObject, SearchObject } from 'imapflow';

import { createGmailProvider, type GmailProviderConfig } from '../gmail-provider.js';
import { createGraphProvider, type GraphProviderConfig } from '../graph-provider.js';
import { createImapProvider, type ImapClient, type ImapProviderConfig } from '../imap-provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

const AT = Date.UTC(2026, 8, 20, 10);

const RAW = [
  'From: "UPS" <pkginfo@ups.com>',
  'To: me@example.com',
  'Subject: UPS Update: Delivered',
  'Message-ID: <m1@ups.example>',
  `Date: ${new Date(AT).toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Tracking Number: 1Z999AA10123456784',
  '--b',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Tracking Number: <b>1Z999AA10123456784</b></p>',
  '--b--',
  '',
].join('\r\n');

const store = (prefix: string): OAuthAccountStore => {
  const data = new Map<string, string>([
    [`${prefix}.work.access_token`, 'token'],
    [`${prefix}.work.expires_at`, String(Date.now() + 3_600_000)],
    [`${prefix}.work.refresh_token`, 'refresh'],
  ]);
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

// ── IMAP ────────────────────────────────────────────────────────────────────

class FetchImapClient extends EventEmitter implements ImapClient {
  usable = true;
  opened: { path: string; readOnly: boolean }[] = [];
  fetched: { range: string | number[]; query: FetchQueryObject }[] = [];
  logouts = 0;

  constructor(private readonly messages: Map<number, Buffer>) { super(); }

  async connect(): Promise<void> {}
  async logout(): Promise<void> { this.logouts += 1; this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<MailboxObject> {
    this.opened.push({ path, readOnly: options?.readOnly === true });
    return { path, delimiter: '/', flags: new Set(), exists: this.messages.size } as unknown as MailboxObject;
  }
  async search(_query: SearchObject): Promise<number[]> { return []; }
  async *fetch(range: string | number[], query: FetchQueryObject): AsyncIterable<any> {
    this.fetched.push({ range, query });
    for (const uid of Array.isArray(range) ? range : []) {
      const source = this.messages.get(uid);
      if (source !== undefined) yield { uid, flags: new Set(['\\Seen']), internalDate: new Date(AT), source };
    }
  }
  async idle(): Promise<boolean> { return true; }
}

const imapConfig: ImapProviderConfig = {
  host: 'imap.example.test',
  port: 993,
  secure: true,
  username: 'me@example.com',
  password: 'secret',
  folders: ['INBOX'],
};

describe('IMAP', () => {
  it('reads a UID on its own connection, EXAMINEing the folder so nothing is marked seen', async () => {
    const client = new FetchImapClient(new Map([[41, Buffer.from(RAW)]]));
    const provider = createImapProvider({ slug: 'work', config: () => imapConfig, clientFactory: () => client });
    const message = await provider.fetchMessage!('41@INBOX');
    expect(message).toMatchObject({
      source_id: '41@INBOX',
      from: 'pkginfo@ups.com',
      from_name: 'UPS',
      subject: 'UPS Update: Delivered',
      rfc_message_id: '<m1@ups.example>',
      direction: 'inbound',
    });
    expect(message?.body_html).toContain('<b>1Z999AA10123456784</b>');
    expect(client.opened).toEqual([{ path: 'INBOX', readOnly: true }]);
    expect(client.fetched[0]?.range).toEqual([41]);
    expect(client.logouts).toBe(1);
  });

  it('answers null for a UID no longer in the folder, and refuses an id that is not UID@folder', async () => {
    const client = new FetchImapClient(new Map());
    const provider = createImapProvider({ slug: 'work', config: () => imapConfig, clientFactory: () => client });
    await expect(provider.fetchMessage!('41@INBOX')).resolves.toBeNull();
    await expect(provider.fetchMessage!('INBOX')).rejects.toMatchObject({ code: 'message_not_found' });
  });
});

// ── Graph ───────────────────────────────────────────────────────────────────

const graphConfig: GraphProviderConfig = { account_slug: 'work', backfill_days: 7, poll_seconds: 30, granted_scopes: ['Mail.Read'] };
const graphOAuth: OAuthProviderConfig = { tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', clientId: 'cid' };

const graphWith = (fetcher: HttpFetcher) => createGraphProvider({
  slug: 'work',
  config: () => graphConfig,
  accountStore: store('graph'),
  providerConfig: graphOAuth,
  fetcher,
  scheduler: () => () => undefined,
});

describe('Graph', () => {
  it('reads a message with its HTML and sender name', async () => {
    const urls: string[] = [];
    const provider = graphWith(async (url) => {
      urls.push(url);
      return response(200, {
        id: 'AAMk-1',
        subject: 'UPS Update: Delivered',
        internetMessageId: '<m1@ups.example>',
        from: { emailAddress: { address: 'pkginfo@ups.com', name: 'UPS' } },
        toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
        ccRecipients: [],
        conversationId: 'conv-1',
        parentFolderId: 'folder-1',
        isRead: true,
        hasAttachments: false,
        receivedDateTime: new Date(AT).toISOString(),
        body: { contentType: 'html', content: '<p>Tracking Number: <b>1Z999AA10123456784</b></p>' },
      });
    });
    const message = await provider.fetchMessage!('AAMk-1');
    expect(message).toMatchObject({ source_id: 'AAMk-1', from: 'pkginfo@ups.com', subject: 'UPS Update: Delivered' });
    expect(message?.body_html).toContain('1Z999AA10123456784');
    // The message is one request; the rest ask the well-known folders' ids,
    // once, for the direction of a message read on its own.
    expect(urls.filter((url) => new URL(url).pathname.includes('/me/messages/'))).toHaveLength(1);
    expect(urls.filter((url) => new URL(url).pathname.includes('/me/mailFolders/'))).toHaveLength(4);
    expect(new URL(urls[0]!).pathname).toMatch(/\/me\/messages\/AAMk-1$/);
  });

  it('answers null when Graph no longer has it (a moved message gets a new id), and throws on a failed read', async () => {
    await expect(graphWith(async () => response(404, { error: 'gone' })).fetchMessage!('AAMk-1')).resolves.toBeNull();
    await expect(graphWith(async () => response(500, { error: 'down' })).fetchMessage!('AAMk-1'))
      .rejects.toThrow(/read failed \(500\)/);
  });
});

// ── Gmail ───────────────────────────────────────────────────────────────────

const gmailConfig: GmailProviderConfig = { account_slug: 'work', backfill_days: 7, poll_seconds: 30, granted_scopes: [] };
const gmailOAuth: OAuthProviderConfig = { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid' };

const gmailWith = (fetcher: HttpFetcher) => createGmailProvider({
  slug: 'work',
  config: () => gmailConfig,
  accountStore: store('gmail'),
  providerConfig: gmailOAuth,
  fetcher,
  scheduler: () => () => undefined,
});

describe('Gmail', () => {
  it('reads the raw message', async () => {
    const provider = gmailWith(async (url) => {
      expect(new URL(url).searchParams.get('format')).toBe('raw');
      return response(200, {
        id: 'g1', threadId: 't1', labelIds: ['INBOX'], internalDate: String(AT),
        raw: Buffer.from(RAW).toString('base64url'),
      });
    });
    await expect(provider.fetchMessage!('g1')).resolves.toMatchObject({ source_id: 'g1', from_name: 'UPS' });
  });

  it('answers null when Gmail no longer has it, and throws on a failed read', async () => {
    await expect(gmailWith(async () => response(404, { error: 'gone' })).fetchMessage!('g1')).resolves.toBeNull();
    await expect(gmailWith(async () => response(500, { error: 'down' })).fetchMessage!('g1')).rejects.toThrow(/read failed/);
  });
});
