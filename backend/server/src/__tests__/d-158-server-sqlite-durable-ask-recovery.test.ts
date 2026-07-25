/** D-158 — server-side durable `ask` recovery over the REAL SQLite store
 *  (I-2 durable ask / I-4 handler-kind-not-closure), driven through the
 *  production boot path.
 *
 *  WHY THIS TEST EXISTS — the coverage gap it closes.
 *  The durable `ask_id` + `on_answer` substrate is verified elsewhere, but
 *  never over the production persistence + composition seam:
 *    - The package round-trip test (`packages/notification/.../
 *      d-158-phase-0-block.test.ts`, "restart and recovery") proves the
 *      recovery SEMANTICS — but over `createInMemoryCollection`, which
 *      stores raw object REFERENCES in a `Map`. There is no serialization
 *      boundary, so block B reads back the very object block A stored; a
 *      `PendingAsk` field that fails to JSON-round-trip (a `Map`, a class
 *      instance, an `undefined` that drops) would pass that test yet
 *      corrupt in production.
 *    - The server-wiring composition test
 *      (`d-157-server-wiring-notification-composition.test.ts`) drives boot
 *      recovery — but with a MOCK block whose `recoverPendingAsks` is a
 *      `vi.fn()`.
 *  Neither exercises the real `createSQLiteCollection<PendingAsk>(db,
 *  'pending_asks')` JSON.stringify/parse round-trip + `composeNotification
 *  Block` + `recoverNotificationBlockAtBoot`. This test does: persist via
 *  block A → discard block A → rebuild block B over the SAME SQLite db (the
 *  restart) → recover → assert open asks re-deliver and answered-but-
 *  unhandled asks re-dispatch to a freshly-wired handler carrying the
 *  persisted `(handler_kind, handler_payload)` + the round-tripped answer.
 *
 *  D-169 P2 framing: notify was made durable by persisting `notification_
 *  fired` activity rows (`notification.recent` survives restart). The ask
 *  path's equivalent — the open-ask read backing `notification.pending_asks`
 *  + full crash recovery — is proven durable over real SQLite here.
 *
 *  `sweepAwaitingCheckpoints` is mocked to a zero-result no-op so each test
 *  isolates the durable-ASK recovery invariant from the checkpoint sweep
 *  (which `recoverNotificationBlockAtBoot` also drives — covered by its own
 *  tests). Spec: D-158 § A.2 / I-2 / I-4.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Checkpoint } from '@recued/contracts';
import {
  IN_DOUBT_ANNOTATION_KEY,
  IN_DOUBT_HANDLER_KIND,
  IN_DOUBT_TARGET_COLLECTION,
} from '@recued/gateway';
import {
  createAskStore,
  type AskOption,
  type NotificationMessage,
  type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweepAwaitingCheckpointsMock = vi.hoisted(() => vi.fn());

vi.mock('../preflight-boot-sweep.js', () => ({
  sweepAwaitingCheckpoints: sweepAwaitingCheckpointsMock,
}));

import type { EventBus } from '../events/bus.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import {
  composeNotificationBlock,
  recoverNotificationBlockAtBoot,
} from '../composition/bin/wire-notification-block.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';

const NOW = Date.parse('2026-05-29T12:00:00.000Z');

const zeroSweepResult = () => ({
  inspected: 0,
  raised: 0,
  alreadyPaired: 0,
  failed: 0,
  orphaned: 0,
  terminal: 0,
});

/** A recording event bus — captures every `emit`ed UI event so a restart's
 *  re-delivery can be asserted on the fresh block's own bus. */
const recordingBus = (): {
  bus: EventBus;
  events: Array<Record<string, unknown> & { kind: string }>;
} => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const bus = {
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn((event: Record<string, unknown> & { kind: string }) => {
      events.push(event);
      return { cursor: 1, ...event };
    }),
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  } as unknown as EventBus;
  return { bus, events };
};

let annotationSeq = 0;

/** Build the notification block over a given SQLite db + bus. Reusing the
 *  SAME `db` object across two calls is what simulates a process restart:
 *  the `pending_asks` rows persist (the table lives in the shared db
 *  handle), while the block, its handler registry, and its channels are
 *  reconstructed fresh — exactly what boot does. */
