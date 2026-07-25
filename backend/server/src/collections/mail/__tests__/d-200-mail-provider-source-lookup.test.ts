import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MAIL_RECONCILIATION_ID_HEADER } from '@recued/contracts';
import type { FetchQueryObject, MailboxObject, SearchObject } from 'imapflow';

import {
  buildGmailRfc5322,
  createGmailProvider,
  GMAIL_SEND_SCOPE,
  type GmailProviderConfig,
} from '../gmail-provider.js';
import {
  createGraphProvider,
  GRAPH_SEND_SCOPE,
  type GraphProviderConfig,
} from '../graph-provider.js';
import {
  buildImapRfc5322,
  createImapProvider,
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
} from '../imap-provider.js';
import {
  evaluateMailSentReconciliationCandidates,
  MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES,
  mailAttachmentPartFromBytes,
  mailSentReconciliationAttachmentPartFromBytes,
  type MailSentReconciliationCandidate,
  type MailSentReconciliationQuery,
  type OutgoingMessage,
} from '../provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

const RECONCILIATION_ID = `d200-${'a'.repeat(64)}`;
const SENT_AT = Date.UTC(2026, 6, 11, 12, 0, 0);
const PDF_BYTES = Buffer.from('%PDF-1.7\nexact-d200-artifact\n%%EOF', 'utf8');
const PDF_SHA256 = createHash('sha256').update(PDF_BYTES).digest('hex');
const SUBJECT = 'Your approved document is ready';
const RECIPIENT = 'visitor@example.test';

const QUERY: MailSentReconciliationQuery = {
  proof_kind: 'attachment',
  reconciliation_id: RECONCILIATION_ID,
  recipient: RECIPIENT,
  subject: SUBJECT,
  sent_after: SENT_AT - 1_000,
  sent_before: SENT_AT + 60_000,
  attachment_sha256: PDF_SHA256,
  attachment_size_bytes: PDF_BYTES.length,
  attachment_filename: 'document.pdf',
  attachment_mime_type: 'application/pdf',
};

const ENVELOPE_QUERY: MailSentReconciliationQuery = {
  proof_kind: 'envelope',
  reconciliation_id: RECONCILIATION_ID,
  recipient: RECIPIENT,
  subject: SUBJECT,
  sent_after: SENT_AT - 1_000,
  sent_before: SENT_AT + 60_000,
};

const attachment = (bytes = PDF_BYTES) => mailAttachmentPartFromBytes({
  filename: 'document.pdf',
  mime_type: 'application/pdf',
  source_part_id: 'attachment-1',
  bytes,
});

const candidate = (
  overrides: Partial<MailSentReconciliationCandidate> = {},
): MailSentReconciliationCandidate => ({
  source_id: 'provider-message-1',
  rfc_message_id: '<provider-message-1@example.test>',
  reconciliation_header_values: [RECONCILIATION_ID],
  to: [RECIPIENT],
  cc: [],
  bcc: [],
  subject: SUBJECT,
  sent_at: SENT_AT,
  attachments: [attachment()],
  attachment_set_complete: true,
  ...overrides,
});

