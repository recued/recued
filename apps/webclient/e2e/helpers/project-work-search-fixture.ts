import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type ProjectWorkKind, type WorkEntityProjectItemsRpcRequest, type WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Real owner handlers, resolver and SQLite. Only transport timing, failures
 * and an older server's lack of query support are simulated. */
export const installProjectWorkSearchFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = Date.parse('2026-11-15T12:00:00Z');
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1 });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers })!.handlers;
  store.writeProject({ id: 'launch', source_id: 'recued.project', title: 'Kestrel launch', description: 'Prepare the customer release.' }, now);
  store.writeProject({ id: 'other', source_id: 'recued.project', title: 'Other project' }, now);
  const phrase = 'ÉCOLE_100%', long = 'Earlier context. '.repeat(40) + `${phrase} <img src=x onerror="throw Error('unsafe')"> release decision. ` + 'Later context. '.repeat(25);
  const statement = 'Earlier context. '.repeat(15) + `${phrase} <img src=x onerror="throw Error('unsafe')"> release decision. ` + 'Later context. '.repeat(5);
  for (let index = 0; index < 35; index++) {
    const id = String(index).padStart(2, '0'), body = index >= 10 ? long : 'Unrelated content.';
    store.writeTask({ id: `task-${id}`, source_id: 'recued.task', title: `Launch task ${id}`, body, done: index >= 30, parent_project_id: 'launch' }, now + index);
    store.writeNote({ id: `note-${id}`, source_id: 'recued.note', title: `Launch note ${id}`, body, related_project_ids: ['launch', 'launch'] }, now + index);
    store.writeCommitment({ id: `promise-${id}`, source_id: 'recued.commitment', statement: index >= 10 ? statement : body, direction: 'inbound', derivation: 'user_declared',
      blocks_project_ids: ['launch'], lifecycle_state: index >= 30 ? 'fulfilled' : 'pending' }, now + index);
  }
  store.writeNote({ source_id: 'recued.note', title: 'Unlinked matching note', body: long, related_project_ids: ['other'] }, now + 100);
  store.writeTask({ source_id: 'recued.task', title: 'Other matching task', body: long, parent_project_id: 'other' }, now + 100);
  const reads: WorkEntityProjectItemsRpcRequest[] = [], writes: Array<{ method: string; args: unknown }> = [];
  let legacy = false, failed: { kind: ProjectWorkKind; offset?: number } | null = null;
  let hold: { kind: ProjectWorkKind; query: string } | null = null, release: (() => void) | undefined;
  const client = { instance_id: 'project-search-browser', client_kind: 'webclient' } as never;
  await page.exposeFunction('__projectWorkSearchRpc', async (method: string, raw: never) => {
    try {
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      const handler = handlers[method as keyof typeof handlers];
      if (!handler) return undefined;
      if (method === 'work_entity.upsert' || method === 'work_entity.task.mark_done') writes.push({ method, args: structuredClone(raw) });
      const args = raw as WorkEntityProjectItemsRpcRequest;
      if (method === 'work_entity.project.items') {
        reads.push(structuredClone(args));
        if (failed?.kind === args.kind && (failed.offset === undefined || failed.offset === (args.offset ?? 0)))
          return { error: { code: 'unavailable', message: `${args.kind} search was interrupted.` } };
        const result = await handler((legacy ? { ...args, query: undefined } : raw) as never, client) as WorkEntityProjectItemsRpcResponse;
        if (legacy) delete result.query;
        if (hold?.kind === args.kind && hold.query === args.query) { hold = null; await new Promise<void>(done => { release = done; }); }
        return { result };
      }
      return { result: await handler(raw, client) };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __projectWorkSearchRpc(method: string, args: unknown): Promise<unknown> }).__projectWorkSearchRpc(method, args) }));
  return { reads, writes, fail: (value: typeof failed) => { failed = value; }, legacy: (value: boolean) => { legacy = value; },
    hold: (kind: ProjectWorkKind, query: string) => { hold = { kind, query }; }, pending: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    dispose() { release?.(); bus.dispose(); db.close(); } };
};
