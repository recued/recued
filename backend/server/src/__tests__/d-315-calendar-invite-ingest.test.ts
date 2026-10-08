/** D-315 slice 7 (ruling 34) — mail ingest keeps a calendar invite, as a
 *  calendar, and lets one copy of it wake a recipe.
 *
 *  What was true before, and what each part here proves is no longer:
 *   - Google's `invite.ics` (`application/ics`) was stored as `text/plain`, so a
 *     recipe waiting for `text/calendar` never heard of it;
 *   - Gmail dropped an invite's inline `text/calendar` part whenever anything
 *     else in the email had a filename — an Outlook invite with an agenda PDF
 *     left no invite at all;
 *   - Outlook's meeting emails carry no `.ics` through Graph at all;
 *   - an email carrying the invite twice (Google sends it inline and attached,
 *     and IMAP keeps both) woke every invite recipe twice — two asks for one
 *     invite. */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { attachFile } from '../collections/file/attach-file.js';
import { createInboundFileCollection, type InboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createGmailProvider, type GmailProviderConfig } from '../collections/mail/gmail-provider.js';
import { createGraphProvider, type GraphMessagePayload, type GraphProviderConfig } from '../collections/mail/graph-provider.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../collections/mail/oauth.js';
import {
  detectMailAttachmentMimeType,
  type CanonicalMessage,
  type InboundMailAttachmentPart,
  type MailProvider,
  type ProviderSyncCallback,
} from '../collections/mail/provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';

