/** D-315 §6.3 — Backfill: a template's mail that already arrived, read by the
 *  same passes as new mail. A real mail collection whose stub provider can
 *  fetch a message again, the real store and the real writer. */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailFactEmailRef, MailTemplateDefinition } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { inboundFileRecordId } from '../collections/file/inbound-file-collection.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, MailProvider, ProviderSyncCallback } from '../collections/mail/provider.js';
import { createMailFactAiRunner, type MailFactAiRunner } from '../mail-facts/ai-pass.js';
import { createMailFactBackfill, type MailFactBackfill } from '../mail-facts/backfill.js';
import { createMailFactWriter, type MailFactWriteInput, type MailFactWriter } from '../mail-facts/fact-writer.js';
import { createMailFactIngest } from '../mail-facts/mail-ingest.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { TRIGGER_QUEUE_PRODUCER_DEPTH } from '../triggers/queue.js';
import { createEventTriggersStore } from '../triggers/store.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let db: Database.Database;
let blobsDir: string;
let blobs: BlobStore;
let store: MailFactStore;
let events: WarehouseEvent[];
let written: string[];
let writer: MailFactWriter;

beforeEach(async () => {
  db = new Database(':memory:');
  blobsDir = await mkdtemp(join(tmpdir(), 'd315-backfill-'));
  blobs = createBlobStore(blobsDir);
  store = createMailFactStore(db, { now: () => NOW });
  events = [];
  written = [];
  const real = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => NOW });
  writer = {
    ...real,
    write: (input: MailFactWriteInput) => {
      written.push(input.ref.record_id);
      return real.write(input);
    },
  };
});

afterEach(async () => {
  db.close();
  await rm(blobsDir, { recursive: true, force: true });
});

const ups = (source_id: string, daysAgo: number, over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id,
  rfc_message_id: `<${source_id}@ups.example>`,
  from: 'pkginfo@ups.com',
  from_name: 'UPS',
  to: ['me@example.com'],
  cc: [],
  subject: 'UPS Update: Delivered',
  thread_id: `t-${source_id}`,
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: NOW - daysAgo * DAY,
  body_text: `Tracking Number: 1Z999AA1012345678${source_id.slice(-1)}`,
  ...over,
});

/** The mailbox the provider can give back whole — or not, per source id. */
const mailbox = async (
  scan: CanonicalMessage[],
  gone: ReadonlySet<string> = new Set(),
  /** Called while the provider fetches a message, as a delete or a move can land then. */
  duringFetch?: (source_id: string, box: MailCollection) => void,
): Promise<MailCollection> => {
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'gmail',
    config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
  });
  const full = new Map(scan.map((message) => [message.source_id, message]));
  const provider: MailProvider = {
    kind: 'gmail',
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
    fetchMessage: async (id: string) => {
      duringFetch?.(id, collection);
      return gone.has(id) ? null : full.get(id) ?? null;
    },
  };
  // eslint-disable-next-line prefer-const -- the provider's fetch closes over it
  let collection: MailCollection;
  collection = createMailCollection({
    db,
    blobs,
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 90, retention_days: 90, quota_bytes: 1024 * 1024 }),
    instances,
    now: () => NOW,
  });
  await collection.sync.start();
  return collection;
};

const recordIdOf = (box: MailCollection, source_id: string): string =>
  box.list({ platform: 'mail', slug: 'work', limit: 500 }).find((r) => r.source_id === source_id)!.record_id;

const backfillFor = (box: MailCollection, triggerRoom?: () => Promise<void>): MailFactBackfill =>
  createMailFactBackfill({
    store,
    writer,
    mailboxes: () => [box],
    blobs,
    retentionDays: () => 90,
    now: () => NOW,
    mintId: () => 'mbf_1',
    ...(triggerRoom !== undefined ? { triggerRoom } : {}),
  });

const definition: MailTemplateDefinition = {
  name: 'UPS',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
  ],
  html: false,
  ai: { enabled: false },
};

