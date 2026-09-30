/** D-315 — every wait on the way to a write (the waiting sweep, §13).
 *
 *  A write that trusted what it read before a wait wrote the email as it was:
 *  moved while a backfill fetched it, it kept what an older template read; its
 *  file deleted while it waited for room, a fact named the file. Each path's
 *  waits are listed here, and each is given each change an email can take
 *  there — a label off or on, a relationship off, a move, a deletion, a file
 *  gone, its template's AI off — and the result must be what the same run
 *  gives when the change came first: the write reads, after its last wait,
 *  everything it depends on.
 *
 *  The waits (§13 lists them with what each write re-reads):
 *   - the live ingest: an attachment's download;
 *   - a backfill: the provider's fetch, and the wait for room;
 *   - the AI pass: the stored copy's read, the model's call, and the wait for
 *     room. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { MailTemplateDefinition } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { inboundFileRecordId } from '../collections/file/inbound-file-collection.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, MailProvider, ProviderSyncCallback } from '../collections/mail/provider.js';
import { createMailFactAiRunner, type MailFactAiEmail } from '../mail-facts/ai-pass.js';
import { createMailFactBackfill } from '../mail-facts/backfill.js';
import { createMailFactWriter, type MailFactWriteInput } from '../mail-facts/fact-writer.js';
import { createMailFactIngest } from '../mail-facts/mail-ingest.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** What a world holds, as two runs are compared: each fact of each email, by
 *  the email's id (named by its source id alike in both), the things, and
 *  what was told. Ids minted for a fact or a thing are left out, and a file
 *  is named by whether it is stored — the ingest names one by its email's id
 *  when it downloaded it, which a move changes. */
const picture = (store: MailFactStore, events: readonly WarehouseEvent[], files?: ReadonlySet<string>) => ({
  facts: store.listFacts()
    .map((fact) => ({
      email: fact.email.record_id,
      type: fact.type,
      from_template: fact.template_id !== null,
      variables: fact.variables,
      data: fact.data === null ? null : Object.fromEntries(Object.entries(fact.data as Record<string, unknown>).map(([key, value]) =>
        [key, typeof value === 'string' && value.startsWith('file:') ? (files?.has(value) === false ? 'a file not stored' : 'a stored file') : value])),
      complete: fact.complete,
      ai: fact.ai === undefined ? null : { state: fact.ai.state, ...('reason' in fact.ai ? { reason: fact.ai.reason } : {}) },
    }))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  things: store.listThings().length,
  // What each event said, but the ids a world mints, at any depth.
  told: events.map((event) => JSON.stringify({
    kind: `${event.entity_type}.${event.event_kind}`,
    changed: event.changed_fields ?? null,
    origin: event.origin ?? null,
    record: event.record ?? null,
  }, (key, value: unknown) => (key === '_id' || key === 'thing_id' ? undefined
    : typeof value === 'string' && /^(?:mtpl|mfact|mthing|thing)_[\w-]+$/.test(value) ? 'an id'
      : typeof value === 'string' && value.startsWith('file:') ? 'a file'
        : value))).sort(),
});

// ────────────────────────────────────────────────────────────────
// A mailbox: the live ingest and a backfill
// ────────────────────────────────────────────────────────────────

type Wait = 'bytes' | 'fetch' | 'room';

interface Mailbox {
  readonly store: MailFactStore;
  readonly events: WarehouseEvent[];
  readonly box: MailCollection;
  readonly push: (event: Parameters<ProviderSyncCallback>[0]) => Promise<void>;
  /** The provider's copy of each message, by source id: what a fetch gives. */
  readonly messages: Map<string, CanonicalMessage>;
  /** The attachment files stored, by file id. */
  readonly files: Set<string>;
  readonly state: { relationships: string[] };
  /** Run once at the wait named, then cleared. */
  readonly at: Partial<Record<Wait, () => Promise<void> | void>>;
  readonly templateId: string;
  readonly close: () => Promise<void>;
}

/** Read by the ingest as it was first written — the tracking number alone —
 *  and by a backfill as it is now: its order and its receipt too. So a
 *  backfill that skips an email leaves what the first reading gave. */
