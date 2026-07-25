/** D-157 P0 - in_doubt reconciliation leaf tests. */

import type { Commit } from '@recued/contracts';
import type {
  Answer,
  AskHandlerFn,
  AskOption,
  NotificationMessage,
} from '@recued/notification';
import { describe, expect, it, vi } from 'vitest';

import {
  buildInDoubtAsk,
  createInDoubtAnswerHandler,
  IN_DOUBT_ASK_OPTIONS,
  IN_DOUBT_HANDLER_KIND,
  raiseInDoubtAsks,
  registerInDoubtHandler,
  type InDoubtAnnotationWriter,
  type InDoubtNotifier,
} from '../in-doubt-reconciliation.js';

const DISPATCHED_AT = Date.parse('2026-05-22T17:24:30.123Z');
const ANSWERED_AT = Date.parse('2026-05-22T17:25:10.456Z');

const commit = (overrides: Partial<Commit> = {}): Commit => ({
  commit_id: 'commit-1',
  kind: 'action',
  ingredient: 'mail.send',
  tool: 'mail.sendMessage',
  args: {
    to: 'ada@example.com',
    subject: 'Launch notes',
  },
  status: 'in_doubt',
  source: {
    channel: 'chat',
    actor: 'user_self',
    chat_session_id: 'chat-1',
    user_id: 'user-1',
  },
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
  idempotency_key: 'idem-1',
  dispatched_at: DISPATCHED_AT,
  request_id: 'request-1',
  ...overrides,
});

const answer = (option: string): Answer => ({
  option,
  answered_at: ANSWERED_AT,
});

const payloadFor = (c: Commit): Record<string, unknown> => ({
  commit_id: c.commit_id,
  correlation_id: c.correlation_id,
  dispatched_at: c.dispatched_at,
});

const writer = (): InDoubtAnnotationWriter => ({
  writeReconciliation: vi.fn().mockResolvedValue(undefined),
});

