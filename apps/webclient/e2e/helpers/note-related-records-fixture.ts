import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** The browser uses real contact and work-entity handlers over SQLite. Timing
 * and per-record read failures are injected only at the transport boundary. */
export const installNoteRelatedFixture = async (page: Page, includeMissing = false) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), contacts = createContactStore(db), bus = createWarehouseEventBus();
  const now = Date.parse('2026-11-15T12:00:00Z'), contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <img src=x>' })).contact;
  if (includeMissing) await handleContactUpsert(contactDeps, { email: 'failed@example.test', name: 'Recovered contact' });
  if (!person.contact_id) throw new Error('Native contact has no identity');
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  const resolver = createWorkEntityResolver(store), dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers })!.handlers;
  store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch <img src=x> project' }, now);
  store.writeProject({ id: 'project-two', source_id: 'recued.project', title: 'Second project' }, now);
  if (includeMissing) store.writeProject({ id: 'failed-project', source_id: 'recued.project', title: 'Recovered project' }, now);
  const body = Array.from({ length: 30 }, (_, index) => `## Section ${index + 1}\n\nMarker café ${index + 1}. ${'Long note context. '.repeat(12)}\n\n`).join('');
  store.writeNote({ id: 'note-one', source_id: 'recued.note', title: 'Linked note', body,
    related_contact_ids: [person.contact_id, ...(includeMissing ? ['missing@example.test', 'failed@example.test'] : [])],
    related_project_ids: ['project-one', 'project-two', ...(includeMissing ? ['missing-project', 'failed-project'] : [])] }, now);
  store.writeNote({ id: 'note-other', source_id: 'recued.note', title: 'Other note', body: 'A different note.', related_project_ids: ['project-two'] }, now);
  const original = store.readNote('note-one')!;
  const reads: Array<{ method: string; id: string }> = [], writes: Array<{ method: string; args: unknown }> = [];
  const failed = new Set<string>();
  type Hold = { method: string; id: string; started: boolean; release?: () => void };
  const holds: Hold[] = [];
  const client = { instance_id: 'note-related-browser', client_kind: 'webclient' } as never;
  await page.exposeFunction('__noteRelatedRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {}, id = String(args.id ?? args.email ?? '');
    if (method === 'work_entity.get' || method === 'contact.get') reads.push({ method, id });
    try {
      const held = holds.find(item => item.method === method && item.id === id && !item.started);
      if (held) { held.started = true; await new Promise<void>(done => { held.release = done; }); }
      if (failed.has(`${method}:${id}`)) throw new Error('This read was interrupted.');
      if (['work_entity.upsert', 'work_entity.delete', 'work_entity.task.mark_done', 'contact.upsert', 'contact.delete'].includes(method)) writes.push({ method, args: structuredClone(args) });
      if (method === 'contact.get') return { result: await handleContactGet(contactDeps, args as { email: string }) };
      if (method === 'contact.list' || method === 'contact.search.local') return { result: await handleContactList(contactDeps, args) };
      if (method === 'contact.resolve') return { result: await handleContactResolve(contactDeps, args) };
      if (method === 'contact.upsert') return { result: await handleContactUpsert(contactDeps, args as { email: string }) };
      if (method === 'collection.mail.list') return { result: { instances: [{ slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test',
        send_capable: true, draft_capable: true, receive_capable: true, auth_state: 'healthy', caps: {} }] } };
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      const handler = handlers[method as keyof typeof handlers];
      return handler ? { result: await handler(args as never, client) } : undefined;
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __noteRelatedRpc(method: string, args: unknown): Promise<unknown> }).__noteRelatedRpc(method, args) }));
  return { reads, writes, original, person,
    readNote: () => store.readNote('note-one')!,
    fail: (method: string, id: string, value = true) => { if (value) failed.add(`${method}:${id}`); else failed.delete(`${method}:${id}`); },
    hold: (method: string, id: string) => { holds.push({ method, id, started: false }); },
    pending: () => holds.some(item => item.release !== undefined),
    release: () => { for (const held of holds) { const done = held.release; held.release = undefined; done?.(); } },
    deleteProject: (id: string) => store.deleteProject(id),
    replaceProject: () => { store.deleteProject('project-one', { tombstone: false }); store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Reused project id' }, now + 5000); },
    dispose() { for (const held of holds) held.release?.(); bus.dispose(); db.close(); } };
};
