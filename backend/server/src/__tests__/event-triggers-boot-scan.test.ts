/** D-124 — mail a boot scan finds reaches the triggers.
 *
 *  At boot the collections start before `composeListeners` composes the
 *  trigger dispatcher: a mailbox's `sync.start()` awaits its scan, which reads
 *  the mail that came while the server was down. Each such email's
 *  `data.mail.<slug>.message.created` reached no trigger — every recipe that
 *  runs on new mail missed it, on every server whose vault unlocks at boot.
 *
 *  A recorder listens from before the collections start and keeps what a
 *  trigger would have been told; composing the dispatcher seals it, and once
 *  the pre-approval driver is there it is replayed through the dispatcher's
 *  own callbacks (`deliver`), never through the bus. Proven here over the
 *  server's real contexts, in the server's own boot order; only Gmail is
 *  scripted. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import type { CanonicalEvent, RecipeDefinition } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { createCalendarCollection } from '../collections/calendar/calendar-collection.js';
import { attachFile } from '../collections/file/attach-file.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, InboundMailAttachmentPart, MailProvider } from '../collections/mail/provider.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import type { CalendarProvider, ProviderEventPayload } from '../collections/calendar/provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { composeEventTriggers } from '../composition/bin/wire-event-triggers.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { bootEventKeep, createBootEventRecorder } from '../triggers/boot-events.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { handleTriggersUpdate } from '../triggers/handler.js';
import { createEventTriggersStore } from '../triggers/store.js';

const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });

const mailEvent = (record_id: string, event_kind: WarehouseEvent['event_kind'] = 'created', slug = 'work'): WarehouseEvent => ({
  platform: 'mail', slug, entity_type: 'message', event_kind, record_id, at: 1,
});

describe('the boot recorder', () => {
  it('keeps what matches and is kept, until sealed; replays it once, in order, each once there is room', async () => {
    const bus = createWarehouseEventBus();
    const recorder = createBootEventRecorder({
      bus, pattern: 'data.mail.**.created', keep: (event) => event.slug === 'work',
    });
    bus.emit(mailEvent('m-1'));
    bus.emit(mailEvent('m-2', 'updated'));
    bus.emit(mailEvent('m-3', 'created', 'first-scan'));
    bus.emit(mailEvent('m-4'));
    recorder.seal();
    bus.emit(mailEvent('m-5'));

    const handed: string[] = [];
    const gates: (() => void)[] = [];
    const room = vi.fn(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const replayed = recorder.replay((event) => { handed.push(event.record_id); }, room);
    await flush();
    expect(handed).toEqual([]);
    gates.shift()!();
    await flush();
    expect(handed).toEqual(['m-1']);
    gates.shift()!();
    await replayed;
    expect(handed).toEqual(['m-1', 'm-4']);
    // Once.
    await recorder.replay((event) => { handed.push(event.record_id); });
    expect(handed).toEqual(['m-1', 'm-4']);
  });

  it('keeps nothing more once it replays, sealed or not', async () => {
    const bus = createWarehouseEventBus();
    const recorder = createBootEventRecorder({ bus, pattern: 'data.mail.**.created', keep: () => true });
    const handed: string[] = [];
    await recorder.replay((event) => { handed.push(event.record_id); });
    bus.emit(mailEvent('m-1'));
    await recorder.replay((event) => { handed.push(event.record_id); });
    expect(handed).toEqual([]);
  });

  it('keeps what a trigger would be told of, as the dispatcher decides it', () => {
    const keep = bootEventKeep({ isComplete: () => true });
    expect(keep(mailEvent('m-1'))).toBe(true);
    // Mail: its arrivals only.
    expect(keep(mailEvent('m-2', 'updated'))).toBe(false);
    expect(keep({ platform: 'calendar', slug: 'work', entity_type: 'event', event_kind: 'updated', record_id: 'e-1', at: 1 })).toBe(true);
    expect(keep({ platform: 'file', slug: 'work', entity_type: 'file', event_kind: 'deleted', record_id: 'f-1', at: 1 })).toBe(true);
    // Published by a mailbox's first scan: past mail's.
    expect(keep({ platform: 'file', slug: 'received', entity_type: 'file', event_kind: 'created', record_id: 'f-2', at: 1, in_drain: true })).toBe(false);
    expect(keep({ platform: 'contact', slug: 'default', entity_type: 'contact', event_kind: 'created', record_id: 'c-1', at: 1 })).toBe(false);
    // A collection's own first scan.
    expect(bootEventKeep({ isComplete: () => false })(mailEvent('m-3'))).toBe(false);
  });

  it('hands over the rest when one cannot be handed over', async () => {
    const bus = createWarehouseEventBus();
    const warn = vi.fn();
    const recorder = createBootEventRecorder({ bus, pattern: 'data.mail.**.created', keep: () => true, logger: { warn } });
    bus.emit(mailEvent('m-1'));
    bus.emit(mailEvent('m-2'));
    const handed: string[] = [];
    await recorder.replay((event) => {
      if (event.record_id === 'm-1') throw new Error('broke');
      handed.push(event.record_id);
    });
    expect(handed).toEqual(['m-2']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('dispatcher.deliver', () => {
  it('reaches the triggers exactly as the bus would — its patterns and filters — and not the bus', async () => {
    const db = new Database(':memory:');
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-new', recipe_id: 'r-new', publisher_id: 'local', pattern: 'data.mail.**.created',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    store.create({
      trigger_id: 't-other', recipe_id: 'r-other', publisher_id: 'local', pattern: 'data.calendar.**.created',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    const bus = createWarehouseEventBus();
    const onBus = vi.fn();
    bus.subscribe('data.mail.**', onBus);
    const runRecipe = vi.fn(async () => ({ run_id: 'run-1' }));
    const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe } });
    dispatcher.rebuild();
    dispatcher.deliver(mailEvent('m-1'));
    await dispatcher.drained();
    expect(runRecipe.mock.calls.map((call) => (call as unknown as [{ recipe_id: string }])[0].recipe_id)).toEqual(['r-new']);
    // The bus's other subscribers heard it when it came, not again.
    expect(onBus).not.toHaveBeenCalled();
    // A disposed dispatcher's triggers hear nothing handed over.
    dispatcher.dispose();
    dispatcher.deliver(mailEvent('m-2'));
    await dispatcher.drained();
    expect(runRecipe).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe('D-124 — a calendar a boot scan reads, in the boot order', () => {
  const meeting = (source_id: string, over: Partial<CanonicalEvent> = {}): ProviderEventPayload => ({
    event: {
      source_id, ical_uid: `uid-${source_id}`, calendar_id: 'cal-1', summary: `Meeting ${source_id}`,
      start_at: 1_700_000_000_000, end_at: 1_700_000_900_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: 1_690_000_000_000, updated_at: 1_700_000_000_000, ...over,
    } as CanonicalEvent,
    description_bytes: 0,
  });

  /** A calendar synced once before, its triggers composed only after its scan
   *  — as the server boots — with the recorder the server makes. */
  const calendarAtBoot = async (firstScanDone: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'd-124-boot-calendar-'));
    const db = new Database(join(dir, 'server.db'));
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'calendar', slug: 'work', adapter_type: 'gcal', config: {}, caps: {}, auth_state: 'healthy', last_synced_at: null,
    } as never);
    const bus = createWarehouseEventBus();
    let listed: ProviderEventPayload[] = [meeting('e1'), meeting('e2')];
    const provider = {
      kind: 'gcal', slug: 'work',
      async connect() {}, async close() {},
      async initialScan(opts: { onEvent: (payload: ProviderEventPayload) => Promise<boolean> }) {
        for (const payload of listed) if (!(await opts.onEvent(payload))) break;
      },
      async startSync() { return async () => {}; },
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0, pending_series_expansions: 0 }),
    } as unknown as CalendarProvider;
    const calendar = createCalendarCollection({
      db, blobs: createBlobStore(join(dir, 'blobs')), bus, slug: 'work', provider, instances,
      gate: createStorageGate({ quota: 1 << 30, reservePct: 10, surface: 'collection:calendar:work' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1 << 30, expansion_past_days: 30, expansion_future_days: 90 }),
    });
    if (firstScanDone) {
      await calendar.sync.start();
      await calendar.sync.stop();
    }
    // The restart: the recorder listens from before the collections start;
    // one meeting moved while the server was down.
    const recorder = createBootEventRecorder({ bus, pattern: '**', keep: bootEventKeep(createBackfillStateLookup({ instances })) });
    listed = [meeting('e1', { start_at: 1_700_003_600_000, end_at: 1_700_004_500_000, updated_at: 1_700_000_500_000 }), meeting('e2')];
    await calendar.sync.start();
    // Then the dispatcher composes, and the recorder is sealed and replayed.
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-calendar', recipe_id: 'r-calendar', publisher_id: 'local', pattern: 'data.calendar.**',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    const runs: string[] = [];
    const dispatcher = createEventTriggerDispatcher({
      bus, store,
      runtime: { runRecipe: async (input) => { runs.push((input.context as { event: { payload: { record_id: string } } }).event.payload.record_id); return { run_id: 'run-1' }; } },
    });
    dispatcher.rebuild();
    recorder.seal();
    await recorder.replay((event) => { dispatcher.deliver(event); }, () => dispatcher.room());
    await dispatcher.drained();
    const close = async (): Promise<void> => {
      dispatcher.dispose();
      await calendar.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { runs, close };
  };

  it('replays a meeting moved while the server was down — once, and nothing for one that stayed', async () => {
    const boot = await calendarAtBoot(true);
    try {
      expect(boot.runs).toEqual(['cal:work:e1']);
    } finally {
      await boot.close();
    }
  });

  it('replays nothing from a calendar’s first scan: what it finds was already there', async () => {
    const boot = await calendarAtBoot(false);
    try {
      expect(boot.runs).toEqual([]);
    } finally {
      await boot.close();
    }
  });
});

