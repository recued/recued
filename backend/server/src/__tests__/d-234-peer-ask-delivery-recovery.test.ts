import Database from 'better-sqlite3';
import type { Checkpoint } from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  createGatedActionStore,
  type GatedActionRecord,
} from '../gated-action-store.js';
import {
  journalOwnsInterruptedPeerDispatch,
  recoverPeerAskDelivery,
  settleLocallyEndedPeerDeliveryReceipt,
  type PeerAskDeliveryOutcome,
} from '../peer-ask-delivery-recovery.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import {
  createPeerAskOutboxStore,
  type PeerAskOutboxStageRow,
} from '../storage/peer-ask-outbox-store.js';

const NOW = 1_700_000_000_000;
const REF = 'a'.repeat(64);

const checkpoint = (): Checkpoint => ({
  checkpoint_id: 'peer-checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'peer-step',
  step_state: {},
  created_at: NOW,
});

const stage = (): PeerAskOutboxStageRow => ({
  exchange_ref: REF,
  run_id: 'run-1',
  gated_step_id: 'peer-step',
  checkpoint_id: 'peer-checkpoint-1',
  action_ref: 'action-1',
  connection: 'peer-bob',
  label: 'review',
  offered: ['yes'],
  created_at: NOW,
  delivery: {
    recipient_fingerprint: 'recipient-1',
    spec: {
      connection: 'peer-bob',
      label: 'review',
      question: 'Ship it?',
      options: [{ id: 'yes', label: 'Yes' }],
      on_timeout: 'wait',
      via: 'direct',
    },
  },
});

const awaiting = (status: 'awaiting_approval' | 'awaiting_peer'): AuditEntry =>
  buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'hash-1',
    commit_status: status,
    duration_ms: 1,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    run_id: 'run-1',
    checkpoint_id: status === 'awaiting_peer' ? 'peer-checkpoint-1' : 'approval-checkpoint-1',
    now: NOW,
  });

const harness = async (anchor?: AuditEntry) => {
  const db = new Database(':memory:');
  const outbox = createPeerAskOutboxStore(db);
  const answers = createPeerAnswerStore(db);
  const checkpoints = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  await checkpoints.write(checkpoint());
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  if (anchor !== undefined) await auditLog.append(anchor);
  const gatedActions = createGatedActionStore(
    createInMemoryCollection<GatedActionRecord>(),
    { now: () => NOW, newActionRef: () => 'action-1' },
  );
  const held = await gatedActions.createHeld({
    run_id: 'run-1',
    recipe_id: 'recipe-1',
    gated_step_id: 'peer-step',
    checkpoint_id: 'approval-checkpoint-1',
  });
  await gatedActions.markDispatching(held.action_ref);
  const deliver = vi.fn(async (): Promise<PeerAskDeliveryOutcome> => ({
    kind: 'dispatched' as const,
    status_message: 'handed off',
    result: { exchange_ref: REF, status: 'dispatched' },
  }));
  return {
    db,
    outbox,
    answers,
    checkpoints,
    auditLog,
    gatedActions,
    deliver,
    deps: {
      outbox,
      answers,
      checkpoints,
      auditLog,
      gatedActions,
      deliver,
      now: () => NOW + 100,
      log: () => {},
    },
  };
};

