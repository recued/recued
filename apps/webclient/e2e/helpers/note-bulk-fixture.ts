import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type WorkEntity, type ContactRecord } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactSearchLocal, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';

type Note = Extract<WorkEntity, { _kind: 'note' }>;
/** Native note/contact handlers and SQLite. Only transport timing, source
 * acknowledgements and failures are controlled by the browser fixture. */
export const installNoteBulkFixture = async (page: Page, options: { pageSize?: number; extraNotes?: number } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = Date.parse('2026-11-21T12:00:00Z');
  const contacts = createContactStore(db), contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <img src=x>' })).contact;
  const other = (await handleContactUpsert(contactDeps, { email: 'other@example.test', name: 'Other person' })).contact;
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'readonly.note', top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Read-only notes', write_capable: false });
  store.writeProject({ id: 'launch', source_id: 'recued.project', title: 'Launch project' }, now);
  store.writeProject({ id: 'target', source_id: 'recued.project', title: 'Target <img src=x> project' }, now);
  store.writeNote({ id: 'a', source_id: 'recued.note', title: 'Capture Alpha', body: 'Original α body\r\n\r\n> Source quotation\n',
    related_project_ids: ['launch'], related_contact_ids: [other.contact_id!], related_calendar_event_ids: ['event'], related_mail_thread_ids: ['thread'] }, now);
  store.writeNote({ id: 'b', source_id: 'recued.note', title: 'Capture Beta', body: 'Keep all context.', related_project_ids: ['launch'] }, now);
  store.writeNote({ id: 'readonly', source_id: 'readonly.note', title: 'Read-only note', body: 'Retain this text.' }, now);
  store.writeNote({ id: 'pending', source_id: 'recued.note', title: 'Pending source note', body: 'Awaiting source confirmation.' }, now);
  const pending = new Set(['pending']);
  for (let i = 0; i < (options.extraNotes ?? 0); i++) store.writeNote({ id: `extra-${i}`, source_id: 'recued.note', title: `Extra note ${i}`, body: 'More context' }, now);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers, contactDisplay: contacts })!.handlers;
  const writes: Array<Record<string, unknown>> = [], replies: Array<{ method: string; id: string }> = [];
  const failures = new Map<string, 'before' | 'lost' | 'pending' | 'unchanged'>();
  let failedList = false, revisions = true, failedSearch = false;
  const contactReplies = new Map<string, ContactRecord | null>();
  let hold: { method: string; id: string } | null = null, release: (() => void) | undefined;
  const client = { instance_id: 'note-bulk-browser', client_kind: 'webclient' } as never;
  const withPending = (entity: WorkEntity): WorkEntity => ({ ...entity, pending_write: { staged_at: now + 1000, operation: 'update', dirty_fields: ['body'], state: 'awaiting_verify' } });
  await page.exposeFunction('__noteBulkRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}, id = String(args.id ?? args.email ?? '');
    try {
      if (hold && ['work_entity.get', 'contact.get'].includes(method) && hold.method === method && hold.id === id) {
        hold = null; await new Promise<void>(done => { release = done; });
      }
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'contact.get') return { result: contactReplies.has(id) ? { contact: contactReplies.get(id)! } : await handleContactGet(contactDeps, args as { email: string }) };
      if (method === 'contact.list' || method === 'contact.search.local') {
        if (failedSearch) throw new Error('Contact search interrupted.');
        return { result: method === 'contact.search.local' ? await handleContactSearchLocal(contactDeps, args as unknown as Parameters<typeof handleContactSearchLocal>[1]) : await handleContactList(contactDeps, args) };
      }
      if (method === 'contact.resolve') return { result: await handleContactResolve(contactDeps, args) };
      if (method === 'work_entity.search' && failedSearch) throw new Error('Project search interrupted.');
      if (method === 'work_entity.list' && failedList) { failedList = false; throw new Error('The note list refresh was interrupted.'); }
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      const mutation = method === 'work_entity.upsert' && args.kind === 'note';
      if (mutation) writes.push(structuredClone(args));
      const failure = mutation ? failures.get(id) : undefined; if (mutation) failures.delete(id);
      if (failure === 'before') throw new Error('This note save was interrupted.');
      let result: { entity?: WorkEntity | null; entities?: WorkEntity[]; note_edit_revision?: string } = failure === 'unchanged' ? await handlers['work_entity.get']({ kind: 'note', id }, client)
        : await handler((method === 'work_entity.list' && args.kind === 'note' && options.pageSize ? { ...args, limit: options.pageSize } : args) as never, client) as { entity?: WorkEntity | null; entities?: WorkEntity[]; note_edit_revision?: string };
      if (failure === 'pending') pending.add(id);
      if (mutation && hold?.method === method && hold.id === id) { hold = null; await new Promise<void>(done => { release = done; }); }
      if (failure === 'lost') throw new Error('The note change reply was lost.');
      if (result.entity && pending.has(id)) result = { ...result, entity: withPending(result.entity) };
      if (result.entities) result = { ...result, entities: result.entities.map(n => pending.has(n.id) ? withPending(n) : n) };
      if (!revisions) delete result.note_edit_revision;
      replies.push({ method, id }); return { result };
    } catch (cause) { return { error: { code: String((cause as { code?: string }).code ?? 'unavailable'), message: cause instanceof Error ? cause.message : String(cause) } }; }
  });
  await page.addInitScript(() => {
    const state = { settled: [] as string[] };
    Object.assign(window, { __noteBulkTransport: state, __connectionsFixture: async (method: string, args: unknown) => {
      const result = await (window as unknown as { __noteBulkRpc(m: string, a: unknown): Promise<unknown> }).__noteBulkRpc(method, args);
      state.settled.push(`${method}:${String((args as { id?: string } | undefined)?.id ?? '')}`); return result;
    } });
  });
  return { writes, replies, person, other, read: (id: string) => store.readNote(id)!,
    change: (id: string, patch: Partial<Note>) => store.writeNote({ ...store.readNote(id)!, ...patch }, now + 2000),
    replace: (id: string) => { const old = store.readNote(id)!; store.deleteNote(id, { tombstone: false }); store.writeNote({ id, source_id: old.source_id, title: old.title, body: 'Replacement note' }, now + 5000); },
    replaceProject: () => { store.deleteProject('target', { tombstone: false }); store.writeProject({ id: 'target', source_id: 'recued.project', title: 'Target replacement' }, now + 5000); },
    contactReply: (id: string, value: ContactRecord | null) => { contactReplies.set(id, value); },
    failSearch: (value: boolean) => { failedSearch = value; }, failNextList: () => { failedList = true; },
    revisions: (value: boolean) => { revisions = value; },
    fail: (id: string, kind: 'before' | 'lost' | 'pending' | 'unchanged') => { failures.set(id, kind); },
    confirm: (id: string) => { pending.delete(id); },
    hold: (method: string, id: string) => { hold = { method, id }; }, waiting: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    readonly: (value: boolean) => store.registerSource({ id: 'recued.note', top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Recued', write_capable: !value }),
    dispose() { release?.(); bus.dispose(); db.close(); },
  };
};