/** A dispatcher composed after the collections started — as the server boots
 *  — with one trigger, the recorder sealed and replayed into it; what ran. */
const replayAtBoot = async (
  db: Database.Database,
  bus: ReturnType<typeof createWarehouseEventBus>,
  recorder: ReturnType<typeof createBootEventRecorder>,
  pattern: string,
) => {
  const store = createEventTriggersStore(db);
  store.create({
    trigger_id: 't-boot', recipe_id: 'r-boot', publisher_id: 'local', pattern,
    enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
  } as never);
  const runs: [string, string][] = [];
  const dispatcher = createEventTriggerDispatcher({
    bus, store,
    runtime: {
      runRecipe: async (input) => {
        const event = (input.context as { event: { kind: string; payload: { record_id: string } } }).event;
        runs.push([event.kind, event.payload.record_id]);
        return { run_id: `run-${runs.length}` };
      },
    },
  });
  dispatcher.rebuild();
  recorder.seal();
  await recorder.replay((event) => { dispatcher.deliver(event); }, () => dispatcher.room());
  await dispatcher.drained();
  dispatcher.dispose();
  return runs;
};

describe('D-124 — a folder a boot walk reads, in the boot order', () => {
  const folderAtBoot = async (firstWalkDone: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'd-124-boot-folder-'));
    const root = join(dir, 'watched');
    mkdirSync(root, { recursive: true });
    const db = new Database(join(dir, 'server.db'));
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'file', slug: 'work', adapter_type: 'local', config: {}, caps: {}, auth_state: 'healthy', last_synced_at: null,
    } as never);
    const bus = createWarehouseEventBus();
    const folder = () => createFileCollection({
      db, blobs: createBlobStore(join(dir, 'blobs')), bus, slug: 'work', instances,
      gate: createStorageGate({ quota: 1 << 30, reservePct: 10, surface: 'collection:file:work' }),
      config: () => ({ path: root, ignore: [], max_body_bytes: 10 * 1024 * 1024, retention_days: 0, quota_bytes: 1 << 30 }),
    });
    writeFileSync(join(root, 'kept.txt'), 'kept');
    writeFileSync(join(root, 'removed.txt'), 'removed');
    if (firstWalkDone) {
      const first = folder();
      await first.sync.start();
      await first.close();
    }
    // While the server was down: one file came, one went.
    writeFileSync(join(root, 'added.txt'), 'added');
    unlinkSync(join(root, 'removed.txt'));
    const recorder = createBootEventRecorder({ bus, pattern: '**', keep: bootEventKeep(createBackfillStateLookup({ instances })) });
    const collection = folder();
    await collection.sync.start();
    const runs = await replayAtBoot(db, bus, recorder, 'data.file.**');
    const pathOf = new Map(collection.list({ platform: 'file', slug: 'work' }).map((r) => [r.record_id, r.hot_fields.path]));
    await collection.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    return { runs, pathOf };
  };

  it('replays what changed while the server was down — a file that came, one that went — and nothing for one that stayed', async () => {
    const { runs, pathOf } = await folderAtBoot(true);
    expect(runs.map(([kind, record_id]) => [kind, pathOf.get(record_id) ?? 'gone'])).toEqual([['created', 'added.txt'], ['deleted', 'gone']]);
  });

  it('replays nothing from a folder’s first walk: what it finds was already there', async () => {
    const { runs } = await folderAtBoot(false);
    expect(runs).toEqual([]);
  });
});

