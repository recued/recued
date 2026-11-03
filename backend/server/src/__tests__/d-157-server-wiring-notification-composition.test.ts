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
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
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
  recoverPendingAsksOnceRunning,
} from '../composition/bin/wire-notification-block.js';
import { createLifecycleStateMachine } from '../lifecycle/lifecycle-state.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import {
  createGatedActionStore,
  type GatedActionRecord,
  type GatedActionStore,
} from '../gated-action-store.js';
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
  leftPassive: 0,
  failed: 0,
  orphaned: 0,
  superseded: 0,
  heldForPeer: 0,
  repairedPeerFailures: 0,
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
  listOpenAsks: vi.fn().mockResolvedValue([]),
  listUnresolvedAsks: vi.fn().mockResolvedValue([]),
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

  /** ⚠ The unrunnable-pack dismiss handler used to be asserted here too. It is
   *  GONE, not forgotten: D-259's boot pack finding was an `ask` only to borrow
   *  the ask store's durability, and a one-option ask needed a no-op answer
   *  consumer registered purely so a dismissal could complete. It is a `notify`
   *  now — nothing to answer, so nothing to register. The durable half moved to
   *  `packs.unrunnable`, which re-derives the condition per call. */
  it('registers the gateway handlers', () => {
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
  it('freezes interrupted dispatches at boot, and leaves answered asks to the running server', async () => {
    const order: string[] = [];
    const block = recoveryBlock(vi.fn(async () => {
      order.push('recover');
    }));
    const gatedActionStore = {
      list: vi.fn(async () => [{ action_ref: 'action-1', status: 'dispatching' }]),
      finish: vi.fn(async (_actionRef, input) => {
        order.push('receipt');
        return { status: input.status };
      }),
    } as unknown as GatedActionStore;
    sweepAwaitingCheckpointsMock.mockImplementationOnce(async () => {
      order.push('sweep');
      return zeroSweepResult();
    });

    await recoverNotificationBlockAtBoot({
      block,
      checkpointStore: stubCheckpointStore(),
      auditLog: stubAuditLog(),
      gatedActionStore,
    });

    // D-158 P3 — the asks are swept once the server runs (`recoverPendingAsksOnceRunning`), so
    // the freeze still comes first: the boot completes before the server runs.
    expect(order).toEqual(['receipt', 'sweep']);
    expect(gatedActionStore.finish).toHaveBeenCalledWith(
      'action-1',
      expect.objectContaining({ status: 'in_doubt' }),
    );
  });

  it('repairs a terminal peer-delivery receipt before generic restart reconciliation', async () => {
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-peer-crash', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-peer-crash',
      recipe_id: 'recipe-1',
      gated_step_id: 'peer-step',
      checkpoint_id: 'checkpoint-peer',
    });
    await actions.markDispatching(held.action_ref);
    const log = stubAuditLog();
    vi.mocked(log.get).mockResolvedValue(buildAuditEntry({
      recipe_id: 'recipe-1',
      recipe_hash: 'hash-1',
      commit_status: 'failed',
      duration_ms: 20,
      errors: [{
        error_id: 'peer-delivery-failed',
        code: 'INGREDIENT_ADAPTER_ALL_FAILED',
        message: 'The peer outbox was unavailable.',
        severity: 'fatal',
        source: {
          recipe_id: 'recipe-1',
          step_id: 'peer-step',
          ingredient_slug: 'peer-ask',
        },
        details: {
          exchange_ref: 'exchange-1',
          reason: 'peer_outbox_unavailable',
        },
        timestamp: new Date(NOW).toISOString(),
        retryable: false,
      }],
      config_snapshot: {},
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: 'server-1',
      run_id: 'run-peer-crash',
      now: NOW,
    }));

    await recoverNotificationBlockAtBoot({
      block: recoveryBlock(),
      checkpointStore: stubCheckpointStore(),
      auditLog: log,
      gatedActionStore: actions,
    });

    expect(await actions.get(held.action_ref)).toMatchObject({
      status: 'failed',
      result: {
        exchange_ref: 'exchange-1',
        reason: 'peer_outbox_unavailable',
        status: 'failed',
      },
    });
  });

  it('sweeps awaiting checkpoints at boot, and leaves the asks to the running server', async () => {
    // D-158 P3 — run here, before `startCollectionAdapters`, the asks' email was refused and an
    // approval answered while the server stopped resumed its run without its mailboxes. The
    // checkpoint sweep pairs through the durable index of unresolved asks (open and answered),
    // so running first it mints no replacement for an ask that is not swept yet.
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

    expect(order).toEqual(['sweep']);
    expect(block.recoverPendingAsks).not.toHaveBeenCalled();
    expect(sweepAwaitingCheckpointsMock).toHaveBeenCalledWith({
      checkpointStore: checkpoints,
      auditLog: log,
      notifier: block,
      listUnresolvedAsks: expect.any(Function),
    });
    const sweepDeps = sweepAwaitingCheckpointsMock.mock.calls[0]![0];
    await sweepDeps.listUnresolvedAsks();
    expect(block.listUnresolvedAsks).toHaveBeenCalledTimes(1);
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

describe('recoverPendingAsksOnceRunning (D-158 P3)', () => {
  const block = () => ({ recoverPendingAsks: vi.fn(async () => undefined) });

  it('sweeps once, at the flip to running', () => {
    const b = block();
    const machine = createLifecycleStateMachine('booting');
    recoverPendingAsksOnceRunning({ block: b, lifecycle: { machine } });
    expect(b.recoverPendingAsks).not.toHaveBeenCalled();
    machine.transition('running');
    expect(b.recoverPendingAsks).toHaveBeenCalledTimes(1);
    machine.transition('draining');
    expect(b.recoverPendingAsks).toHaveBeenCalledTimes(1);
  });

  it('sweeps at once when the server runs already, or has no lifecycle', () => {
    const running = block();
    const machine = createLifecycleStateMachine('booting');
    machine.transition('running');
    recoverPendingAsksOnceRunning({ block: running, lifecycle: { machine } });
    expect(running.recoverPendingAsks).toHaveBeenCalledTimes(1);
    const bare = block();
    recoverPendingAsksOnceRunning({ block: bare });
    expect(bare.recoverPendingAsks).toHaveBeenCalledTimes(1);
  });

  it('never sweeps when the boot ends another way, or when cancelled first', () => {
    const crashed = block();
    const failing = createLifecycleStateMachine('booting');
    recoverPendingAsksOnceRunning({ block: crashed, lifecycle: { machine: failing } });
    failing.transition('crashed');
    expect(crashed.recoverPendingAsks).not.toHaveBeenCalled();
    const cancelled = block();
    const machine = createLifecycleStateMachine('booting');
    const cancel = recoverPendingAsksOnceRunning({ block: cancelled, lifecycle: { machine } });
    cancel();
    machine.transition('running');
    expect(cancelled.recoverPendingAsks).not.toHaveBeenCalled();
  });

  it('a sweep that fails is told, not thrown into the boot', async () => {
    const warn = vi.fn();
    recoverPendingAsksOnceRunning({
      block: { recoverPendingAsks: vi.fn(async () => { throw new Error('store locked'); }) }, warn,
    });
    // A block that cannot sweep at all fails the same way, not the composition.
    expect(() => recoverPendingAsksOnceRunning({ block: {} as never, warn })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toContain('store locked');
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
