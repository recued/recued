/** D-188 — chat while the server is paused (the owner's ruling of 2026-11-08: the pause is a
 *  lockdown, "schedule/arm/trigger/manual all stopped", and chat with them).
 *
 *  No turn starts: the queue keeps what is sent and starts it after Resume. Every built-in
 *  tool call is refused before any gate or handler, a read as much as a write, and nothing is
 *  put to the owner (`registry-pause.ts`). */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext, InternalToolRegistry } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { handleSend } from '../chat-handler.js';
import { wrapRegistryWithPause } from '../registry-pause.js';
import { pausedCallRefusal } from '../raw-op-dispatch.js';

const selfSignature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const bareRegistry = (): InternalToolRegistry => ({
  list: () => [], listByTier: () => [], getByName: () => null,
  dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {},
});

describe('D-188 — no chat turn starts while paused', () => {
  it('keeps a message sent during the pause and runs it after Resume', async () => {
    const db = new Database(':memory:'); ensureChatSchema(db);
    cleanups.push(() => { if (db.open) db.close(); });
    const store = createChatStore(db);
    store.createSession({ id: 's' });
    const raw = createChatOrchestrator({ chatStore: store, registry: bareRegistry(), selfSignature });
    let paused = true;
    const started: string[] = [];
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async (input) => {
      started.push(input.message);
      return raw.runTurn(input);
    } }, { db, store, pollMs: 5, isPaused: () => paused });
    cleanups.push(() => orchestrator.turnQueue!.close());
    // The pump runs its rounds during the pause (recovery reports in); it only claims nothing.
    let rounds = 0;
    orchestrator.turnQueue!.whenRecovered(() => { rounds += 1; });

    const sent = await handleSend({ store, orchestrator, selfSignature },
      { session_id: 's', message: 'A', submission_id: 'a', picker_state: { current: 'self' } });
    expect(sent.disposition).toBe('accepted');
    await vi.waitFor(() => expect(rounds).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(started).toEqual([]);
    expect((await orchestrator.turnQueue!.snapshot('s')).turns.map((turn) => turn.status)).toEqual(['queued']);

    paused = false;
    await vi.waitFor(() => expect(started).toEqual(['A']));
    await vi.waitFor(async () =>
      expect((await orchestrator.turnQueue!.snapshot('s')).turns.map((turn) => turn.status)).toEqual(['completed']));
  });
});

describe('D-188 — every built-in tool call is refused while paused', () => {
  const ctx = { channel: 'chat' } as unknown as ChatDispatchContext;
  const setup = (paused: () => boolean) => {
    const dispatched: string[] = [];
    const checked: string[] = [];
    const inner: InternalToolRegistry = {
      ...bareRegistry(),
      getByName: (name) => (name === 'memory.search' ? ({ name } as never) : null),
      dispatch: async (name) => { dispatched.push(name); return { ok: true, result: { name } }; },
      checkBeforeAsking: async (name) => { checked.push(name); return null; },
    };
    const registry = wrapRegistryWithPause(inner, (name) => (paused() ? pausedCallRefusal(name) : undefined));
    return { registry, dispatched, checked };
  };

  it('refuses a read and a write before the handler, in the words a paused held write reads', async () => {
    const { registry, dispatched, checked } = setup(() => true);
    for (const name of ['memory.search', 'memory.write']) {
      expect(await registry.dispatch(name, {}, ctx)).toEqual({
        ok: false, reason: 'classification_blocked', detail: pausedCallRefusal(name),
      });
      expect(await registry.checkBeforeAsking!(name, {}, ctx)).toEqual({
        ok: false, reason: 'classification_blocked', detail: pausedCallRefusal(name),
      });
    }
    expect(dispatched).toEqual([]);
    expect(checked).toEqual([]);
    expect(pausedCallRefusal('memory.search')).toContain('server_paused');
  });

  it('passes every call through while the server runs, and keeps the rest of the registry', async () => {
    const { registry, dispatched, checked } = setup(() => false);
    expect(await registry.dispatch('memory.search', {}, ctx)).toEqual({ ok: true, result: { name: 'memory.search' } });
    expect(await registry.checkBeforeAsking!('memory.write', {}, ctx)).toBeNull();
    expect(dispatched).toEqual(['memory.search']);
    expect(checked).toEqual(['memory.write']);
    expect(registry.getByName('memory.search')).toEqual({ name: 'memory.search' });
  });

  it('asks nothing before a tool with no check of its own while the server runs', async () => {
    const registry = wrapRegistryWithPause(bareRegistry(), () => undefined);
    expect(await registry.checkBeforeAsking!('memory.write', {}, ctx)).toBeNull();
  });
});
