import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, defaultQuietHoursPolicy, reminderMailReference,
  type ReminderMailReference, type CollectionRecord, type MailMessageSnapshot, type WorkEntityUpsertRpcRequest } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';
import { createInstanceStore } from '../../../../backend/server/src/collections/instance-store.js';
import { createCollectionTable } from '../../../../backend/server/src/collections/table.js';
import { getMailMessage } from '../../../../backend/server/src/collections/mail/message-read.js';
import { createReminderStore } from '../../../../backend/server/src/storage/reminder-store.js';
import { wireReminderDispatchers } from '../../../../backend/server/src/composition/bin/wire-reminders.js';
import { makeReminderHandlers } from '../../../../backend/server/src/reminders/reminder-rpc-handler.js';

/** Real task CRUD over SQLite; the retained mailbox and transport faults are
 * controlled so a browser can exercise an exact-message handoff and recovery. */
export const installMailTaskFixture = async (page: Page, options: { reminders?: boolean; now?: number } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = options.now ?? Date.parse('2026-11-16T12:00:00Z');
  if (options.reminders) await page.clock.setFixedTime(new Date(now));
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'other.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Other tasks', write_capable: true });
  store.writeProject({ id: 'launch', source_id: 'recued.project', title: 'Launch project' }, now);
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus, now: () => now }) })!.handlers;
  const client = { instance_id: 'mail-task-browser', client_kind: 'webclient' } as never;
  const writes: WorkEntityUpsertRpcRequest[] = [], calls: string[] = [];
  const records: CollectionRecord[] = Array.from({ length: 35 }, (_, index) => ({ record_id: `mail-${index + 1}`, source_id: `native-${index + 1}`,
    received_at: now - index, modified_at: now - index, size_bytes: 100,
    hot_fields: { from: 'Alex <alex@example.test>', to: ['owner@example.test'], subject: `Quote ${index + 1}`, thread_id: index < 2 ? 'quote-thread' : `thread-${index + 1}`,
      direction: 'inbound', folder: 'INBOX', is_read: false, is_flagged: false, has_attachments: false } }));
  const instances = options.reminders ? createInstanceStore({ db }) : undefined;
  const mailTables = new Map<string, ReturnType<typeof createCollectionTable>>();
  if (instances) for (const slug of ['work', 'personal']) {
    instances.upsert({ platform: 'mail', slug, adapter_type: 'imap', config: {}, auth_state: 'healthy', last_synced_at: now,
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' } });
    const table = createCollectionTable({ db, platform: 'mail', slug }); mailTables.set(slug, table);
    for (const record of records) table.upsert(record);
  }
  const reminderStore = options.reminders ? createReminderStore(db) : undefined;
  const reminderHandlers = options.reminders ? makeReminderHandlers({ dispatchers: wireReminderDispatchers({ db, now: () => now,
    serverTimeZoneStore: { read: () => ({ mode: 'fixed', zone: 'America/Los_Angeles', updated_at: now }) },
    quietHoursStore: { read: defaultQuietHoursPolicy } }) })!.handlers : undefined;
  const reminderCalls: { method: string; args: Record<string, unknown> }[] = [];
  let loseReminderReply = false, filterSupported = true;
  const held = new Set<string>(), releases = new Map<string, () => void>();
  let body: string | null = 'Please review this quote.\nConfirm the delivery date.\n' + 'Supporting context.\n'.repeat(80), partial = false;
  let failSources = false, holdSources = false, release: (() => void) | undefined;
  let reply: 'normal' | 'lost' | 'pending' = 'normal';
  await page.exposeFunction('__mailTaskRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}; calls.push(method);
    try {
      const id = String(args.reminder_id ?? args.record_id ?? (args.page as { mail_ref?: ReminderMailReference } | undefined)?.mail_ref?.record_id ?? '');
      const key = method + ':' + id;
      if (held.delete(key)) await new Promise<void>(done => releases.set(key, done));
      if (options.reminders && method === 'server.timezone.get') return { result: { resolved_zone: 'America/Los_Angeles' } };
      if (reminderHandlers && Object.hasOwn(reminderHandlers, method)) {
        reminderCalls.push({ method, args: structuredClone(args) });
        const handler = reminderHandlers[method as keyof typeof reminderHandlers] as (args: never, client: never) => Promise<unknown>;
        const result = await handler(args as never, client);
        if (method === 'reminder.create' && loseReminderReply) { loseReminderReply = false; throw new Error('The reminder reply was lost.'); }
        if (method === 'reminder.list' && !filterSupported) {
          const out = result as import('@recued/contracts').ReminderListResult;
          return { result: { ...out, mail_links_supported: undefined, page: out.page ? { ...out.page, mail_ref: undefined } : undefined } };
        }
        return { result };
      }
      if (method === 'work_entity.source.list') {
        if (holdSources) { holdSources = false; await new Promise<void>(done => { release = done; }); }
        if (failSources) throw new Error('Task Sources could not be loaded.');
        return { result: { sources: store.listSources() } };
      }
      if (method === 'collection.listInstances') return { result: { instances: (options.reminders ? ['work', 'personal'] : ['work']).map(slug =>
        ({ platform: 'mail', slug, adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: now })) } };
      if (method === 'collection.list' && args.platform === 'mail') {
        const before = args.before as { received_at: number; record_id: string } | undefined;
        return { result: { records: records.filter(row => !before || row.received_at < before.received_at)
          .slice(0, Number(args.limit ?? 30)) } };
      }
      if (method === 'collection.get' && args.platform === 'mail') return { result: { record: options.reminders
        ? mailTables.get(String(args.slug))?.get(String(args.record_id)) ?? null : records.find(row => row.record_id === args.record_id) ?? null } };
      if (method === 'collection.mail.conversation.get') {
        const record = records.find(row => row.record_id === args.record_id)!;
        const items = records.filter(row => row.hot_fields.thread_id === record.hot_fields.thread_id).map(row => ({ ...row, ...row.hot_fields, snippet: 'Review the quote.', has_attachments: false }));
        const slug = String(args.slug ?? 'work');
        return { result: { slug, anchor: items.find(row => row.record_id === record.record_id), messages: items,
          thread_id: record.hot_fields.thread_id, incarnation: instances?.getIncarnation?.('mail', slug) ?? 'work-v1', mailbox_address: 'owner@example.test' } };
      }
      if (method === 'collection.mail.message.get') {
        if (options.reminders) {
          const slug = String(args.slug), table = mailTables.get(slug);
          const collection = table ? {
            get: (id: string) => { const saved = table.get(id); return saved ? { ...saved,
              body_inline: id === 'mail-2' ? 'The second email needs a separate follow-up.' : body ?? undefined } : null; },
            accountEmail: slug + '@example.test', provider: {},
          } : undefined;
          return { result: await getMailMessage({ getCollection: () => collection, getIncarnation: () => instances!.getIncarnation!('mail', slug),
          listMailInstances: async () => ({ instances: [] }) }, args as unknown as import('@recued/contracts').MailMessageRef) };
        }
        const record = records.find(row => row.record_id === args.record_id)!;
        const snapshot: MailMessageSnapshot = { slug: 'work', record_id: record.record_id, from: String(record.hot_fields.from), to: ['owner@example.test'], cc: [],
          subject: String(record.hot_fields.subject), received_at: record.received_at, body: record.record_id === 'mail-2' ? 'The second email needs a separate follow-up.' : body,
          body_truncated: partial, read: 'stored', reply: null };
        return { result: snapshot };
      }
      if (method === 'collection.mail.message.attachments') return { result: { slug: 'work', record_id: args.record_id, incarnation: 'work-v1', items: [], warnings: [], truncated: false } };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      if (method === 'work_entity.upsert') {
        writes.push(structuredClone(args) as unknown as WorkEntityUpsertRpcRequest);
        const result = await handler(args as never, client) as { entity: object };
        if (reply === 'lost') throw new Error('The task save reply was lost.');
        return { result: reply === 'pending' ? { ...result, entity: { ...result.entity, pending_write: { staged_at: now, operation: 'create', dirty_fields: ['title'], state: 'awaiting_verify' } } } : result };
      }
      return { result: await handler(args as never, client) };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(track => {
    if (!track) {
      Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
        (window as unknown as { __mailTaskRpc(method: string, args: unknown): Promise<unknown> }).__mailTaskRpc(method, args) });
      return;
    }
    const settled: string[] = [];
    Object.assign(window, { __mailTaskSettled: settled, __connectionsFixture: async (method: string, args: unknown) => {
      const out = await (window as unknown as { __mailTaskRpc(method: string, args: unknown): Promise<unknown> }).__mailTaskRpc(method, args);
      settled.push(method + ':' + String((args as { record_id?: string })?.record_id ?? '')); return out;
    } });
  }, options.reminders === true);
  return { writes, calls, tasks: () => store.listTasks(), now, reminderCalls,
    mailReference: (slug = 'work', id = 'mail-1') => reminderMailReference(slug, mailTables.get(slug)!.get(id)!, instances!.getIncarnation!('mail', slug))!,
    seedReminder: (mail_ref: ReminderMailReference, text: string, state: 'pending' | 'cancelled' | 'delivered' = 'pending', at = now + 3600_000) => {
      const row = reminderStore!.create({ text, at, mail_ref, time_zone: 'America/Los_Angeles', origin: {} }, now);
      if (state === 'cancelled') reminderStore!.cancel(row.reminder_id, now);
      if (state === 'delivered') reminderStore!.markDelivered(row.reminder_id, now, ['in_app']);
      return row.reminder_id;
    },
    reminder: (id: string) => reminderStore!.get(id), reminders: () => reminderStore!.listPending(500),
    cancelReminder: (id: string) => reminderStore!.cancel(id, now), deliverReminder: (id: string) => reminderStore!.markDelivered(id, now, ['in_app']),
    loseReminderReply: () => { loseReminderReply = true; }, filterSupported: (supported: boolean) => { filterSupported = supported; },
    hold: (method: string, id: string) => held.add(method + ':' + id), waitingRead: () => releases.size > 0,
    releaseReads: () => { for (const done of releases.values()) done(); releases.clear(); },
    replaceEmail: (slug = 'work', id = 'mail-1') => { const table = mailTables.get(slug)!; table.upsert({ ...table.get(id)!, source_id: 'reused-' + id, received_at: now + 5000 }); },
    removeEmail: (slug = 'work', id = 'mail-1') => mailTables.get(slug)!.delete(id),
    reenroll: (slug = 'work') => {
      const prior = instances!.get('mail', slug)!; instances!.delete('mail', slug); instances!.upsert(prior);
    },
    failSources: (value: boolean) => { failSources = value; },
    noWritable: () => { for (const id of ['recued.task', 'other.task']) store.registerSource({ id, top_tier_kind: 'task', source_kind: 'builtin', source_label: id, write_capable: false }); },
    partialBody: () => { body = 'Only the retained beginning.'; partial = true; },
    missingBody: () => { body = null; },
    reply: (value: typeof reply) => { reply = value; },
    holdSources: () => { holdSources = true; }, waiting: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    dispose() { release?.(); for (const done of releases.values()) done(); releases.clear(); bus.dispose(); db.close(); } };
};
