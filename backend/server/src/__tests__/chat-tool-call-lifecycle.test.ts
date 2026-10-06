import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDispatchContext, ChatDispatchResult, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { bindChatToolCallRun, observeResumedChatToolCall, withChatToolCallContext } from '../chat-tool-call-context.js';
import { createChatRunSettledSink } from '../chat-run-settled-sink.js';
import {
  buildWaitedCallsContext, joinInFlightContexts, renderWaitedCallsContext, WAITED_CALLS_CONTEXT_LEAD,
} from '../chat-waited-calls-context.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatToolCallStore } from '../storage/chat-tool-call-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { handleExecutionActive, handleToolCallDismiss } from '../execution-control-handler.js';
import type { WsClient } from '../ws-server.js';

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const source = { channel: 'chat' as const, actor: 'user_self' as const,
  chat_session_id: 'session', turn_id: 'turn', user_id: 'owner' };
const scope = { row_eligibility: 'chat:owner_authenticated' as const, recall_contract_id: null, tool_session_id: 'session' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });

const storage = (path = ':memory:') => {
  const db = new Database(path);
  cleanup.push(() => { if (db.open) db.close(); });
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 'session', now: 1_000 });
  return { db, store };
};

const startInput = (id: string) => ({
  id, session_id: 'session', turn_id: 'turn', role: 'tool' as const,
  tool_name: 'recipe.run', content: 'recipe.run({"task":"private arguments"})',
  target_server: 'self' as const, picker_at_send: { display_name: 'self', signature },
  model_used: { provider: 'recued', model_id: 'tool-call' }, execution_source: source, ts: 1_000,
});

const orchestrator = (store: ReturnType<typeof createChatStore>,
  dispatch: (ctx: ChatDispatchContext) => Promise<ChatDispatchResult>,
  synthesize: () => Promise<void> = async () => {}, callCount = 1) => {
  const entry: ToolEntry = { name: 'mail.search', tier: 1, description: 'Fixture',
    arg_schema: { type: 'object' }, topic_tags: ['mail'], classification: 'read', concurrency_safe: true };
  const registry: InternalToolRegistry = {
    list: () => [entry], listByTier: tier => tier === 1 ? [entry] : [],
    getByName: name => name === entry.name ? entry : null,
    subscribeRefresh: () => () => {}, dispatch: (_name, _args, ctx) => dispatch(ctx),
  };
  let rounds = 0;
  return createChatOrchestrator({ chatStore: store, registry,
    broadcast: { emit: () => {} }, selfSignature: signature,
    executeAiCall: async () => {
      if (++rounds === 1) return { body: { response: '', events: [],
        tool_calls: Array.from({ length: callCount }, () => ({
          tool: 'mail.search', args: { query: 'private arguments' },
        })) } };
      await synthesize();
      return { body: { response: 'Finished.', events: [], tool_calls: [] } };
    },
  });
};
const turnInput = { session_id: 'session', message: 'Search mail', picker_state: { current: 'self' as const } };

