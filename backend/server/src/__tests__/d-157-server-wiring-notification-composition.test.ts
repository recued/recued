/** D-157 server-wiring - notification block composition. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Checkpoint, Commit } from '@recued/contracts';
import {
  IN_DOUBT_ANNOTATION_KEY,
  IN_DOUBT_HANDLER_KIND,
  IN_DOUBT_TARGET_COLLECTION,
  PREFLIGHT_HANDLER_KIND,
} from '@recued/gateway';
import type { NotificationBlock } from '@recued/notification';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const raiseInDoubtAsksMock = vi.hoisted(() => vi.fn());
const sweepAwaitingCheckpointsMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/gateway')>();
  return {
    ...actual,
    raiseInDoubtAsks: raiseInDoubtAsksMock,
  };
});

vi.mock('../preflight-boot-sweep.js', () => ({
  sweepAwaitingCheckpoints: sweepAwaitingCheckpointsMock,
}));

import type { EventBus } from '../events/bus.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import {
  composeNotificationBlock,
  raiseInDoubtForSweptCommits,
  recoverNotificationBlockAtBoot,
} from '../composition/bin/wire-notification-block.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';

const NOW = Date.parse('2026-05-22T18:00:00.000Z');

const zeroSweepResult = () => ({
  inspected: 0,
  raised: 0,
  alreadyPaired: 0,
  failed: 0,
  orphaned: 0,
  terminal: 0,
});

const eventBus = (
  emit: ReturnType<typeof vi.fn> = vi.fn((event) => ({ cursor: 1, ...event })),
): EventBus & { emit: ReturnType<typeof vi.fn> } => ({
  cursor: vi.fn(() => 0),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit,
  replay: vi.fn(() => []),
  subscriberCount: vi.fn(() => 0),
}) as unknown as EventBus & { emit: ReturnType<typeof vi.fn> };

const auditLog = (db: Database.Database): AuditLogStore =>
  createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );

const checkpointStore = (db: Database.Database): CheckpointStore => {
  const store = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  return store;
};

const annotationStore = (
  db: Database.Database,
  dir: string,
): AnnotationStore => {
  let nextId = 0;
  return createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => NOW,
    newId: () => `annotation-${++nextId}`,
  });
};

const composeHarness = (overrides: {
  eventBus?: EventBus & { emit: ReturnType<typeof vi.fn> };
  getExecuteDeps?: () => ExecuteHandlerDeps | undefined;
} = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // `composeNotificationBlock` unconditionally builds the D-192 Slice 6b
  // container-pick store (`createSourceDependencyEntityStore`), so its table
  // must exist before composition — same pattern as `checkpointStore` above.
  ensureSourceDependencyEntitySchema(db);
  const dir = mkdtempSync(join(tmpdir(), 'notification-composition-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const bus = overrides.eventBus ?? eventBus();
  const getExecuteDeps: () => ExecuteHandlerDeps | undefined =
    overrides.getExecuteDeps ?? vi.fn<() => ExecuteHandlerDeps | undefined>(
      () => undefined,
    );
  const stores = {
    db,
    auditLog: auditLog(db),
    checkpointStore: checkpointStore(db),
    annotationStore: annotationStore(db, dir),
    eventBus: bus,
    getExecuteDeps,
  };

  return {
    ...stores,
    ...composeNotificationBlock(stores),
  };
};

const recoveryBlock = (
  recoverPendingAsks: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
): NotificationBlock & { recoverPendingAsks: ReturnType<typeof vi.fn> } => ({
  recoverPendingAsks,
}) as unknown as NotificationBlock & { recoverPendingAsks: ReturnType<typeof vi.fn> };

const stubCheckpointStore = (): CheckpointStore =>
  ({ list: vi.fn() }) as unknown as CheckpointStore;

const stubAuditLog = (): AuditLogStore =>
  ({ get: vi.fn() }) as unknown as AuditLogStore;

const commit = (overrides: Partial<Commit> = {}): Commit => ({
  commit_id: 'commit-1',
  kind: 'action',
  ingredient: 'mail',
  tool: 'send',
  args: { to: 'ada@example.test' },
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
  dispatched_at: NOW,
  request_id: 'run-1',
  ...overrides,
});

let warnSpy: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  raiseInDoubtAsksMock.mockReset();
  raiseInDoubtAsksMock.mockResolvedValue({
    ask_ids: [],
    skipped: [],
    failed: [],
  });
  sweepAwaitingCheckpointsMock.mockReset();
  sweepAwaitingCheckpointsMock.mockResolvedValue(zeroSweepResult());
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('composeNotificationBlock', () => {
  it('returns a block and resumer bundle', () => {
    const { block, resumer } = composeHarness();

    expect(block).toEqual(expect.objectContaining({
      ask: expect.any(Function),
      notify: expect.any(Function),
      recoverPendingAsks: expect.any(Function),
      registerAskHandler: expect.any(Function),
      submitAnswer: expect.any(Function),
    }));
    expect(resumer).toEqual(expect.objectContaining({
      resumeRun: expect.any(Function),
      denyRun: expect.any(Function),
    }));
  });

  it('creates the pending ask and notification settings SQLite tables', () => {
    const { db } = composeHarness();

    const rows = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('pending_asks', 'notification_settings')
       ORDER BY name`,
    ).all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'notification_settings',
      'pending_asks',
    ]);
  });

  it('fans notify, ask, and ask_closed UI events onto eventBus.emit', async () => {
    const bus = eventBus();
    const { block } = composeHarness({ eventBus: bus });

    await block.notify({ title: 'Heads up', text: 'Check the run.' });
    const { ask_id } = await block.ask(
      { title: 'Confirm action', text: 'Did the action complete?' },
      [{ id: 'sent', label: 'Sent' }],
      {
        kind: IN_DOUBT_HANDLER_KIND,
        payload: {
          commit_id: 'commit-1',
          correlation_id: 'corr-1',
          dispatched_at: NOW,
        },
      },
    );
    await block.submitAnswer({ ask_id, option: 'sent', via: 'ui' });

    expect(bus.emit.mock.calls.map(([event]) => event.kind)).toEqual([
      'notification.notify',
      'notification.ask',
      'notification.ask_closed',
    ]);
    expect(bus.emit).toHaveBeenNthCalledWith(1, {
      kind: 'notification.notify',
      title: 'Heads up',
      text: 'Check the run.',
    });
    expect(bus.emit).toHaveBeenNthCalledWith(2, {
      kind: 'notification.ask',
      ask_id,
      title: 'Confirm action',
      text: 'Did the action complete?',
      options: [{ id: 'sent', label: 'Sent' }],
    });
    expect(bus.emit).toHaveBeenNthCalledWith(3, {
      kind: 'notification.ask_closed',
      ask_id,
    });
  });

  it('omits title when a notify message has no title field', async () => {
    const bus = eventBus();
    const { block } = composeHarness({ eventBus: bus });

    await block.notify({ text: 'Untitled notification.' });

    expect(bus.emit).toHaveBeenCalledWith({
      kind: 'notification.notify',
      text: 'Untitled notification.',
    });
    expect(bus.emit.mock.calls[0]?.[0]).not.toHaveProperty('title');
  });

  it('swallows eventBus.emit failures so block.ask still resolves', async () => {
    const bus = eventBus(vi.fn(() => {
      throw new Error('bus unavailable');
    }));
    const { block } = composeHarness({ eventBus: bus });

    await expect(block.ask(
      { text: 'Still durable.' },
      [{ id: 'sent', label: 'Sent' }],
      {
        kind: IN_DOUBT_HANDLER_KIND,
        payload: {
          commit_id: 'commit-1',
          correlation_id: 'corr-1',
          dispatched_at: NOW,
        },
      },
    )).resolves.toEqual({ ask_id: expect.any(String) });
    expect(bus.emit).toHaveBeenCalledTimes(1);
  });

  it('does not call getExecuteDeps while composing the resumer', () => {
    const getExecuteDeps = vi.fn(() => {
      throw new Error('getExecuteDeps should be lazy');
    });

    expect(() => composeHarness({ getExecuteDeps })).not.toThrow();
    expect(getExecuteDeps).not.toHaveBeenCalled();
  });

  it('registers both gateway handler kinds on the composed block', () => {
    const { block } = composeHarness();

    expect(() => block.registerAskHandler(PREFLIGHT_HANDLER_KIND, vi.fn()))
      .toThrow(/already registered/);
    expect(() => block.registerAskHandler(IN_DOUBT_HANDLER_KIND, vi.fn()))
      .toThrow(/already registered/);
  });

  it('dispatches the registered in-doubt handler to the annotation writer', async () => {
    const { block, annotationStore } = composeHarness();

    const { ask_id } = await block.ask(
      { text: 'Did this complete?' },
      [{ id: 'retry', label: 'No - retry' }],
      {
        kind: IN_DOUBT_HANDLER_KIND,
        payload: {
          commit_id: 'commit-1',
          correlation_id: 'corr-1',
          dispatched_at: NOW,
        },
      },
    );
    await block.submitAnswer({ ask_id, option: 'retry', via: 'ui' });

    const rows = await annotationStore.annotationsForRecord(
      IN_DOUBT_TARGET_COLLECTION,
      'commit-1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_collection: IN_DOUBT_TARGET_COLLECTION,
      target_id: 'commit-1',
      key: IN_DOUBT_ANNOTATION_KEY,
      value: {
        answer: 'retry',
        answered_at: expect.any(Number),
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
      },
      event_at: NOW,
    });
  });
});

describe('recoverNotificationBlockAtBoot', () => {
  it('runs recoverPendingAsks before sweeping awaiting checkpoints', async () => {
    const order: string[] = [];
    const block = recoveryBlock(vi.fn(async () => {
      order.push('recover');
    }));
    const checkpoints = stubCheckpointStore();
    const log = stubAuditLog();
    sweepAwaitingCheckpointsMock.mockImplementationOnce(async () => {
      order.push('sweep');
      return zeroSweepResult();
    });

    await recoverNotificationBlockAtBoot({
      block,
      checkpointStore: checkpoints,
      auditLog: log,
    });

    expect(order).toEqual(['recover', 'sweep']);
    expect(block.recoverPendingAsks).toHaveBeenCalledTimes(1);
    expect(sweepAwaitingCheckpointsMock).toHaveBeenCalledWith({
      checkpointStore: checkpoints,
      auditLog: log,
      notifier: block,
    });
  });

  it('swallows recoverPendingAsks failures and still runs the sweep', async () => {
    const block = recoveryBlock(
      vi.fn().mockRejectedValue(new Error('recover failed')),
    );

    await expect(recoverNotificationBlockAtBoot({
      block,
      checkpointStore: stubCheckpointStore(),
      auditLog: stubAuditLog(),
    })).resolves.toBeUndefined();

    expect(sweepAwaitingCheckpointsMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'recoverPendingAsks failed at boot',
    ));
  });

  it('swallows awaiting-checkpoint sweep failures', async () => {
    sweepAwaitingCheckpointsMock.mockRejectedValueOnce(new Error('sweep failed'));

    await expect(recoverNotificationBlockAtBoot({
      block: recoveryBlock(),
      checkpointStore: stubCheckpointStore(),
      auditLog: stubAuditLog(),
    })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'awaiting-checkpoint sweep threw',
    ));
  });

  it.each([
    ['raised', { raised: 1 }],
    ['failed', { failed: 1 }],
    ['orphaned', { orphaned: 1 }],
  ] as const)('logs the sweep summary when %s is non-zero', async (_field, patch) => {
    sweepAwaitingCheckpointsMock.mockResolvedValueOnce({
      ...zeroSweepResult(),
      inspected: 1,
      ...patch,
    });

    await recoverNotificationBlockAtBoot({
      block: recoveryBlock(),
      checkpointStore: stubCheckpointStore(),
      auditLog: stubAuditLog(),
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      '[preflight] awaiting-checkpoint sweep',
    ));
  });

  it('does not warn when the sweep result is all zeros', async () => {
    await recoverNotificationBlockAtBoot({
      block: recoveryBlock(),
      checkpointStore: stubCheckpointStore(),
      auditLog: stubAuditLog(),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('raiseInDoubtForSweptCommits', () => {
  it('returns early for an empty swept commit list', async () => {
    await raiseInDoubtForSweptCommits({
      block: recoveryBlock(),
      sweptCommits: [],
    });

    expect(raiseInDoubtAsksMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes non-empty swept commits to raiseInDoubtAsks', async () => {
    const block = recoveryBlock();
    const row = commit({ commit_id: 'commit-raised' });

    await raiseInDoubtForSweptCommits({
      block,
      sweptCommits: [row],
    });

    expect(raiseInDoubtAsksMock).toHaveBeenCalledTimes(1);
    expect(raiseInDoubtAsksMock).toHaveBeenCalledWith(block, [row]);
  });

  it('warns when raiseInDoubtAsks reports failed commits', async () => {
    raiseInDoubtAsksMock.mockResolvedValueOnce({
      ask_ids: ['ask-1'],
      skipped: [],
      failed: ['commit-failed'],
    });

    await raiseInDoubtForSweptCommits({
      block: recoveryBlock(),
      sweptCommits: [commit()],
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      '1 commit(s) could not be surfaced',
    ));
  });

  it('swallows and warns when raiseInDoubtAsks throws', async () => {
    raiseInDoubtAsksMock.mockRejectedValueOnce(new Error('raise failed'));

    await expect(raiseInDoubtForSweptCommits({
      block: recoveryBlock(),
      sweptCommits: [commit()],
    })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'in-doubt ask raise threw',
    ));
  });
});