describe('D-124 — a mail attachment received while the server was down', () => {
  /** A mailbox whose attachments are published as received files — as the
   *  server wires them — and its mail, listed by `listed`. */
  const mailboxWithAttachments = () => {
    const dir = mkdtempSync(join(tmpdir(), 'd-124-received-'));
    const db = new Database(join(dir, 'server.db'));
    const blobs = createBlobStore(join(dir, 'blobs'));
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'imap', config: {}, caps: {}, auth_state: 'healthy', last_synced_at: null,
    } as never);
    const bus = createWarehouseEventBus();
    const registry = createCollectionRegistry();
    let ids = 0;
    const annotations = createAnnotationStore({ db, blobs, now: () => 1_000 + ids, newId: () => `link-${(ids += 1)}` });
    const received = createInboundFileCollection({
      db, blobs, bus, slug: 'received', now: () => 1_000,
      gate: createStorageGate({ quota: 1 << 30, reservePct: 10, surface: 'collection:file:received' }),
    });
    registry.register(received);
    const part = (id: string): InboundMailAttachmentPart => ({
      filename: `${id}.pdf`, mime_type: 'application/pdf', size: 20, source_part_id: id,
      async fetchBytes() { return Buffer.from(`%PDF-1.4 ${id}`); },
    });
    const message = (source_id: string): CanonicalMessage => ({
      source_id, from: 'shop@example.com', to: ['me@example.com'], cc: [], subject: `Receipt ${source_id}`, thread_id: source_id,
      folder_or_label: 'INBOX', is_read: false, is_flagged: false, has_attachments: true, received_at: Date.now() - 60_000,
      body_text: 'Attached.', attachments: [part(`part-${source_id}`)],
    } as CanonicalMessage);
    const box = { listed: [message('m1')] };
    const provider = {
      kind: 'imap', slug: 'work', sendCapable: false, mutationCapable: false, accountEmail: 'me@example.com',
      async connect() {}, async close() {},
      async initialScan(opts: { onMessage: (m: CanonicalMessage) => Promise<boolean> }) {
        for (const m of box.listed) if (!(await opts.onMessage(m))) break;
      },
      async startSync() { return async () => {}; },
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    } as unknown as MailProvider;
    const mail = createMailCollection({
      db, blobs, bus, slug: 'work', provider, instances,
      gate: createStorageGate({ quota: 1 << 30, reservePct: 10, surface: 'collection:mail:work' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1 << 30 }),
      inboundAttachmentDeps: () => ({
        fileIngestor: received, attach: attachFile,
        attachDeps: { annotationDeps: { store: annotations } as AnnotationRpcDeps, registry },
      }),
    });
    registry.register(mail);
    const fileOf = (source_id: string): string => received.list({ platform: 'file', slug: 'received', limit: 10 })
      .find((record) => record.source_id.includes(`part-${source_id}`))!.record_id;
    const close = async (): Promise<void> => {
      await mail.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, bus, instances, mail, box, message, fileOf, close };
  };

  it('reaches a received-file trigger; one stored before does not', async () => {
    const m = mailboxWithAttachments();
    try {
      await m.mail.sync.start();
      await m.mail.sync.stop();
      // The restart: a second email, with its attachment, came while it was down.
      const recorder = createBootEventRecorder({ bus: m.bus, pattern: '**', keep: bootEventKeep(createBackfillStateLookup({ instances: m.instances })) });
      m.box.listed = [m.message('m1'), m.message('m2')];
      await m.mail.sync.start();
      const runs = await replayAtBoot(m.db, m.bus, recorder, 'data.file.received.*.created');
      expect(runs).toEqual([['created', m.fileOf('m2')]]);
    } finally {
      await m.close();
    }
  });

  it('fires nothing for the attachments of a mailbox’s first scan — past mail’s — and fires for one that arrives after', async () => {
    const m = mailboxWithAttachments();
    // A live dispatcher, as for a mailbox connected after the server started.
    const store = createEventTriggersStore(m.db);
    store.create({
      trigger_id: 't-received', recipe_id: 'r-received', publisher_id: 'local', pattern: 'data.file.received.*.created',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    const runs: string[] = [];
    const dispatcher = createEventTriggerDispatcher({
      bus: m.bus, store, backfillState: createBackfillStateLookup({ instances: m.instances }),
      runtime: {
        runRecipe: async (input) => {
          runs.push((input.context as { event: { payload: { record_id: string } } }).event.payload.record_id);
          return { run_id: `run-${runs.length}` };
        },
      },
    });
    dispatcher.rebuild();
    try {
      await m.mail.sync.start();
      await dispatcher.drained();
      expect(runs).toEqual([]);
      // Mail that arrives once the first scan is done.
      await m.mail.sync.stop();
      m.box.listed = [m.message('m1'), m.message('m2')];
      await m.mail.sync.start();
      await dispatcher.drained();
      expect(runs).toEqual([m.fileOf('m2')]);
    } finally {
      dispatcher.dispose();
      await m.close();
    }
  });
});

