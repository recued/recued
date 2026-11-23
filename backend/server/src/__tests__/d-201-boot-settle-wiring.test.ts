/** D-201 Slice 10BJ (10BF finding 11) — the production start hands its
 *  continuation store to the settle of approved steps a held run kept
 *  (`settleReturnedApprovedDispatchesAtBoot`). Every test of that settle called
 *  it, or `recoverNotificationBlockAtBoot`, directly: with the boot step's hand
 *  off undone, all of them stayed green, and a death after an approved write
 *  froze its receipt in doubt beside a run that goes on past it.
 *
 *  The other half, the store built over the server's database and spread into
 *  this step, is pinned beside that runtime
 *  (`serve-start-lifecycle-recovery-pre-listener-runtime.test.ts`). */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import {
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import type { Lifecycle } from '../lifecycle/index.js';
import { createLifecycleStateMachine } from '../lifecycle/lifecycle-state.js';
import type { NotificationBlock } from '@recued/notification';
import { startBootRecoveryAndAdapters } from '../serve/start-boot-recovery-and-adapters.js';
import { createApprovalRestartContinuationStore } from '../storage/approval-restart-continuation-store.js';

const RUN = 'run-boot-settle';
const CHECKPOINT = 'ckpt-boot-settle';

/** A held run's approved step under way at a death: its receipt still
 *  dispatching, and the row its run wrote ahead of the next step saying the
 *  step came back. */
const diedPastTheApprovedStep = async () => {
  const db = new Database(':memory:');
  const receipts = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
  const held = await receipts.createHeld({ run_id: RUN, gated_step_id: 'remove', checkpoint_id: CHECKPOINT });
  await receipts.claimDispatch(held.action_ref, { checkpoint_id: CHECKPOINT, attempt_id: 'attempt-1' });
  const continuations = createApprovalRestartContinuationStore(db);
  continuations.put({
    checkpoint_id: CHECKPOINT,
    run_id: RUN,
    gated_step_id: 'remove',
    value: { deleted: true },
    later: [],
    held: {
      checkpoint: { checkpoint_id: CHECKPOINT, run_id: RUN, gated_step_id: 'remove', step_state: {} } as unknown as Checkpoint,
      anchor: { run_id: RUN, commit_status: 'awaiting_approval' } as unknown as AuditEntry,
      approved_returned: true,
      step_in_doubt: 'notify',
    },
  });
  return { db, receipts, continuations, actionRef: held.action_ref };
};

/** The boot's recovery step, as the server runs it. */
const boot = async (
  receipts: ReturnType<typeof createGatedActionStore>,
  continuations: ReturnType<typeof createApprovalRestartContinuationStore> | undefined,
): Promise<void> => {
  await startBootRecoveryAndAdapters({
    lifecycle: { machine: createLifecycleStateMachine('booting') } as unknown as Lifecycle,
    bootSigningIdentity: async () => undefined,
    notificationBlock: {
      listUnresolvedAsks: async () => [],
      recoverPendingAsks: async () => undefined,
    } as unknown as NotificationBlock,
    checkpointStore: createCheckpointStore(createInMemoryCollection<Checkpoint>()),
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    gatedActionStore: receipts,
    ...(continuations !== undefined ? { approvalRestartContinuations: continuations } : {}),
    commitStore: undefined,
    fileStack: undefined,
    collection: { startCollectionAdapters: async () => undefined },
    warn: () => undefined,
  });
};

describe('D-201 Slice 10BJ — the start hands its continuation store to the settle (10BF finding 11)', () => {
  it('a receipt a held run says came back is settled from the row at the boot, never frozen in doubt', async () => {
    const world = await diedPastTheApprovedStep();
    await boot(world.receipts, world.continuations);
    // Undone, the boot froze it: `in_doubt`, "server_restarted_while_dispatching".
    expect(await world.receipts.get(world.actionRef)).toMatchObject({ status: 'succeeded' });
    world.db.close();
  });

  it('without the store, the same receipt is frozen in doubt: what the case above tells apart', async () => {
    const world = await diedPastTheApprovedStep();
    await boot(world.receipts, undefined);
    expect(await world.receipts.get(world.actionRef)).toMatchObject({ status: 'in_doubt' });
    world.db.close();
  });
});
