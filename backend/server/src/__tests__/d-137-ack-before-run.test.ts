/** D-137 ack-before-run chat.send seam.
 *
 *  `handleSend` resolves at the orchestrator's `on_accepted` commit seam
 *  while the orchestrator's direct `runTurn` contract remains
 *  resolve-at-completion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type {
  ChatDispatchContext,
  InternalToolRegistry,
  RecuedServerSignature,
} from '@recued/contracts';
import { handleSend, type ChatRpcDeps } from '../chat-handler.js';
import {
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatBroadcastEmitter,
  type ChatOrchestrator,
  type ChatTurnAck,
  type ChatTurnInput,
} from '../chat-orchestrator.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let pending = true;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = (value) => {
      pending = false;
      innerResolve(value);
    };
    reject = (reason) => {
      pending = false;
      innerReject(reason);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get pending() {
      return pending;
    },
  };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const mintSequence = (...ids: string[]) => {
  const remaining = [...ids];
  return () => remaining.shift() ?? `id-extra-${remaining.length}`;
};

const setupRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(async (
    _name: string,
    _args: unknown,
    _ctx: ChatDispatchContext,
  ) => ({ ok: true, result: { rows: [] } })) as InternalToolRegistry['dispatch'],
  subscribeRefresh: () => () => undefined,
});

const isEngineTurnFailedEvent = (event: BroadcastChatEvent) =>
  event.kind === 'chat.transparency'
  && (event as { event?: { kind?: unknown } }).event?.kind ===
    'engine.turn_failed';

describe('D-137 ack-before-run — handleSend', () => {
  let db: Database.Database;
  let store: ChatStore;
  let broadcastedEvents: BroadcastChatEvent[];
  let broadcast: ChatBroadcastEmitter;
  let orchestrator: ChatOrchestrator;
  let deps: ChatRpcDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1000 });
    broadcastedEvents = [];
    broadcast = {
      emit: (event) => {
        broadcastedEvents.push(event);
      },
    };
    orchestrator = {
      runTurn: vi.fn(async () => ({ turn_id: 'turn-stub' })),
      dispatch: {
        dispatchTool: vi.fn(),
      },
    } as unknown as ChatOrchestrator;
    deps = {
      store,
      orchestrator,
      broadcast,
      selfSignature,
      now: () => 1000,
      mintId: () => 'mint-stub',
    };
  });

  it('HEADLINE: resolves at on_accepted while the turn completion is still pending', async () => {
    const completion = createDeferred<ChatTurnAck>();
    orchestrator.runTurn = vi.fn((input: ChatTurnInput) => {
      input.on_accepted?.({ turn_id: 't1' });
      return completion.promise;
    });

    await expect(
      handleSend(deps, {
        session_id: 'sess-1',
        message: 'hello',
        picker_state: { current: 'self' },
      }),
    ).resolves.toEqual({ turn_id: 't1' });

    expect(completion.pending).toBe(true);
    completion.resolve({ turn_id: 't1' });
    await flushMicrotasks();
  });

  it('rejects pre-accept failures and does not emit engine.turn_failed', async () => {
    const error = new Error('tail read failed before accept');
    orchestrator.runTurn = vi.fn(() => Promise.reject(error));

    await expect(
      handleSend(deps, {
        session_id: 'sess-1',
        message: 'hello',
        picker_state: { current: 'self' },
      }),
    ).rejects.toBe(error);

    expect(
      broadcastedEvents.filter(isEngineTurnFailedEvent),
    ).toEqual([]);
  });

  it('resolves post-accept failures and emits exactly one engine.turn_failed transparency event', async () => {
    const completion = createDeferred<ChatTurnAck>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    orchestrator.runTurn = vi.fn((input: ChatTurnInput) => {
      input.on_accepted?.({ turn_id: 't1' });
      return completion.promise;
    });

    await expect(
      handleSend(deps, {
        session_id: 'sess-1',
        message: 'hello',
        picker_state: { current: 'self' },
      }),
    ).resolves.toEqual({ turn_id: 't1' });

    completion.reject(new Error('model shell failed after accept'));
    await flushMicrotasks();
    consoleError.mockRestore();

    const failures = broadcastedEvents.filter(isEngineTurnFailedEvent);
    expect(failures).toEqual([
      {
        kind: 'chat.transparency',
        session_id: 'sess-1',
        turn_id: 't1',
        event: { kind: 'engine.turn_failed' },
      },
    ]);
  });

  it('degenerates to completion-time ack when the orchestrator never fires on_accepted', async () => {
    orchestrator.runTurn = vi.fn(async () => ({ turn_id: 't9' }));

    await expect(
      handleSend(deps, {
        session_id: 'sess-1',
        message: 'hello',
        picker_state: { current: 'self' },
      }),
    ).resolves.toEqual({ turn_id: 't9' });
  });
});

describe('D-137 ack-before-run — real orchestrator', () => {
  let db: Database.Database;
  let store: ChatStore;
  let captured: BroadcastChatEvent[];
  let broadcast: ChatBroadcastEmitter;
  let auditLog: Parameters<typeof createChatOrchestrator>[0]['auditLog'];

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db);
    captured = [];
    broadcast = {
      emit: (event) => {
        captured.push(event);
      },
    };
    auditLog = {
      logActivity: vi.fn(),
    } as unknown as Parameters<typeof createChatOrchestrator>[0]['auditLog'];
  });

  it('fires on_accepted after the user message is durably in the chat store', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: setupRegistry(),
      broadcast,
      auditLog,
      selfSignature,
      now: () => 2000,
      mintId: mintSequence('turn-real', 'user-msg', 'assistant-msg'),
    });
    let acceptedMessages: Promise<void> | null = null;

    const result = await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'committed hello',
      picker_state: { current: 'self' },
      on_accepted: ({ turn_id }) => {
        expect(turn_id).toBe('turn-real');
        acceptedMessages = store.listMessages('sess-1').then((messages) => {
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            id: 'user-msg',
            role: 'user',
            content: 'committed hello',
          });
        });
      },
    });

    expect(result.turn_id).toBe('turn-real');
    expect(acceptedMessages).not.toBeNull();
    await acceptedMessages;
    const messagesAfterCompletion = await store.listMessages('sess-1');
    expect(messagesAfterCompletion).toHaveLength(2);
    expect(messagesAfterCompletion.some((message) => message.role === 'assistant')).toBe(
      true,
    );
  });

  it('keeps the turn alive when on_accepted throws and still emits chat.message_complete', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: setupRegistry(),
      broadcast,
      auditLog,
      selfSignature,
      now: () => 2000,
      mintId: mintSequence('turn-real', 'user-msg', 'assistant-msg'),
    });

    await expect(
      orchestrator.runTurn({
        session_id: 'sess-1',
        message: 'hello despite callback throw',
        picker_state: { current: 'self' },
        on_accepted: () => {
          throw new Error('on_accepted failed');
        },
      }),
    ).resolves.toEqual({ turn_id: 'turn-real' });

    expect(
      captured.filter((event) => event.kind === 'chat.message_complete'),
    ).toHaveLength(1);
  });
});