// ── Over the server composition, in its boot order ──────────────────────

const OWNER = 'me@owner.example';
let tmp: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

interface GmailMessage { readonly id: string; readonly at: number }

/** The mailbox's current messages, served as the Gmail REST API would. */
const scriptGmail = (mailbox: GmailMessage[]): void => {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') return json({ emailAddress: OWNER, historyId: '100' });
    if (path === '/history') return json({ historyId: '100' });
    if (path === '/messages') {
      return json({ messages: mailbox.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: mailbox.length });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    const message = one ? mailbox.find((m) => m.id === decodeURIComponent(one[1]!)) : undefined;
    if (message !== undefined && url.searchParams.get('format') === 'raw') {
      const raw = [
        'From: "Shop" <hello@shop.example>', `To: ${OWNER}`, 'Subject: Hello', `Message-ID: <${message.id}@shop.example>`,
        `Date: ${new Date(message.at).toUTCString()}`, 'Content-Type: text/plain; charset=utf-8', '', 'Hi there.', '',
      ].join('\r\n');
      return json({
        id: message.id, threadId: message.id, labelIds: ['INBOX'],
        raw: Buffer.from(raw).toString('base64url'), internalDate: String(message.at),
      });
    }
    return new Response(JSON.stringify({ error: `unscripted ${url.href}` }), { status: 404 });
  });
};