const makeStore = (
  seed: Record<string, string>,
): OAuthAccountStore => {
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

const outgoing = (): OutgoingMessage => ({
  to: [RECIPIENT],
  subject: SUBJECT,
  body_text: 'The exact approved PDF is attached.',
  reconciliation_id: RECONCILIATION_ID,
  attachments: [{
    filename: 'document.pdf',
    mime_type: 'application/pdf',
    bytes_b64: PDF_BYTES.toString('base64'),
    size_bytes: PDF_BYTES.length,
  }],
});

describe('D-200 provider-neutral Sent source proof', () => {
  it('keeps envelope-only proof closed and distinct from attachment proof', async () => {
    const fetchBytes = vi.fn(async () => { throw new Error('must not fetch'); });
    await expect(evaluateMailSentReconciliationCandidates(
      ENVELOPE_QUERY,
      [candidate({
        attachment_set_complete: false,
        attachments: [{
          filename: 'unrelated.bin',
          mime_type: 'application/octet-stream',
          size: 10,
          source_part_id: 'unrelated',
          fetchBytes,
        }],
      })],
      true,
    )).resolves.toEqual({
      status: 'matched',
      scanned_candidates: 1,
      match: {
        proof_kind: 'envelope',
        source_id: 'provider-message-1',
        provider_message_id: '<provider-message-1@example.test>',
        sent_at: SENT_AT,
      },
    });
    expect(fetchBytes).not.toHaveBeenCalled();

    await expect(evaluateMailSentReconciliationCandidates({
      ...ENVELOPE_QUERY,
      attachment_sha256: PDF_SHA256,
    } as MailSentReconciliationQuery, [], true)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
  });

  it('matches exactly one identity/envelope/time/attachment-byte candidate', async () => {
    const fetchBytes = vi.fn(async () => Buffer.from(PDF_BYTES));
    const result = await evaluateMailSentReconciliationCandidates(QUERY, [candidate({
      attachments: [{
        filename: 'document.pdf',
        mime_type: 'application/pdf',
        size: PDF_BYTES.length,
        source_part_id: 'attachment-1',
        disposition: 'attachment',
        fetchBytes,
      }],
    })], true);

    expect(result).toEqual({
      status: 'matched',
      scanned_candidates: 1,
      match: {
        proof_kind: 'attachment',
        source_id: 'provider-message-1',
        provider_message_id: '<provider-message-1@example.test>',
        sent_at: SENT_AT,
        attachment_sha256: PDF_SHA256,
        attachment_size_bytes: PDF_BYTES.length,
      },
    });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('keeps complete absence observational and incomplete absence unavailable', async () => {
    await expect(evaluateMailSentReconciliationCandidates(QUERY, [], true)).resolves.toEqual({
      status: 'not_found',
      scanned_candidates: 0,
    });
    await expect(evaluateMailSentReconciliationCandidates(QUERY, [], false)).resolves.toEqual({
      status: 'unavailable',
      reason: 'scan_limit',
      scanned_candidates: 0,
    });
  });

  it('refuses duplicate headers, duplicate messages, and source mismatches', async () => {
    await expect(evaluateMailSentReconciliationCandidates(QUERY, [candidate({
      reconciliation_header_values: [RECONCILIATION_ID, `d200-${'b'.repeat(64)}`],
    })], true)).resolves.toMatchObject({ status: 'ambiguous', reason: 'duplicate_header' });

    await expect(evaluateMailSentReconciliationCandidates(QUERY, [
      candidate(),
      candidate({ source_id: 'provider-message-2' }),
    ], true)).resolves.toMatchObject({ status: 'ambiguous', reason: 'multiple_messages' });

    for (const mismatch of [
      candidate({ to: ['other@example.test'] }),
      candidate({ cc: ['copy@example.test'] }),
      candidate({ bcc: ['blind-copy@example.test'] }),
      candidate({ subject: 'A different subject' }),
      candidate({ sent_at: QUERY.sent_before }),
      candidate({ attachments: [{ ...attachment(), disposition: 'inline' }] }),
      candidate({ attachments: [mailSentReconciliationAttachmentPartFromBytes({
        filename: '../document.pdf',
        mime_type: 'application/pdf',
        source_part_id: 'path-mismatch',
        bytes: PDF_BYTES,
      })] }),
      candidate({ attachments: [mailSentReconciliationAttachmentPartFromBytes({
        filename: 'document.pdf',
        mime_type: 'text/plain',
        source_part_id: 'mime-mismatch',
        bytes: PDF_BYTES,
      })] }),
      candidate({ attachments: [attachment(Buffer.from('different bytes'))] }),
      candidate({ attachments: [attachment(), attachment()] }),
    ]) {
      await expect(evaluateMailSentReconciliationCandidates(QUERY, [mismatch], true))
        .resolves.toMatchObject({ status: 'ambiguous', reason: 'source_mismatch' });
    }
  });

  it('does not turn unreadable or incompletely enumerated attachments into mismatch', async () => {
    await expect(evaluateMailSentReconciliationCandidates(QUERY, [candidate({
      attachment_set_complete: false,
    })], true)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'attachment_unreadable',
    });

    await expect(evaluateMailSentReconciliationCandidates(QUERY, [candidate({
      attachments: [{
        ...attachment(),
        async fetchBytes() { throw new Error('provider attachment read failed'); },
      }],
    })], true)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'attachment_unreadable',
    });
  });
});

describe('D-200 Gmail Sent source lookup', () => {
  const providerConfig: OAuthProviderConfig = {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: 'cid',
  };
  const config: GmailProviderConfig = {
    account_slug: 'work',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'],
  };

  it('lists the bounded SENT window, fetches raw source, and proves the PDF bytes', async () => {
    const raw = buildGmailRfc5322(outgoing(), SENT_AT, () => 0.125);
    const calls: string[] = [];
    const fetcher: HttpFetcher = async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/messages')) {
        expect(parsed.searchParams.getAll('labelIds')).toEqual(['SENT']);
        expect(parsed.searchParams.get('maxResults')).toBe('50');
        expect(parsed.searchParams.get('q')).toMatch(/^after:\d+ before:\d+$/);
        return response(200, { messages: [{ id: 'gmail-sent-1', threadId: 'thread-1' }] });
      }
      if (parsed.pathname.endsWith('/messages/gmail-sent-1')) {
        if (parsed.searchParams.get('format') === 'metadata') {
          expect(parsed.searchParams.getAll('metadataHeaders')).toContain(
            MAIL_RECONCILIATION_ID_HEADER,
          );
          return response(200, {
            id: 'gmail-sent-1',
            threadId: 'thread-1',
            labelIds: ['SENT'],
            internalDate: String(SENT_AT),
            sizeEstimate: Buffer.byteLength(raw),
            payload: { headers: [{
              name: MAIL_RECONCILIATION_ID_HEADER,
              value: RECONCILIATION_ID,
            }] },
          });
        }
        expect(parsed.searchParams.get('format')).toBe('raw');
        return response(200, {
          id: 'gmail-sent-1',
          threadId: 'thread-1',
          labelIds: ['SENT'],
          internalDate: String(SENT_AT),
          raw: Buffer.from(raw).toString('base64url'),
        });
      }
      return response(404, { error: 'unmapped', url });
    };
    const provider = createGmailProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'gmail.work.access_token': 'token',
        'gmail.work.expires_at': String(Date.now() + 3_600_000),
        'gmail.work.refresh_token': 'refresh',
      }),
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });

    const result = await provider.lookupSentByReconciliationId!(QUERY);
    expect(result.status, JSON.stringify({ result, calls })).toBe('matched');
    expect(result).toMatchObject({
      status: 'matched',
      match: {
        source_id: 'gmail-sent-1',
        sent_at: SENT_AT,
        attachment_sha256: PDF_SHA256,
      },
    });
    expect(calls).toHaveLength(3);
  });

  it('returns unavailable instead of not_found when Gmail source reads fail', async () => {
    const provider = createGmailProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'gmail.work.access_token': 'token',
        'gmail.work.expires_at': String(Date.now() + 3_600_000),
        'gmail.work.refresh_token': 'refresh',
      }),
      providerConfig,
      fetcher: async () => response(503, 'unavailable'),
      scheduler: () => () => undefined,
    });
    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider_error',
      scanned_candidates: 0,
    });
  });

  it('uses metadata to skip raw bodies that do not carry the identity', async () => {
    const calls: string[] = [];
    const provider = createGmailProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'gmail.work.access_token': 'token',
        'gmail.work.expires_at': String(Date.now() + 3_600_000),
      }),
      providerConfig,
      fetcher: async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/messages')) {
          return response(200, { messages: [{ id: 'unrelated', threadId: 'thread-2' }] });
        }
        if (parsed.pathname.endsWith('/messages/unrelated')
          && parsed.searchParams.get('format') === 'metadata') {
          return response(200, {
            id: 'unrelated',
            threadId: 'thread-2',
            sizeEstimate: 1_024,
            payload: { headers: [] },
          });
        }
        throw new Error(`raw body should not be fetched: ${url}`);
      },
      scheduler: () => () => undefined,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'not_found',
      scanned_candidates: 1,
    });
    expect(calls).toHaveLength(2);
  });

  it('enforces the decoded-source ceiling even when Gmail underestimates metadata size', async () => {
    const encodedOverCap = 'A'.repeat(
      4 * Math.ceil(MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES / 3) + 5,
    );
    const provider = createGmailProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'gmail.work.access_token': 'token',
        'gmail.work.expires_at': String(Date.now() + 3_600_000),
      }),
      providerConfig,
      fetcher: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/messages')) {
          return response(200, { messages: [{ id: 'oversized', threadId: 'thread-3' }] });
        }
        if (parsed.pathname.endsWith('/messages/oversized')
          && parsed.searchParams.get('format') === 'metadata') {
          return response(200, {
            id: 'oversized',
            threadId: 'thread-3',
            sizeEstimate: 1_024,
            payload: { headers: [{
              name: MAIL_RECONCILIATION_ID_HEADER,
              value: RECONCILIATION_ID,
            }] },
          });
        }
        if (parsed.pathname.endsWith('/messages/oversized')) {
          return response(200, {
            id: 'oversized',
            threadId: 'thread-3',
            labelIds: ['SENT'],
            internalDate: String(SENT_AT),
            raw: encodedOverCap,
          });
        }
        return response(404, { error: 'unmapped', url });
      },
      scheduler: () => () => undefined,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider_error',
      scanned_candidates: 0,
    });
  });
});