describe('a backfill (§6.3)', () => {
  it('reads the period’s mail that meets the conditions, oldest first, storing facts and firing nothing', async () => {
    const box = await mailbox([
      ups('m1', 3),
      ups('m2', 10),
      ups('m3', 2, { from: 'news@club.example', from_name: 'Club' }),
      ups('m4', 40),
    ]);
    // The template came after the mail: nothing has read it yet.
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    expect(backfill.start({ template_id: template.template_id, days: 30 })).toMatchObject({
      job_id: 'mbf_1', status: 'running', run_recipes: false,
    });
    await backfill.settled();
    expect(backfill.state()).toEqual({
      job: expect.objectContaining({ status: 'done', total: 2, read: 2, facts: 2, events: 0, stored_copies: 0, kept: 0 }),
      max_days: 90,
    });
    expect(written).toEqual([recordIdOf(box, 'm2'), recordIdOf(box, 'm1')]);
    // Read whole: the carrier comes from the sender's name, which only a fetch has.
    expect(store.listFacts().map((f) => f.variables.carrier)).toEqual(['UPS', 'UPS']);
    expect(events).toEqual([]);
    // Template health counts a backfill's reading.
    expect(store.getTemplate(template.template_id)?.health).toMatchObject({ matched: 2, entered: 2 });
  });

  it('reads every email of the period, however many share one date', async () => {
    // More emails of one date than a page holds, and an older one past them.
    const burst = Array.from({ length: 502 }, (_, i) => ups(`b${String(i).padStart(3, '0')}`, 3));
    const box = await mailbox([...burst, ups('older', 10)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', total: 503, read: 503 });
    expect(new Set(written).size).toBe(503);
  }, 60_000);

  it('reads no file an attachment failed to store: the fact misses it, as at ingest', async () => {
    const pdf = ups('m1', 3, {
      has_attachments: true,
      attachments: [{ filename: 'bill.pdf', mime_type: 'application/pdf', size: 3, source_part_id: 'p1', fetchBytes: async () => Buffer.from('pdf') }],
    } as never);
    const box = await mailbox([pdf]);
    const withDocument: MailTemplateDefinition = {
      ...definition,
      type: 'bill',
      entrance: { conditions: definition.entrance.conditions, variables: ['issuer'] },
      rules: [
        { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'document' }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: 'application/pdf' } },
      ],
    };
    const template = store.createTemplate({ definition: withDocument, origin: { kind: 'owner' } });
    // The harness's mailbox stores no attachment file: as when the download failed.
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    // The email's tracking number gives a shipment fact too: the bill is the
    // template's, found by its type (fact ids are random, so order is not).
    const bill = store.listFacts().find((fact) => fact.type === 'bill');
    expect(bill?.variables.issuer).toBe('UPS');
    expect(bill?.variables.document ?? null).toBeNull();
  });

  it('leaves a sent email out when it can read only the stored copy, as the ingest left it out', async () => {
    // Sent by the account; its provider can no longer give it whole.
    const box = await mailbox([ups('m1', 3, { direction: 'outbound' })], new Set(['m1']));
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', stored_copies: 1, facts: 0, events: 0 });
    // Neither the template nor the markup read it: no parcel is coming to the one who sent it.
    expect(store.listFacts()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('counts only its own template’s health: the others read these emails when they came', async () => {
    const box = await mailbox([ups('m1', 3), ups('m2', 4)]);
    // Another kind's template that reads the same emails.
    const other = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const template = store.createTemplate({ definition: { ...definition, type: 'purchase', rules: [], entrance: { conditions: definition.entrance.conditions, variables: [] } }, origin: { kind: 'owner' } });
    const before = store.getTemplate(other.template_id)!.health;
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(store.getTemplate(other.template_id)!.health).toEqual(before);
    expect(store.getTemplate(template.template_id)!.health).toMatchObject({ matched: 2, entered: 2 });
  });

  it('writes nothing for an email deleted while it was fetched: its facts went with it', async () => {
    const box = await mailbox([ups('m1', 3)], new Set(), (source_id, own) => {
      if (source_id === 'm1') own.delete(recordIdOf(own, 'm1'));
    });
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 1, facts: 0, events: 0 });
    expect(store.listFacts()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('runs the recipes when asked: its events carry the backfill origin', async () => {
    const box = await mailbox([ups('m1', 3)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', events: 1 });
    expect(events).toEqual([expect.objectContaining({ platform: 'mail_fact', event_kind: 'created', origin: 'backfill' })]);
  });

  it('waits for room in the trigger queue before each email when it runs recipes, and only then', async () => {
    const box = await mailbox([ups('m1', 3), ups('m2', 4)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const gates: (() => void)[] = [];
    const room = vi.fn(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const backfill = backfillFor(box, room);
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // The queue is full: nothing is written, so nothing is refused at its ceiling.
    expect(written).toEqual([]);
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(written).toEqual([recordIdOf(box, 'm2')]);
    gates.shift()!();
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 2, events: 2 });

    // Storing facts fires nothing, so it never waits.
    const quiet = vi.fn(() => new Promise<void>(() => {}));
    const second = backfillFor(box, quiet);
    second.start({ template_id: template.template_id, days: 30 });
    await second.settled();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('stops while it waits for room, when the owner stops it', async () => {
    const box = await mailbox([ups('m1', 3)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const room = vi.fn(() => new Promise<void>(() => {}));
    const backfill = backfillFor(box, room);
    const { job_id } = backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await vi.waitFor(() => expect(room).toHaveBeenCalledTimes(1));
    backfill.cancel(job_id);
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'cancelled', facts: 0 });
    expect(written).toEqual([]);
  });

  it('stops when the owner stops it while it fetches: no wait for room begins, and another may start', async () => {
    let backfill!: MailFactBackfill;
    const box = await mailbox([ups('m1', 3)], new Set(), () => { backfill.cancel('mbf_1'); });
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    // The queue has no room, and never will: only a Stop ends a wait.
    const room = vi.fn(() => new Promise<void>(() => {}));
    backfill = backfillFor(box, room);
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'cancelled', facts: 0 });
    expect(room).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(backfill.start({ template_id: template.template_id, days: 30 })).toMatchObject({ status: 'running' });
    await backfill.settled();
  });

  it('writes nothing for an email deleted while it waited for room', async () => {
    const box = await mailbox([ups('m1', 3)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box, async () => {
      box.delete(recordIdOf(box, 'm1'));
    });
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 1, facts: 0, events: 0 });
    expect(store.listFacts()).toEqual([]);
  });

  it('never replaces facts read from the whole email with the stored copy’s poorer reading', async () => {
    // m2's tracking value matches no carrier, so the standards pass adds nothing to it.
    const box = await mailbox(
      [ups('m1', 3), ups('m2', 5, { body_text: 'Tracking Number: PKG-4472' })],
      new Set(['m1', 'm2']),
    );
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    // m1 was read whole before (at ingest, with its sender's name).
    writer.write({
      ref: { slug: 'work', record_id: recordIdOf(box, 'm1') },
      email: {
        subject: 'UPS Update: Delivered', body_text: 'Tracking Number: 1Z999AA10123456781', html: null,
        from_address: 'pkginfo@ups.com', from_name: 'UPS', headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
      },
      email_at: NOW - 3 * DAY,
      content_fingerprint: 'ingest',
      may_trigger: false,
      count_health: false,
    });
    written.length = 0;
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    // m1 kept its facts; m2, with none, was read from the stored copy.
    expect(backfill.state().job).toMatchObject({ read: 2, stored_copies: 2, kept: 1, facts: 1 });
    expect(written).toEqual([recordIdOf(box, 'm2')]);
    const m1 = store.factsForEmail({ slug: 'work', record_id: recordIdOf(box, 'm1') });
    expect(m1[0]?.variables.carrier).toBe('UPS');
    const m2 = store.factsForEmail({ slug: 'work', record_id: recordIdOf(box, 'm2') });
    expect(m2[0]?.variables).toMatchObject({ tracking_number: 'PKG-4472', carrier: null });
  });

  it('counts a template’s health once per email: a second backfill counts nothing again', async () => {
    const box = await mailbox([ups('m1', 3), ups('m2', 4)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    const once = store.getTemplate(template.template_id)!.health;
    expect(once).toMatchObject({ matched: 2, entered: 2 });
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(store.getTemplate(template.template_id)!.health).toEqual(once);
  });

  it('writes nothing new over a period it already read', async () => {
    // Each email is read again (ruling 13: a backfill is how a template reads
    // past mail), and a fact whose email and template did not change stays.
    const box = await mailbox([ups('m1', 3)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 1, facts: 0 });
    expect(store.listFacts()).toHaveLength(1);
  });

  it('runs one job at a time, refuses what it cannot do, and stops when cancelled', async () => {
    const box = await mailbox([ups('m1', 3), ups('m2', 4)]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const off = store.createTemplate({ definition: { ...definition, name: 'Off' }, origin: { kind: 'owner' }, active: false });
    const backfill = backfillFor(box);
    expect(() => backfill.start({ template_id: 'mtpl_nope', days: 30 })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => backfill.start({ template_id: off.template_id, days: 30 })).toThrow(expect.objectContaining({ code: 'bad_request' }));
    expect(() => backfill.start({ template_id: template.template_id, days: 91 })).toThrow(expect.objectContaining({ code: 'bad_request' }));
    const job = backfill.start({ template_id: template.template_id, days: 30 });
    expect(() => backfill.start({ template_id: template.template_id, days: 30 })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(backfill.cancel('mbf_other')).toBeNull();
    backfill.cancel(job.job_id);
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'cancelled' });
    expect(backfill.state().job!.read).toBeLessThan(2);
  });
});

describe('a backfill that runs recipes loses no event (§6.3)', () => {
  /** Recipes that run slowly — each waits until `release` — subscribed to the
   *  shipments, and a writer whose events reach them. */
  const slowRecipes = (subscribers: number, fields?: string[]) => {
    const triggers = createEventTriggersStore(db);
    for (let n = 0; n < subscribers; n += 1) {
      triggers.create({
        trigger_id: `t-${n}`, recipe_id: `r-${n}`, publisher_id: 'local', pattern: 'data.mail_fact.shipment.thing.*',
        enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
        ...(fields !== undefined ? { fields } : {}),
      } as never);
    }
    const bus = createWarehouseEventBus();
    let open!: () => void;
    const released = new Promise<void>((resolve) => { open = resolve; });
    let runs = 0;
    const dispatcher = createEventTriggerDispatcher({
      bus, store: triggers,
      runtime: { runRecipe: async () => { runs += 1; await released; return { run_id: `run-${runs}` }; } },
    });
    dispatcher.rebuild();
    const real = createMailFactWriter({ store, emit: (event) => bus.emit(event), now: () => NOW });
    writer = { ...real, write: (input: MailFactWriteInput) => { written.push(input.ref.record_id); return real.write(input); } };
    return { dispatcher, release: () => open(), runs: () => runs };
  };

  it('many emails about one thing: it waits while the thing’s recipe is behind, and every email runs', async () => {
    // Seventy notices of one parcel; the recipe wakes for every email.
    const box = await mailbox(Array.from({ length: 70 }, (_, n) => ups(`m${n}-7`, 70 - n, { subject: `UPS Update ${n}` })));
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const recipes = slowRecipes(1, ['last_email_at']);
    const backfill = backfillFor(box, () => recipes.dispatcher.room());
    backfill.start({ template_id: template.template_id, days: 90, run_recipes: true });
    // The recipe is behind: the backfill waits once the thing holds as many
    // events as a producer may add — and not before.
    await vi.waitFor(() => expect(written.length).toBeGreaterThanOrEqual(TRIGGER_QUEUE_PRODUCER_DEPTH));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(written.length).toBeLessThanOrEqual(TRIGGER_QUEUE_PRODUCER_DEPTH + 1);
    expect(backfill.state().job).toMatchObject({ status: 'running' });
    recipes.release();
    await backfill.settled();
    await recipes.dispatcher.drained();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 70, events: 70 });
    expect(recipes.runs()).toBe(70);
    recipes.dispatcher.dispose();
    await box.sync.stop();
  });

  it('one email of many parcels, many recipes: every thing reaches every recipe', async () => {
    const parcels = Array.from({ length: 100 }, (_, n) => `Parcel ${n}\nTracking Number: 1Z999AA10123${String(n).padStart(5, '0')}`).join('\n');
    const box = await mailbox([ups('m1', 1, { body_text: parcels })]);
    const template = store.createTemplate({
      definition: { ...definition, repeat: { source: 'body', split: 'Parcel \\d+' } }, origin: { kind: 'owner' },
    });
    const recipes = slowRecipes(11);
    const backfill = backfillFor(box, () => recipes.dispatcher.room());
    backfill.start({ template_id: template.template_id, days: 90, run_recipes: true });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', facts: 100, events: 100 });
    recipes.release();
    await recipes.dispatcher.drained();
    // 100 things × 11 recipes: more keys than the queue's ceiling, none refused.
    expect(recipes.runs()).toBe(1_100);
    recipes.dispatcher.dispose();
    await box.sync.stop();
  });
});

describe('a backfill that runs recipes tells each email as it came, the AI’s answers included (§6.3)', () => {
  /** The rules read the parcel and its state; the delivery note is the AI's
   *  when the email has none. */
  const aiDefinition: MailTemplateDefinition = {
    ...definition,
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }], variables: ['tracking_number'] },
    rules: [
      ...definition.rules,
      { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [
        { contains: 'Delivered', value: 'delivered' }, { contains: 'On the way', value: 'in_transit' },
      ] } },
      { target: { data: 'note' }, source: 'body', find: { kind: 'after_label', label: 'Note:' } },
    ],
    ai: { enabled: true, prompt: 'Fill the delivery note.', slots: ['data.note'], pool: 'free_only' },
  };
  const parcel = () => [
    ups('old', 3, { subject: 'UPS Update: On the way', body_text: 'Tracking Number: TRACK-A' }),
    ups('new', 1, { subject: 'UPS Update: Delivered', body_text: 'Tracking Number: TRACK-A\nNote: delivered to door' }),
  ];

  /** The AI pass over the real writer. Its call answers once `open` is called. */
  const aiPass = () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let runner!: MailFactAiRunner;
    const real = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => NOW, onAiQueued: () => runner.kick() });
    writer = { ...real, write: (input: MailFactWriteInput) => { written.push(input.ref.record_id); return real.write(input); } };
    runner = createMailFactAiRunner({
      store,
      writer,
      readEmail: async () => ({ from: 'pkginfo@ups.com', to: ['me@example.com'], cc: [], subject: 'UPS', date: '2026-09-20T00:00:00Z', body_text: 'A parcel.' }),
      call: async () => {
        await gate;
        return { facts: [{ position: 0, values: { 'data.note': 'arriving soon' } }] };
      },
      isPaused: () => false,
      byokAllowed: () => false,
      now: () => NOW,
    });
    return { runner, open: () => open() };
  };

  const backfillWithAi = (box: MailCollection, aiSettled: (ref: MailFactEmailRef) => Promise<number>): MailFactBackfill =>
    createMailFactBackfill({
      store, writer, mailboxes: () => [box], blobs, retentionDays: () => 90, now: () => NOW, mintId: () => 'mbf_1', aiSettled,
    });

  it('an older email waiting on the AI is told before a newer one the rules read whole', async () => {
    const box = await mailbox(parcel());
    const template = store.createTemplate({ definition: aiDefinition, origin: { kind: 'owner' } });
    const ai = aiPass();
    // The answer comes once the job waits for it — or, a job that never
    // waits, once the job is done.
    const backfill = backfillWithAi(box, (ref) => { ai.open(); return ai.runner.untilSettled(ref); });
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    void backfill.settled().then(() => ai.open());
    await backfill.settled();
    await ai.runner.settled();
    ai.runner.dispose();
    expect(events.map((event) => [event.event_kind, (event.record as { state?: string } | undefined)?.state])).toEqual([
      ['created', 'in_transit'],
      ['updated', 'delivered'],
    ]);
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 2, events: 2 });
    await box.sync.stop();
  });

  it('waits on no AI when it runs no recipes: it tells nothing', async () => {
    const box = await mailbox(parcel());
    const template = store.createTemplate({ definition: aiDefinition, origin: { kind: 'owner' } });
    const ai = aiPass();
    const aiSettled = vi.fn((ref: MailFactEmailRef) => ai.runner.untilSettled(ref));
    const backfill = backfillWithAi(box, aiSettled);
    backfill.start({ template_id: template.template_id, days: 30 });
    // Done while the AI has not answered.
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 2 });
    expect(aiSettled).not.toHaveBeenCalled();
    ai.open();
    await ai.runner.settled();
    ai.runner.dispose();
    expect(events).toEqual([]);
    await box.sync.stop();
  });

  it('stops while it waits on the AI, when the owner stops it: what it read is still told', async () => {
    const box = await mailbox(parcel());
    const template = store.createTemplate({ definition: aiDefinition, origin: { kind: 'owner' } });
    const ai = aiPass();
    let waiting = false;
    const backfill = backfillWithAi(box, (ref) => { waiting = true; return ai.runner.untilSettled(ref); });
    const { job_id } = backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await vi.waitFor(() => expect(waiting).toBe(true));
    backfill.cancel(job_id);
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'cancelled', read: 1 });
    expect(written).toEqual([recordIdOf(box, 'old')]);
    ai.open();
    await ai.runner.settled();
    ai.runner.dispose();
    expect(events.map((event) => (event.record as { state?: string } | undefined)?.state)).toEqual(['in_transit']);
    await box.sync.stop();
  });
});