describe('buildInDoubtAsk', () => {
  it('builds a durable ask with the commit identity, exact options, and JSON payload', () => {
    const c = commit({
      commit_id: 'commit-build',
      correlation_id: 'corr-build',
      ingredient: 'calendar.create',
      tool: 'calendar.events.insert',
      dispatched_at: DISPATCHED_AT,
    });

    const ask = buildInDoubtAsk(c);
    const dispatchedIso = new Date(c.dispatched_at).toISOString();
    const renderedMessage = `${ask.message.title ?? ''} ${ask.message.text}`;

    expect(ask.message.title).toEqual(expect.any(String));
    expect(renderedMessage).toContain(c.tool);
    expect(renderedMessage).toContain(c.ingredient);
    expect(renderedMessage).toContain(dispatchedIso);
    expect(dispatchedIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    expect(ask.options).toBe(IN_DOUBT_ASK_OPTIONS);
    expect(ask.options).toEqual([
      { id: 'sent', label: 'Sent' },
      { id: 'retry', label: 'No — retry' },
      { id: 'skip', label: 'Skip' },
    ]);

    expect(ask.handler).toEqual({
      kind: IN_DOUBT_HANDLER_KIND,
      payload: {
        commit_id: c.commit_id,
        correlation_id: c.correlation_id,
        dispatched_at: c.dispatched_at,
      },
    });
    expect(JSON.parse(JSON.stringify(ask.handler.payload))).toEqual(
      ask.handler.payload,
    );
  });
});

describe('createInDoubtAnswerHandler', () => {
  it.each(IN_DOUBT_ASK_OPTIONS.map((option) => option.id))(
    'records a %s reconciliation answer linked to the commit',
    async (option) => {
      const c = commit({
        commit_id: `commit-${option}`,
        correlation_id: `corr-${option}`,
      });
      const w = writer();

      await createInDoubtAnswerHandler(w)(payloadFor(c), answer(option));

      expect(w.writeReconciliation).toHaveBeenCalledTimes(1);
      expect(w.writeReconciliation).toHaveBeenCalledWith({
        commit_id: c.commit_id,
        correlation_id: c.correlation_id,
        answer: option,
        answered_at: ANSWERED_AT,
        event_at: c.dispatched_at,
      });
    },
  );

  it('does not auto-resume a retry answer; the sole effect is the writer call', async () => {
    const calls: string[] = [];
    const annotations: unknown[] = [];
    const recordingWriter = new Proxy(
      {
        writeReconciliation: vi.fn(async (annotation: unknown) => {
          calls.push('writeReconciliation');
          annotations.push(annotation);
        }),
      },
      {
        get(target, property, receiver) {
          if (property in target) {
            return Reflect.get(target, property, receiver);
          }
          return vi.fn(async () => {
            calls.push(String(property));
          });
        },
      },
    ) as InDoubtAnnotationWriter;
    const c = commit({
      commit_id: 'commit-retry',
      correlation_id: 'corr-retry',
    });

    await createInDoubtAnswerHandler(recordingWriter)(
      payloadFor(c),
      answer('retry'),
    );

    expect(calls).toEqual(['writeReconciliation']);
    expect(recordingWriter.writeReconciliation).toHaveBeenCalledTimes(1);
    expect(annotations).toEqual([
      {
        commit_id: 'commit-retry',
        correlation_id: 'corr-retry',
        answer: 'retry',
        answered_at: ANSWERED_AT,
        event_at: DISPATCHED_AT,
      },
    ]);
  });

  it.each([
    [
      'missing commit_id',
      { correlation_id: 'corr-1', dispatched_at: DISPATCHED_AT },
    ],
    [
      'non-string commit_id',
      {
        commit_id: 42,
        correlation_id: 'corr-1',
        dispatched_at: DISPATCHED_AT,
      },
    ],
    [
      'missing correlation_id',
      { commit_id: 'commit-1', dispatched_at: DISPATCHED_AT },
    ],
    [
      'non-string correlation_id',
      {
        commit_id: 'commit-1',
        correlation_id: 42,
        dispatched_at: DISPATCHED_AT,
      },
    ],
    [
      'missing dispatched_at',
      { commit_id: 'commit-1', correlation_id: 'corr-1' },
    ],
    [
      'non-number dispatched_at',
      {
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
        dispatched_at: '2026-05-22T17:24:30.123Z',
      },
    ],
    [
      'NaN dispatched_at',
      {
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
        dispatched_at: Number.NaN,
      },
    ],
    [
      'Infinity dispatched_at',
      {
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
        dispatched_at: Number.POSITIVE_INFINITY,
      },
    ],
  ])('throws on malformed payload: %s', async (_name, payload) => {
    const w = writer();

    await expect(
      createInDoubtAnswerHandler(w)(
        payload as Record<string, unknown>,
        answer('sent'),
      ),
    ).rejects.toThrow(/malformed payload/);
    expect(w.writeReconciliation).not.toHaveBeenCalled();
  });
});

describe('registerInDoubtHandler', () => {
  it('registers gateway.in_doubt and wires the same answer-handler behavior', async () => {
    const w = writer();
    let registered: AskHandlerFn | undefined;
    const notifier: InDoubtNotifier = {
      ask: vi.fn(),
      registerAskHandler: vi.fn((kind, handler) => {
        expect(kind).toBe(IN_DOUBT_HANDLER_KIND);
        registered = handler;
      }),
    };
    const c = commit({
      commit_id: 'commit-registered',
      correlation_id: 'corr-registered',
    });

    registerInDoubtHandler(notifier, w);

    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(notifier.registerAskHandler).toHaveBeenCalledWith(
      IN_DOUBT_HANDLER_KIND,
      expect.any(Function),
    );
    expect(registered).toEqual(expect.any(Function));

    await registered?.(payloadFor(c), answer('skip'));

    expect(w.writeReconciliation).toHaveBeenCalledTimes(1);
    expect(w.writeReconciliation).toHaveBeenCalledWith({
      commit_id: 'commit-registered',
      correlation_id: 'corr-registered',
      answer: 'skip',
      answered_at: ANSWERED_AT,
      event_at: DISPATCHED_AT,
    });
  });
});

describe('raiseInDoubtAsks', () => {
  it('raises asks only for in_doubt commits and isolates per-commit failures', async () => {
    const askedCommitIds: string[] = [];
    const notifier: InDoubtNotifier = {
      ask: vi.fn(
        async (
          _message: NotificationMessage,
          _options: readonly AskOption[],
          handler,
        ) => {
          const commitId = handler.payload.commit_id;
          if (typeof commitId !== 'string') {
            throw new Error('test expected commit_id payload');
          }
          askedCommitIds.push(commitId);
          if (commitId === 'commit-failed') {
            throw new Error('ask persistence failed');
          }
          return { ask_id: `ask-${commitId}` };
        },
      ),
      registerAskHandler: vi.fn(),
    };
    const commits = [
      commit({ commit_id: 'commit-first', correlation_id: 'corr-first' }),
      commit({
        commit_id: 'commit-skipped',
        correlation_id: 'corr-skipped',
        status: 'succeeded',
      }),
      commit({ commit_id: 'commit-failed', correlation_id: 'corr-failed' }),
      commit({ commit_id: 'commit-later', correlation_id: 'corr-later' }),
    ];

    const result = await raiseInDoubtAsks(notifier, commits);

    expect(notifier.ask).toHaveBeenCalledTimes(3);
    expect(askedCommitIds).toEqual([
      'commit-first',
      'commit-failed',
      'commit-later',
    ]);
    expect(result).toEqual({
      ask_ids: ['ask-commit-first', 'ask-commit-later'],
      skipped: ['commit-skipped'],
      failed: ['commit-failed'],
    });
  });

  it('uses only ask/registerAskHandler on the injected notifier and no channel method', async () => {
    const methodCalls: string[] = [];
    const method = (name: string): unknown =>
      new Proxy(() => undefined, {
        apply: () => {
          methodCalls.push(name);
          if (name === 'ask') return Promise.resolve({ ask_id: 'ask-1' });
          return undefined;
        },
        get: (_target, property) => method(`${name}.${String(property)}`),
      });
    const notifier = new Proxy(
      {},
      { get: (_target, property) => method(String(property)) },
    ) as InDoubtNotifier;

    registerInDoubtHandler(notifier, writer());
    await raiseInDoubtAsks(notifier, [commit()]);

    expect(methodCalls).toEqual(['registerAskHandler', 'ask']);
  });
});
