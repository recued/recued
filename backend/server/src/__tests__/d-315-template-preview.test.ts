/** D-315 slice 3 — the template editor's reads (§6.1, §6.2): an email read
 *  again as the ingest read it, and Preview over the mailboxes. A real mail
 *  collection over a stub provider that can fetch one message again. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailTemplateDefinition } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, MailProvider } from '../collections/mail/provider.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import { readStoredEmail } from '../mail-facts/stored-email.js';
import { MailPreviewSecurityNotice, previewTemplate, type TemplatePreviewDeps } from '../mail-facts/template-preview.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;
const shipment = getMailFactBuiltinType('shipment')!;

const message = (source_id: string, over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id,
  rfc_message_id: `<${source_id}@ups.example>`,
  from: 'pkginfo@ups.com',
  from_name: 'UPS',
  to: ['me@example.com'],
  cc: [],
  subject: 'UPS Update: On the way',
  thread_id: `T-${source_id}`,
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: NOW - DAY,
  body_text: `Tracking Number: 1Z999AA1012345678${source_id.length}`,
  ...over,
});

let db: Database.Database;
let blobsDir: string;
let blobs: BlobStore;

beforeEach(async () => {
  db = new Database(':memory:');
  blobsDir = await mkdtemp(join(tmpdir(), 'd315-preview-'));
  blobs = createBlobStore(blobsDir);
});

afterEach(async () => {
  db.close();
  await rm(blobsDir, { recursive: true, force: true });
});

/** A mailbox whose provider stored `scan` and can fetch each message again
 *  from `full` (by source id) — or cannot, when `fetchable` is false. */
const mailbox = async (
  scan: CanonicalMessage[],
  options: { fetchable?: boolean; full?: Map<string, CanonicalMessage | null> } = {},
): Promise<MailCollection> => {
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'imap',
    config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
  });
  const full = options.full ?? new Map(scan.map((m) => [m.source_id, m]));
  const provider: MailProvider = {
    kind: 'imap',
    slug: 'work',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'me@example.com',
    async connect() {},
    async initialScan(opts) {
      for (const msg of scan) if (!(await opts.onMessage(msg))) break;
    },
    async startSync() { return async () => {}; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    ...(options.fetchable === false ? {} : { fetchMessage: async (id: string) => full.get(id) ?? null }),
  };
  const collection = createMailCollection({
    db,
    blobs,
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
    instances,
    now: () => NOW,
  });
  await collection.sync.start();
  return collection;
};

const recordIdOf = (collection: MailCollection, source_id: string): string =>
  collection.list({ platform: 'mail', slug: 'work', limit: 500 }).find((r) => r.source_id === source_id)!.record_id;

const deps = (collection: MailCollection): TemplatePreviewDeps => ({
  mailboxes: () => [collection],
  blobs,
  retentionDays: () => 365,
  standardsOff: () => new Set(),
});

const ups = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'UPS',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