describe('an email a move gave a new id (§6.3)', () => {
  it('reads its attachment again by the id the ingest named its file: the fact that needs it stays', async () => {
    const files = new Set<string>();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'imap',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    const invoice = ups('7@INBOX', 3, {
      subject: 'Your bill',
      has_attachments: true,
      attachments: [{ source_part_id: 'p1', filename: 'bill.pdf', mime_type: 'application/pdf', size: 8, fetchBytes: async () => Buffer.from('%PDF-1.7') }],
    } as never);
    // The provider gives the message back under whichever id it has now.
    const provider: MailProvider = {
      kind: 'imap',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) { await opts.onMessage(invoice); },
      async startSync() { return async () => {}; },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      fetchMessage: async (id: string) => ({ ...invoice, source_id: id, folder_or_label: id.endsWith('@Archive') ? 'Archive' : 'INBOX' }),
    };
    const ingest = createMailFactIngest({ writer, now: () => NOW });
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
      onRecordRekeyed: ingest.onRecordRekeyed,
      inboundAttachmentDeps: () => ({
        fileIngestor: {
          ingest: async (arg: { origin: 'mail_attachment'; source_id: string }) => {
            const record_id = inboundFileRecordId(arg.origin, arg.source_id);
            files.add(record_id);
            return { record_id };
          },
        },
        attach: async () => {},
        attachDeps: {},
      }) as never,
    });
    // A bill needs its PDF to be read at all.
    const template = store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Bills', type: 'bill',
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['document'] },
        rules: [
          { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'document' }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: 'application/pdf' } },
        ],
        html: false, ai: { enabled: false },
      },
    });
    await box.sync.start();
    const original = recordIdOf(box, '7@INBOX');
    const bill = () => store.listFacts().find((fact) => fact.type === 'bill');
    const document = inboundFileRecordId('mail_attachment', `work/${original}:p1`);
    expect(bill()?.variables.document).toBe(document);

    // Moved by Recued itself: the row takes the id its new place gives it,
    // and its facts go with it. Its file keeps the id it was stored under.
    const moved = box.applyVerifiedMutation(original, { source_id: '3@Archive', is_read: false, is_flagged: false, folder_or_label: 'Archive' })!;
    expect(moved.record_id).not.toBe(original);
    expect(bill()?.email.record_id).toBe(moved.record_id);

    // Read again from its provider, the email still has its PDF.
    const backfill = createMailFactBackfill({
      store, writer, mailboxes: () => [box], blobs, retentionDays: () => 90, now: () => NOW, mintId: () => 'mbf_1',
      fileStored: (file_id) => files.has(file_id),
      formerRecordIds: (slug, record_id) => store.formerEmailIds(slug, record_id),
    });
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', read: 1 });
    expect(bill()).toMatchObject({ email: { record_id: moved.record_id }, variables: expect.objectContaining({ document }) });
    await box.sync.stop();
  });

  it('keeps the fact of a template switched off before the move, when the sync read the new id first (§4.3)', async () => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'imap',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    // No carrier's number: only the template reads it.
    const notice = ups('7@INBOX', 3, { body_text: 'Tracking Number: TRACK-A' });
    let sync: ProviderSyncCallback | null = null;
    const provider: MailProvider = {
      kind: 'imap',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) { await opts.onMessage(notice); },
      async startSync(cb) {
        sync = cb;
        return async () => { sync = null; };
      },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    };
    const ingest = createMailFactIngest({ writer, now: () => NOW });
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
      onRecordRekeyed: ingest.onRecordRekeyed,
    });
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    await box.sync.start();
    try {
      const original = recordIdOf(box, '7@INBOX');
      const [fact] = store.factsForEmail({ slug: 'work', record_id: original });
      expect(fact?.thing_id).toEqual(expect.any(String));
      store.updateTemplate(template.template_id, { active: false });
      // The sync finds it in its new folder before the move's own answer lands.
      await sync!({ kind: 'created', source_id: '3@Archive', message: { ...notice, source_id: '3@Archive', folder_or_label: 'Archive' } });
      const moved = box.applyVerifiedMutation(original, { source_id: '3@Archive', is_read: false, is_flagged: false, folder_or_label: 'Archive' })!;
      expect(moved.record_id).not.toBe(original);
      expect(store.factsForEmail({ slug: 'work', record_id: moved.record_id })).toEqual([
        expect.objectContaining({ fact_id: fact!.fact_id, thing_id: fact!.thing_id }),
      ]);
      expect(store.listThings().map((thing) => thing.thing_id)).toEqual([fact!.thing_id]);
    } finally {
      await box.sync.stop();
    }
  });
});

