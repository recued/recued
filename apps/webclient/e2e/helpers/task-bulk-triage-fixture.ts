import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type ContactRecord, type WorkEntity } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactSearchLocal, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';

/** Real owner CRUD and lifecycle handlers over SQLite. Only lost replies,
 * pending Source receipts, interruptions and read timing are simulated. */
export const installTaskBulkTriageFixture = async (page: Page, options: { includeUndated?: boolean } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = Date.parse('2026-11-15T12:00:00Z');
  const contacts = createContactStore(db), contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'person@example.test', name: 'Riley' })).contact;
  const other = (await handleContactUpsert(contactDeps, { email: 'other@example.test', name: 'Riley' })).contact;
  const target = (await handleContactUpsert(contactDeps, { email: 'alex@example.test', name: 'Alex <img src=x>' })).contact;
  const contactReplies = new Map<string, ContactRecord | null>();
  const failedContactReads = new Set<string>(); let failedContactSearch = false;
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'readonly.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Read-only tasks', write_capable: false, registered_at: now });
  store.registerSource({ id: 'imported.project', top_tier_kind: 'project', source_kind: 'builtin', source_label: 'Imported projects', write_capable: false, registered_at: now });
  store.writeProject({ id: 'launch', source_id: 'recued.project', title: 'Launch project' }, now);
  store.writeProject({ id: 'release', source_id: 'recued.project', title: 'Customer release' }, now);
  store.writeProject({ id: 'imported-release', source_id: 'imported.project', title: 'Customer release' }, now);
  const original = { id: 'open-a', source_id: 'recued.task', title: 'Prepare launch', body: 'Keep the original context.',
    done: false, priority: 'low' as const, due_at: now + 86400000, assigned_contact_id: 'person@example.test',
    parent_project_id: 'launch', parent_calendar_event_id: 'event-one', linked_mail_thread_id: 'thread-one', blocks_task_ids: ['done-a'] };
  store.writeTask(original, now);
  store.writeTask({ id: 'open-b', source_id: 'recued.task', title: 'Review proposal', done: false, priority: 'medium', due_at: now + 4 * 86400000 }, now);
  if (options.includeUndated) store.writeTask({ id: 'undated', source_id: 'recued.task', title: 'Unscheduled follow-up', done: false }, now);
  store.writeTask({ id: 'done-a', source_id: 'recued.task', title: 'Finished review', done: true, completed_at: now - 1000, priority: 'low', due_at: now - 86400000 }, now);
  store.writeTask({ id: 'done-b', source_id: 'recued.task', title: 'Finished approval', done: true, completed_at: now - 2000, priority: 'high', due_at: now - 86400000 }, now);
  store.writeTask({ id: 'readonly', source_id: 'readonly.task', title: 'Read-only task', done: true }, now);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers, contactDisplay: contacts })!.handlers;
  const writes: Array<{ method: string; args: Record<string, unknown> }> = [];
  let hold: { method: string; id: string } | null = null, release: (() => void) | undefined;
  const failures = new Map<string, 'lost' | 'pending' | 'before' | 'unchanged'>(), pending = new Set<string>();
  const failedProjectReads = new Set<string>(); let failedProjectSearch = false;
  const client = { instance_id: 'task-triage-browser', client_kind: 'webclient' } as never;
  const pendingEntity = (entity: WorkEntity) => ({ ...entity, pending_write: { staged_at: now + 1000, operation: 'update', dirty_fields: ['priority', 'done', 'due_at', 'parent_project_id', 'assigned_contact_id'], state: 'awaiting_verify' } });
  await page.exposeFunction('__taskTriageRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}, id = String(args.id ?? args.email ?? '');
    try {
      if (method === 'work_entity.get' && args.kind === 'project' && failedProjectReads.has(id)) throw new Error('Project lookup interrupted.');
      if (method === 'work_entity.search' && args.kind === 'project' && failedProjectSearch) throw new Error('Project search interrupted.');
      if (hold && ['work_entity.get', 'contact.get'].includes(hold.method) && method === hold.method && id === hold.id) {
        hold = null; await new Promise<void>(done => { release = done; });
      }
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'contact.get') {
        if (failedContactReads.has(id)) throw new Error('Contact lookup interrupted.');
        return { result: contactReplies.has(id) ? { contact: contactReplies.get(id)! } : await handleContactGet(contactDeps, args as { email: string }) };
      }
      if (method === 'contact.list' || method === 'contact.search.local') {
        if (failedContactSearch) throw new Error('Contact search interrupted.');
        return { result: method === 'contact.search.local'
          ? await handleContactSearchLocal(contactDeps, args as unknown as Parameters<typeof handleContactSearchLocal>[1]) : await handleContactList(contactDeps, args) };
      }
      if (method === 'contact.resolve') return { result: await handleContactResolve(contactDeps, args) };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      const mutation = method === 'work_entity.upsert' || method === 'work_entity.task.mark_done';
      if (mutation) writes.push({ method, args: structuredClone(args) });
      const failure = mutation ? failures.get(id) : undefined;
      if (mutation) failures.delete(id);
      if (failure === 'before') throw new Error('The task change was interrupted.');
      if (failure === 'unchanged') return { result: await handlers['work_entity.get']({ kind: 'task', id }, client) };
      const result = await handler(args as never, client) as { entity?: WorkEntity | null };
      if (failure === 'pending') pending.add(id);
      if (hold && hold.method === method && hold.id === id) {
        hold = null; await new Promise<void>(done => { release = done; });
      }
      if (failure === 'lost') throw new Error('The task change reply was lost.');
      return { result: result.entity && pending.has(id) ? { ...result, entity: pendingEntity(result.entity) } : result };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __taskTriageRpc(method: string, args: unknown): Promise<unknown> }).__taskTriageRpc(method, args) }));
  return { writes, person, other, target, read: (id: string) => store.readTask(id)!,
    contactReply: (id: string, value?: ContactRecord | null) => { if (value === undefined) contactReplies.delete(id); else contactReplies.set(id, value); },
    failContactReads: (id: string, fail: boolean) => { if (fail) failedContactReads.add(id); else failedContactReads.delete(id); },
    failContactSearch: (fail: boolean) => { failedContactSearch = fail; },
    change: (id: string, patch: Partial<Pick<Extract<WorkEntity, { _kind: 'task' }>, 'due_at' | 'done' | 'parent_project_id' | 'assigned_contact_id'>>) =>
      store.writeTask({ ...store.readTask(id)!, ...patch }, now + 2000),
    replaceProject: (id: string) => { const old = store.readProject(id)!; store.deleteProject(id, { tombstone: false }); store.writeProject({ id, source_id: old.source_id, title: old.title }, now + 5000); },
    failProjectReads: (id: string, fail: boolean) => { if (fail) failedProjectReads.add(id); else failedProjectReads.delete(id); },
    failProjectSearch: (fail: boolean) => { failedProjectSearch = fail; },
    fail: (id: string, kind: 'lost' | 'pending' | 'before' | 'unchanged') => { failures.set(id, kind); },
    confirm: (id: string) => { pending.delete(id); },
    hold: (method: string, id: string) => { hold = { method, id }; }, waiting: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    readonly: (value: boolean) => store.registerSource({ id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Recued', write_capable: !value }),
    replace: (id: string) => { const old = store.readTask(id)!; store.deleteTask(id, { tombstone: false }); store.writeTask({ id, source_id: old.source_id, title: old.title, done: old.done }, now + 5000); },
    dispose() { release?.(); bus.dispose(); db.close(); } };
};
