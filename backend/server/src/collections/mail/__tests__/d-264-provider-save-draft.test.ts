/** D-264 slice 4a — the three providers can park a message in Drafts.
 *
 *  The single most important assertion in this file is the NEGATIVE one:
 *  **`saveDraft` must never send.** Graph's send path is create-draft followed
 *  by `POST /messages/{id}/send`, and `saveDraft` is that path with the second
 *  call removed. A regression that re-adds it would deliver mail the owner only
 *  meant to park, and every other assertion here would still pass — so the call
 *  log is inspected, not just the return value.
 *
 *  The second is that IMAP saves a draft with NO SMTP. That is the case D-264
 *  exists for: a mailbox that cannot send can still hold a draft.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import type { MailboxObject } from 'imapflow';
import {
  createImapProvider, findDraftsFolder, findSentFolder,
  IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES,
  type ImapClient, type ImapClientFactory, type ImapProviderConfig,
} from '../imap-provider.js';
import { createGraphProvider, GRAPH_MODIFY_SCOPE, type GraphProviderConfig } from '../graph-provider.js';
import { createGmailProvider, GMAIL_MODIFY_SCOPE, type GmailProviderConfig } from '../gmail-provider.js';
import type { OutgoingMessage } from '../provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

const msg: OutgoingMessage = {
  to: ['bob@example.com'], subject: 'hello', body_text: 'body',
};

// ────────────────────────────────────────────────────────────────
// IMAP
// ────────────────────────────────────────────────────────────────

interface AppendCall { path: string; flags?: string[] }

class DraftImapClient extends EventEmitter implements ImapClient {
  usable = true;
  appended: AppendCall[] = [];
  deleted: string[] = [];
  constructor(
    private readonly boxes: Array<{ path: string; specialUse?: string }>,
    private readonly appendResult: unknown = { uid: 42 },
    private readonly canDelete = false,
  ) { super(); }
  async connect(): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string): Promise<MailboxObject> {
    return { path, delimiter: '/', flags: new Set(), exists: 0 } as unknown as MailboxObject;
  }
  async search(): Promise<number[]> { return []; }
  async *fetch(): AsyncIterable<never> { /* nothing */ }
  async idle(): Promise<boolean> { return true; }
  async list(): Promise<Array<{ path: string; specialUse?: string }>> { return this.boxes; }
  async append(path: string, _content: string | Buffer, flags?: string[]): Promise<unknown> {
    this.appended.push({ path, ...(flags ? { flags } : {}) });
    return this.appendResult;
  }
  messageDelete?: (range: string, opts?: { uid?: boolean }) => Promise<boolean>;
  static withDelete(boxes: Array<{ path: string; specialUse?: string }>, appendResult?: unknown) {
    const client = new DraftImapClient(boxes, appendResult, true);
    client.messageDelete = async (range: string) => { client.deleted.push(range); return true; };
    return client;
  }
}

/** No `smtp` block — `sendCapable: false`. The whole point. */
const imapWith = (client: ImapClient, smtp?: Record<string, unknown>) => {
  const factory: ImapClientFactory = () => client;
  return createImapProvider({
    slug: 'archive',
    config: (): ImapProviderConfig => ({
      host: 'imap.example.com', port: 993, secure: true,
      username: 'me@example.com', folders: ['INBOX'],
      ...(smtp ? { smtp } : {}),
    } as ImapProviderConfig),
    clientFactory: factory,
  });
};

/** `saveDraft` reads the first CONNECTED folder's client, so the provider has
 *  to be connected exactly as the Sent APPEND path requires. */
const connectedImap = async (client: ImapClient, smtp?: Record<string, unknown>) => {
  const provider = imapWith(client, smtp);
  await provider.connect();
  return provider;
};

describe('D-264 — IMAP Drafts folder discovery', () => {
  const bare = (paths: string[]) => new DraftImapClient(paths.map((path) => ({ path })));

  it('prefers the RFC 6154 \\Drafts flag over any name', async () => {
    const client = new DraftImapClient([
      { path: 'Drafts' },
      { path: 'Entwürfe', specialUse: '\\Drafts' },
    ]);
    expect(await findDraftsFolder(client)).toBe('Entwürfe');
  });

  it('falls back through the known names when the server publishes no flag', async () => {
    for (const name of IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES) {
      expect(await findDraftsFolder(bare([name, 'INBOX']))).toBe(name);
    }
  });

  it('returns null when neither a flag nor a known name is present', async () => {
    expect(await findDraftsFolder(bare(['INBOX', 'Archive']))).toBeNull();
  });

  it('resolves Drafts and Sent INDEPENDENTLY — the shared helper differs only in target', async () => {
    const client = new DraftImapClient([
      { path: 'S', specialUse: '\\Sent' },
      { path: 'D', specialUse: '\\Drafts' },
    ]);
    expect(await findSentFolder(client)).toBe('S');
    expect(await findDraftsFolder(client)).toBe('D');
  });
});

