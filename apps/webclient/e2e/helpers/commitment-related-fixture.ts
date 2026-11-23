import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type Commitment } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactList, handleContactResolve, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Actual SQLite work/contact owners, with controlled ancillary reads and response order. */
export const installCommitmentRelatedFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), contacts = createContactStore(db), bus = createWarehouseEventBus();
  const now = Date.parse('2026-11-20T12:00:00Z'), contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <team>', company: 'Example Co', phone: '+14155550123' })).contact;
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch project', description: 'Keep the original launch scope.', state: 'active' }, now);
  store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Review the proposal', body: 'Keep these task notes.\n' + 'Saved context. '.repeat(100), done: false }, now);
  store.writeTask({ id: 'task-two', source_id: 'recued.task', title: 'Original review', done: true }, now);
  const seed = (id: string, patch: Partial<Commitment> = {}, at = now) => store.writeCommitment({ id, source_id: 'recued.commitment',
    statement: id === 'promise-one' ? 'Send the revised proposal' : 'Another promise', direction: 'outbound', promised_at: now,
    promised_for_at: now + 86_400_000, derivation: 'evidence_captured', counterparty_contact_id: person.contact_id,
    blocks_task_ids: ['task-one', 'task-two'], blocks_project_ids: ['project-one'], evidence_blob: [{ kind: 'message', vendor: 'slack',
      full_target_id: 'slack/message', actor_platform_id: 'riley', snippet: 'I will send the revised proposal.', sent_at: now - 1000, captured_at: now }], ...patch }, at);
  seed('promise-one'); seed('promise-two'); const original = store.readCommitment('promise-one')!;
  const resolver = createWorkEntityResolver(store), handlers = makeWorkEntityCrudHandlers({ store, resolver,
    dispatchers: createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 }), contactDisplay: contacts })!.handlers;
  const reads: Array<{ method: string; id: string; kind?: string }> = [], writes: Array<{ method: string; args: unknown }> = [];
  const failed = new Set<string>();
  const holds: Array<{ method: string; id: string; started: boolean; release?: () => void }> = [];
  const client = { instance_id: 'commitment-related-browser', client_kind: 'webclient' } as never;
  await page.exposeFunction('__commitmentRelatedRpc', async (method: string, raw: Record<string, unknown> = {}) => {
    const args = raw ?? {}, id = String(args.email ?? args.id ?? args.entity_id ?? '');
    reads.push({ method, id, ...(typeof args.kind === 'string' ? { kind: args.kind } : {}) });
    try {
      if (failed.has(`${method}:${id}`)) throw new Error('This read was interrupted.');
      let result: unknown;
      if (method === 'contact.get') result = await handleContactGet(contactDeps, args as { email: string });
      else if (method === 'contact.list' || method === 'contact.search.local') result = await handleContactList(contactDeps, args);
      else if (method === 'contact.resolve') result = await handleContactResolve(contactDeps, args);
      else if (method === 'contact.upsert') { writes.push({ method, args: structuredClone(args) }); result = await handleContactUpsert(contactDeps, args as { email: string }); }
      else if (method === 'work_entity.source.list') result = { sources: store.listSources() };
      else if (method === 'data.timeline') result = { entries: [] };
      else if (method === 'contact.contributions') result = { contributions: [] };
      else if (method === 'collection.mail.list') result = { instances: [{ slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test',
        send_capable: true, draft_capable: true, receive_capable: true, auth_state: 'healthy', caps: {} }] };
      else {
        const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
        if (['work_entity.upsert', 'work_entity.delete', 'work_entity.task.mark_done', 'work_entity.commitment.fulfill', 'work_entity.commitment.cancel'].includes(method)) writes.push({ method, args: structuredClone(args) });
        result = await handler(args as never, client);
      }
      const held = holds.find(item => item.method === method && item.id === id && !item.started);
      if (held) { held.started = true; await new Promise<void>(done => { held.release = done; }); }
      return { result };
    } catch (error) { return { error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => {
    const settled: Record<string, number> = {};
    Object.assign(window, { __commitmentRelatedSettled: settled, __connectionsFixture: async (method: string, args: unknown) => {
      const reply = await (window as unknown as { __commitmentRelatedRpc(method: string, args: unknown): Promise<unknown> }).__commitmentRelatedRpc(method, args);
      const input = (args ?? {}) as { email?: string; id?: string; entity_id?: string }, key = `${method}:${input.email ?? input.id ?? input.entity_id ?? ''}`;
      settled[key] = (settled[key] ?? 0) + 1; return reply;
    } });
  });
  return { person, original, reads, writes, saved: () => store.readCommitment('promise-one'),
    seedProject: (id: string) => store.writeProject({ id, source_id: 'recued.project', title: 'Another project' }, now),
    patch: (patch: Partial<Commitment>) => store.writeCommitment({ ...store.readCommitment('promise-one')!, ...patch }, now + 2000),
    fail: (method: string, id: string, value = true) => { if (value) failed.add(`${method}:${id}`); else failed.delete(`${method}:${id}`); },
    hold: (method: string, id: string) => { holds.push({ method, id, started: false }); }, pending: () => holds.some(item => item.release),
    release: () => { for (const item of holds) { const done = item.release; item.release = undefined; done?.(); } },
    renameTask: (title: string) => store.writeTask({ ...store.readTask('task-one')!, title }, now + 2000),
    deleteTask: () => store.deleteTask('task-one'),
    restoreTask: () => store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Recovered task', done: false }, now + 3000),
    replaceProject: () => { store.deleteProject('project-one', { tombstone: false }); store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'A different project' }, now + 5000); },
    replacePromise: () => { store.deleteCommitment('promise-one', { tombstone: false }); seed('promise-one', { statement: 'A different promise' }, now + 5000); },
    seedProjects: (count: number) => { const ids: string[] = []; for (let i = 0; i < count; i++) { const id = `paged-${i}`; store.writeProject({ id, source_id: 'recued.project', title: `Project ${i}` }, now); ids.push(id); }
      store.writeCommitment({ ...store.readCommitment('promise-one')!, blocks_project_ids: ids }, now + 2000); },
    dispose() { for (const item of holds) item.release?.(); bus.dispose(); db.close(); },
  };
};