const firstDefinition: MailTemplateDefinition = {
  name: 'UPS, watched',
  type: 'shipment',
  entrance: {
    conditions: [
      { field: 'from', op: 'domain_is', value: 'ups.com' },
      { field: 'label', op: 'is', value: 'watch' },
      { field: 'relationship', op: 'is', value: 'work' },
    ],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
  ],
  html: false,
  ai: { enabled: false },
};
const nowDefinition: MailTemplateDefinition = {
  ...firstDefinition,
  rules: [
    ...firstDefinition.rules,
    { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
    { target: { data: 'receipt' }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: 'application/pdf' } },
  ],
};

const notice = (at: Mailbox['at'], over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'm1',
  rfc_message_id: '<m1@ups.example>',
  from: 'pkginfo@ups.com',
  from_name: 'UPS',
  to: ['me@example.com'],
  cc: [],
  subject: 'UPS Update: on its way',
  thread_id: 't-m1',
  folder_or_label: 'INBOX',
  labels: ['INBOX', 'watch'],
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: true,
  received_at: NOW - DAY,
  body_text: 'Tracking Number: TRACK-A\nOrder: ORD-1',
  attachments: [{
    source_part_id: 'p1',
    filename: 'receipt.pdf',
    mime_type: 'application/pdf',
    size_bytes: 8,
    fetchBytes: async () => {
      const wait = at.bytes;
      delete at.bytes;
      await wait?.();
      return Buffer.from('%PDF-1.4');
    },
  }],
  ...over,
} as CanonicalMessage);

/** A real mailbox and fact store, its template first read as `firstDefinition`
 *  (the ingest reads `scan` with it), then edited to `nowDefinition`. */
const mailbox = async (options: { readonly scan: (at: Mailbox['at']) => CanonicalMessage[]; readonly firstRead?: boolean }): Promise<Mailbox> => {
  const db = new Database(':memory:');
  const blobsDir = await mkdtemp(join(tmpdir(), 'd315-waits-'));
  const blobs = createBlobStore(blobsDir);
  const store = createMailFactStore(db, { now: () => NOW });
  const events: WarehouseEvent[] = [];
  const writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => NOW });
  const files = new Set<string>();
  const state = { relationships: ['work'] };
  const at: Mailbox['at'] = {};
  const messages = new Map<string, CanonicalMessage>();
  for (const message of options.scan(at)) messages.set(message.source_id, message);
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'gmail',
    config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
  });
  let sync: ProviderSyncCallback | null = null;
  const provider: MailProvider = {
    kind: 'gmail',
    slug: 'work',
    sendCapable: false,
    mutationCapable: true,
    accountEmail: 'me@example.com',
    async connect() {},
    async initialScan(opts) { for (const message of [...messages.values()]) await opts.onMessage(message); },
    async startSync(cb) {
      sync = cb;
      return async () => { sync = null; };
    },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    fetchMessage: async (id: string) => {
      const found = messages.get(id) ?? null;
      const wait = at.fetch;
      delete at.fetch;
      await wait?.();
      return found;
    },
  };
  const ingest = createMailFactIngest({ writer, now: () => NOW, relationshipsOf: () => state.relationships });
  const box = createMailCollection({
    db,
    blobs,
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 90, retention_days: 90, quota_bytes: 1024 * 1024 }),
    instances,
    now: () => NOW,
    onMessageUpserted: ingest.onMessageUpserted,
    onMessageStored: ingest.onMessageStored,
    onRecordsRemoved: ingest.onRecordsRemoved,
    onRecordRekeyed: ingest.onRecordRekeyed,
    inboundAttachmentDeps: () => ({
      fileIngestor: {
        ingest: async (arg: { origin: string; source_id: string }) => {
          const record_id = inboundFileRecordId(arg.origin as never, arg.source_id);
          files.add(record_id);
          return { record_id };
        },
      },
      attach: async () => {},
      attachDeps: {},
    }) as never,
  });
  const template = store.createTemplate({ definition: options.firstRead === false ? nowDefinition : firstDefinition, origin: { kind: 'owner' } });
  await box.sync.start();
  if (options.firstRead !== false) store.updateTemplate(template.template_id, { definition: nowDefinition });
  events.length = 0;
  return {
    store,
    events,
    box,
    push: (event) => sync!(event),
    messages,
    files,
    state,
    at,
    templateId: template.template_id,
    close: async () => {
      await box.sync.stop();
      db.close();
      await rm(blobsDir, { recursive: true, force: true });
    },
  };
};