describe('Preview (§6.2)', () => {
  it('reads the source again from its provider, then the newest emails that meet the conditions', async () => {
    const box = await mailbox([
      message('m1', { received_at: NOW - 3 * DAY }),
      message('m2', { received_at: NOW - 2 * DAY, from: 'news@shop.example', from_name: 'Shop' }),
      message('m3', { received_at: NOW - DAY }),
      message('m4', { received_at: NOW - 5 * DAY }),
    ]);
    const source = { email: { slug: 'work', record_id: recordIdOf(box, 'm1') } };
    const result = await previewTemplate(deps(box), ups(), shipment, source, 10);
    // Read whole: the sender's name is not stored, and the carrier rule reads it.
    expect(result.source).toMatchObject({ read: 'provider', outcome: 'entered' });
    expect(result.source?.facts[0]?.variables).toMatchObject({ carrier: 'UPS', tracking_number: '1Z999AA10123456782' });
    // Newest first; the other sender left out; the source not repeated.
    expect(result.recent.map((r) => r.email?.subject)).toEqual(['UPS Update: On the way', 'UPS Update: On the way']);
    expect(result.recent.map((r) => r.email?.record_id)).toEqual([recordIdOf(box, 'm3'), recordIdOf(box, 'm4')]);
    expect(result.recent[0]?.email?.goes_at).toBe(NOW - DAY + 365 * DAY);
    expect(result.scanned).toBe(4);

    const one = await previewTemplate(deps(box), ups(), shipment, source, 1);
    expect(one.recent.map((r) => r.email?.record_id)).toEqual([recordIdOf(box, 'm3')]);
  });

  it('walks past a page of emails that share one date to the email it reads', async () => {
    const burst = Array.from({ length: 202 }, (_, i) => message(`n${i}`, { from: 'news@club.example', from_name: 'Club', subject: 'Club news' }));
    const box = await mailbox([...burst, message('older', { received_at: NOW - 3 * DAY })]);
    const result = await previewTemplate(deps(box), ups(), shipment, undefined, 10);
    expect(result.recent.map((row) => row.email?.record_id)).toEqual([recordIdOf(box, 'older')]);
  }, 60_000);

  it('shows what did not enter, and the entrance variables its rules missed', async () => {
    const box = await mailbox([message('m1', { body_text: 'Your parcel is on its way.' })]);
    const result = await previewTemplate(deps(box), ups(), shipment, undefined, 10);
    expect(result.recent).toEqual([
      expect.objectContaining({ outcome: 'not_entered', unread: ['tracking_number'], facts: [] }),
    ]);
  });

  it('merges the standards pass as the writer will: a template that reads only the state is complete', async () => {
    const box = await mailbox([message('m1', { body_text: 'UPS 1Z999AA10123456784 is on its way' })]);
    const stateOnly = ups({
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: [] },
      rules: [{
        target: { variable: 'state' },
        source: 'subject',
        find: { kind: 'keyword_map', cases: [{ contains: 'On the way', value: 'in_transit' }] },
      }],
    });
    const [fact] = (await previewTemplate(deps(box), stateOnly, shipment, undefined, 10)).recent[0]!.facts;
    expect(fact).toMatchObject({
      complete: true,
      variables: { state: 'in_transit', tracking_number: '1Z999AA10123456784', carrier: 'UPS' },
      passes: { state: 'rule', tracking_number: 'standard' },
    });
  });

  it('reads the stored copy when the provider cannot fetch, and says so', async () => {
    // A tracking value no carrier's shape matches, so the standards pass adds nothing.
    const box = await mailbox([message('m1', { body_text: 'Tracking Number: PKG-4471' })], { fetchable: false });
    const [row] = (await previewTemplate(deps(box), ups(), shipment, undefined, 10)).recent;
    // The stored copy has no sender name, so the carrier the rule reads from it is missing.
    expect(row).toMatchObject({ read: 'stored', outcome: 'entered' });
    expect(row?.facts[0]?.variables).toMatchObject({ tracking_number: 'PKG-4471', carrier: null });
  });

  it('leaves to the full read a condition the stored copy cannot decide', async () => {
    // From contains "UPS" holds on the sender's NAME, which only a fetch has.
    const box = await mailbox([message('m1', { from: 'notify@carrier.example' })]);
    const byName = ups({
      entrance: { conditions: [{ field: 'from', op: 'contains', value: 'UPS' }], variables: ['tracking_number'] },
    });
    const result = await previewTemplate(deps(box), byName, shipment, undefined, 10);
    expect(result.recent.map((r) => r.outcome)).toEqual(['entered']);
  });

  it('passes over drafts and mail Recued sent, as the ingest does', async () => {
    const box = await mailbox([
      message('m1', { direction: 'draft' }),
      message('m2', { reconciliation_id: 'rcd_0123456789abcdef0123456789abcdef' }),
    ]);
    expect((await previewTemplate(deps(box), ups(), shipment, undefined, 10)).recent).toEqual([]);
  });

  it('passes over security notices, and refuses one as the email it is made from (§9)', async () => {
    const box = await mailbox([
      message('m1', { subject: 'UPS Update: Your verification code is 482913' }),
      message('m2'),
    ]);
    const result = await previewTemplate(deps(box), ups(), shipment, undefined, 10);
    expect(result.recent.map((row) => row.email?.record_id)).toEqual([recordIdOf(box, 'm2')]);
    await expect(previewTemplate(deps(box), ups(), shipment, { email: { slug: 'work', record_id: recordIdOf(box, 'm1') } }, 10))
      .rejects.toBeInstanceOf(MailPreviewSecurityNotice);
    await expect(previewTemplate(deps(box), ups(), shipment, {
      sample: { from: 'UPS <pkginfo@ups.com>', subject: 'Your one-time code', body: 'Tracking Number: 1Z999AA10123456784' },
    }, 10)).rejects.toBeInstanceOf(MailPreviewSecurityNotice);
  });

  it('reads a pasted sample', async () => {
    const box = await mailbox([]);
    const result = await previewTemplate(deps(box), ups(), shipment, {
      sample: { from: 'UPS <pkginfo@ups.com>', subject: 'UPS Update', body: 'Tracking Number: 1Z999AA10123456784' },
    }, 10);
    expect(result.source).toMatchObject({ read: 'sample', outcome: 'entered' });
    expect(result.source?.facts[0]?.variables).toMatchObject({ carrier: 'UPS' });
    expect(result.source?.email).toBeUndefined();
  });
});