describe('peer ask delivery power-cut recovery', () => {
  it('retires a staged P2 plan when power fails before the awaiting_peer anchor', async () => {
    const h = await harness(awaiting('awaiting_approval'));
    h.outbox.stage(stage());

    await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, {
      ...h.deps,
      retireUnanchoredStaged: true,
    });

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.outbox.getDelivery(REF)).toBeNull();
    expect(await h.checkpoints.listByRun('run-1')).toEqual([]);
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('in_doubt');
    expect((await h.gatedActions.get('action-1'))?.status).toBe('in_doubt');
  });

  it('does not let a stale staged row terminalize a superseding action checkpoint', async () => {
    const h = await harness(awaiting('awaiting_approval'));
    h.outbox.stage(stage());
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'later-checkpoint');

    await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, {
      ...h.deps,
      retireUnanchoredStaged: true,
    });

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.outbox.getDelivery(REF)).toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('awaiting_approval');
    expect(await h.gatedActions.get('action-1')).toMatchObject({
      status: 'dispatching',
      current_checkpoint_id: 'later-checkpoint',
    });
  });

  it('activates and sends the exact staged plan after the anchor committed', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());

    const result = await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(result.kind).toBe('delivered');
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.outbox.getDelivery(REF)).toMatchObject({ delivery_state: 'delivered' });
    expect((await h.gatedActions.get('action-1'))?.status).toBe('dispatched');
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('awaiting_peer');
  });

  it('re-sends after activation committed but transport never started', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);

    await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.outbox.getDelivery(REF)?.delivery_state).toBe('delivered');
  });

  it('activates but does not send a question whose deadline elapsed before boot', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    const expired = stage();
    h.outbox.stage({
      ...expired,
      deadline_at: NOW,
      delivery: {
        ...expired.delivery,
        spec: {
          ...expired.delivery.spec,
          deadline_at: NOW,
          on_timeout: 'stop',
        },
      },
    });

    const result = await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(result.kind).toBe('not_ready');
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.outbox.getDelivery(REF)?.delivery_state).toBe('pending');
    expect((await h.gatedActions.get('action-1'))?.status).toBe('dispatching');
  });

  it('repairs a delivered handoff receipt without sending a second question', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);
    h.outbox.markDelivered(REF);

    await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(h.deliver).not.toHaveBeenCalled();
    expect((await h.gatedActions.get('action-1'))?.status).toBe('dispatched');
  });

  it('lets an authenticated answer that arrived during send beat refusal', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);
    h.deliver.mockImplementationOnce(async () => {
      h.answers.record({
        exchange_ref: REF,
        peer_contract_id: 'peer-contract-1',
        answered: true,
        option: 'yes',
        at: NOW,
      });
      return {
        kind: 'failed',
        status_message: 'refused',
        result: {
          exchange_ref: REF,
          status: 'failed',
          refusal: 'label_not_exposed',
          reason: 'not exposed',
        },
      } as const;
    });

    const result = await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(result.kind).toBe('deferred');
    expect(h.outbox.getDelivery(REF)?.delivery_state).toBe('pending');
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('awaiting_peer');
    expect((await h.gatedActions.get('action-1'))?.status).toBe('dispatching');
  });

  it('finishes refusal after the terminal audit committed then threw', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);
    h.deliver.mockResolvedValueOnce({
      kind: 'failed',
      status_message: 'refused',
      result: {
        exchange_ref: REF,
        status: 'failed',
        refusal: 'label_not_exposed',
        reason: 'not exposed',
      },
    });
    const append = h.auditLog.append.bind(h.auditLog);
    vi.spyOn(h.auditLog, 'append').mockImplementationOnce(async (entry) => {
      await append(entry);
      throw new Error('commit acknowledgement lost');
    });

    const result = await recoverPeerAskDelivery(h.outbox.getDelivery(REF)!, h.deps);

    expect(result.kind).toBe('refused');
    expect(h.outbox.getDelivery(REF)).toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('failed');
    expect((await h.gatedActions.get('action-1'))?.status).toBe('failed');
  });

  it('fails closed and retires a corrupted pending plan at boot', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);
    h.db.prepare('UPDATE peer_ask_outbox SET delivery_json = ? WHERE exchange_ref = ?')
      .run('{"spec":', REF);
    const corrupted = h.outbox.getDelivery(REF)!;

    await recoverPeerAskDelivery(corrupted, {
      ...h.deps,
      retireUnanchoredStaged: true,
    });

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.outbox.get(REF)).toBeNull();
    expect(h.outbox.getDelivery(REF)).toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('in_doubt');
    expect((await h.gatedActions.get('action-1'))?.status).toBe('in_doubt');
  });

  it('preserves generic dispatch recovery only for the exact journal action/checkpoint', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    const action = (await h.gatedActions.get('action-1'))!;

    await expect(journalOwnsInterruptedPeerDispatch(action, h.deps)).resolves.toBe(true);
    await expect(journalOwnsInterruptedPeerDispatch(
      { ...action, current_checkpoint_id: 'different' },
      h.deps,
    )).resolves.toBe(false);
    await expect(journalOwnsInterruptedPeerDispatch(
      { ...action, action_ref: 'different' },
      h.deps,
    )).resolves.toBe(false);
  });

  it('settles a locally-ended pending handoff in_doubt before its journal closes', async () => {
    const h = await harness(awaiting('awaiting_peer'));
    await h.gatedActions.bindDispatchCheckpoint('action-1', 'peer-checkpoint-1');
    h.outbox.stage(stage());
    h.outbox.activate(REF);

    await settleLocallyEndedPeerDeliveryReceipt(
      h.outbox.getDelivery(REF)!,
      'timed_out',
      h.gatedActions,
    );

    expect(await h.gatedActions.get('action-1')).toMatchObject({
      status: 'in_doubt',
      result: { reason: 'peer_timeout_before_verified_delivery' },
    });
  });
});