const recordIdOf = (world: Mailbox, source_id: string): string | undefined =>
  world.box.list({ platform: 'mail', slug: 'work', limit: 50 }).find((row) => row.source_id === source_id)?.record_id;

/** What can happen to an email, as the owner or the mailbox does it. */
const changes: Record<string, (world: Mailbox) => Promise<void> | void> = {
  'a label taken off, by the sync': async (world) => {
    const message = { ...world.messages.get('m1')!, labels: ['INBOX'] };
    world.messages.set('m1', message);
    await world.push({ kind: 'updated', source_id: 'm1', message });
  },
  'a relationship taken off': (world) => {
    world.state.relationships = [];
  },
  'moved, to a new id': (world) => {
    const moved = { ...world.messages.get('m1')!, source_id: 'm1@Archive', folder_or_label: 'Archive', labels: ['Archive', 'watch'] };
    world.messages.set('m1@Archive', moved);
    world.box.applyVerifiedMutation(recordIdOf(world, 'm1')!, {
      source_id: 'm1@Archive', is_read: false, is_flagged: false, folder_or_label: 'Archive', labels: ['Archive', 'watch'],
    });
  },
  'deleted, by the sync': async (world) => {
    world.messages.delete('m1');
    await world.push({ kind: 'deleted', source_id: 'm1' });
  },
  'its receipt’s file deleted': (world) => {
    for (const file of [...world.files]) world.files.delete(file);
  },
};