describe('reading a stored email again', () => {
  it('treats another message under the same IMAP UID as gone, and reads the stored copy', async () => {
    const renumbered = new Map([['m1', message('m1', { rfc_message_id: '<someone-else@elsewhere>' })]]);
    const box = await mailbox([message('m1')], { full: renumbered });
    const stored = await readStoredEmail({ blobs }, box, recordIdOf(box, 'm1'));
    expect(stored).toMatchObject({ read: 'stored', fallback: 'gone' });
    expect(stored?.envelope.sent_by_account).toBe(false);
  });

  it('takes a message fetched with no Message-ID for another one when the stored email has one', async () => {
    // The id reused for a message that carries no Message-ID: not this email.
    const reused = new Map([['m1', message('m1', { rfc_message_id: undefined, subject: 'Someone else', body_text: 'Not yours' })]]);
    const box = await mailbox([message('m1')], { full: reused });
    const stored = await readStoredEmail({ blobs }, box, recordIdOf(box, 'm1'));
    expect(stored).toMatchObject({ read: 'stored', fallback: 'gone' });
    expect(stored?.email.body_text).not.toBe('Not yours');
  });

  it('names an attachment by the file the ingest made of it', async () => {
    const withFile = message('m1', {
      has_attachments: true,
      attachments: [{
        filename: 'label.pdf', mime_type: 'application/pdf', size: 3, source_part_id: 'p7',
        fetchBytes: async () => Buffer.from('pdf'),
      }],
    });
    const box = await mailbox([message('m1')], { full: new Map([['m1', withFile]]) });
    const stored = await readStoredEmail({ blobs, fileStored: () => true }, box, recordIdOf(box, 'm1'));
    expect(stored?.email.attachments).toEqual([
      { file_id: expect.stringMatching(/^file:[0-9a-f]{32}$/), filename: 'label.pdf', mime_type: 'application/pdf' },
    ]);
    // A download that failed at ingest stored no file: none is offered, and a
    // rule cannot read one that does not exist.
    const asked: string[] = [];
    const missing = await readStoredEmail({ blobs, fileStored: (id) => { asked.push(id); return false; } }, box, recordIdOf(box, 'm1'));
    expect(missing?.email.attachments).toEqual([]);
    expect(asked).toEqual([stored!.email.attachments[0]!.file_id]);
    // Nothing to ask: nothing offered.
    expect((await readStoredEmail({ blobs }, box, recordIdOf(box, 'm1')))?.email.attachments).toEqual([]);
  });
});

describe('the editor’s rpc', () => {
  const rpcFor = async (box: MailCollection) => {
    const store = createMailFactStore(db);
    return makeMailFactRpcHandlers({ store, editor: deps(box) })!.handlers;
  };

  it('reads an email for the editor, whole', async () => {
    const box = await mailbox([message('m1', { body_html: '<p>Tracking</p>' })]);
    const rpc = await rpcFor(box);
    const content = await rpc['mail_fact.email.read']({ slug: 'work', record_id: recordIdOf(box, 'm1') }, owner);
    expect(content).toMatchObject({
      read: 'provider',
      from_name: 'UPS',
      html: '<p>Tracking</p>',
      body_text: 'Tracking Number: 1Z999AA10123456782',
      email: { from: 'pkginfo@ups.com', subject: 'UPS Update: On the way' },
    });
    expect(content.truncated).toBeUndefined();
  });

  it('refuses a security notice, an email no longer stored, and a server without mail', async () => {
    const box = await mailbox([message('m1', { subject: 'Your verification code' })]);
    const rpc = await rpcFor(box);
    await expect(rpc['mail_fact.email.read']({ slug: 'work', record_id: recordIdOf(box, 'm1') }, owner))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc['mail_fact.email.read']({ slug: 'work', record_id: 'mail:nope' }, owner))
      .rejects.toMatchObject({ code: 'not_found' });
    const bare = makeMailFactRpcHandlers({ store: createMailFactStore(db) })!.handlers;
    await expect(bare['mail_fact.email.read']({ slug: 'work', record_id: 'x' }, owner))
      .rejects.toMatchObject({ code: 'not_configured' });
    await expect(bare['mail_fact.template.preview']({ definition: ups() }, owner))
      .rejects.toMatchObject({ code: 'not_configured' });
  });

  it('cuts a very long email for the editor and says so', async () => {
    const box = await mailbox([message('m1', { body_text: 'x'.repeat(250_000) })]);
    const content = await (await rpcFor(box))['mail_fact.email.read']({ slug: 'work', record_id: recordIdOf(box, 'm1') }, owner);
    expect(content.body_text).toHaveLength(200_000);
    expect(content.truncated).toBe(true);
  });

  it('previews through the rpc, and refuses what it cannot read', async () => {
    const box = await mailbox([message('m1')]);
    const rpc = await rpcFor(box);
    await expect(rpc['mail_fact.template.preview']({ definition: ups(), limit: 5 }, owner))
      .resolves.toMatchObject({ recent: [expect.objectContaining({ outcome: 'entered' })] });
    for (const bad of [
      { definition: ups(), limit: -1 },
      { definition: ups(), source: { sample: { from: 'a@b.example', subject: 's' } } },
      { definition: ups(), source: { sample: { from: 'a@b.example', subject: 's', body: 'x'.repeat(200_001) } } },
      { definition: ups({ entrance: { conditions: [], variables: ['nope'] } }) },
    ]) {
      await expect(rpc['mail_fact.template.preview'](bad as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    }
  });
});