describe('an email changed while a backfill waited (§6.3)', () => {
  it('a label taken off while it waited for room: read as it is now, its fact is not brought back', async () => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'gmail',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    // No carrier's number: only the template reads it, and it reads only mail labelled "watch".
    const watched = ups('m1', 1, { labels: ['INBOX', 'watch'], body_text: 'Tracking Number: TRACK-A' });
    let sync: ProviderSyncCallback | null = null;
    const provider: MailProvider = {
      kind: 'gmail',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) { await opts.onMessage(watched); },
      async startSync(cb) {
        sync = cb;
        return async () => { sync = null; };
      },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      // Fetched as it was when the backfill read it.
      fetchMessage: async () => watched,
    };
    const ingest = createMailFactIngest({ writer, now: () => NOW });
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
    });
    const template = store.createTemplate({
      definition: {
        ...definition,
        entrance: { conditions: [...definition.entrance.conditions, { field: 'label', op: 'is', value: 'watch' }], variables: ['tracking_number'] },
      },
      origin: { kind: 'owner' },
    });
    await box.sync.start();
    try {
      const ref = { slug: 'work', record_id: recordIdOf(box, 'm1') };
      expect(store.factsForEmail(ref)).toHaveLength(1);
      const backfill = createMailFactBackfill({
        store, writer, blobs, mailboxes: () => [box], retentionDays: () => 90, now: () => NOW, mintId: () => 'mbf_1',
        triggerRoom: async () => {
          // The label comes off while the backfill waits: the sync reads it so, and its fact goes.
          await sync!({ kind: 'updated', source_id: 'm1', message: { ...watched, labels: ['INBOX'] } });
          expect(store.factsForEmail(ref)).toEqual([]);
        },
      });
      events.length = 0;
      backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
      await backfill.settled();
      expect(backfill.state().job).toMatchObject({ status: 'done', read: 1 });
      expect(store.factsForEmail(ref)).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      await box.sync.stop();
    }
  });
});