describe('D-264 — IMAP saveDraft', () => {
  it('APPENDs into Drafts with the \\Draft flag, on a mailbox that CANNOT send', async () => {
    const client = new DraftImapClient([{ path: 'Drafts', specialUse: '\\Drafts' }]);
    const provider = await connectedImap(client);

    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
    expect(provider.draftCapable).toBe(true);

    const saved = await provider.saveDraft!(msg);
    expect(client.appended).toEqual([{ path: 'Drafts', flags: ['\\Draft'] }]);
    expect(saved.source_id).toBe('42');
    expect(saved.replaced).toBe(false);
    expect(saved.warnings).toBeUndefined();
  });

  it('falls back to the generated Message-Id when the server returns no APPENDUID', async () => {
    const client = new DraftImapClient([{ path: 'Drafts', specialUse: '\\Drafts' }], {});
    const provider = await connectedImap(client);
    const saved = await provider.saveDraft!(msg);
    // Never empty — a later export has to be able to hand this back.
    expect(saved.source_id.length).toBeGreaterThan(0);
    expect(saved.source_id).not.toBe('42');
  });

  it('refuses with MAIL_DRAFT_FOLDER_NOT_FOUND rather than writing somewhere else', async () => {
    const client = new DraftImapClient([{ path: 'INBOX' }]);
    const provider = await connectedImap(client);
    await expect(provider.saveDraft!(msg)).rejects.toMatchObject({
      code: 'MAIL_DRAFT_FOLDER_NOT_FOUND',
    });
    expect(client.appended).toEqual([]);
  });

  it('⛔ NEVER DELETES — a UID is only meaningful in the SELECTed mailbox', async () => {
    // Theoriginal implementation called `messageDelete(priorUid, {uid:true})` on a
    // client still selected on INBOX, because APPEND deliberately does not move
    // the selection. That deleted INBOX's message 7 while the draft survived,
    // and reported `replaced: true`. Irreversible, silent, and shaped like
    // success — so the delete is gone, and no capability re-enables it.
    const client = DraftImapClient.withDelete([{ path: 'Drafts', specialUse: '\\Drafts' }]);
    const provider = await connectedImap(client);
    const saved = await provider.saveDraft!(msg, { source_id: '7' });
    expect(client.deleted).toEqual([]);
    expect(saved.replaced).toBe(false);
    expect(saved.warnings?.[0]?.code).toBe('MAIL_DRAFT_PRIOR_NOT_REMOVED');
  });

  it('SAVES ANYWAY and warns — never claims a replacement it did not perform', async () => {
    const client = new DraftImapClient([{ path: 'Drafts', specialUse: '\\Drafts' }]);
    const provider = await connectedImap(client);
    const saved = await provider.saveDraft!(msg, { source_id: '7' });
    expect(saved.replaced).toBe(false);
    expect(client.appended).toHaveLength(1);
    expect(saved.warnings?.[0]?.code).toBe('MAIL_DRAFT_PRIOR_NOT_REMOVED');
  });
});

// ────────────────────────────────────────────────────────────────
// Graph
// ────────────────────────────────────────────────────────────────

const okRes = (status: number, body: unknown) => ({
  status, ok: status >= 200 && status < 300,
  async json() { return body; },
  async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
});

const oauthConfig: OAuthProviderConfig = { tokenUrl: 'https://token.example/t', clientId: 'cid' };
const seededStore = (prefix: string): OAuthAccountStore => {
  const data = new Map<string, string>([
    [`${prefix}.access_token`, 'at'],
    [`${prefix}.expires_at`, String(Date.now() + 3_600_000)],
    [`${prefix}.refresh_token`, 'rt'],
  ]);
  return {
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    async getAll() { return Object.fromEntries(data); },
  };
};

interface Call { url: string; method?: string }

const graphProvider = (fetcher: HttpFetcher, scopes = [GRAPH_MODIFY_SCOPE]) =>
  createGraphProvider({
    slug: 'work',
    config: (): GraphProviderConfig => ({
      account_slug: 'work', backfill_days: 7, poll_seconds: 30,
      granted_scopes: scopes,
    } as GraphProviderConfig),
    accountStore: seededStore('graph.work'),
    providerConfig: oauthConfig,
    fetcher,
    scheduler: () => () => undefined,
  });