describe('D-200 Graph Sent source lookup', () => {
  const providerConfig: OAuthProviderConfig = {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: 'cid',
  };
  const config: GraphProviderConfig = {
    account_slug: 'work',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: [GRAPH_SEND_SCOPE, 'Mail.Read'],
  };

  it('reads Sent Items message headers and fileAttachment bytes from Graph', async () => {
    const calls: string[] = [];
    const fetcher: HttpFetcher = async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/mailFolders/sentitems/messages')) {
        expect(parsed.searchParams.get('$filter')).toContain('sentDateTime ge ');
        expect(parsed.searchParams.get('$select')).toBe('id');
        return response(200, { value: [{ id: 'graph-sent-1' }] });
      }
      if (parsed.pathname.endsWith('/me/messages/graph-sent-1')) {
        const selected = parsed.searchParams.get('$select') ?? '';
        expect(selected).toContain('internetMessageHeaders');
        expect(selected).toContain('sentDateTime');
        return response(200, {
          id: 'graph-sent-1',
          subject: SUBJECT,
          internetMessageId: '<graph-sent-1@example.test>',
          internetMessageHeaders: [{
            name: MAIL_RECONCILIATION_ID_HEADER,
            value: RECONCILIATION_ID,
          }],
          toRecipients: [{ emailAddress: { address: RECIPIENT } }],
          hasAttachments: true,
          sentDateTime: new Date(SENT_AT).toISOString(),
        });
      }
      if (parsed.pathname.endsWith('/me/messages/graph-sent-1/attachments')) {
        expect(parsed.searchParams.get('$select')).toContain('size');
        return response(200, { value: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'graph-attachment-1',
          name: 'document.pdf',
          contentType: 'application/pdf',
          size: PDF_BYTES.length,
        }] });
      }
      if (parsed.pathname.endsWith(
        '/me/messages/graph-sent-1/attachments/graph-attachment-1',
      )) {
        return response(200, {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'graph-attachment-1',
          name: 'document.pdf',
          contentType: 'application/pdf',
          size: PDF_BYTES.length,
          contentBytes: PDF_BYTES.toString('base64'),
        });
      }
      return response(404, { error: 'unmapped', url });
    };
    const provider = createGraphProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'graph.work.access_token': 'token',
        'graph.work.expires_at': String(Date.now() + 3_600_000),
        'graph.work.refresh_token': 'refresh',
      }),
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });

    const result = await provider.lookupSentByReconciliationId!(QUERY);
    expect(result.status, JSON.stringify({ result, calls })).toBe('matched');
    expect(result).toMatchObject({
      status: 'matched',
      match: {
        source_id: 'graph-sent-1',
        provider_message_id: '<graph-sent-1@example.test>',
        attachment_sha256: PDF_SHA256,
      },
    });
    expect(calls).toHaveLength(4);
  });

  it('proves an identity-bearing envelope without enumerating Graph attachments', async () => {
    const calls: string[] = [];
    const provider = createGraphProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'graph.work.access_token': 'token',
        'graph.work.expires_at': String(Date.now() + 3_600_000),
      }),
      providerConfig,
      fetcher: async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/mailFolders/sentitems/messages')) {
          return response(200, { value: [{ id: 'graph-envelope-1' }] });
        }
        if (parsed.pathname.endsWith('/me/messages/graph-envelope-1')) {
          return response(200, {
            id: 'graph-envelope-1',
            subject: SUBJECT,
            internetMessageId: '<graph-envelope-1@example.test>',
            internetMessageHeaders: [{
              name: MAIL_RECONCILIATION_ID_HEADER,
              value: RECONCILIATION_ID,
            }],
            toRecipients: [{ emailAddress: { address: RECIPIENT } }],
            hasAttachments: true,
            sentDateTime: new Date(SENT_AT).toISOString(),
          });
        }
        throw new Error(`envelope proof must not fetch attachments: ${url}`);
      },
      scheduler: () => () => undefined,
    });

    await expect(provider.lookupSentByReconciliationId!(ENVELOPE_QUERY)).resolves.toEqual({
      status: 'matched',
      scanned_candidates: 1,
      match: {
        proof_kind: 'envelope',
        source_id: 'graph-envelope-1',
        provider_message_id: '<graph-envelope-1@example.test>',
        sent_at: SENT_AT,
      },
    });
    expect(calls).toHaveLength(2);
  });

  it('does not enumerate attachments for a Graph message without the identity', async () => {
    const calls: string[] = [];
    const provider = createGraphProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'graph.work.access_token': 'token',
        'graph.work.expires_at': String(Date.now() + 3_600_000),
      }),
      providerConfig,
      fetcher: async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/mailFolders/sentitems/messages')) {
          return response(200, { value: [{ id: 'graph-unrelated' }] });
        }
        if (parsed.pathname.endsWith('/me/messages/graph-unrelated')) {
          return response(200, {
            id: 'graph-unrelated',
            subject: SUBJECT,
            internetMessageHeaders: [],
            toRecipients: [{ emailAddress: { address: RECIPIENT } }],
            hasAttachments: true,
            sentDateTime: new Date(SENT_AT).toISOString(),
          });
        }
        throw new Error(`attachment source should not be fetched: ${url}`);
      },
      scheduler: () => () => undefined,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'not_found',
      scanned_candidates: 1,
    });
    expect(calls).toHaveLength(2);
  });

  it('refuses oversized Graph contentBytes before decoding provider source', async () => {
    const provider = createGraphProvider({
      slug: 'work',
      config: () => config,
      accountStore: makeStore({
        'graph.work.access_token': 'token',
        'graph.work.expires_at': String(Date.now() + 3_600_000),
      }),
      providerConfig,
      fetcher: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/mailFolders/sentitems/messages')) {
          return response(200, { value: [{ id: 'graph-oversized' }] });
        }
        if (parsed.pathname.endsWith('/me/messages/graph-oversized')) {
          return response(200, {
            id: 'graph-oversized',
            subject: SUBJECT,
            internetMessageId: '<graph-oversized@example.test>',
            internetMessageHeaders: [{
              name: MAIL_RECONCILIATION_ID_HEADER,
              value: RECONCILIATION_ID,
            }],
            toRecipients: [{ emailAddress: { address: RECIPIENT } }],
            hasAttachments: true,
            sentDateTime: new Date(SENT_AT).toISOString(),
          });
        }
        if (parsed.pathname.endsWith('/me/messages/graph-oversized/attachments')) {
          return response(200, { value: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'oversized-attachment',
            name: 'document.pdf',
            contentType: 'application/pdf',
            size: PDF_BYTES.length,
            isInline: false,
          }] });
        }
        if (parsed.pathname.endsWith(
          '/me/messages/graph-oversized/attachments/oversized-attachment',
        )) {
          return response(200, {
            id: 'oversized-attachment',
            name: 'document.pdf',
            contentType: 'application/pdf',
            size: PDF_BYTES.length,
            contentBytes: 'A'.repeat(4 * Math.ceil(PDF_BYTES.length / 3) + 5),
          });
        }
        return response(404, { error: 'unmapped', url });
      },
      scheduler: () => () => undefined,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'unavailable',
      reason: 'attachment_unreadable',
      scanned_candidates: 1,
    });
  });
});