const compose = (
  db: Database.Database,
  dir: string,
  bus: EventBus,
) => {
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );
  const checkpointStore = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  ensureSourceDependencyEntitySchema(db);
  const annotationStore = createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => NOW,
    newId: () => `annotation-${++annotationSeq}`,
  });

  const { block } = composeNotificationBlock({
    db,
    auditLog,
    checkpointStore,
    annotationStore,
    eventBus: bus,
    getExecuteDeps: () => undefined,
  });

  return { block, checkpointStore, auditLog, annotationStore };
};

const cleanups: Array<() => void> = [];

/** A fresh in-memory SQLite db + a temp dir for annotation blobs, both
 *  torn down after each test. The db is the durable substrate the restart
 *  simulation reuses. */
const freshDb = (): { db: Database.Database; dir: string } => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'durable-ask-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { db, dir };
};

const message: NotificationMessage = {
  title: 'Approve the wire transfer',
  text: 'Send $4,200 to Ada Lovelace?',
  link_url: '/asks/xfer-42',
};

const options: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

/** A handler payload with nesting + an array — the shape JSON must
 *  faithfully round-trip for `on_answer` to fire with the right context
 *  after a restart (I-4). */
const HANDLER_KIND = 'test.durable';
const handlerPayload = {
  checkpoint_id: 'ckpt-42',
  reason: { kind: 'high_value', amount_cents: 420000 },
  steps: ['debit', 'credit'],
};
const handlerRef = { kind: HANDLER_KIND, payload: handlerPayload };

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  annotationSeq = 0;
  sweepAwaitingCheckpointsMock.mockReset();
  sweepAwaitingCheckpointsMock.mockResolvedValue(zeroSweepResult());
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('D-158 durable ask recovery over real SQLite', () => {
  it('persists an open ask whose every field survives the SQLite JSON round-trip', async () => {
    const { db, dir } = freshDb();
    const { bus } = recordingBus();
    const { block } = compose(db, dir, bus);

    const { ask_id } = await block.ask(message, options, handlerRef);

    // Read the row back through a brand-new store handle over the same db
    // — the JSON.stringify (on write) / JSON.parse (on read) boundary the
    // in-memory collection never exercises.
    const reread = createAskStore(
      createSQLiteCollection<PendingAsk>(db, 'pending_asks'),
    );
    const row = await reread.get(ask_id);

    expect(row).toEqual({
      ask_id,
      message,
      options,
      handler_kind: HANDLER_KIND,
      handler_payload: handlerPayload,
      fanout_channels: ['ui'],
      status: 'open',
      created_at: expect.any(Number),
    });
    // Open ask carries no answer fields yet.
    expect(row).not.toHaveProperty('answer');
    expect(row).not.toHaveProperty('answered_via');
  });

  it('re-delivers an open ask to the ui bus on recoverNotificationBlockAtBoot after a restart', async () => {
    const { db, dir } = freshDb();

    // Block A persists the ask, then is discarded (the "crash").
    const busA = recordingBus();
    const { ask_id } = await compose(db, dir, busA.bus).block.ask(
      message,
      options,
      handlerRef,
    );

    // Block B is rebuilt over the SAME db with its OWN bus — the restart.
    const busB = recordingBus();
    const blockB = compose(db, dir, busB.bus);

    // Nothing has been delivered to block B yet (it never called `ask`) —
    // so the recovery call below is the SOLE cause of the re-delivery, not
    // any leftover block-A state. Brackets the assertion as load-bearing.
    expect(busB.events).toEqual([]);

    await recoverNotificationBlockAtBoot({
      block: blockB.block,
      checkpointStore: blockB.checkpointStore,
      auditLog: blockB.auditLog,
    });

    // The re-delivery lands on block B's fresh bus — proving the ask was
    // reconstructed from SQLite, not from any block-A in-memory state.
    expect(busB.events).toContainEqual({
      kind: 'notification.ask',
      ask_id,
      title: message.title,
      text: message.text,
      options: options.map((o) => ({ id: o.id, label: o.label })),
    });
    // Still open + still answerable after recovery (no premature transition).
    const row = await blockB.block.listOpenAsks();
    expect(row.map((a) => a.ask_id)).toEqual([ask_id]);
    expect(sweepAwaitingCheckpointsMock).toHaveBeenCalledTimes(1);
  });

  it('re-dispatches an answered-but-unhandled ask to a freshly-wired handler with the persisted kind, payload, and round-tripped answer', async () => {
    const { db, dir } = freshDb();

    // Block A persists the ask and records an answer, but has no handler
    // wired for HANDLER_KIND — so the dispatch is a no-op and the ask is
    // left durably `answered` (the crash-between-record-and-handle state).
    const busA = recordingBus();
    const blockA = compose(db, dir, busA.bus);
    const { ask_id } = await blockA.block.ask(message, options, handlerRef);
    await blockA.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });

    // Confirm the pre-restart state really is durably `answered`, not
    // `handled` — and that the answer + provenance round-tripped to SQLite.
    const midStore = createAskStore(
      createSQLiteCollection<PendingAsk>(db, 'pending_asks'),
    );
    const midRow = await midStore.get(ask_id);
    expect(midRow?.status).toBe('answered');
    expect(midRow?.answer?.option).toBe('approve');
    expect(midRow?.answered_via).toBe('ui');
    const answeredAt = midRow?.answer?.answered_at;
    expect(typeof answeredAt).toBe('number');

    // Block B rebuilds over the same db and wires the handler fresh — the
    // closure block A never carried (I-4). Boot recovery re-dispatches.
    const busB = recordingBus();
    const blockB = compose(db, dir, busB.bus);
    const handler = vi.fn();
    blockB.block.registerAskHandler(HANDLER_KIND, handler);

    // Registration alone fires nothing — only the boot recovery sweep can
    // dispatch the persisted `answered` ask, so this brackets the call.
    expect(handler).not.toHaveBeenCalled();

    await recoverNotificationBlockAtBoot({
      block: blockB.block,
      checkpointStore: blockB.checkpointStore,
      auditLog: blockB.auditLog,
    });

    // The persisted (kind, payload) reached the freshly-wired function with
    // the channel-stripped answer (I-10) read back from SQLite.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerPayload, {
      option: 'approve',
      answered_at: answeredAt,
    });

    // Terminal after recovery.
    const finalRow = await midStore.get(ask_id);
    expect(finalRow?.status).toBe('handled');
  });

  it('keeps the open-asks read (notification.pending_asks backing) intact across a restart', async () => {
    const { db, dir } = freshDb();

    const busA = recordingBus();
    const blockA = compose(db, dir, busA.bus);
    const first = await blockA.block.ask(message, options, handlerRef);
    const second = await blockA.block.ask(
      { text: 'Second pending decision' },
      options,
      handlerRef,
    );

    // Restart: a fresh block reads the open asks straight from SQLite.
    const busB = recordingBus();
    const blockB = compose(db, dir, busB.bus);

    expect(await blockB.block.countOutstandingAsks()).toBe(2);
    const openIds = (await blockB.block.listOpenAsks()).map((a) => a.ask_id);
    expect(openIds).toContain(first.ask_id);
    expect(openIds).toContain(second.ask_id);
    expect(openIds).toHaveLength(2);
  });

  it('keeps first-answer-wins dedup durable across a restart', async () => {
    const { db, dir } = freshDb();

    // Block A records the winning answer (no handler → stays `answered`).
    const busA = recordingBus();
    const blockA = compose(db, dir, busA.bus);
    const { ask_id } = await blockA.block.ask(message, options, handlerRef);
    await blockA.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });

    // Block B rebuilds over the same db; a second answer arrives post-
    // restart on a different option. The open→answered SQLite write is the
    // durable dedup point — block B observes `answered`, so the late reply
    // is a no-op and the recorded answer is unchanged (I-6).
    const busB = recordingBus();
    const blockB = compose(db, dir, busB.bus);
    const lateHandler = vi.fn();
    blockB.block.registerAskHandler(HANDLER_KIND, lateHandler);

    await blockB.block.submitAnswer({ ask_id, option: 'reject', via: 'ui' });

    const store = createAskStore(
      createSQLiteCollection<PendingAsk>(db, 'pending_asks'),
    );
    const row = await store.get(ask_id);
    // First answer wins; the late reject neither overwrote it nor dispatched.
    expect(row?.answer?.option).toBe('approve');
    expect(row?.status).toBe('answered');
    expect(lateHandler).not.toHaveBeenCalled();
  });

  it('survives a real SQLite connection close + reopen from disk (a true process restart)', async () => {
    // The cases above share one in-memory db HANDLE across both blocks —
    // faithful for "fresh block over persisted rows", but not a real
    // connection teardown (closing a `:memory:` handle drops the database).
    // This case uses an on-disk file: persist, CLOSE the connection, then
    // REOPEN a fresh connection to the same file — the production restart.
    const dir = mkdtempSync(join(tmpdir(), 'durable-ask-file-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'pending-asks.sqlite');

    const dbA = new Database(file);
    const busA = recordingBus();
    const { ask_id } = await compose(dbA, dir, busA.bus).block.ask(
      message,
      options,
      handlerRef,
    );
    dbA.close(); // the connection teardown a process restart entails

    const dbB = new Database(file); // reopen from disk — the fresh process
    cleanups.push(() => dbB.close());
    const busB = recordingBus();
    const blockB = compose(dbB, dir, busB.bus);

    // Block B has delivered nothing — recovery is the sole cause below.
    expect(busB.events).toEqual([]);
    await recoverNotificationBlockAtBoot({
      block: blockB.block,
      checkpointStore: blockB.checkpointStore,
      auditLog: blockB.auditLog,
    });

    expect(busB.events).toContainEqual({
      kind: 'notification.ask',
      ask_id,
      title: message.title,
      text: message.text,
      options: options.map((o) => ({ id: o.id, label: o.label })),
    });
    // The row genuinely round-tripped through disk, not a shared handle.
    const reopened = createAskStore(
      createSQLiteCollection<PendingAsk>(dbB, 'pending_asks'),
    );
    expect(await reopened.get(ask_id)).toMatchObject({
      ask_id,
      status: 'open',
      message,
      handler_kind: HANDLER_KIND,
    });
  });

  it('re-dispatches a persisted ask under the REAL gateway in-doubt handler kind to its production annotation effect after a restart', async () => {
    // The cases above use a synthetic `test.durable` handler, which proves
    // the recovery MECHANISM but not that a real production handler
    // registration survives a restart. This case persists an ask under the
    // real `IN_DOUBT_HANDLER_KIND` and asserts boot recovery re-dispatches
    // it through the production in-doubt handler to its observable effect.
    const { db, dir } = freshDb();
    const inDoubtPayload = {
      commit_id: 'commit-1',
      correlation_id: 'corr-1',
      dispatched_at: NOW,
    };

    // Block A persists the ask under the real kind. The composer registers
    // that handler on block A too, so to reach the answered-but-unhandled
    // crash state we record the answer DIRECTLY through a bare store —
    // bypassing block A's dispatch, exactly as a crash between "answer
    // recorded" and "handler ran" would leave it.
    const busA = recordingBus();
    const { ask_id } = await compose(db, dir, busA.bus).block.ask(
      { text: 'Did the send complete?' },
      [{ id: 'retry', label: 'No — retry' }],
      { kind: IN_DOUBT_HANDLER_KIND, payload: inDoubtPayload },
    );
    const bareStore = createAskStore(
      createSQLiteCollection<PendingAsk>(db, 'pending_asks'),
    );
    await bareStore.recordAnswer(ask_id, { option: 'retry', answered_at: NOW }, 'ui');

    // Block B rebuilds over the same db — the composer RE-registers the real
    // in-doubt handler. Boot recovery must re-dispatch the persisted ask to
    // it (proving the production registration is restart-durable), producing
    // the in-doubt annotation effect.
    const busB = recordingBus();
    const blockB = compose(db, dir, busB.bus);

    await recoverNotificationBlockAtBoot({
      block: blockB.block,
      checkpointStore: blockB.checkpointStore,
      auditLog: blockB.auditLog,
    });

    const rows = await blockB.annotationStore.annotationsForRecord(
      IN_DOUBT_TARGET_COLLECTION,
      'commit-1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: IN_DOUBT_ANNOTATION_KEY,
      value: {
        answer: 'retry',
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
      },
    });
    // The real production handler ran to completion → terminal.
    expect((await bareStore.get(ask_id))?.status).toBe('handled');
  });
});
