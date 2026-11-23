import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type WorkEntityUpsertRpcRequest, type WorkEntity } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

export const NOTE_BODY = '\n  # Café 🧾\n\n- Keep **Markdown**\n<img src=x onerror="throw Error(\'unsafe\')">\nTrailing spaces  \n';
export type DuplicateKind = 'task' | 'note';
/** Real SQLite and owner CRUD. Only transport delay, lost/malformed replies and
 * Source permission changes are simulated. */
export const installWorkEntityDuplicateFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = Date.parse('2026-11-15T12:00:00Z');
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers })!.handlers;
  store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch project' }, now);
  const seedTask = { id: 'task-original', source_id: 'recued.task', title: 'Original task', body: 'Reusable task notes', done: true,
    due_at: now - 86400000, completed_at: now - 1000, priority: 'high' as const, assigned_contact_id: 'person@example.test',
    parent_calendar_event_id: 'event-one', linked_mail_thread_id: 'thread-one', parent_project_id: 'project-one', blocks_task_ids: ['task-blocked'] };
  store.writeTask(seedTask, now);
  store.writeTask({ id: 'task-other', source_id: 'recued.task', title: 'Other task', done: false }, now);
  const seedNote = { id: 'note-original', source_id: 'recued.note', title: 'Original note', body: NOTE_BODY,
    related_contact_ids: ['person@example.test'], related_calendar_event_ids: ['event-one'], related_mail_thread_ids: ['thread-one'], related_project_ids: ['project-one'] };
  store.writeNote(seedNote, now);
  const writes: WorkEntityUpsertRpcRequest[] = [];
  const read = (kind: DuplicateKind) => kind === 'task' ? store.readTask('task-original')! : store.readNote('note-original')!;
  const originals = { task: structuredClone(read('task')), note: structuredClone(read('note')) };
  let hold: string | null = null, release: (() => void) | undefined;
  let failure: string | null = null;
  let reply: 'normal' | 'lost' | 'original' | 'pending' = 'normal';
  const client = { instance_id: 'duplicate-browser', client_kind: 'webclient' } as never;
  await page.exposeFunction('__duplicateRpc', async (method: string, raw: never) => {
    try {
      if (failure === method) throw new Error('The source read was interrupted.');
      if (hold === method) { hold = null; await new Promise<void>(done => { release = done; }); }
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'contact.list' || method === 'contact.search.local') return { result: { contacts: [{ _id: 'person@example.test', _collection: 'contact',
        email: 'person@example.test', name: 'Person', first_seen: now, last_interaction: now, interaction_count: 0, source: 'manual', created_at: now, updated_at: now }], total: 1 } };
      const handler = handlers[method as keyof typeof handlers];
      if (!handler) return undefined;
      if (method === 'work_entity.upsert') {
        const args = raw as WorkEntityUpsertRpcRequest; writes.push(structuredClone(args));
        const result = await handler(raw, client) as { entity: WorkEntity };
        if (reply === 'lost') throw new Error('The save reply was lost.');
        if (reply === 'original') return { result: { entity: read(args.kind as DuplicateKind) } };
        if (reply === 'pending') return { result: { entity: { ...result.entity,
          pending_write: { staged_at: now, operation: 'create', dirty_fields: ['title'], state: 'awaiting_verify' } } } };
        return { result };
      }
      return { result: await handler(raw, client) };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __duplicateRpc(method: string, args: unknown): Promise<unknown> }).__duplicateRpc(method, args) }));
  return { originals, writes, read,
    externalNote: () => {
      store.registerSource({ id: 'archive.note', top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Archive', write_capable: false });
      store.writeNote({ ...seedNote, source_id: 'archive.note', source_record_id: 'native-note' }, now);
      originals.note = structuredClone(read('note'));
    },
    addDestination: (id: string, readThrough = false) => store.registerSource({ id, top_tier_kind: 'note', source_kind: 'builtin',
      source_label: id, write_capable: true, ...(readThrough ? { sync_posture: 'read_through' as const } : {}) }),
    created: (kind: DuplicateKind) => (kind === 'task' ? store.listTasks() : store.listNotes()).filter(row => row.id !== `${kind}-original` && row.id !== 'task-other'),
    latestTaskTitle: (title: string) => store.writeTask({ ...seedTask, title }, now + 500),
    readonly: (kind: DuplicateKind) => { store.registerSource({ id: `recued.${kind}`, top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued', write_capable: false }); },
    hold: (method: string) => { hold = method; }, pending: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    fail: (method: string | null) => { failure = method; }, reply: (value: typeof reply) => { reply = value; },
    dispose() { release?.(); bus.dispose(); db.close(); } };
};
