import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, defaultQuietHoursPolicy, type ReminderRecordReference, type ReminderState, type Booking, type Commitment, type ContactRecord, type Note, type Project, type Task, type WorkEntityGetRpcResponse, type WorkEntityProjectAttentionRpcResponse } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers, type WorkEntityCrudRpcDeps } from '../../../../backend/server/src/work-entity-crud-handler.js';
import { createReminderStore } from '../../../../backend/server/src/storage/reminder-store.js';
import { createReminderDispatchers } from '../../../../backend/server/src/reminders/reminder-service.js';
import { makeReminderHandlers } from '../../../../backend/server/src/reminders/reminder-rpc-handler.js';

/** Real task/contact/project handlers over SQLite; faults are injected at the
 * transport boundary. Related record labels deliberately contain markup. */
export const installTaskReaderFixture = async (page: Page, options: { sourceRecords?: WorkEntityCrudRpcDeps['sourceRecords']; reminders?: boolean } = {}) => {
  const now = Date.parse('2026-10-31T18:00:00Z'); await page.clock.setFixedTime(new Date(now));
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), contacts = createContactStore(db), bus = createWarehouseEventBus();
  const contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <img src=x>' })).contact;
  if (!person.contact_id) throw new Error('Contact has no canonical identity.');
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  const writeProject = (at = now) => store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch <img src=x> project' }, at);
  writeProject();
  const body = 'Bring the launch agenda. <script>window.taskMarkupExecuted=true</script>\n\n'
    + Array.from({ length: 25 }, (_, i) => `Task context ${i + 1}. ${'Keep this entire note readable. '.repeat(5)}`).join('\n\n');
  store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Plan launch <img src=x>', body, done: false, priority: 'high',
    due_at: Date.parse('2026-11-01T08:30:12.345Z'), assigned_contact_id: person.contact_id, parent_project_id: 'project-one' }, now);
  store.writeTask({ id: 'task-two', source_id: 'recued.task', title: 'Other task', done: false, parent_project_id: 'project-one' }, now);
  const resolver = createWorkEntityResolver(store), dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers, contactDisplay: contacts, now: () => now, ...options })!.handlers;
  const client = { instance_id: 'task-reader-browser', client_kind: 'webclient' } as never;
  const reminderStore = options.reminders ? createReminderStore(db) : undefined;
  const reminderHandlers = reminderStore ? makeReminderHandlers({ dispatchers: createReminderDispatchers({
    store: reminderStore, readRecord: (kind, id) => store.readByKind(kind, id), timeZone: () => 'America/Los_Angeles',
    now: () => now, quietHours: defaultQuietHoursPolicy,
  }) })!.handlers : undefined;
  const reminderRequests: Array<Record<string, unknown>> = [];
  const reminderWrites: Array<{ method: string; args: Record<string, unknown> }> = [];
  let lostReminderUpdate = false, lostReminderCancel = false, failReminderPages = false, reminderSeed = 0;
  let loseReminderReply = false, reminderLinks = true, reminderRecordFiltering = true;
  const reads: Array<{ method: string; id: string }> = [], writes: Array<{ method: string; args: Record<string, unknown> }> = [];
  const queries: Array<{ method: string; args: Record<string, unknown> }> = [];
  const failed = new Set<string>(), held = new Set<string>(), heldAll = new Set<string>(), releases = new Map<string, Set<() => void>>();
  const release = () => {
    heldAll.clear();
    for (const callbacks of releases.values()) for (const done of callbacks) done();
    releases.clear();
  };
  let reply: 'confirmed' | 'lost' | 'pending' = 'confirmed';
  let attentionPatch: Partial<WorkEntityProjectAttentionRpcResponse> | undefined;
  let pendingTask: Task['pending_write'];
  const contactReplies = new Map<string, ContactRecord | null>();
  const taskReplies = new Map<string, Partial<WorkEntityGetRpcResponse>>();
  let fixtureCaller: ((method: string, args: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  const rpc = async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}, id = String(args.id ?? args.reminder_id ?? args.email ?? (method === 'work_entity.project.attention' ? args.project_id : '') ?? ''), key = `${method}:${id}`;
    try {
      if (['work_entity.get', 'contact.get', 'work_entity.source.list'].includes(method)) reads.push({ method, id });
      if (['work_entity.get', 'work_entity.list', 'work_entity.search', 'work_entity.linked_from', 'work_entity.project.attention'].includes(method)) queries.push({ method, args: structuredClone(args) });
      if (held.delete(key) || heldAll.has(key)) await new Promise<void>(done => {
        const callbacks = releases.get(key) ?? new Set<() => void>(); callbacks.add(done); releases.set(key, callbacks);
      });
      if (failed.has(key)) throw new Error('This read was interrupted.');
      if (['work_entity.upsert', 'work_entity.task.mark_done', 'contact.upsert'].includes(method)) writes.push({ method, args: structuredClone(args) });
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (options.reminders && method === 'server.timezone.get') return { result: { resolved_zone: 'America/Los_Angeles' } };
      if (method === 'contact.get') return { result: contactReplies.has(id) ? { contact: contactReplies.get(id)! } : await handleContactGet(contactDeps, args as { email: string }) };
      if (method === 'contact.list' || method === 'contact.search.local') return { result: await handleContactList(contactDeps, args) };
      if (method === 'contact.resolve') return { result: await handleContactResolve(contactDeps, args) };
      if (reminderHandlers && Object.hasOwn(reminderHandlers, method)) {
        if (method === 'reminder.list' && failReminderPages && (args.page as { cursor?: unknown } | undefined)?.cursor)
          throw new Error('A later reminder page was interrupted.');
        if (method === 'reminder.create') reminderRequests.push(structuredClone(args));
        if (method === 'reminder.update' || method === 'reminder.cancel') reminderWrites.push({ method, args: structuredClone(args) });
        const handle = reminderHandlers[method as keyof typeof reminderHandlers] as (args: never, client: never) => Promise<unknown>;
        const result = await handle(args as never, client);
        if (method === 'reminder.create' && loseReminderReply) { loseReminderReply = false; throw new Error('Reminder reply was lost.'); }
        if (method === 'reminder.update' && lostReminderUpdate) { lostReminderUpdate = false; throw new Error('The move reply was lost.'); }
        if (method === 'reminder.cancel' && lostReminderCancel) { lostReminderCancel = false; throw new Error('The cancellation reply was lost.'); }
        if (method === 'reminder.list' && !reminderRecordFiltering) {
          const out = result as import('@recued/contracts').ReminderListResult;
          return { result: { ...out, page: out.page ? { ...out.page, record_ref: undefined } : undefined } };
        }
        if (method === 'reminder.list' && !reminderLinks) return { result: { ...(result as object), record_links_supported: undefined } };
        return { result };
      }
      if (fixtureCaller) { const value = await fixtureCaller(method, args); if (value !== undefined) return value; }
      if (method === 'collection.listInstances') return { result: { instances: [] } };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      const result = await handler(args as never, client);
      if (method === 'work_entity.project.attention' && attentionPatch) return { result: { ...(result as WorkEntityProjectAttentionRpcResponse), ...attentionPatch } };
      if (method === 'work_entity.get' && args.kind === 'task' && taskReplies.has(id)) {
        return { result: { ...(result as WorkEntityGetRpcResponse), ...taskReplies.get(id) } };
      }
      if (method === 'work_entity.get' && args.kind === 'task' && args.id === 'task-one' && pendingTask) {
        const value = result as WorkEntityGetRpcResponse;
        return { result: { ...value, entity: { ...value.entity, pending_write: pendingTask } } };
      }
      if (method === 'work_entity.upsert' && reply === 'lost') throw new Error('The save reply was lost.');
      if (method === 'work_entity.upsert' && reply === 'pending') {
        const value = result as WorkEntityGetRpcResponse;
        return { result: { ...value, entity: { ...value.entity, pending_write: { staged_at: now, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } } } };
      }
      return { result };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  };
  await page.exposeFunction('__taskReaderRpc', rpc);
  await page.addInitScript(() => {
    const settled: string[] = [];
    Object.assign(window, { __taskReaderSettled: settled, __connectionsFixture: async (method: string, args: unknown) => {
      const reply = await (window as unknown as { __taskReaderRpc(method: string, args: unknown): Promise<unknown> }).__taskReaderRpc(method, args);
      settled.push(`${method}:${String((args as { id?: string; email?: string })?.id ?? (args as { email?: string })?.email ?? '')}`);
      return reply;
    } });
  });
  return { rpc, person, reads, writes, queries, reminderRequests, reminderWrites,
    loseReminderUpdate: () => { lostReminderUpdate = true; },
    loseReminderCancel: () => { lostReminderCancel = true; },
    failReminderPages: (fail: boolean) => { failReminderPages = fail; },
    seedReminder: (input: { text: string; at: number; managed?: boolean; state?: ReminderState; record_ref?: ReminderRecordReference }) => {
      const params = { text: input.text, at: input.at, time_zone: 'America/Los_Angeles', origin: {}, ...(input.record_ref ? { record_ref: input.record_ref } : {}) };
      const row = input.managed ? reminderStore!.ensureClock({ ...params,
        clock: { occurrence_id: 'today-clock-' + ++reminderSeed, point_key: 'p', ask_id: 'a-' + reminderSeed } }, now) : reminderStore!.create(params, now);
      if (input.state === 'delivered') reminderStore!.markDelivered(row.reminder_id, now, ['in_app']);
      if (input.state === 'cancelled') reminderStore!.cancel(row.reminder_id, now);
      return row.reminder_id;
    },
    reminders: () => reminderStore!.listPending(500),
    reminder: (id: string) => reminderStore!.get(id),
    cancelReminder: (id: string) => reminderStore!.cancel(id, now),
    deliverReminder: (id: string) => reminderStore!.markDelivered(id, now, ['in_app']),
    loseReminderReply: () => { loseReminderReply = true; },
    reminderLinks: (supported: boolean) => { reminderLinks = supported; },
    reminderRecordFiltering: (supported: boolean) => { reminderRecordFiltering = supported; },
    fixtureCaller: (caller: NonNullable<typeof fixtureCaller>) => { fixtureCaller = caller; }, task: (id = 'task-one') => store.readTask(id)!,
    note: (id = 'note-one') => store.readNote(id)!, tasks: () => store.listTasks(), notes: () => store.listNotes(),
    mergeContacts: (emails: string[], survivor: string) => contacts.setMergedInto(emails.map(email => contacts.get(email)!), survivor, now + 2000),
    splitContact: (email: string) => contacts.setMergedInto([contacts.get(email)!], null, now + 3000),
    addEmailAlias: (contactId: string, email: string) => contacts.upsertContactAlias({ contact_id: contactId, kind: 'email_alias', alias_pattern: email, source: 'manual' }, now),
    removeEmailAlias: (id: string) => contacts.deleteContactAlias(id),
    contactReply: (id: string, value?: ContactRecord | null) => { if (value === undefined) contactReplies.delete(id); else contactReplies.set(id, value); },
    seedContact: async (email: string, name: string) => (await handleContactUpsert(contactDeps, { email, name })).contact,
    attentionReply: (patch?: Partial<WorkEntityProjectAttentionRpcResponse>) => { attentionPatch = patch; },
    project: (id = 'project-one') => store.readProject(id)!,
    seedProject: (id: string, patch: Partial<Project> = {}, at = now) => store.writeProject({ id, source_id: 'recued.project', title: id, ...patch }, at),
    updateProject: (id: string, patch: Partial<Project>) => store.writeProject({ ...store.readProject(id)!, ...patch }, now + 1000),
    booking: (id = 'booking-one') => store.readBooking(id)!,
    seedBooking: (id: string, patch: Partial<Booking> = {}, at = now) => store.writeBooking({ id, source_id: 'recued.booking', title: 'Consultation <team>',
      lifecycle_state: 'confirmed', counterparty_contact_id: person.contact_id, slot_start_at: Date.parse('2026-11-21T19:30:00Z'),
      slot_end_at: Date.parse('2026-11-21T20:30:00Z'), ...patch }, at),
    updateBooking: (id: string, patch: Partial<Booking>) => store.writeBooking({ ...store.readBooking(id)!, ...patch }, now + 1000),
    removeBooking: (id: string) => store.deleteBooking(id, { tombstone: false }),
    commitment: (id = 'promise-one') => store.readCommitment(id)!,
    seedCommitment: (id: string, patch: Partial<Commitment> = {}, at = now) => store.writeCommitment({ id, source_id: 'recued.commitment',
      statement: 'Send the revised proposal', direction: 'outbound', derivation: 'user_declared', promised_at: now,
      promised_for_at: Date.parse('2026-11-01T00:00:00Z'), counterparty_contact_id: person.contact_id, ...patch }, at),
    updateCommitment: (id: string, patch: Partial<Commitment>) => store.writeCommitment({ ...store.readCommitment(id)!, ...patch }, now + 1000),
    removeCommitment: (id: string) => store.deleteCommitment(id, { tombstone: false }),
    seedNote: (id: string, patch: Partial<Note> = {}) => store.writeNote({ id, source_id: 'recued.note', body: '', ...patch }, now),
    updateNote: (id: string, patch: Partial<Note>) => store.writeNote({ ...store.readNote(id)!, ...patch }, now + 1000),
    removeNote: (id: string) => store.deleteNote(id, { tombstone: false }),
    registerSource: (id: string, kind: 'task' | 'note' | 'commitment' | 'booking', writable = true) => store.registerSource({ id, top_tier_kind: kind, source_kind: 'builtin', source_label: `Other ${kind}s`, write_capable: writable, registered_at: now }),
    updateTask: (id: string, patch: Partial<Task>) => store.writeTask({ ...store.readTask(id)!, ...patch }, now + 1000),
    seedTask: (id: string, patch: Partial<Task> = {}, at = now) => store.writeTask({ id, source_id: 'recued.task', title: id, done: false, ...patch }, at),
    removeTask: (id: string) => store.deleteTask(id, { tombstone: false }),
    taskReply: (id: string, value?: Partial<WorkEntityGetRpcResponse>) => { if (value) taskReplies.set(id, value); else taskReplies.delete(id); },
    update: (patch: Partial<Task>) => { if ('pending_write' in patch) pendingTask = patch.pending_write; return store.writeTask({ ...store.readTask('task-one')!, ...patch }, now + 1000); },
    writable(value: boolean) { store.registerSource({ ...store.listSources().find(source => source.id === 'recued.task')!, write_capable: value }); },
    fail: (method: string, id: string, value = true) => { if (value) failed.add(`${method}:${id}`); else failed.delete(`${method}:${id}`); },
    hold: (method: string, id: string) => held.add(`${method}:${id}`), waiting: () => releases.size > 0,
    holdAll: (method: string, id: string) => heldAll.add(`${method}:${id}`),
    release,
    reply: (value: typeof reply) => { reply = value; },
    removeProject: () => store.deleteProject('project-one', { tombstone: false }),
    restoreProject: (incarnation = 1) => writeProject(now + 5000 * incarnation),
    replaceTask() { store.deleteTask('task-one', { tombstone: false }); store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Reused task identity', done: false }, now + 5000); },
    dispose() { release(); bus.dispose(); db.close(); } };
};