describe('an email changed while it was read (§5, §6.3)', () => {
  /** A real mailbox whose provider pushes live changes; its hooks the fact ingest's. */
  const liveMailbox = async (scan: CanonicalMessage[], relationshipsOf: (address: string) => readonly string[] = () => []) => {
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
      async initialScan(opts) { for (const msg of scan) await opts.onMessage(msg); },
      async startSync(cb) {
        sync = cb;
        return async () => { sync = null; };
      },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      fetchMessage: async () => scan[0] ?? null,
    };
    const ingest = createMailFactIngest({ writer, now: () => NOW, relationshipsOf });
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
      inboundAttachmentDeps: () => ({
        fileIngestor: { ingest: async () => ({ record_id: 'file:1' }) },
        attach: async () => {},
        attachDeps: {},
      }) as never,
    });
    await box.sync.start();
    return { box, push: (event: Parameters<ProviderSyncCallback>[0]) => sync!(event) };
  };
  const onlyFor = (condition: MailTemplateDefinition['entrance']['conditions'][number]): MailTemplateDefinition => ({
    ...definition,
    entrance: { conditions: [...definition.entrance.conditions, condition], variables: ['tracking_number'] },
  });

  it('a label taken off while its attachment downloads: the ingest reads it as it is then, and starts nothing', async () => {
    store.createTemplate({ definition: onlyFor({ field: 'label', op: 'is', value: 'watch' }), origin: { kind: 'owner' } });
    const { box, push } = await liveMailbox([]);
    try {
      // After the first backfill: new mail, news.
      const arriving = ups('m1', 0, {
        labels: ['INBOX', 'watch'],
        body_text: 'Tracking Number: TRACK-A',
        has_attachments: true,
        attachments: [{
          source_part_id: 'p1', filename: 'receipt.pdf', mime_type: 'application/pdf', size_bytes: 4,
          fetchBytes: async () => {
            const id = box.list({ platform: 'mail', slug: 'work', limit: 10 })[0]!.record_id;
            box.applyVerifiedMutation(id, { source_id: 'm1', is_read: false, is_flagged: false, folder_or_label: 'INBOX', labels: ['INBOX'] });
            return Buffer.from('%PDF');
          },
        }],
      } as never);
      await push({ kind: 'created', source_id: 'm1', message: arriving });
      expect(box.list({ platform: 'mail', slug: 'work', limit: 10 })[0]!.hot_fields.labels).toEqual(['INBOX']);
      expect(store.listFacts()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      await box.sync.stop();
    }
  });

  it('a relationship taken off while a backfill waited for room: the sync read it so, and the backfill brings nothing back', async () => {
    let relationships = ['work'];
    const template = store.createTemplate({ definition: onlyFor({ field: 'relationship', op: 'is', value: 'work' }), origin: { kind: 'owner' } });
    const notice = ups('m1', 1, { body_text: 'Tracking Number: TRACK-A' });
    const { box, push } = await liveMailbox([notice], () => relationships);
    try {
      expect(store.listFacts()).toHaveLength(1);
      const backfill = createMailFactBackfill({
        store, writer, blobs, mailboxes: () => [box], retentionDays: () => 90, now: () => NOW, mintId: () => 'mbf_1',
        relationshipsOf: () => relationships,
        triggerRoom: async () => {
          // The sender is no longer a work contact, and the sync reads the email again.
          relationships = [];
          await push({ kind: 'updated', source_id: 'm1', message: { ...notice, is_read: true } });
          expect(store.listFacts()).toEqual([]);
        },
      });
      events.length = 0;
      backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
      await backfill.settled();
      expect(backfill.state().job).toMatchObject({ status: 'done', read: 1 });
      expect(store.listFacts()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      await box.sync.stop();
    }
  });
});

