/** D-343 (the owner's day over Telegram, 2026-11-15) — the dispatch qualifies a bare id of a row
 *  on Recued's own Source so its approval says "changes your data in Recued", and `work.search`
 *  hands the model qualified ids. Chat's `work.update` passed that id raw to `work_entity.upsert`,
 *  which reads it as a local row id: the owner approved moving the plumber call to 5 pm, and the
 *  change failed "task 'we1:task:…' not found". It now resolves to the local row first.
 *
 *  Driven on the real store and dispatchers: which row an id names is the store's decision. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qualifyWorkEntityId, RECUED_BUILTIN_SOURCE_ID, type ExecutionSource } from '@recued/contracts';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
const NOW = Date.parse('2026-11-15T09:00:00Z');

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const source_id = RECUED_BUILTIN_SOURCE_ID('task');
  const task = store.writeTask({ id: 'task-plumber', source_id, title: 'Call the plumber', due_at: NOW - 9 * 3_600_000 }, NOW);
  const qualified = qualifyWorkEntityId({ kind: 'task', source_id, local_id: task.id });
  return { store, task, qualified, update: buildChatTier1Handlers(deps)['work.update']! };
};

describe('D-343 — chat work.update takes the qualified id of a local task', () => {
  it('moves its due time, as the owner approved', async () => {
    const f = harness();
    const at = Date.parse('2026-11-15T17:00:00Z');
    expect(f.qualified.startsWith('we1:task:')).toBe(true);
    expect(await f.update({ kind: 'task', id: f.qualified, due_at: at }, approved))
      .toMatchObject({ ok: true, result: { updated: true, id: f.qualified, fields: ['due_at'] } });
    expect(f.store.readTask(f.task.id)?.due_at).toBe(at);
  });

  it('ticks it off', async () => {
    const f = harness();
    expect(await f.update({ kind: 'task', id: f.qualified, done: true }, approved)).toMatchObject({ ok: true });
    expect(f.store.readTask(f.task.id)?.completed_at).toBe(NOW);
  });

  it('still refuses a qualified id that names no row here', async () => {
    const f = harness();
    const ghost = qualifyWorkEntityId({ kind: 'task', source_id: RECUED_BUILTIN_SOURCE_ID('task'), local_id: 'nope' });
    expect(await f.update({ kind: 'task', id: ghost, title: 'x' }, approved)).toMatchObject({ ok: false });
  });
});
