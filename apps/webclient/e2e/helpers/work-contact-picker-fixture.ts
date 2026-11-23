import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type ContactRecord, type WorkEntityUpsertRpcRequest } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactSearchLocal, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Real SQLite contact reads/search and work writes. Only transport failures,
 * unavailable records and read completion order are controlled. */
export const installWorkContactPickerFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), contacts = createContactStore(db), bus = createWarehouseEventBus();
  const now = Date.parse('2026-11-20T12:00:00Z'), contactDeps = { store: contacts, now: () => now };
  const first = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <img src=x>', company: 'Example <team>', phone: '+14155550123' })).contact;
  const second = (await handleContactUpsert(contactDeps, { email: 'riley.other@example.test', name: 'Riley <img src=x>' })).contact;
  const third = (await handleContactUpsert(contactDeps, { email: 'alex@example.test', name: 'Alex' })).contact;
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Review launch', body: 'Keep these notes.\n\n', done: false, assigned_contact_id: first.contact_id, priority: 'high' }, now);
  store.writeTask({ id: 'task-two', source_id: 'recued.task', title: 'Another task', done: false, assigned_contact_id: third.contact_id }, now);
  store.writeNote({ id: 'note-one', source_id: 'recued.note', title: 'Launch brief', body: 'Keep this note.', related_contact_ids: [first.contact_id!, second.email] }, now);
  store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch project', related_contact_ids: [first.contact_id!, second.email] }, now);
  store.writeCommitment({ id: 'commitment-one', source_id: 'recued.commitment', statement: 'Review the launch', direction: 'inbound', derivation: 'user_declared', counterparty_contact_id: first.contact_id }, now);
  const resolver = createWorkEntityResolver(store), dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers, contactDisplay: contacts })!.handlers;
  const client = { instance_id: 'contact-picker-browser', client_kind: 'webclient' } as never;
  const writes: WorkEntityUpsertRpcRequest[] = [], reads: string[] = [];
  const failed = new Set<string>(), held = new Set<string>(), replies = new Map<string, ContactRecord | null>(), releases = new Map<string, () => void>();
  let failedSearch = false, heldQuery: string | null = null;
  const hold = async (key: string) => { if (held.delete(key)) await new Promise<void>(done => releases.set(key, done)); };
  await page.exposeFunction('__workContactRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}, id = String(args.email ?? args.id ?? '');
    try {
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'data.timeline') { await hold('timeline:' + String(args.entity_id)); return { result: { entries: [] } }; }
      if (method === 'contact.get') {
        reads.push(id); if (failed.has(id)) throw new Error('Contact details interrupted.');
        const result = replies.has(id) ? { contact: replies.get(id)! } : await handleContactGet(contactDeps, { email: id });
        await hold(id); return { result };
      }
      if (method === 'contact.list') return { result: await handleContactList(contactDeps, args) };
      if (method === 'contact.search.local') {
        if (failedSearch) throw new Error('Contact search interrupted.');
        const result = await handleContactSearchLocal(contactDeps, args as unknown as Parameters<typeof handleContactSearchLocal>[1]);
        if (heldQuery === args.query) { heldQuery = null; await new Promise<void>(done => releases.set('search', done)); }
        return { result };
      }
      if (method === 'contact.resolve') return { result: await handleContactResolve(contactDeps, args) };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      if (method === 'work_entity.upsert') writes.push(structuredClone(args) as unknown as WorkEntityUpsertRpcRequest);
      return { result: await handler(args as never, client) };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => {
    const settled: Record<string, number> = {};
    Object.assign(window, { __workContactSettled: settled, __connectionsFixture: async (method: string, args: unknown) => {
      const result = await (window as unknown as { __workContactRpc(method: string, args: unknown): Promise<unknown> }).__workContactRpc(method, args);
      const input = (args ?? {}) as { id?: unknown; email?: unknown }, key = method + ':' + String(input.email ?? input.id ?? '');
      settled[key] = (settled[key] ?? 0) + 1;
      return result;
    } });
  });
  return { first, second, third, writes, reads,
    task: () => store.readTask('task-one')!, note: () => store.readNote('note-one')!, project: () => store.readProject('project-one')!, commitment: () => store.readCommitment('commitment-one')!,
    failName: (id: string, fail: boolean) => { if (fail) failed.add(id); else failed.delete(id); }, holdName: (id: string) => { held.add(id); },
    holdTimeline: (id: string) => held.add('timeline:' + id),
    reply: (id: string, contact?: ContactRecord | null) => { if (contact === undefined) replies.delete(id); else replies.set(id, contact); },
    waiting: (id: string) => releases.has(id), release: (id: string) => { const done = releases.get(id); releases.delete(id); done?.(); },
    failSearch: (value: boolean) => { failedSearch = value; }, holdSearch: (query: string) => { heldQuery = query; },
    seedContacts: async (count: number) => { for (let i = 0; i < count; i++) await handleContactUpsert(contactDeps, { email: `paged-${i}@example.test`, name: `Paged person ${i}` }); },
    renameContact: async (email: string, name: string) => { await handleContactUpsert(contactDeps, { email, name }); },
    legacyTask: () => store.writeTask({ ...store.readTask('task-one')!, assigned_contact_id: first.email }, now),
    merge: () => contacts.setMergedInto([contacts.get(first.email)!], second.email, now + 2000),
    alias: (email: string) => contacts.upsertContactAlias({ contact_id: third.contact_id!, kind: 'email_alias', alias_pattern: email, source: 'manual' }, now),
    dispose() { for (const done of releases.values()) done(); releases.clear(); bus.dispose(); db.close(); } };
};