class ReconciliationImapClient extends EventEmitter implements ImapClient {
  usable = true;
  opened: string[] = [];
  searchQuery: SearchObject | null = null;
  logoutCalls = 0;
  fetchQueries: FetchQueryObject[] = [];

  constructor(
    private readonly source: Buffer,
    private readonly reportedSize = source.length,
  ) { super(); }

  async connect(): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { this.logoutCalls++; this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string): Promise<MailboxObject> {
    this.opened.push(path);
    return { path, delimiter: '/', flags: new Set(), exists: 1 } as unknown as MailboxObject;
  }
  async search(query: SearchObject): Promise<number[]> {
    this.searchQuery = query;
    return [41];
  }
  async *fetch(
    _range: string | number[],
    query: FetchQueryObject,
  ): AsyncIterable<any> {
    this.fetchQueries.push(query);
    if (query.size) {
      yield { uid: 41, size: this.reportedSize };
      return;
    }
    yield {
      uid: 41,
      flags: new Set(['\\Seen']),
      internalDate: new Date(SENT_AT),
      source: this.source,
    };
  }
  async idle(): Promise<boolean> { return true; }
  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return [{ path: 'Sent Mail', specialUse: '\\Sent' }];
  }
}

describe('D-200 IMAP Sent source lookup', () => {
  it('uses a dedicated Sent client and exact HEADER search before source proof', async () => {
    const raw = buildImapRfc5322(outgoing(), {
      from: 'owner@example.test',
      messageId: '<imap-sent-1@example.test>',
      sentAt: SENT_AT,
    }, () => 0.125);
    const client = new ReconciliationImapClient(Buffer.from(raw));
    const clientFactory: ImapClientFactory = () => client;
    const config: ImapProviderConfig = {
      host: 'imap.example.test',
      port: 993,
      secure: true,
      username: 'owner@example.test',
      password: 'secret',
      folders: ['INBOX'],
    };
    const provider = createImapProvider({
      slug: 'work',
      config: () => config,
      clientFactory,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toMatchObject({
      status: 'matched',
      match: {
        source_id: '41@Sent Mail',
        provider_message_id: '<imap-sent-1@example.test>',
        attachment_sha256: PDF_SHA256,
      },
    });
    expect(client.opened).toEqual(['Sent Mail']);
    expect(client.searchQuery?.header).toEqual({
      [MAIL_RECONCILIATION_ID_HEADER]: RECONCILIATION_ID,
    });
    expect(client.logoutCalls).toBe(1);
  });

  it('refuses an oversized IMAP source before fetching its body', async () => {
    const client = new ReconciliationImapClient(
      Buffer.from('not fetched'),
      MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES + 1,
    );
    const provider = createImapProvider({
      slug: 'work',
      config: () => ({
        host: 'imap.example.test',
        port: 993,
        secure: true,
        username: 'owner@example.test',
        password: 'secret',
        folders: ['INBOX'],
      }),
      clientFactory: () => client,
    });

    await expect(provider.lookupSentByReconciliationId!(QUERY)).resolves.toEqual({
      status: 'unavailable',
      reason: 'attachment_unreadable',
      scanned_candidates: 0,
    });
    expect(client.fetchQueries).toHaveLength(1);
    expect(client.fetchQueries[0]?.size).toBe(true);
    expect(client.fetchQueries[0]?.source).toBeUndefined();
  });
});