describe('an attachment read again (§6.3)', () => {
  it('keeps the type the ingest read from its bytes: a PDF its provider calls octet-stream still meets a bill that needs a PDF', async () => {
    // Each stored file, by the type it was stored with.
    const files = new Map<string, string>();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'imap',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    const invoice = ups('7@INBOX', 3, {
      subject: 'Your bill',
      has_attachments: true,
      attachments: [{ source_part_id: 'p1', filename: 'bill', mime_type: 'application/octet-stream', size: 8, fetchBytes: async () => Buffer.from('%PDF-1.7') }],
    } as never);
    const provider: MailProvider = {
      kind: 'imap',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) { await opts.onMessage(invoice); },
      async startSync() { return async () => {}; },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      fetchMessage: async () => invoice,
    };
    const ingest = createMailFactIngest({ writer, now: () => NOW });
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
      inboundAttachmentDeps: () => ({
        fileIngestor: {
          ingest: async (arg: { origin: 'mail_attachment'; source_id: string; mime_type: string }) => {
            const record_id = inboundFileRecordId(arg.origin, arg.source_id);
            files.set(record_id, arg.mime_type);
            return { record_id };
          },
        },
        attach: async () => {},
        attachDeps: {},
      }) as never,
    });
    const template = store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Bills', type: 'bill',
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['document'] },
        rules: [
          { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'document' }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: 'application/pdf' } },
        ],
        html: false, ai: { enabled: false },
      },
    });
    await box.sync.start();
    try {
      const bill = () => store.listFacts().find((fact) => fact.type === 'bill');
      // The ingest read its bytes: a PDF.
      expect([...files.values()]).toEqual(['application/pdf']);
      const document = bill()?.variables.document;
      expect(document).toEqual(expect.any(String));
      const backfill = createMailFactBackfill({
        store, writer, mailboxes: () => [box], blobs, retentionDays: () => 90, now: () => NOW, mintId: () => 'mbf_1',
        fileStored: (file_id) => files.has(file_id),
        storedFileType: (file_id) => files.get(file_id),
      });
      backfill.start({ template_id: template.template_id, days: 30 });
      await backfill.settled();
      expect(backfill.state().job).toMatchObject({ status: 'done', read: 1 });
      expect(bill()).toMatchObject({ variables: expect.objectContaining({ document }) });
    } finally {
      await box.sync.stop();
    }
  });
});