/** Runs on every new mail, as 18 shipped recipes do. */
const onNewMail: RecipeDefinition = {
  recipe_id: 'boot-scan-new-mail',
  version: 1,
  ttl: 0,
  metadata: { name: 'boot-scan-new-mail', description: 'Runs on every new mail.', author: 'test', supported_platforms: [] },
  variables: {},
  event_triggers: [{ event: 'data.mail.**.created' }],
  prefetch_steps: [],
  steps: [{ id: 'seen', transform: 'coalesce', values: ['{{context.event.payload.record_id}}'] }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** The server's real contexts over one SQLite file, a Gmail account connected
 *  and the new-mail recipe installed — composed up to where the boot starts
 *  the collections. */
const bootToAdapters = async () => {
  tmp = mkdtempSync(join(tmpdir(), 'd-124-boot-scan-'));
  const dbPath = join(tmp, 'server.db');
  const runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({
    dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig,
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({
    db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
    auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId,
    recipeStore: storage.recipeStore, pairedInstances: storage.pairedInstances,
    workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound,
  });
  // The vault unlocks at boot, as a keyfile does: the mailboxes sync at once.
  await app.keys!.init({ password: 'd-124-boot-scan-passphrase' });
  const collection = composeCollectionContext({
    db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests, baseVault: storage.baseVault,
    auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
    contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
    accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys,
    connectionStore: app.connectionStoreRef, workEntityStore: storage.workEntityStoreRef,
    enrichmentCascade: app.enrichmentCascadeRef,
  });
  const execution = await composeExecutionContext({
    storage, app, collection, baseVault: storage.baseVault, lateBound, env: {},
  });
  createOAuthAppConfigStore(storage.db!, { getEncryptionKey: app.keys!.keyProvider('server-data') })
    .setIssuer('google', 'client-id', 'client-secret');
  await storage.accountStore!.set('gmail.work.access_token', 'at');
  await storage.accountStore!.set('gmail.work.refresh_token', 'rt');
  await storage.accountStore!.set('gmail.work.expires_at', String(Date.now() + 3_600_000));
  const mailStack = collection.mailStack!;
  mailStack.instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'gmail', config: { account_email: OWNER },
    caps: {}, auth_state: 'healthy', last_synced_at: null,
  } as never);
  storage.recipeStore.save(onNewMail, 'local', 'inline');
  // D-319 — the recipe was switched on before the restart: it has a dish, and
  // its trigger is made for that dish.
  execution.executeDeps.dishStore!.set({
    dish_id: 'dsh_boot', recipe_id: onNewMail.recipe_id, publisher_id: 'local', name: '', is_default: true,
    config_overlay: {}, enabled: true, created_at: 1,
  });

  /** What `composeListeners` does, in its order: compose the dispatcher (which
   *  subscribes it), seal the recorder at once, and — once the pre-approval
   *  driver is there — replay it. The recipe's trigger is switched on between,
   *  as it was before the restart. */
  const composeListenersPart = async () => {
    const triggers = composeEventTriggers({
      db: storage.db, warehouseBus: app.warehouseBus, executeDeps: execution.executeDeps,
      auditLog: storage.auditLog, eventBus: storage.eventBus, localManifestStore: undefined,
    })!;
    collection.bootEvents.seal();
    const row = triggers.store.list().find((t) => t.recipe_id === onNewMail.recipe_id)!;
    await handleTriggersUpdate(triggers.triggersDeps, { trigger_id: row.trigger_id, enabled: true });
    const replay = () => collection.bootEvents.replay(
      (event) => { triggers.dispatcher.deliver(event); },
      () => triggers.dispatcher.room(),
    );
    return { triggers, replay };
  };
  const runs = async () =>
    (await storage.auditLog!.listActivities()).filter((a) => a.action === 'trigger_fired' && a.recipe_id === onNewMail.recipe_id);
  const close = async (triggers?: { dispatcher: { dispose(): void } }): Promise<void> => {
    triggers?.dispatcher.dispose();
    await mailStack.disposeAll();
    storage.db?.close();
  };
  return { mailStack, composeListenersPart, runs, close };
};

describe('D-124 — mail a boot scan finds, over the server composition in its boot order', () => {
  it('runs the new-mail recipe for mail that came while the server was down', async () => {
    const server = await bootToAdapters();
    let triggers: { dispatcher: { dispose(): void; drained(): Promise<void> } } | undefined;
    try {
      // The mailbox synced before the restart; one email came while it was down.
      server.mailStack.instances.markBackfillComplete('mail', 'work');
      scriptGmail([{ id: 'g1', at: Date.now() - 60_000 }]);
      await server.mailStack.startAll();
      const composed = await server.composeListenersPart();
      triggers = composed.triggers;
      await composed.replay();
      await composed.triggers.dispatcher.drained();
      expect(await server.runs()).toMatchObject([{ detail: 'completed' }]);
    } finally {
      await server.close(triggers);
    }
  }, 60_000);

  it('fires nothing for a mailbox’s first scan: the mail it finds is past mail', async () => {
    const server = await bootToAdapters();
    let triggers: { dispatcher: { dispose(): void; drained(): Promise<void> } } | undefined;
    try {
      scriptGmail([{ id: 'g1', at: Date.now() - 60_000 }, { id: 'g2', at: Date.now() - 120_000 }]);
      await server.mailStack.startAll();
      const composed = await server.composeListenersPart();
      triggers = composed.triggers;
      await composed.replay();
      await composed.triggers.dispatcher.drained();
      expect(await server.runs()).toEqual([]);
    } finally {
      await server.close(triggers);
    }
  }, 60_000);

  it('hands over only what came before the dispatcher subscribed: mail after it runs once', async () => {
    const server = await bootToAdapters();
    let triggers: { dispatcher: { dispose(): void; drained(): Promise<void> } } | undefined;
    try {
      server.mailStack.instances.markBackfillComplete('mail', 'work');
      const mailbox: GmailMessage[] = [{ id: 'g1', at: Date.now() - 60_000 }];
      scriptGmail(mailbox);
      await server.mailStack.startAll();
      const composed = await server.composeListenersPart();
      triggers = composed.triggers;
      // Mail arrives after the dispatcher subscribed and before the replay:
      // the dispatcher hears it itself.
      await server.mailStack.pauseSync();
      mailbox.push({ id: 'g2', at: Date.now() - 30_000 });
      await server.mailStack.resumeSync();
      await composed.replay();
      await composed.triggers.dispatcher.drained();
      expect(await server.runs()).toHaveLength(2);
    } finally {
      await server.close(triggers);
    }
  }, 60_000);

  it('is wired so by the server: sealed as the dispatcher composes, replayed once the pre-approval driver is there', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'),
      'utf-8',
    );
    const composed = source.indexOf('const eventTriggersBundle = composeEventTriggers(');
    const sealed = source.indexOf('collection.bootEvents.seal();');
    expect(composed).toBeGreaterThan(0);
    expect(sealed).toBeGreaterThan(composed);
    // Nothing between them waits: no event can come in the gap and be heard
    // twice, or not at all.
    expect(source.slice(composed, sealed)).not.toContain('await ');
    const replayed = source.indexOf('void collection.bootEvents.replay(');
    expect(replayed).toBeGreaterThan(source.indexOf('await storage.preapprovalStorage!.recover()'));
    expect([...source.matchAll(/collection\.bootEvents\.(seal|replay)\(/g)]).toHaveLength(2);
    // And the recorder listens from before the collections start: it is made
    // with the collection context, whose adapters the boot starts later.
    const collectionSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-collection-context.ts'),
      'utf-8',
    );
    expect(collectionSource).toContain("pattern: '**',");
    expect(collectionSource).toContain('keep: bootEventKeep(bootBackfillState),');
  });
});