describe('durable chat calls through the orchestrator', () => {
  it('records before dispatch, tracks the exact live run, and saves the result before synthesis', async () => {
    const { db, store } = storage();
    const entered = deferred(), release = deferred(), synthesizing = deferred(), finish = deferred();
    const live = new InFlightRegistry(new LaneSemaphore());
    const app = orchestrator(store, async ctx => {
      // This executes inside the real registry-dispatch boundary: the row
      // must already exist before an operation can start.
      const [record] = store.toolCalls!.list();
      expect(record).toMatchObject({ state: 'running', turn_id: ctx.turn_id });
      const onProgress = bindChatToolCallRun('run-real', 'long-recipe');
      live.registerRun({ run_id: 'run-real', recipe_id: 'long-recipe',
        source: ctx.execution_source!, session_id: 'chat:session', origin: 'attended',
        started_at: Date.now(), abort: vi.fn(), ...(onProgress ? { onProgress } : {}) });
      live.reportProgress('run-real', 'heartbeat');
      entered.resolve();
      await release.promise;
      live.completeRun('run-real');
      return { ok: true, run_id: 'run-real', result: { private_result: 'saved before synthesis' } };
    }, async () => { synthesizing.resolve(); await finish.promise; });
    const turn = app.runTurn(turnInput);
    try {
      await Promise.race([entered.promise, turn.then(() => { throw new Error('Dispatch was not reached'); })]);
      const [record] = store.toolCalls!.list();
      expect(record).toMatchObject({ run_id: 'run-real', recipe_id: 'long-recipe',
        last_signal_at: expect.any(Number) });
      expect(JSON.stringify(record)).not.toContain('private arguments');
      expect(db.prepare('SELECT role FROM chat_messages').all()).toHaveLength(2);
      const active = handleExecutionActive({ registry: live, toolCalls: store.toolCalls },
        { user_id: 'owner' } as WsClient, { session_id: 'chat:session' });
      expect(active.tool_calls?.[0]?.message_id).toBe(record!.message_id);
      release.resolve();
      await synthesizing.promise;
      const rows = await store.listMessages('session');
      expect(rows.map(row => row.role)).toEqual(['user', 'tool', 'tool']);
      expect(rows.find(row => row.tool_call)?.tool_call?.state).toBe('succeeded');
      expect(rows.at(-1)?.content).toContain('saved before synthesis');
      expect(store.toolCalls!.list()).toEqual([]);
      const resultId = `${record!.message_id}:result`;
      expect(await store.getRecallMessage!({ ...scope, item_id: resultId })).toBeNull();
      expect(await store.getRecallPair!({ ...scope, item_id: record!.message_id })).toEqual([]);
      finish.resolve();
      await turn;
      expect((await store.listMessages('session')).map(row => row.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
      expect(await store.getRecallMessage!({ ...scope, item_id: resultId })).not.toBeNull();
      expect(db.prepare('SELECT DISTINCT pair_id FROM chat_messages WHERE role = ?').all('tool'))
        .toEqual([{ pair_id: 'run-real' }]);
    } finally { release.resolve(); finish.resolve(); await turn; }
  });

  it('never dispatches when the early durable write fails', async () => {
    const { store } = storage();
    vi.spyOn(store.toolCalls!, 'start').mockRejectedValueOnce(new Error('disk unavailable'));
    const dispatch = vi.fn(async (): Promise<ChatDispatchResult> => ({ ok: true, result: {} }));
    await orchestrator(store, dispatch).runTurn(turnInput);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.toolCalls!.list()).toEqual([]);
  });

  it('closes a thrown tool failure without leaving a running record or duplicate result', async () => {
    const { db, store } = storage();
    await orchestrator(store, async () => {
      bindChatToolCallRun('failed-run', 'recipe');
      throw new Error('provider failed');
    }).runTurn(turnInput);
    const toolRows = (await store.listMessages('session')).filter(row => row.role === 'tool');
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0]?.tool_call?.state).toBe('failed');
    expect(toolRows[1]?.content).toContain('provider failed');
    expect(store.toolCalls!.list()).toEqual([]);
    expect(db.prepare('SELECT DISTINCT pair_id FROM chat_messages WHERE role = ?').all('tool'))
      .toEqual([{ pair_id: 'failed-run' }]);
  });

  it('retries a failed result write at turn-end without repeating the operation', async () => {
    const { store } = storage();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = vi.fn(async (): Promise<ChatDispatchResult> => {
      bindChatToolCallRun('completed-run', 'recipe');
      vi.spyOn(store, 'appendMessage').mockRejectedValueOnce(new Error('temporary write failure'));
      return { ok: true, result: { answer: 'completed once' } };
    });
    await orchestrator(store, dispatch, async () => {
      expect(store.toolCalls!.list()).toEqual([
        expect.objectContaining({ state: 'interrupted', run_id: 'completed-run' }),
      ]);
    }).runTurn(turnInput);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const rows = (await store.listMessages('session')).filter(row => row.role === 'tool');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tool_call?.state).toBe('succeeded');
    expect(rows[1]?.content).toContain('completed once');
    expect(store.toolCalls!.list()).toEqual([]);
    expect(await store.getRecallMessage!({ ...scope, item_id: rows[1]!.id })).not.toBeNull();
  });

  it('closes the recall source when result candidate finalization fails', async () => {
    const { db, store } = storage();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const finalize = store.finalizeMessageSource!;
    vi.spyOn(store, 'finalizeMessageSource').mockImplementation(input =>
      input.message_id.endsWith(':result')
        ? Promise.reject(new Error('candidate write failed')) : finalize(input));
    await orchestrator(store, async () => ({ ok: true, result: { answer: 'saved' } })).runTurn(turnInput);
    const rows = (await store.listMessages('session')).filter(row => row.role === 'tool');
    expect(rows[0]?.tool_call?.state).toBe('succeeded');
    expect(rows[1]?.content).toContain('saved');
    expect(await store.getRecallMessage!({ ...scope, item_id: rows[1]!.id })).toBeNull();
    expect(db.prepare('SELECT source_lifecycle FROM chat_messages WHERE message_id = ?')
      .get(rows[1]!.id)).toEqual({ source_lifecycle: 'failed' });
  });

  it('keeps concurrent failed calls separate even when a provider reuses its error', async () => {
    const { store } = storage();
    const error = new Error('shared provider failure');
    await orchestrator(store, async () => { throw error; }, async () => {}, 2).runTurn(turnInput);
    const rows = (await store.listMessages('session')).filter(row => row.role === 'tool');
    const calls = rows.filter(row => row.tool_call);
    expect(rows).toHaveLength(4);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.tool_call?.state).toBe('failed');
      const paired = await store.getRecallPair!({ ...scope, item_id: call.id });
      expect(paired).toHaveLength(1);
      expect(paired[0]?.item_id).toBe(`${call.id}:result`);
    }
  });
});

