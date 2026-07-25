/** D-214 acceptance #50 — the chat `auditLog` sink must reach a REAL store
 *  through the REAL composer.
 *
 *  Why this test exists, and why it is not the mock test next door:
 *  `d-137-phase-1-2-chat-orchestrator.test.ts` hands `createChatOrchestrator`
 *  a hand-rolled `{ logActivity }` mock, so it proves the *emitter* fires —
 *  never that the live composition supplies the dep. `auditLog` is OPTIONAL on
 *  `ChatOrchestratorDeps` and every emitter routes through `safeLogActivity`,
 *  which no-ops silently on an absent dep. That combination is invisible to an
 *  output assertion: chat tool history would simply not exist, and nothing
 *  would fail.
 *
 *  D-214's compiler reads `chat_tool_call` rows as its chat-side input, so an
 *  unwired sink would make the table empty by construction. This test pins the
 *  seam that carries it: compose through `composeChatOrchestrator`, dispatch a
 *  tool, and assert the row landed in a real `AuditLogStore`.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChatTab } from '@recued/contracts';
import { createAuditLogStore, type AuditLogStore } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import type { EventBus } from '../events/bus.js';
import {
  composeChatOrchestrator,
  type ComposeChatOrchestratorDeps,
} from '../composition/bin/wire-chat-orchestrator.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const inertEventBus = (): EventBus =>
  ({
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn((event: unknown) => ({
      ...(event as Record<string, unknown>),
      cursor: 1,
    })),
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  }) as unknown as EventBus;

/** A real audit store over the same db the chat substrate uses — the same
 *  two collections `compose-storage-context.ts` wires in production. */
const realAuditLog = (db: Database.Database): AuditLogStore =>
  createAuditLogStore(
    createSQLiteCollection(db, 'audit_entries'),
    createSQLiteCollection(db, 'audit_activities'),
  );

const buildDeps = (
  db: Database.Database,
  auditLog: AuditLogStore | undefined,
): ComposeChatOrchestratorDeps =>
  ({
    db,
    keys: undefined,
    eventBus: inertEventBus(),
    auditLog,
    serverInstanceId: 'server-test',
    recipeStore: {
      ids: vi.fn(() => []),
      get: vi.fn(() => null),
      getStored: vi.fn(() => null),
      listStored: vi.fn(() => []),
    } as never,
    llmConfig: undefined,
    getLlmConfig: () => undefined,
    llmQuota: {} as never,
    llmAdapterRegistry: {} as never,
    emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
    pairedInstances: undefined,
    getContactStore: vi.fn(() => undefined),
    getCollectionRegistry: vi.fn(() => undefined),
    getEnrichmentStore: vi.fn(() => undefined),
    getConnectionStore: vi.fn(() => undefined),
    getExecutorConfig: vi.fn(() => undefined),
    getExecuteDeps: vi.fn(() => undefined),
  }) as unknown as ComposeChatOrchestratorDeps;

describe('D-214 #50 — chat audit sink reaches a real store through the composer', () => {
  it('records a chat_tool_call activity row when a tool is dispatched in a chat turn', async () => {
    const db = makeDb();
    const auditLog = realAuditLog(db);
    const bundle = composeChatOrchestrator(buildDeps(db, auditLog));

    bundle.chatStore.createSession({ id: 'sess-1', now: 1000 });

    await bundle.orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    });

    const activities = await auditLog.listActivities(50);
    const toolCalls = activities.filter((row) => row.action === 'chat_tool_call');

    expect(toolCalls.length).toBeGreaterThan(0);
  });

  it('orders the durable tool-call row before dispatch completion', async () => {
    const db = makeDb();
    const backing = realAuditLog(db);
    let releaseWrite!: () => void;
    let observeWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      observeWrite = resolve;
    });
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const auditLog: AuditLogStore = {
      ...backing,
      async logActivity(entry, options) {
        if (entry.action === 'chat_tool_call') {
          observeWrite();
          await writeRelease;
        }
        await backing.logActivity(entry, options);
      },
    };
    const bundle = composeChatOrchestrator(buildDeps(db, auditLog));
    bundle.chatStore.createSession({ id: 'sess-ordered', now: 1000 });

    let dispatchSettled = false;
    const dispatch = bundle.orchestrator.dispatch.dispatchTool({
      session_id: 'sess-ordered',
      turn_id: 'turn-ordered',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await writeStarted;
    await Promise.resolve();
    expect(dispatchSettled).toBe(false);

    releaseWrite();
    await dispatch;
    expect(
      (await backing.listActivities(50))
        .some((row) => row.action === 'chat_tool_call'),
    ).toBe(true);
  });

  /** The negative control. Without it the test above could pass on a build that
   *  audits from somewhere other than the injected dep, and the seam this file
   *  exists to pin would still be free to rot. */
  it('records NOTHING when the composer is given no auditLog — the dep is the only path', async () => {
    const db = makeDb();
    const observer = realAuditLog(db);
    const bundle = composeChatOrchestrator(buildDeps(db, undefined));

    bundle.chatStore.createSession({ id: 'sess-2', now: 1000 });

    await bundle.orchestrator.dispatch.dispatchTool({
      session_id: 'sess-2',
      turn_id: 'turn-1',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    });

    const activities = await observer.listActivities(50);
    expect(activities.filter((row) => row.action === 'chat_tool_call')).toEqual([]);
  });
});