describe('a backfill, changed at each of its waits (§6.3)', () => {
  const run = async (world: Mailbox) => {
    const backfill = createMailFactBackfill({
      store: world.store,
      writer: createMailFactWriter({ store: world.store, emit: (event) => world.events.push(event), now: () => NOW }),
      blobs: createBlobStore(tmpdir()),
      mailboxes: () => [world.box],
      retentionDays: () => 90,
      now: () => NOW,
      mintId: () => 'mbf_1',
      relationshipsOf: () => world.state.relationships,
      fileStored: (file_id) => world.files.has(file_id),
      formerRecordIds: (slug, record_id) => world.store.formerEmailIds(slug, record_id),
      legacyAttachmentsAmbiguous: (_slug, record_id) => world.box.legacyAttachmentsAmbiguous(record_id),
      triggerRoom: async () => {
        const wait = world.at.room;
        delete world.at.room;
        await wait?.();
      },
    });
    backfill.start({ template_id: world.templateId, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job?.status).toBe('done');
    return backfill.state().job;
  };

  /** The mail as it is now, delivered again by the sync: a reading since
   *  finds what changed — what the backfill recorded it read is what it read. */
  const redeliver = async (world: Mailbox): Promise<void> => {
    for (const message of [...world.messages.values()]) {
      if (recordIdOf(world, message.source_id) !== undefined) await world.push({ kind: 'updated', source_id: message.source_id, message });
    }
  };
  /** An older email, read first: its waits come before the one changed. */
  const earlier = (at: Mailbox['at']): CanonicalMessage =>
    notice(at, { source_id: 'm0', rfc_message_id: '<m0@ups.example>', thread_id: 't-m0', received_at: NOW - 2 * DAY, body_text: 'Tracking Number: TRACK-0\nOrder: ORD-0', attachments: [] });

  for (const wait of ['fetch', 'room', 'earlier'] as const) {
    for (const [change, apply] of Object.entries(changes)) {
      const when = wait === 'fetch' ? 'while it was fetched' : wait === 'room' ? 'while it waited for room' : 'before its turn, while an earlier email was fetched';
      it(`${change}, ${when}: as though it came first`, async () => {
        const scan = (at: Mailbox['at']) => (wait === 'earlier' ? [earlier(at), notice(at)] : [notice(at)]);
        const first = await mailbox({ scan });
        const during = await mailbox({ scan });
        try {
          await apply(first);
          await run(first);
          during.at[wait === 'earlier' ? 'fetch' : wait] = () => apply(during);
          await run(during);
          expect(during.at.fetch ?? during.at.room, 'the wait was reached').toBeUndefined();
          expect(picture(during.store, during.events, during.files)).toEqual(picture(first.store, first.events, first.files));
          await redeliver(first);
          await redeliver(during);
          expect(picture(during.store, during.events, during.files)).toEqual(picture(first.store, first.events, first.files));
        } finally {
          await first.close();
          await during.close();
        }
      });
    }
  }

  it('a move followed reads the email where it is, and the facts the template reads now', async () => {
    const world = await mailbox({ scan: (at) => [notice(at)] });
    try {
      world.at.room = () => changes['moved, to a new id']!(world);
      const job = await run(world);
      expect(world.store.listFacts()).toEqual([expect.objectContaining({
        email: { slug: 'work', record_id: recordIdOf(world, 'm1@Archive') },
        variables: expect.objectContaining({ tracking_number: 'TRACK-A', order_id: 'ORD-1' }),
      })]);
      // One email, read once for the job's count however far it was followed.
      expect(job).toMatchObject({ total: 1, read: 1, facts: 1 });
    } finally {
      await world.close();
    }
  });

  it('follows an email moved again at every fetch only so far: each is another fetch', async () => {
    const world = await mailbox({ scan: (at) => [notice(at)] });
    try {
      let fetched = 0;
      let at = 'm1';
      const moveOn = (): void => {
        fetched += 1;
        const next = `m1@F${fetched}`;
        world.messages.set(next, { ...world.messages.get(at)!, source_id: next, folder_or_label: `F${fetched}` });
        world.box.applyVerifiedMutation(recordIdOf(world, at)!, {
          source_id: next, is_read: false, is_flagged: false, folder_or_label: `F${fetched}`, labels: [`F${fetched}`, 'watch'],
        });
        at = next;
        if (fetched < 10) world.at.fetch = moveOn;
      };
      world.at.fetch = moveOn;
      const job = await run(world);
      // The first read and three moves followed; the fourth is left to a later reading.
      expect(fetched).toBe(4);
      expect(job).toMatchObject({ total: 1, read: 1 });
    } finally {
      await world.close();
    }
  });
});

describe('the live ingest, changed while an attachment downloads (§5)', () => {
  /** The same email arriving after the change: what the ingest should read. */
  const arrivedChanged: Record<string, { readonly change: (world: Mailbox) => Promise<void> | void; readonly arrives: (at: Mailbox['at']) => CanonicalMessage | null; readonly before?: (world: Mailbox) => void }> = {
    'a label taken off': {
      change: (world) => {
        world.box.applyVerifiedMutation(recordIdOf(world, 'm1')!, {
          source_id: 'm1', is_read: false, is_flagged: false, folder_or_label: 'INBOX', labels: ['INBOX'],
        });
      },
      arrives: (at) => notice(at, { received_at: NOW, labels: ['INBOX'] }),
    },
    'a relationship taken off': {
      change: (world) => { world.state.relationships = []; },
      arrives: (at) => notice(at, { received_at: NOW }),
      before: (world) => { world.state.relationships = []; },
    },
    'moved, to a new id': {
      change: (world) => {
        world.box.applyVerifiedMutation(recordIdOf(world, 'm1')!, {
          source_id: 'm1@Archive', is_read: false, is_flagged: false, folder_or_label: 'Archive', labels: ['Archive', 'watch'],
        });
      },
      arrives: (at) => notice(at, { received_at: NOW, source_id: 'm1@Archive', folder_or_label: 'Archive', labels: ['Archive', 'watch'] }),
    },
    'deleted, by the sync': {
      change: async (world) => { await world.push({ kind: 'deleted', source_id: 'm1' }); },
      arrives: () => null,
    },
  };

  for (const [change, { change: apply, arrives, before }] of Object.entries(arrivedChanged)) {
    it(`${change}: read as though it arrived so`, async () => {
      const first = await mailbox({ scan: () => [], firstRead: false });
      const during = await mailbox({ scan: () => [], firstRead: false });
      try {
        before?.(first);
        const arrived = arrives(first.at);
        if (arrived !== null) await first.push({ kind: 'created', source_id: arrived.source_id, message: arrived });
        during.at.bytes = () => apply(during);
        await during.push({ kind: 'created', source_id: 'm1', message: notice(during.at, { received_at: NOW }) });
        expect(during.at.bytes, 'the wait was reached').toBeUndefined();
        expect(picture(during.store, during.events, during.files)).toEqual(picture(first.store, first.events, first.files));
      } finally {
        await first.close();
        await during.close();
      }
    });
  }
});

// ────────────────────────────────────────────────────────────────
// The AI pass
// ────────────────────────────────────────────────────────────────

describe('the AI pass, changed at each of its waits (§4.3)', () => {
  type AiWait = 'read' | 'call' | 'room';
  const aiDefinition: MailTemplateDefinition = {
    name: 'Shop orders',
    type: 'purchase',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }, { field: 'label', op: 'is', value: 'watch' }], variables: ['order_id'] },
    rules: [{ target: { variable: 'order_id' }, source: 'subject', find: { kind: 'pattern', pattern: 'order (\\S+)' } }],
    html: false,
    ai: { enabled: true, prompt: 'Order confirmations from Shop.', slots: ['merchant', 'total'], pool: 'free_only' },
  };
  const email: MailFactAiEmail = {
    from: 'orders@shop.example', to: ['me@example.com'], cc: [], subject: 'Your order A-1', date: '2026-09-20T10:00:00.000Z',
    body_text: 'Thank you for your order A-1 from Shop. Total: EUR 12.50.',
  };
  const input = (record_id: string, labels: string[]): MailFactWriteInput => ({
    ref: { slug: 'work', record_id },
    email: {
      subject: email.subject, body_text: email.body_text, html: null, from_address: email.from, from_name: 'Shop',
      headers: {}, labels, relationships: [], attachments: [],
    },
    email_at: 1_000,
    content_fingerprint: `content-of-${record_id}`,
    may_trigger: true,
    count_health: true,
  });

  const world = () => {
    const db = new Database(':memory:');
    let ids = 0;
    const store = createMailFactStore(db, { now: () => NOW, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
    const events: WarehouseEvent[] = [];
    const writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => NOW });
    const stored = new Set(['mail:1']);
    const at: Partial<Record<AiWait, () => void>> = {};
    const once = async (wait: AiWait): Promise<void> => {
      const run = at[wait];
      delete at[wait];
      run?.();
    };
    const runner = createMailFactAiRunner({
      store,
      writer,
      readEmail: async (ref) => {
        const found = stored.has(ref.record_id) ? email : null;
        await once('read');
        return found;
      },
      call: async () => {
        await once('call');
        return { facts: [{ position: 0, merchant: 'Shop', total: { amount: '12.50', currency: 'EUR' } }] };
      },
      triggerRoom: () => once('room'),
      isPaused: () => false,
      byokAllowed: () => false,
      now: () => NOW,
    });
    const template = store.createTemplate({ definition: aiDefinition, origin: { kind: 'owner' } });
    writer.write(input('mail:1', ['INBOX', 'watch']));
    events.length = 0;
    const change: Record<string, () => void> = {
      'a label taken off, by the sync': () => { writer.write(input('mail:1', ['INBOX'])); },
      'moved, to a new id': () => {
        stored.delete('mail:1');
        stored.add('mail:2');
        writer.rekeyEmail('work', 'mail:1', 'mail:2');
      },
      'deleted, by the sync': () => {
        stored.delete('mail:1');
        writer.removeEmails('work', ['mail:1']);
      },
      'its template’s AI switched off': () => {
        store.updateTemplate(template.template_id, { definition: { ...aiDefinition, ai: { enabled: false } } });
      },
      'a slot taken from its AI': () => {
        store.updateTemplate(template.template_id, { definition: { ...aiDefinition, ai: { ...aiDefinition.ai, slots: ['total'] } as MailTemplateDefinition['ai'] } });
      },
      'its template switched off': () => { store.updateTemplate(template.template_id, { active: false }); },
      'its template deleted': () => { store.deleteTemplate(template.template_id); },
    };
    return { store, events, runner, at, change, close: () => { runner.dispose(); db.close(); } };
  };

  const names = Object.keys(world().change);
  for (const wait of ['read', 'call', 'room'] as const) {
    for (const change of names) {
      it(`${change}, at ${wait === 'read' ? 'the read of its copy' : wait === 'call' ? 'the model’s call' : 'the wait for room'}: as though it came first`, async () => {
        const first = world();
        const during = world();
        try {
          first.change[change]!();
          first.runner.kick();
          await first.runner.settled();
          during.at[wait] = during.change[change]!;
          during.runner.kick();
          await during.runner.settled();
          expect(picture(during.store, during.events)).toEqual(picture(first.store, first.events));
        } finally {
          first.close();
          during.close();
        }
      });
    }
  }
});