describe('an email’s labels, as a backfill reads them (§6.3)', () => {
  it('reads a folder as a label: filed in Receipts, the email meets a template that names it', async () => {
    // No labels, only a folder — as an IMAP mailbox files it.
    const box = await mailbox([ups('m1', 1, { folder_or_label: 'Receipts', body_text: 'Tracking Number: TRACK-A' })]);
    const template = store.createTemplate({
      definition: {
        ...definition,
        entrance: { conditions: [...definition.entrance.conditions, { field: 'label', op: 'is', value: 'Receipts' }], variables: ['tracking_number'] },
      },
      origin: { kind: 'owner' },
    });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(store.factsForEmail({ slug: 'work', record_id: recordIdOf(box, 'm1') }))
      .toEqual([expect.objectContaining({ template_id: template.template_id })]);
    await box.sync.stop();
  });
});

describe('a backfill that runs recipes tells mail in the order its facts are dated (§6.3)', () => {
  it.each([
    ['before the template, which kept only its date', false],
    ['by the template, which read its facts', true],
  ])('a future-dated transit notice read first — %s — is told before the delivery that came after', async (_when, templateFirst) => {
    let clock = NOW - 10 * DAY;
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'gmail',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    // Dated a year ahead and read first: its facts are dated when it was
    // read. The delivery came a day later. No carrier's number, so nothing
    // but the template reads them: before it, only their dates are kept.
    const transit = ups('m1-1', 0, { subject: 'UPS Update: On the way', received_at: NOW + 365 * DAY, body_text: 'Tracking Number: TRACK-A' });
    const delivered = ups('m2-1', 0, { subject: 'UPS Update: Delivered', received_at: NOW - 9 * DAY, body_text: 'Tracking Number: TRACK-A' });
    const provider: MailProvider = {
      kind: 'gmail',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) {
        clock = NOW - 10 * DAY;
        await opts.onMessage(transit);
        clock = NOW - 9 * DAY;
        await opts.onMessage(delivered);
      },
      async startSync() { return async () => {}; },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      fetchMessage: async (id: string) => [transit, delivered].find((message) => message.source_id === id) ?? null,
    };
    const ingest = createMailFactIngest({ writer, now: () => clock });
    const box = createMailCollection({
      db,
      blobs,
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'work',
      provider,
      config: () => ({ backfill_days: 90, retention_days: 90, quota_bytes: 1024 * 1024 }),
      instances,
      now: () => clock,
      onMessageUpserted: ingest.onMessageUpserted,
    });
    const withState: MailTemplateDefinition = {
      ...definition,
      rules: [
        ...definition.rules,
        { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [
          { contains: 'Delivered', value: 'delivered' }, { contains: 'On the way', value: 'in_transit' },
        ] } },
      ],
    };
    const early = templateFirst ? store.createTemplate({ origin: { kind: 'owner' }, definition: withState }) : undefined;
    await box.sync.start();
    // The first scan read past mail: nothing was told.
    expect(events).toEqual([]);
    expect(store.listFacts()).toHaveLength(templateFirst ? 2 : 0);
    const template = early ?? store.createTemplate({ origin: { kind: 'owner' }, definition: withState });
    clock = NOW;
    const backfill = createMailFactBackfill({
      store, writer, mailboxes: () => [box], blobs, retentionDays: () => 90, now: () => clock, mintId: () => 'mbf_1',
    });
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(events.map((event) => (event.record as { state?: string } | undefined)?.state)).toEqual(['in_transit', 'delivered']);
    await box.sync.stop();
  });
});