describe('restart recovery and lifecycle boundaries', () => {
  it('keeps a late outcome reviewable when the vault locks before its result can be saved', async () => {
    const { db } = storage();
    let key: Uint8Array | null = new Uint8Array(32).fill(18);
    const store = createChatStore(db, () => key);
    const old = createChatToolCallStore(db, store.appendMessage, 'old-process');
    await old.start(startInput('call-locked'));
    old.bind('call-locked', 'run-locked');
    old.hold('call-locked');
    key = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createChatRunSettledSink(store, signature, { emit: vi.fn() })({
      execution_source: source, run_id: 'run-locked', tool_name: 'recipe.run',
      result: { success: false, denied: true }, ts: Date.now(),
    });
    expect(store.toolCalls!.list()).toEqual([
      expect.objectContaining({ message_id: 'call-locked', state: 'interrupted' }),
    ]);
    expect(store.toolCalls!.dismiss('session', 'call-locked')).toBe(true);
  });

  it('keeps repeated holds pending and closes the call only with a terminal late result', async () => {
    const { store } = storage();
    const sink = createChatRunSettledSink(store, signature, { emit: vi.fn() });
    await store.toolCalls!.start(startInput('held-call'));
    store.toolCalls!.bind('held-call', 'held-run');
    store.toolCalls!.hold('held-call');
    const settle = (result: unknown) => sink({ execution_source: source,
      run_id: 'held-run', tool_name: 'recipe.run', result, ts: Date.now() });
    await settle({ success: false, awaiting_approval: true });
    await settle({ success: false, awaiting_peer: true });
    expect(await store.listMessages('session')).toHaveLength(1);
    expect(store.toolCalls!.list()[0]?.state).toBe('held');
    await settle({ success: true, answer: 'private late result' });
    expect(store.toolCalls!.list()).toEqual([]);
    const rows = await store.listMessages('session');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tool_call?.state).toBe('succeeded');
    expect(rows[1]?.content).toContain('private late result');
    expect(await store.getRecallPair!({ ...scope, item_id: 'held-call' })).toEqual([]);
  });

  it('records an authorized resume and its progress across another restart without dispatching work', async () => {
    const { db, store } = storage();
    const old = createChatToolCallStore(db, store.appendMessage, 'before-restart');
    await old.start(startInput('held-call'));
    old.bind('held-call', 'run-held');
    old.hold('held-call');
    expect(observeResumedChatToolCall(db, { ...source, chat_session_id: 'other' }, 'run-held')).toBeUndefined();
    const observer = observeResumedChatToolCall(db, source, 'run-held')!;
    expect(store.toolCalls!.get('held-call')?.state).toBe('running');
    expect(observer.progress(Date.now() + 1_000, false)).toBe(true);
    const nextProcess = createChatToolCallStore(db, store.appendMessage, 'after-second-restart');
    expect(nextProcess.list()[0]).toMatchObject({ state: 'interrupted', last_signal_at: expect.any(Number) });
    observer.hold();
    observer.interrupt();
    expect(nextProcess.list()[0]?.state).toBe('held');
    const resumed = observeResumedChatToolCall(db, source, 'run-held')!;
    resumed.interrupt();
    expect(store.toolCalls!.get('held-call')?.state).toBe('interrupted');
  });

  it('keeps payloads encrypted and exposes only lifecycle metadata while the vault is locked', async () => {
    const { db } = storage();
    let key: Uint8Array | null = new Uint8Array(32).fill(17);
    const store = createChatStore(db, () => key);
    await store.toolCalls!.start(startInput('encrypted-call'));
    const raw = db.prepare('SELECT content_encrypted, metadata_blob FROM chat_messages WHERE message_id = ?')
      .get('encrypted-call');
    expect(JSON.stringify(raw)).not.toContain('private arguments');
    expect((await store.listMessages('session'))[0]?.content).toContain('private arguments');
    key = null;
    const locked = createChatStore(db, () => key);
    expect(locked.toolCalls!.list()).toEqual([
      expect.objectContaining({ message_id: 'encrypted-call', state: 'running' }),
    ]);
    expect(JSON.stringify(locked.toolCalls!.list())).not.toMatch(/private arguments|process_id/);
  });

  it('reopens durable calls as interrupted, scopes them to their chat, and only dismisses by owner decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-tool-call-'));
    const path = join(dir, 'chat.sqlite');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = storage(path);
    const old = createChatToolCallStore(first.db, first.store.appendMessage, 'old-process');
    await old.start(startInput('call-1'));
    old.bind('call-1', 'run-1', 'recipe-1');
    old.progress('call-1', 'run-1', 2_000, false);
    first.db.close();
    const db = new Database(path);
    cleanup.push(() => db.close());
    ensureChatSchema(db);
    const reopened = createChatStore(db);
    const calls = createChatToolCallStore(db, reopened.appendMessage, 'new-process');
    const registry = new InFlightRegistry(new LaneSemaphore());
    const deps = { registry, toolCalls: calls };
    const owner = { user_id: 'owner' } as WsClient;
    expect(handleExecutionActive(deps, owner, {}).entries).toEqual([]);
    expect(calls.list()).toEqual([expect.objectContaining({ state: 'interrupted', last_signal_at: 2_000 })]);
    expect(calls.list('other-session')).toEqual([]);
    await expect(handleToolCallDismiss(deps, {} as WsClient,
      { session_id: 'session', message_id: 'call-1' })).rejects.toThrow(/paired/);
    expect(await handleToolCallDismiss(deps, owner,
      { session_id: 'other-session', message_id: 'call-1' })).toEqual({ dismissed: false });
    expect(await handleToolCallDismiss(deps, owner,
      { session_id: 'session', message_id: 'call-1' })).toEqual({ dismissed: true });
    expect(calls.list()).toEqual([]);
    expect(createChatToolCallStore(db, reopened.appendMessage, 'third-process').list()).toEqual([]);
    expect((await reopened.listMessages('session'))[0]?.content).toContain('private arguments');
    expect(registry.snapshot().entries).toEqual([]);
  });

  it('coalesces progress, rejects other runs and late signals, and atomically settles held pairs', async () => {
    const { db, store } = storage();
    const calls = store.toolCalls!;
    await calls.start(startInput('call'));
    calls.bind('call', 'run', 'recipe');
    expect(calls.progress('call', 'other', 2_000, false)).toBe(false);
    expect(calls.progress('call', 'run', 2_000, false)).toBe(true);
    expect(calls.progress('call', 'run', 2_200, false)).toBe(false);
    expect(calls.progress('call', 'run', 2_500, true)).toBe(true);
    expect(calls.progress('call', 'run', 2_400, false)).toBe(false);
    expect(calls.dismiss('session', 'call')).toBe(false);
    calls.hold('call');
    expect(calls.findByRun('session', 'run')).toEqual(['call']);
    await store.appendMessage({ ...startInput('settle:run'), pair_id: 'run', content: 'Completed', ts: 4_000,
      tool_call_settlements: [{ message_id: 'call', state: 'succeeded' }] });
    expect(calls.progress('call', 'run', 5_000, false)).toBe(false);
    expect(calls.list()).toEqual([]);
    expect(db.prepare('SELECT json_extract(metadata_blob, \'$.tool_call.state\') AS state FROM chat_messages WHERE message_id = ?')
      .get('call')).toEqual({ state: 'succeeded' });
  });

  it('cannot replace the outer run identity or keep writing through detached async context', async () => {
    const bind = vi.fn(), progress = vi.fn(() => true);
    let late: ((at: number, stalled: boolean) => boolean | undefined) | undefined;
    await withChatToolCallContext({ bind, progress }, async () => {
      late = bindChatToolCallRun('outer', 'recipe');
      expect(bindChatToolCallRun('child', 'nested')).toBeUndefined();
      late?.(1, false);
    });
    late?.(2, false);
    expect(bind).toHaveBeenCalledExactlyOnceWith('outer', 'recipe');
    expect(progress).toHaveBeenCalledExactlyOnceWith('outer', 1, false);
  });
});