describe('D-264 — Graph saveDraft', () => {
  const graphFetcher = (log: Call[], patchStatus = 200): HttpFetcher =>
    async (url, init) => {
      log.push({ url, method: init?.method });
      if (url === oauthConfig.tokenUrl) return okRes(200, { access_token: 'at', expires_in: 3600 });
      if (init?.method === 'POST' && url.endsWith('/me/messages')) {
        return okRes(201, { id: 'gid-1', internetMessageId: '<m@x>', conversationId: 'c1' });
      }
      if (init?.method === 'PATCH') return okRes(patchStatus, patchStatus === 200 ? { id: 'gid-prior' } : 'nope');
      return okRes(404, { error: 'unmapped', url });
    };

  it('⛔ CREATES THE DRAFT AND DOES NOT SEND IT', () => {
    const log: Call[] = [];
    const provider = graphProvider(graphFetcher(log));
    return provider.saveDraft!(msg).then((saved) => {
      expect(saved.source_id).toBe('gid-1');
      expect(saved.replaced).toBe(false);
      // The assertion that matters: no `/send` anywhere in the call log.
      expect(log.some((c) => /\/send$/.test(c.url))).toBe(false);
      expect(log.filter((c) => c.method === 'POST' && c.url.endsWith('/me/messages'))).toHaveLength(1);
    });
  });

  it('PATCHes a prior draft in place, keeping the id so a third export supersedes too', async () => {
    const log: Call[] = [];
    const provider = graphProvider(graphFetcher(log));
    const saved = await provider.saveDraft!(msg, { source_id: 'gid-prior' });
    expect(saved.replaced).toBe(true);
    expect(saved.source_id).toBe('gid-prior');
    expect(log.some((c) => c.method === 'PATCH')).toBe(true);
    expect(log.some((c) => c.method === 'POST' && c.url.endsWith('/me/messages'))).toBe(false);
  });

  it('keeps the edit when the update fails — new draft, replaced:false, and says so', async () => {
    const log: Call[] = [];
    const provider = graphProvider(graphFetcher(log, 404));
    const saved = await provider.saveDraft!(msg, { source_id: 'gone' });
    expect(saved.replaced).toBe(false);
    expect(saved.source_id).toBe('gid-1');
    expect(saved.warnings?.[0]?.code).toBe('MAIL_DRAFT_PRIOR_NOT_REMOVED');
    expect(log.some((c) => /\/send$/.test(c.url))).toBe(false);
  });

  it('is absent without the modify grant — lockstep with draftCapable', () => {
    const provider = graphProvider(graphFetcher([]), ['Mail.Read']);
    expect(provider.draftCapable).toBe(false);
    expect(provider.saveDraft).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Gmail
// ────────────────────────────────────────────────────────────────

const gmailProvider = (fetcher: HttpFetcher, scopes = [GMAIL_MODIFY_SCOPE]) =>
  createGmailProvider({
    slug: 'work',
    config: (): GmailProviderConfig => ({
      account_slug: 'work', backfill_days: 7, poll_seconds: 30,
      granted_scopes: scopes,
    } as GmailProviderConfig),
    accountStore: seededStore('gmail.work'),
    providerConfig: oauthConfig,
    fetcher,
    scheduler: () => () => undefined,
  });

describe('D-264 — Gmail saveDraft', () => {
  const gmailFetcher = (log: Call[], putStatus = 200): HttpFetcher =>
    async (url, init) => {
      log.push({ url, method: init?.method });
      if (url === oauthConfig.tokenUrl) return okRes(200, { access_token: 'at', expires_in: 3600 });
      if (init?.method === 'POST' && url.endsWith('/drafts')) return okRes(200, { id: 'draft-new' });
      if (init?.method === 'PUT') return okRes(putStatus, putStatus === 200 ? { id: 'draft-prior' } : 'nope');
      return okRes(404, { error: 'unmapped', url });
    };

  it('creates via POST /drafts and never touches messages/send', async () => {
    const log: Call[] = [];
    const saved = await gmailProvider(gmailFetcher(log)).saveDraft!(msg);
    // The DRAFT id, not the message id — `drafts.update` keys on this, and
    // returning the message id would make every re-export duplicate.
    expect(saved.source_id).toBe('draft-new');
    expect(saved.replaced).toBe(false);
    expect(log.some((c) => c.url.includes('/messages/send'))).toBe(false);
  });

  it('updates in place via PUT /drafts/{id}', async () => {
    const log: Call[] = [];
    const saved = await gmailProvider(gmailFetcher(log)).saveDraft!(msg, { source_id: 'draft-prior' });
    expect(saved.replaced).toBe(true);
    expect(saved.source_id).toBe('draft-prior');
    expect(log.some((c) => c.method === 'PUT')).toBe(true);
    expect(log.some((c) => c.method === 'POST' && c.url.endsWith('/drafts'))).toBe(false);
  });

  it('falls back to a new draft when the update fails, warning about the second copy', async () => {
    const log: Call[] = [];
    const saved = await gmailProvider(gmailFetcher(log, 404)).saveDraft!(msg, { source_id: 'gone' });
    expect(saved.replaced).toBe(false);
    expect(saved.source_id).toBe('draft-new');
    expect(saved.warnings?.[0]?.code).toBe('MAIL_DRAFT_PRIOR_NOT_REMOVED');
  });

  it('surfaces an auth failure without burning a second call', async () => {
    const log: Call[] = [];
    const fetcher: HttpFetcher = async (url, init) => {
      log.push({ url, method: init?.method });
      if (url === oauthConfig.tokenUrl) return okRes(200, { access_token: 'at', expires_in: 3600 });
      return okRes(403, 'insufficient scope');
    };
    await expect(gmailProvider(fetcher).saveDraft!(msg, { source_id: 'p' }))
      .rejects.toBeInstanceOf(IngredientError);
    expect(log.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts'))).toHaveLength(0);
  });

  it('is absent without the modify grant', () => {
    const provider = gmailProvider(gmailFetcher([]), ['https://www.googleapis.com/auth/gmail.readonly']);
    expect(provider.draftCapable).toBe(false);
    expect(provider.saveDraft).toBeUndefined();
  });
});