describe('mail of one date, in the order it arrived (§5, §6.3)', () => {
  it('replays two emails of one date in the order they were first read, as the thing folds them', async () => {
    let clock = NOW - 5 * DAY;
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'gmail',
      config: { retention_days: 90 }, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    // One date, read transit first. The delivery's id comes first in id order.
    const at = NOW - 6 * DAY;
    const recordId = (source_id: string) => `mail:${createHash('sha256').update(source_id).digest('hex').slice(0, 32)}`;
    const [first, second] = ['same-1', 'same-2'].sort((a, b) => (recordId(a) < recordId(b) ? 1 : -1));
    const transit = ups(first!, 0, { subject: 'UPS Update: On the way', received_at: at, body_text: 'Tracking Number: TRACK-A' });
    const delivered = ups(second!, 0, { subject: 'UPS Update: Delivered', received_at: at, body_text: 'Tracking Number: TRACK-A' });
    expect(recordId(delivered.source_id) < recordId(transit.source_id)).toBe(true);
    const provider: MailProvider = {
      kind: 'gmail',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      async connect() {},
      async initialScan(opts) {
        for (const message of [transit, delivered]) {
          clock += 1;
          await opts.onMessage(message);
        }
      },
      async startSync() { return async () => {}; },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      fetchMessage: async (id: string) => [transit, delivered].find((message) => message.source_id === id) ?? null,
    };
    const ingest = createMailFactIngest({ writer, now: () => clock });
    const box = createMailCollection({
      db,
      blobs,
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'work',
      provider,
      config: () => ({ backfill_days: 90, retention_days: 90, quota_bytes: 1024 * 1024 }),
      instances,
      now: () => clock,
      onMessageUpserted: ingest.onMessageUpserted,
    });
    const template = store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        ...definition,
        rules: [
          ...definition.rules,
          { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [
            { contains: 'Delivered', value: 'delivered' }, { contains: 'On the way', value: 'in_transit' },
          ] } },
        ],
      },
    });
    await box.sync.start();
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    expect(events).toEqual([]);
    clock = NOW;
    const backfill = createMailFactBackfill({
      store, writer, mailboxes: () => [box], blobs, retentionDays: () => 90, now: () => clock, mintId: () => 'mbf_1',
    });
    backfill.start({ template_id: template.template_id, days: 30, run_recipes: true });
    await backfill.settled();
    expect(events.map((event) => (event.record as { state?: string } | undefined)?.state)).toEqual(['in_transit', 'delivered']);
    await box.sync.stop();
  });
});

describe('a template whose conditions were narrowed (§6.3)', () => {
  it('reads again the emails holding its facts, though they no longer meet its conditions: their facts go', async () => {
    const box = await mailbox([ups('m1', 3, { subject: 'UPS Update: On the way' })]);
    const template = store.createTemplate({ definition, origin: { kind: 'owner' } });
    const backfill = backfillFor(box);
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    const own = () => store.listFacts().filter((fact) => fact.template_id === template.template_id);
    expect(own()).toHaveLength(1);
    // Narrowed to deliveries: the transit notice is no longer the template's.
    store.updateTemplate(template.template_id, {
      definition: {
        ...definition,
        entrance: { ...definition.entrance, conditions: [...definition.entrance.conditions, { field: 'subject', op: 'contains', value: 'Delivered' }] },
      },
    });
    backfill.start({ template_id: template.template_id, days: 30 });
    await backfill.settled();
    expect(backfill.state().job).toMatchObject({ status: 'done', total: 1, read: 1 });
    expect(own()).toEqual([]);
    await box.sync.stop();
  });
});