const INVITE = [
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'METHOD:REQUEST',
  'BEGIN:VEVENT', 'DTSTART:20261015T140000Z', 'DTEND:20261015T150000Z', 'UID:abc123@google.com',
  'ORGANIZER;CN=Alice:mailto:alice@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@owner.example',
  'SEQUENCE:0', 'SUMMARY:Quarterly planning', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
/** The same invite, written another way: what Google attaches beside it. */
const INVITE_LF = INVITE.replace(/\r\n/g, '\n');
const PDF = Buffer.from('%PDF-1.4 agenda');

// ────────────────────────────────────────────────────────────────
// What an invite is stored as
// ────────────────────────────────────────────────────────────────

describe('an invite is stored as a calendar, whatever it was sent as', () => {
  it.each([
    ['application/ics', INVITE],
    ['application/octet-stream', INVITE],
    ['text/plain', INVITE_LF],
    ['text/calendar; method=REQUEST', `﻿${INVITE}`],
  ])('%s', (reported, text) => {
    expect(detectMailAttachmentMimeType(Buffer.from(text, 'utf8'), reported)).toBe('text/calendar');
  });

  it('a text that is no calendar keeps its type', () => {
    expect(detectMailAttachmentMimeType(Buffer.from('BEGIN:VCARD\r\nFN:Alice\r\nEND:VCARD\r\n'), 'text/vcard')).toBe('text/vcard');
    expect(detectMailAttachmentMimeType(Buffer.from('just notes'), 'application/ics')).toBe('text/plain');
  });
});

// ────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────

const store = (seed: Record<string, string>): OAuthAccountStore => {
  const data = new Map(Object.entries(seed));
  return {
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

type Route = { match: (url: string) => boolean; body: unknown; status?: number };

const router = (routes: Route[]): { fetcher: HttpFetcher; calls: string[] } => {
  const calls: string[] = [];
  const fetcher: HttpFetcher = async (url) => {
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    const status = route ? route.status ?? 200 : 404;
    const body = route ? route.body : { error: `unmapped ${url}` };
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return body; },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
  };
  return { fetcher, calls };
};

const B = 'outer-boundary';
const A = 'alt-boundary';
/** An Outlook-style invite to a Gmail mailbox with an agenda attached: the
 *  invite is only the inline `text/calendar` part, which has no filename. */
const OUTLOOK_TO_GMAIL_RAW = [
  'From: alice@example.com', 'To: me@owner.example', 'Subject: Quarterly planning',
  'Message-ID: <invite@example.com>', 'Date: Thu, 1 Oct 2026 10:00:00 +0000',
  `Content-Type: multipart/mixed; boundary="${B}"`, '',
  `--${B}`, `Content-Type: multipart/alternative; boundary="${A}"`, '',
  `--${A}`, 'Content-Type: text/plain; charset="utf-8"', '', 'You are invited.',
  `--${A}`, 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(INVITE).toString('base64'),
  `--${A}--`,
  `--${B}`, 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="agenda.pdf"', '', PDF.toString('base64'),
  `--${B}--`, '',
].join('\r\n');

describe('Gmail keeps an invite that has no filename', () => {
  it('beside an attachment that has one — the invite and the agenda both arrive', async () => {
    const { fetcher } = router([
      { match: (u) => u.includes('/profile'), body: { historyId: '1000', emailAddress: 'me@owner.example' } },
      { match: (u) => u.includes('/messages?') || u.endsWith('/messages'), body: { messages: [{ id: 'm1', threadId: 't1' }] } },
      { match: (u) => u.includes('/messages/m1?format=raw'),
        body: { id: 'm1', threadId: 't1', labelIds: ['INBOX'], raw: Buffer.from(OUTLOOK_TO_GMAIL_RAW).toString('base64url'), internalDate: '1790000000000' } },
      { match: (u) => u.includes('/messages/m1?format=full'),
        body: {
          id: 'm1', threadId: 't1', labelIds: ['INBOX'],
          payload: {
            partId: '', mimeType: 'multipart/mixed', parts: [
              { partId: '0', mimeType: 'multipart/alternative', parts: [
                { partId: '0.0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from('You are invited.').toString('base64url'), size: 16 } },
                { partId: '0.1', mimeType: 'text/calendar', filename: '', body: { data: Buffer.from(INVITE).toString('base64url'), size: INVITE.length } },
              ] },
              { partId: '1', mimeType: 'application/pdf', filename: 'agenda.pdf', body: { attachmentId: 'ATT-PDF', size: PDF.length } },
            ],
          },
        } },
      { match: (u) => u.includes('/messages/m1/attachments/ATT-PDF'), body: { data: PDF.toString('base64url'), size: PDF.length } },
    ]);
    const provider = createGmailProvider({
      slug: 'work',
      config: (): GmailProviderConfig => ({ account_slug: 'work', backfill_days: 7, poll_seconds: 30 }),
      accountStore: store({ 'gmail.work.access_token': 'at', 'gmail.work.expires_at': String(Date.now() + 3_600_000), 'gmail.work.refresh_token': 'rt' }),
      providerConfig: { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'c', clientSecret: 's' } as OAuthProviderConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    let message: CanonicalMessage | undefined;
    await provider.initialScan({ backfill_days: 7, onMessage: async (m) => { message = m; return true; } });
    await provider.close();
    const parts = message!.attachments!;
    expect(parts.map((p) => [p.filename, p.mime_type])).toEqual([
      ['invite.ics', 'text/calendar'],
      ['agenda.pdf', 'application/pdf'],
    ]);
    expect((await parts[0]!.fetchBytes()).toString('utf8')).toBe(INVITE);
  });
});

const MEETING_MIME = [
  'From: alice@example.com', 'To: me@owner.example', 'Subject: Quarterly planning',
  `Content-Type: multipart/alternative; boundary="${A}"`, '',
  `--${A}`, 'Content-Type: text/html; charset="utf-8"', '', '<p>You are invited.</p>',
  `--${A}`, 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', 'Content-Transfer-Encoding: quoted-printable', '',
  INVITE.replace(/=/g, '=3D'),
  `--${A}--`, '',
].join('\r\n');

const graphMessage = (overrides: Partial<GraphMessagePayload>): GraphMessagePayload => ({
  id: 'gid', subject: 'Quarterly planning', from: { emailAddress: { address: 'alice@example.com' } },
  toRecipients: [{ emailAddress: { address: 'me@owner.example' } }], ccRecipients: [], conversationId: 'c1',
  parentFolderId: 'inbox', isRead: false, hasAttachments: false, receivedDateTime: '2026-10-01T10:00:00Z',
  body: { contentType: 'html', content: '<p>You are invited.</p>' },
  ...overrides,
});

describe("Outlook's meeting emails give up their invite from the raw message", () => {
  const scan = async (messages: GraphMessagePayload[], mime: Record<string, string>) => {
    const { fetcher, calls } = router([
      { match: (u) => u.includes('/messages?'), body: { value: messages } },
      ...Object.entries(mime).map(([id, text]): Route => ({ match: (u) => u.endsWith(`/me/messages/${id}/$value`), body: text })),
      { match: (u) => u.includes('/messages/delta'), body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x' } },
    ]);
    const provider = createGraphProvider({
      slug: 'work',
      config: (): GraphProviderConfig => ({ account_slug: 'work', backfill_days: 7, poll_seconds: 30 }),
      accountStore: store({ 'graph.work.access_token': 'at', 'graph.work.expires_at': String(Date.now() + 3_600_000), 'graph.work.refresh_token': 'rt' }),
      providerConfig: { tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', clientId: 'c' } as OAuthProviderConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    const got: CanonicalMessage[] = [];
    await provider.initialScan({ backfill_days: 7, onMessage: async (m) => { got.push(m); return true; } });
    await provider.close();
    return { got, calls };
  };

  it('a meeting request carries an invite.ics read from its MIME, and only when stored', async () => {
    const { got, calls } = await scan(
      [graphMessage({ id: 'meet', '@odata.type': '#microsoft.graph.eventMessageRequest' }), graphMessage({ id: 'plain' })],
      { meet: MEETING_MIME },
    );
    const [meet, plain] = got;
    expect(meet!.has_attachments).toBe(true);
    expect(meet!.attachments!.map((p) => [p.filename, p.mime_type])).toEqual([['invite.ics', 'text/calendar']]);
    expect(calls.some((u) => u.includes('$value'))).toBe(false);
    expect((await meet!.attachments![0]!.fetchBytes()).toString('utf8').replace(/\r\n/g, '\n')).toBe(INVITE_LF);
    expect(plain!.attachments).toBeUndefined();
    expect(calls.filter((u) => u.includes('$value'))).toHaveLength(1);
  });

  it('an answer and a cancellation are meeting emails too', async () => {
    const { got } = await scan([
      graphMessage({ id: 'r', '@odata.type': '#microsoft.graph.eventMessageResponse' }),
      graphMessage({ id: 'c', '@odata.type': '#microsoft.graph.eventMessage' }),
    ], {});
    expect(got.map((m) => m.attachments?.map((p) => p.filename))).toEqual([['invite.ics'], ['invite.ics']]);
  });

  it('a meeting item whose MIME holds no calendar fails as a part, not as the email', async () => {
    const { got } = await scan([graphMessage({ id: 'odd', '@odata.type': '#microsoft.graph.eventMessage' })], {
      odd: ['Content-Type: text/plain', '', 'no invite here', ''].join('\r\n'),
    });
    await expect(got[0]!.attachments![0]!.fetchBytes()).rejects.toThrow('carries no invite');
  });
});

// ────────────────────────────────────────────────────────────────
// One invite, one wake
// ────────────────────────────────────────────────────────────────

const part = (filename: string, mime: string, text: string | Buffer, id: string): InboundMailAttachmentPart => ({
  filename,
  mime_type: mime,
  size: Buffer.byteLength(text),
  source_part_id: id,
  async fetchBytes() { return Buffer.from(text); },
});

const message = (id: string, attachments: InboundMailAttachmentPart[]): CanonicalMessage => ({
  source_id: id, from: 'alice@example.com', to: ['me@owner.example'], cc: [], subject: 'Quarterly planning',
  thread_id: `t-${id}`, folder_or_label: 'INBOX', is_read: false, is_flagged: false, has_attachments: true,
  received_at: 1_790_000_000_000, body_text: 'You are invited.', attachments,
});

interface Mailbox {
  collection: MailCollection;
  files: InboundFileCollection;
  fileEvents: WarehouseEvent[];
  receive(msg: CanonicalMessage): Promise<void>;
  close(): Promise<void>;
}

const mailboxes: Mailbox[] = [];
afterEach(async () => { while (mailboxes.length > 0) await mailboxes.pop()!.close(); });

/** A mail collection over the real file store, its first scan done. */
const openMailbox = async (firstScan: CanonicalMessage[] = []): Promise<Mailbox> => {
  const dir = mkdtempSync(join(tmpdir(), 'd315-invite-ingest-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  const db = new Database(join(dir, 'data', 'test.db'));
  const blobs = createBlobStore(join(dir, 'data', 'blobs'));
  const bus = createWarehouseEventBus();
  const fileEvents: WarehouseEvent[] = [];
  bus.subscribe('data.file.**', (event) => { fileEvents.push(event); });
  const registry = createCollectionRegistry();
  let n = 0;
  const annotations = createAnnotationStore({ db, blobs, now: () => 1, newId: () => `link-${++n}` });
  const files = createInboundFileCollection({
    db, blobs, bus, slug: 'received', now: () => 1_790_000_000_000,
    gate: createStorageGate({ quota: 1e8, reservePct: 10, surface: 'collection:file:received' }),
  });
  registry.register(files);
  let push: ProviderSyncCallback | null = null;
  const provider: MailProvider = {
    kind: 'imap', slug: 'work', sendCapable: false, mutationCapable: false, accountEmail: 'me@owner.example',
    async connect() {},
    async initialScan(opts) { for (const m of firstScan) await opts.onMessage(m); },
    async startSync(cb) { push = cb; return async () => { push = null; }; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
  };
  // The mailbox's row, where the first scan records that it finished: until
  // then every attachment it stores is past mail's, and wakes nothing.
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'imap', config: { account_email: 'me@owner.example' },
    caps: {}, auth_state: 'healthy', last_synced_at: null,
  } as never);
  const collection = createMailCollection({
    db, blobs, bus, slug: 'work', provider, instances,
    gate: createStorageGate({ quota: 1e8, reservePct: 10, surface: 'collection:mail:work' }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1e8 }),
    now: () => 1_790_000_000_000,
    inboundAttachmentDeps: () => ({
      fileIngestor: files,
      attach: attachFile,
      attachDeps: { annotationDeps: { store: annotations } as AnnotationRpcDeps, registry },
    }),
  });
  registry.register(collection);
  await collection.sync.start();
  const box: Mailbox = {
    collection, files, fileEvents,
    async receive(msg) { await push!({ kind: 'created', source_id: msg.source_id, message: msg }); },
    async close() { await collection.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  mailboxes.push(box);
  return box;
};

const created = (events: readonly WarehouseEvent[]) => events
  .filter((e) => e.event_kind === 'created')
  .map((e) => ({ filename: e.record?.filename, mime_type: e.record?.mime_type, wakes: e.in_drain !== true }));

describe('one invite starts one run', () => {
  it('two copies of one invite in one email: both kept, the first wakes, the second does not', async () => {
    const box = await openMailbox();
    await box.receive(message('m1', [
      part('attachment-1', 'text/calendar', INVITE, 'p1'),
      part('agenda.pdf', 'application/pdf', PDF, 'p2'),
      part('invite.ics', 'application/ics', INVITE_LF, 'p3'),
    ]));
    expect(created(box.fileEvents)).toEqual([
      { filename: 'attachment-1', mime_type: 'text/calendar', wakes: true },
      { filename: 'agenda.pdf', mime_type: 'application/pdf', wakes: true },
      { filename: 'invite.ics', mime_type: 'text/calendar', wakes: false },
    ]);
  });

  it('two different invites in one email each wake; the same invite in the next email wakes again', async () => {
    const box = await openMailbox();
    const other = INVITE.replace('UID:abc123@google.com', 'UID:other@google.com');
    await box.receive(message('m1', [part('a.ics', 'text/calendar', INVITE, 'p1'), part('b.ics', 'text/calendar', other, 'p2')]));
    await box.receive(message('m2', [part('invite.ics', 'application/ics', INVITE, 'p1')]));
    expect(created(box.fileEvents).map((e) => e.wakes)).toEqual([true, true, true]);
  });

  it("the first scan's invites wake nothing — past mail is past", async () => {
    const box = await openMailbox([message('old', [part('invite.ics', 'application/ics', INVITE, 'p1')])]);
    expect(created(box.fileEvents)).toEqual([{ filename: 'invite.ics', mime_type: 'text/calendar', wakes: false }]);
  });

  it("a received file's event carries its hot fields, for a trigger filter to read before a run", async () => {
    const box = await openMailbox();
    await box.receive(message('m1', [part('invite.ics', 'application/ics', INVITE, 'p1')]));
    const event = box.fileEvents.find((e) => e.event_kind === 'created')!;
    expect(event.record).toMatchObject({ filename: 'invite.ics', mime_type: 'text/calendar', origin: 'mail_attachment', size: INVITE.length });
  });
});
