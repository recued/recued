/** D-315 §6.5 — Senders without a template: counted from the stored mail of
 *  the last 30 days, with no AI; the senders no template and no standard reads,
 *  most mail first. A real mail collection over a stub provider. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, MailProvider } from '../collections/mail/provider.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import { listSendersWithoutTemplate } from '../mail-facts/senders.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;

let db: Database.Database;
let blobsDir: string;
let blobs: BlobStore;
let store: MailFactStore;

beforeEach(async () => {
  db = new Database(':memory:');
  blobsDir = await mkdtemp(join(tmpdir(), 'd315-senders-'));
  blobs = createBlobStore(blobsDir);
  store = createMailFactStore(db, { now: () => NOW });
});

afterEach(async () => {
  db.close();
  await rm(blobsDir, { recursive: true, force: true });
});

let n = 0;
const mail = (from: string, subject: string, daysAgo: number, over: Partial<CanonicalMessage> = {}): CanonicalMessage => {
  n += 1;
  return {
    source_id: `s${n}`,
    from,
    to: ['me@example.com'],
    cc: [],
    subject,
    thread_id: `t${n}`,
    folder_or_label: 'INBOX',
    direction: 'inbound',
    is_read: false,
    is_flagged: false,
    has_attachments: false,
    received_at: NOW - daysAgo * DAY,
    body_text: 'Hello',
    ...over,
  };
};

const mailbox = async (scan: CanonicalMessage[]): Promise<MailCollection> => {
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'imap',
    config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
  });
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
  };
  const collection = createMailCollection({
    db,
    blobs,
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 60, retention_days: 365, quota_bytes: 1024 * 1024 }),
    instances,
    now: () => NOW,
  });
  await collection.sync.start();
  return collection;
};

const deps = (box: MailCollection) => ({ mailboxes: () => [box], store, blobs, now: () => NOW });

describe('Senders without a template (§6.5)', () => {
  it('reads past a page of emails that share one date', async () => {
    const burst = Array.from({ length: 502 }, () => mail('news@club.example', 'Club news', 1));
    const box = await mailbox([...burst, mail('billing@water.example', 'Water bill for September', 2)]);
    const result = await listSendersWithoutTemplate(deps(box), 20);
    expect(result.scanned).toBe(503);
    expect(result.senders.map((s) => [s.address, s.count])).toEqual([
      ['news@club.example', 502],
      ['billing@water.example', 1],
    ]);
  }, 60_000);

  it('counts the senders no template and no standard reads, most mail first, with their common subjects', async () => {
    const box = await mailbox([
      mail('news@club.example', 'Club news #12', 1),
      mail('news@club.example', 'Club news #13', 8),
      mail('news@club.example', 'Your membership renews', 9),
      mail('billing@water.example', 'Water bill for September', 2),
      // The shop's newer email gave no fact, its older one did: a template or
      // a standard reads the shop, so it is not a sender without one.
      mail('ship@shop.example', 'Order 2 shipped', 1),
      mail('ship@shop.example', 'Order 1 shipped', 3),
    ]);
    const shopEmail = box.list({ platform: 'mail', slug: 'work', limit: 50 })
      .find((r) => r.hot_fields.subject === 'Order 1 shipped')!;
    store.insertFact({
      fact_id: 'f1', type: 'shipment', template_id: null, email: { slug: 'work', record_id: shopEmail.record_id },
      email_at: shopEmail.received_at, position: 0, identity_keys: [], thing_id: null, variables: {}, passes: {},
      data: null, missing: [], refused: [], complete: true, source_hash: 'h', revision: 1, created_at: 1,
    });
    const result = await listSendersWithoutTemplate(deps(box), 20);
    expect(result.days).toBe(30);
    expect(result.scanned).toBe(6);
    expect(result.senders.map((s) => [s.address, s.count])).toEqual([
      ['news@club.example', 3],
      ['billing@water.example', 1],
    ]);
    const club = result.senders[0]!;
    // Numbers set aside when counting: the two newsletters are one subject,
    // shown in its newest wording.
    expect(club.subjects).toEqual([
      { subject: 'Club news #12', count: 2 },
      { subject: 'Your membership renews', count: 1 },
    ]);
    expect(club.newest).toMatchObject({ slug: 'work', subject: 'Club news #12', at: NOW - DAY });
  });

  it('leaves out outbound mail, drafts, mail Recued sent, the account itself, security notices and the window’s edge', async () => {
    const box = await mailbox([
      mail('me@example.com', 'Note to self', 1),
      mail('friend@x.example', 'Re: dinner', 1, { direction: 'outbound' }),
      mail('friend@x.example', 'Draft', 1, { direction: 'draft' }),
      mail('friend@x.example', 'Sent by a recipe', 1, { reconciliation_id: 'rcd_0123456789abcdef' }),
      mail('no-reply@bank.example', 'Your sign-in', 1, { body_text: 'Your verification code is 123456' }),
      mail('old@x.example', 'Long ago', 40),
    ]);
    expect((await listSendersWithoutTemplate(deps(box), 20)).senders).toEqual([]);
  });

  it('keeps a dismissed sender out until it is shown again, through the rpc', async () => {
    const box = await mailbox([mail('news@club.example', 'Club news', 1)]);
    const rpc = makeMailFactRpcHandlers({
      store,
      now: () => NOW,
      editor: { mailboxes: () => [box], blobs, standardsOff: () => new Set() },
    })!.handlers;
    expect((await rpc['mail_fact.senders.list'](undefined, owner)).senders).toHaveLength(1);
    await expect(rpc['mail_fact.senders.dismiss']({ address: 'News@Club.example', dismissed: true }, owner))
      .resolves.toEqual({ address: 'news@club.example', dismissed: true });
    const after = await rpc['mail_fact.senders.list'](undefined, owner);
    expect(after.senders).toEqual([]);
    expect(after.dismissed).toEqual(['news@club.example']);
    await rpc['mail_fact.senders.dismiss']({ address: 'news@club.example', dismissed: false }, owner);
    expect((await rpc['mail_fact.senders.list'](undefined, owner)).senders).toHaveLength(1);
    await expect(rpc['mail_fact.senders.list']({ limit: 0 }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(rpc['mail_fact.senders.dismiss']({ address: '', dismissed: true }, owner))
      .rejects.toMatchObject({ code: 'bad_request' });
  });
});