describe('a call that had to wait, and what the next turn is told about it', () => {
  const holdCall = async (store: ReturnType<typeof createChatStore>, id: string, run: string) => {
    await store.toolCalls!.start(startInput(id));
    store.toolCalls!.bind(id, run);
    store.toolCalls!.hold(id);
  };

  it('keeps when it first waited, and settles a refusal as a refusal', async () => {
    const { store } = storage();
    const sink = createChatRunSettledSink(store, signature, { emit: vi.fn() });
    await holdCall(store, 'refused-call', 'refused-run');
    await holdCall(store, 'failed-call', 'failed-run');
    await holdCall(store, 'done-call', 'done-run');
    const firstWait = store.toolCalls!.get('done-call')!.held_at;
    expect(firstWait).toEqual(expect.any(Number));
    // Its go-ahead started it again and it stopped again: still the call that
    // started waiting THEN.
    expect(store.toolCalls!.resumeRun('session', 'done-run')).toEqual(['done-call']);
    store.toolCalls!.hold('done-call');
    expect(store.toolCalls!.get('done-call')!.held_at).toBe(firstWait);

    const settle = (run_id: string, result: unknown) => sink({ execution_source: source,
      run_id, tool_name: 'recipe.run', result, ts: Date.now() });
    await settle('refused-run', { denied: true, message: 'The owner denied it.' });
    await settle('failed-run', { success: false, error: 'provider said no' });
    await settle('done-run', { success: true });
    expect(store.toolCalls!.get('refused-call')).toMatchObject({ state: 'failed', denied: true });
    expect(store.toolCalls!.get('failed-call')).toMatchObject({ state: 'failed' });
    expect(store.toolCalls!.get('failed-call')!.denied).toBeUndefined();
    expect(store.toolCalls!.get('done-call')).toMatchObject({ state: 'succeeded', held_at: firstWait });
    expect(store.toolCalls!.get('done-call')!.denied).toBeUndefined();
  });

  it('lists only this chat\'s calls that waited, most recently changed first, within the bound', async () => {
    const { store } = storage();
    store.createSession({ id: 'other', now: 1_000 });
    await store.toolCalls!.start(startInput('never-waited'));
    for (let i = 0; i < 7; i += 1) await holdCall(store, `waited-${i}`, `run-${i}`);
    await store.toolCalls!.start({ ...startInput('other-chat'), session_id: 'other',
      execution_source: { ...source, chat_session_id: 'other' } });
    store.toolCalls!.bind('other-chat', 'run-other');
    store.toolCalls!.hold('other-chat');
    const listed = store.toolCalls!.listWaited('session', 5);
    expect(listed).toHaveLength(5);
    expect(listed.every((call) => call.session_id === 'session' && call.held_at !== undefined)).toBe(true);
    expect(listed.map((call) => call.message_id)).not.toContain('never-waited');
    expect(store.toolCalls!.listWaited('other', 5).map((call) => call.message_id)).toEqual(['other-chat']);
  });

  it('tells the next turn where each waited call stands: the outcome, never the result', () => {
    const base = { session_id: 'session', turn_id: 'turn', tool_name: 'recued-core/control-device',
      started_at: 10, updated_at: 20, held_at: 15 };
    const { held_at: _never, ...neverWaited } = base;
    const text = renderWaitedCallsContext([
      { ...base, message_id: 'a', run_id: 'r1', state: 'succeeded' },
      { ...base, message_id: 'b', run_id: 'r2', state: 'failed', denied: true },
      { ...base, message_id: 'c', run_id: 'r3', state: 'failed' },
      { ...base, message_id: 'd', run_id: 'r4', state: 'held' },
      { ...base, message_id: 'e', run_id: 'r5', state: 'interrupted' },
      // Running again after its go-ahead: the live in-flight line says so.
      { ...base, message_id: 'f', run_id: 'r6', state: 'running' },
      // Never waited: a synchronous call the model already saw answer.
      { ...neverWaited, message_id: 'g', run_id: 'r7', state: 'succeeded' },
    ]);
    expect(text?.split('\n')).toEqual([
      WAITED_CALLS_CONTEXT_LEAD,
      'run=r1; recipe=recued-core/control-device; state=went ahead and finished; asked_at=10; settled_at=20',
      'run=r2; recipe=recued-core/control-device; state=did not run, the owner refused it; asked_at=10; settled_at=20',
      'run=r3; recipe=recued-core/control-device; state=went ahead but failed; asked_at=10; settled_at=20',
      'run=r4; recipe=recued-core/control-device; state=still waiting; asked_at=10',
      'run=r5; recipe=recued-core/control-device; state=stopped part-way, outcome unknown; asked_at=10; settled_at=20',
    ]);
    // Nothing waited ⇒ no block at all, so such a turn is byte-identical to before.
    expect(renderWaitedCallsContext([])).toBeUndefined();
    expect(renderWaitedCallsContext([{ ...neverWaited, message_id: 'g', state: 'succeeded' }])).toBeUndefined();
  });

  it('is told only in the owner\'s own chat, and shares the field with live work', async () => {
    const { store } = storage();
    await holdCall(store, 'waited', 'run-waited');
    expect(buildWaitedCallsContext(store.toolCalls, source)).toContain('run=run-waited; recipe=recipe.run; state=still waiting');
    expect(buildWaitedCallsContext(store.toolCalls,
      { ...source, actor: 'contracted_user', contract_id: 'contract-1' })).toBeUndefined();
    expect(buildWaitedCallsContext(store.toolCalls, { ...source, chat_session_id: 'elsewhere' })).toBeUndefined();
    expect(buildWaitedCallsContext(undefined, source)).toBeUndefined();
    expect(joinInFlightContexts('live work', undefined)).toBe('live work');
    expect(joinInFlightContexts(undefined, 'waited')).toBe('waited');
    expect(joinInFlightContexts('live work', 'waited')).toBe('live work\nwaited');
    expect(joinInFlightContexts(undefined, undefined)).toBeUndefined();
  });

  it('tidies the STORED running brief when it settles — the to-do written around the wait goes', async () => {
    // ⛔ Through the chat store, which is where a running server keeps the brief
    //   (`briefStore`). The first cut tidied the module's in-memory fallback and
    //   this test passed against it while a live drive showed the owner's note
    //   unchanged: a stub the composition root does not use.
    const { store } = storage();
    const sink = createChatRunSettledSink(store, signature, { emit: vi.fn() });
    const carried = { intent: 'unlock the kitchen door', constraints: ['use the back door at night'],
      findings: ['lock.kitchen_door is the kitchen door'], pending: ['Unlock the kitchen door'], completed: [] };
    await store.writeSessionBrief('session', JSON.stringify(carried));
    await holdCall(store, 'unlock-call', 'run-unlock');
    await sink({ execution_source: source, run_id: 'run-unlock', tool_name: 'control-device',
      result: { success: true }, ts: Date.now() });
    expect(JSON.parse((await store.readSessionBrief('session'))!)).toEqual({ ...carried, pending: [] });
    // A refusal settles the same way: the to-do was about a call that is over.
    await store.writeSessionBrief('session', JSON.stringify(carried));
    await holdCall(store, 'refused-call', 'run-refused');
    await sink({ execution_source: source, run_id: 'run-refused', tool_name: 'control-device',
      result: { denied: true, message: 'The owner denied it.' }, ts: Date.now() });
    expect(JSON.parse((await store.readSessionBrief('session'))!).pending).toEqual([]);
    // And the settlement itself is never undone by the tidy.
    expect(store.toolCalls!.get('unlock-call')?.state).toBe('succeeded');
    expect(store.toolCalls!.get('refused-call')).toMatchObject({ state: 'failed', denied: true });
  });

  it('reports a brief it cannot tidy as that, never as a failed settlement', async () => {
    const { store } = storage();
    const emit = vi.fn();
    const sink = createChatRunSettledSink(store, signature, { emit });
    await holdCall(store, 'unlock-call', 'run-unlock');
    store.readSessionBrief = async () => { throw new Error('brief unreadable'); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sink({ execution_source: source, run_id: 'run-unlock', tool_name: 'control-device',
      result: { success: true }, ts: Date.now() });
    expect(store.toolCalls!.get('unlock-call')?.state).toBe('succeeded');
    const logged = errors.mock.calls.map(([first]) => String(first));
    expect(logged).toEqual(['[chat] run-settled brief tidy failed']);
    // One broadcast — the settlement — not a second "interrupted" round.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('reaches the model on the next turn, after the run settled', async () => {
    const { store } = storage();
    await holdCall(store, 'waited', 'run-unlock');
    await createChatRunSettledSink(store, signature, { emit: vi.fn() })({ execution_source: source,
      run_id: 'run-unlock', tool_name: 'recipe.run', result: { success: true, answer: 'private late result' },
      ts: Date.now() });
    const seen: string[] = [];
    const app = createChatOrchestrator({ chatStore: store, registry: {
      list: () => [], listByTier: () => [], getByName: () => null,
      subscribeRefresh: () => () => {}, dispatch: async () => ({ ok: true, result: null }),
    } as unknown as InternalToolRegistry, broadcast: { emit: () => {} }, selfSignature: signature,
    buildInFlightContext: (src) => joinInFlightContexts(undefined, buildWaitedCallsContext(store.toolCalls, src)),
    executeAiCall: async (...call: unknown[]) => {
      seen.push(JSON.stringify(call));
      return { body: { response: 'Yes, it finished.', events: [], tool_calls: [] } };
    } });
    await app.runTurn({ ...turnInput, message: 'Is it done?' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('run=run-unlock; recipe=recipe.run; state=went ahead and finished');
    // The outcome travels; the late result itself stays out of the model.
    expect(seen.join('')).not.toContain('private late result');
  });
});
