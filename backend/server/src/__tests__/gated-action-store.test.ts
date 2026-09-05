import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createInMemoryCollection } from '@recued/storage';

import {
  createGatedActionStore,
  createSqliteGatedActionChangeClock,
  createSqliteGatedActionChangeSequence,
  createSqliteGatedActionCompareAndSet,
  gatedActionHandoffFromResult,
  projectGatedActionApprovalGroup,
  projectGatedActionReceipt,
  reconcileInterruptedGatedActionsAtBoot,
  type GatedActionRecord,
} from '../gated-action-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

describe('GatedActionStore', () => {
  it('keeps one receipt per run and gated step while allowing several in one run', async () => {
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${sequence += 1}`, now: () => 100 },
    );

    const first = await store.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });
    const rerendered = await store.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-2',
    });
    const second = await store.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'update-crm',
      checkpoint_id: 'checkpoint-3',
    });

    expect(rerendered).toMatchObject({
      action_ref: first.action_ref,
      current_checkpoint_id: 'checkpoint-2',
      revision: 2,
    });
    expect(second.action_ref).not.toBe(first.action_ref);
    expect(await store.list()).toHaveLength(2);
  });

  it('tracks approval re-renders without changing the stable batch group', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-1', now: () => 100 },
    );
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });

    await store.linkApproval(held.action_ref, 'batch-1', 'ask-v1');
    const rerendered = await store.linkApproval(held.action_ref, 'batch-1', 'ask-v2');

    expect(rerendered).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-v2',
    });
    expect(rerendered?.action_ref).toBe(held.action_ref);
  });

  it('starts a new decision group when the same step receives a new checkpoint', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-1', now: () => 100 },
    );
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });
    await store.linkApproval(held.action_ref, 'batch-1', 'ask-v1');

    const renewed = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-2',
    });

    expect(renewed).toMatchObject({
      action_ref: 'action-1',
      approval_ref: 'action-1',
      current_checkpoint_id: 'checkpoint-2',
    });
    expect(renewed).not.toHaveProperty('current_ask_id');
  });

  it('creates a distinct receipt for a later approval segment in the same foreach step', async () => {
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${sequence += 1}`, now: () => 100 },
    );
    const first = await store.createHeld({
      run_id: 'run-segmented',
      gated_step_id: 'send-team',
      checkpoint_id: 'checkpoint-segment-1',
    });
    await store.claimDispatch(first.action_ref, {
      checkpoint_id: 'checkpoint-segment-1',
      attempt_id: 'attempt-segment-1',
    });

    const second = await store.createHeld({
      run_id: 'run-segmented',
      gated_step_id: 'send-team',
      checkpoint_id: 'checkpoint-segment-2',
      predecessor_action_ref: first.action_ref,
    });
    const recovered = await store.createHeld({
      run_id: 'run-segmented',
      gated_step_id: 'send-team',
      checkpoint_id: 'checkpoint-segment-2',
      predecessor_action_ref: first.action_ref,
    });

    expect(second).toMatchObject({
      action_ref: 'action-2',
      current_checkpoint_id: 'checkpoint-segment-2',
      status: 'awaiting_approval',
    });
    expect(recovered.action_ref).toBe(second.action_ref);
    expect((await store.get(first.action_ref))?.status).toBe('dispatching');
    await store.finish(first.action_ref, {
      status: 'succeeded',
      status_message: 'The first segment completed.',
      result: { sent: 'a' },
      observed: { items: 1, succeeded: 1, failed: 0 },
    });
    // A late predecessor mutation has a newer change_seq, but the chain leaf
    // remains the current same-step segment.
    expect((await store.getBySubject('run-segmented', 'send-team'))?.action_ref)
      .toBe(second.action_ref);
    expect(await store.list()).toHaveLength(2);
  });

  it('does not let same-checkpoint create recovery reopen a claimed dispatch', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-claimed' },
    );
    const held = await store.createHeld({
      run_id: 'run-claimed', gated_step_id: 'send-mail', checkpoint_id: 'checkpoint-1',
    });
    await store.claimDispatch(held.action_ref, {
      checkpoint_id: 'checkpoint-1', attempt_id: 'attempt-1',
    });

    const recovered = await store.createHeld({
      run_id: 'run-claimed', gated_step_id: 'send-mail', checkpoint_id: 'checkpoint-1',
    });

    expect(recovered).toMatchObject({
      status: 'dispatching',
      current_checkpoint_id: 'checkpoint-1',
      dispatch_attempt_id: 'attempt-1',
    });
  });

  it('atomically converges concurrent SQLite creators on one subject receipt', async () => {
    const db = new Database(':memory:');
    try {
      const backingA = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      const backingB = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      const storeA = createGatedActionStore(backingA, {
        compareAndSet: createSqliteGatedActionCompareAndSet(db),
      });
      const storeB = createGatedActionStore(backingB, {
        compareAndSet: createSqliteGatedActionCompareAndSet(db),
      });

      const [first, second] = await Promise.all([
        storeA.createHeld({
          run_id: 'run-shared',
          gated_step_id: 'send-mail',
          checkpoint_id: 'checkpoint-1',
        }),
        storeB.createHeld({
          run_id: 'run-shared',
          gated_step_id: 'send-mail',
          checkpoint_id: 'checkpoint-1',
        }),
      ]);

      expect(first.action_ref).toBe(second.action_ref);
      expect(await backingA.list()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('lets exactly one durable dispatch attempt claim an awaiting checkpoint', async () => {
    const db = new Database(':memory:');
    try {
      const backingA = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      const backingB = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      const storeA = createGatedActionStore(backingA, {
        compareAndSet: createSqliteGatedActionCompareAndSet(db),
      });
      const storeB = createGatedActionStore(backingB, {
        compareAndSet: createSqliteGatedActionCompareAndSet(db),
      });
      const held = await storeA.createHeld({
        run_id: 'run-claim',
        gated_step_id: 'send-mail',
        checkpoint_id: 'checkpoint-claim',
      });

      const claims = await Promise.all([
        storeA.claimDispatch(held.action_ref, {
          checkpoint_id: 'checkpoint-claim', attempt_id: 'attempt-a',
        }),
        storeB.claimDispatch(held.action_ref, {
          checkpoint_id: 'checkpoint-claim', attempt_id: 'attempt-b',
        }),
      ]);

      expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
      expect(claims.filter((claim) => claim.kind === 'not_claimed')).toHaveLength(1);
      expect((await storeA.get(held.action_ref))?.dispatch_attempt_id).toBe(
        claims.find((claim) => claim.kind === 'claimed')?.record.dispatch_attempt_id,
      );
    } finally {
      db.close();
    }
  });

  it('recognizes its own dispatch claim when the adapter throws after commit', async () => {
    const backing = createInMemoryCollection<GatedActionRecord>();
    const store = createGatedActionStore(backing, {
      newActionRef: () => 'action-postcommit',
      compareAndSet: async (actionRef, expectedRevision, next) => {
        await backing.set(actionRef, next);
        if (expectedRevision > 0) throw new Error('adapter reported after commit');
        return true;
      },
    });
    const held = await store.createHeld({
      run_id: 'run-postcommit',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-postcommit',
    });

    await expect(store.claimDispatch(held.action_ref, {
      checkpoint_id: 'checkpoint-postcommit',
      attempt_id: 'attempt-postcommit',
    })).resolves.toMatchObject({
      kind: 'claimed',
      record: { status: 'dispatching', dispatch_attempt_id: 'attempt-postcommit' },
    });
  });

  it('recognizes handoff-shaped data only under trusted handoff settlement metadata', () => {
    const providerData = { mode: 'detached', launched: true };

    expect(gatedActionHandoffFromResult(
      providerData,
      'action-1',
      'returned_result',
    )).toBeUndefined();
    expect(gatedActionHandoffFromResult(
      providerData,
      'action-1',
      'durable_handoff',
    )).toEqual({ kind: 'deferred_execution', ref: 'action-1' });
  });

  it('aggregates every item and handoff covered by one approval', async () => {
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${sequence += 1}`, now: () => 100 },
    );
    const bulk = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'mail-team',
      checkpoint_id: 'checkpoint-1',
    });
    const detached = await store.createHeld({
      run_id: 'run-2',
      gated_step_id: 'start-export',
      checkpoint_id: 'checkpoint-2',
    });
    await store.linkApproval(bulk.action_ref, 'batch-1', 'ask-v2');
    await store.linkApproval(detached.action_ref, 'batch-1', 'ask-v2');
    await store.finish(bulk.action_ref, {
      status: 'partial',
      status_message: '2 of 3 approved items completed.',
      result: [
        { ok: true, id: 'm1' },
        { ok: false, error: 'refused' },
        { ok: true, id: 'm3' },
      ],
      observed: { items: 3, succeeded: 2, failed: 1 },
    });
    await store.finish(detached.action_ref, {
      status: 'dispatched',
      status_message: 'The export was handed off.',
      result: { delivery: 'deferred', continuation_ref: 'job-1' },
      observed: { items: 1, succeeded: 0, failed: 0 },
      handoff: { kind: 'deferred_execution', ref: 'job-1' },
    });

    const receipts = (await store.list()).map((record) =>
      projectGatedActionReceipt(record),
    );
    const group = projectGatedActionApprovalGroup(receipts);

    expect(group).toEqual({
      approval_ref: 'batch-1',
      status: 'partial',
      terminal: true,
      status_message: '3 of 4 approved items completed or were handed off.',
      action_refs: ['action-2', 'action-1'],
      items: 4,
      succeeded: 2,
      failed: 1,
      dispatched: 1,
      denied: 0,
      cancelled: 0,
      in_doubt: 0,
      updated_at: 100,
      change_seq: 6,
    });
    expect(receipts.find((receipt) => receipt.action_ref === bulk.action_ref)?.result)
      .toEqual([
        { ok: true, id: 'm1' },
        { ok: false, error: 'refused' },
        { ok: true, id: 'm3' },
      ]);
  });

  it('preserves explicit partial and failed outcomes when observed counts are absent or zero', () => {
    const base = {
      action_ref: 'action-1',
      approval_ref: 'approval-1',
      run_id: 'run-1',
      gated_step_id: 'step-1',
      terminal: true,
      status_message: 'settled',
      created_at: 1,
      updated_at: 2,
      change_seq: 3,
      revision: 2,
    } as const;

    expect(projectGatedActionApprovalGroup([{
      ...base,
      status: 'partial',
    }]).status).toBe('partial');
    expect(projectGatedActionApprovalGroup([{
      ...base,
      status: 'failed',
      observed: { items: 0, succeeded: 0, failed: 0 },
    }]).status).toBe('failed');
    expect(projectGatedActionApprovalGroup([{
      ...base,
      status: 'succeeded',
      status_message: 'Committed; processing remains unconfirmed.',
      observed: { items: 6, succeeded: 5, failed: 1 },
    }])).toMatchObject({
      status: 'succeeded',
      status_message: 'Committed; processing remains unconfirmed.',
      items: 6,
      succeeded: 5,
      failed: 1,
    });
  });

  it('bounds retained results and keeps terminal transitions immutable', async () => {
    const listener = vi.fn();
    let now = 100;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => 'action-1',
        now: () => now,
        maxResultBytes: 12,
        terminalRetentionMs: 50,
      },
    );
    store.subscribe(listener);
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });
    const finished = await store.finish(held.action_ref, {
      status: 'succeeded',
      status_message: 'Completed.',
      result: { payload: 'too large to retain' },
      observed: { items: 1, succeeded: 1, failed: 0 },
    });
    const unchanged = await store.finish(held.action_ref, {
      status: 'failed',
      status_message: 'Must not overwrite a terminal outcome.',
      result: { error: true },
    });

    expect(finished).toMatchObject({
      status: 'succeeded',
      result: { result_available: false },
      result_omitted_reason: 'size_limit',
      terminal_at: 100,
      expires_at: 150,
    });
    expect(unchanged).toEqual(finished);
    expect(listener).toHaveBeenCalledTimes(2);

    now = 150;
    expect(await store.get(held.action_ref)).toBeNull();
  });

  it('expires a terminal approval group atomically at its last member horizon', async () => {
    let now = 100;
    let actionSequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => `action-${actionSequence += 1}`,
        now: () => now,
        terminalRetentionMs: 50,
      },
    );
    const first = await store.createHeld({
      run_id: 'run-1', gated_step_id: 'send-1', checkpoint_id: 'checkpoint-1',
    });
    const second = await store.createHeld({
      run_id: 'run-2', gated_step_id: 'send-2', checkpoint_id: 'checkpoint-2',
    });
    await store.linkApproval(first.action_ref, 'batch-1', 'ask-1');
    await store.linkApproval(second.action_ref, 'batch-1', 'ask-1');
    await store.finish(first.action_ref, {
      status: 'succeeded',
      status_message: 'First completed.',
      result: { ok: true },
    });
    now = 125;
    await store.finish(second.action_ref, {
      status: 'succeeded',
      status_message: 'Second completed.',
      result: { ok: true },
    });

    now = 150;
    expect(await store.get(first.action_ref)).not.toBeNull();
    expect(await store.list()).toHaveLength(2);

    now = 175;
    expect(await store.list()).toEqual([]);
    expect(await store.get(second.action_ref)).toBeNull();
  });

  it('seeds and shares the durable SQLite change sequence across store handles', async () => {
    const db = new Database(':memory:');
    try {
      const backing = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      await backing.set('seed-action', {
        schema_version: 1,
        action_ref: 'seed-action',
        approval_ref: 'seed-action',
        run_id: 'seed-run',
        gated_step_id: 'seed-step',
        status: 'awaiting_approval',
        status_message: 'Waiting.',
        current_checkpoint_id: 'seed-checkpoint',
        settlement_mode: 'returned_result',
        created_at: 1,
        updated_at: 1,
        change_seq: 41,
        revision: 1,
      });

      const firstProcessHandle = createSqliteGatedActionChangeSequence(db);
      const secondStoreHandle = createSqliteGatedActionChangeSequence(db);
      expect(await firstProcessHandle()).toBe(42);
      expect(await secondStoreHandle()).toBe(43);
      expect(await createSqliteGatedActionChangeSequence(db)()).toBe(44);
    } finally {
      db.close();
    }
  });

  it('rotates a restored SQLite lineage above every inherited receipt sequence', async () => {
    const db = new Database(':memory:');
    try {
      const backing = createSQLiteCollection<GatedActionRecord>(db, 'gated_action_receipts');
      await backing.set('seed-action', {
        schema_version: 1,
        action_ref: 'seed-action',
        approval_ref: 'seed-action',
        run_id: 'seed-run',
        gated_step_id: 'seed-step',
        status: 'awaiting_approval',
        status_message: 'Waiting.',
        current_checkpoint_id: 'seed-checkpoint',
        created_at: 1,
        updated_at: 1,
        change_seq: 41,
        revision: 1,
      });
      const epochs = ['epoch-a', 'epoch-b'];
      const clock = createSqliteGatedActionChangeClock(db, {
        newEpoch: () => epochs.shift() ?? 'unexpected',
      });

      expect(clock.snapshot()).toEqual({ epoch: 'epoch-a', floor: 0 });
      expect(clock.rotateEpoch()).toEqual({ epoch: 'epoch-b', floor: 42 });
      await expect(clock.nextChangeSeq()).resolves.toBe(43);
      expect(createSqliteGatedActionChangeClock(db).snapshot()).toEqual({
        epoch: 'epoch-b',
        floor: 42,
      });
    } finally {
      db.close();
    }
  });

  it('accepts concurrently completed change-clock columns by postcondition', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE gated_action_change_sequence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          value INTEGER NOT NULL CHECK (value >= 0)
        );
        INSERT INTO gated_action_change_sequence (singleton, value) VALUES (1, 9);
      `);
      const exec = db.exec.bind(db);
      const intercepted = new Set<string>();
      const racingDb = new Proxy(db, {
        get(target, property) {
          if (property === 'exec') {
            return (sql: string) => {
              const column = sql.includes('ADD COLUMN epoch')
                ? 'epoch'
                : sql.includes('ADD COLUMN floor')
                  ? 'floor'
                  : undefined;
              if (column !== undefined && !intercepted.has(column)) {
                intercepted.add(column);
                exec(sql);
                throw new Error(`duplicate column name: ${column}`);
              }
              return exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Database.Database;

      const clock = createSqliteGatedActionChangeClock(racingDb, {
        newEpoch: () => 'upgraded-epoch',
      });

      expect(intercepted).toEqual(new Set(['epoch', 'floor']));
      expect(clock.snapshot()).toEqual({ epoch: 'upgraded-epoch', floor: 10 });
      await expect(clock.nextChangeSeq()).resolves.toBe(11);
    } finally {
      db.close();
    }
  });

  it('does not let a late ask render rewrite a terminal receipt group', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-1', now: () => 100 },
    );
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });
    await store.linkApproval(held.action_ref, 'batch-1', 'ask-v1');
    const finished = await store.finish(held.action_ref, {
      status: 'succeeded',
      status_message: 'Completed.',
      result: { ok: true },
      observed: { items: 1, succeeded: 1, failed: 0 },
    });

    const unchanged = await store.linkApproval(
      held.action_ref,
      'late-batch',
      'ask-v2',
    );

    expect(unchanged).toEqual(finished);
    expect(unchanged).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-v1',
      status: 'succeeded',
    });
  });

  it('cannot reopen a receipt that another process terminalized after a stale read', async () => {
    const backing = createInMemoryCollection<GatedActionRecord>();
    let injectedTerminal = false;
    const store = createGatedActionStore(backing, {
      newActionRef: () => 'action-1',
      now: () => 100,
      compareAndSet: async (actionRef, expectedRevision, next) => {
        if (expectedRevision === 0) {
          if (await backing.has(actionRef)) return false;
          await backing.set(actionRef, next);
          return true;
        }
        if (!injectedTerminal) {
          injectedTerminal = true;
          const current = await backing.get(actionRef);
          if (current === null) throw new Error('missing test receipt');
          await backing.set(actionRef, {
            ...current,
            status: 'succeeded',
            status_message: 'Completed in another process.',
            revision: expectedRevision + 1,
            terminal_at: 100,
            expires_at: 200,
            result: { ok: true },
            observed: { items: 1, succeeded: 1, failed: 0 },
          });
          return false;
        }
        await backing.set(actionRef, next);
        return true;
      },
    });
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });

    const observed = await store.markDispatching(held.action_ref);

    expect(observed).toMatchObject({
      status: 'succeeded',
      revision: 2,
      result: { ok: true },
    });
    expect(await store.get(held.action_ref)).toMatchObject({
      status: 'succeeded',
      revision: 2,
    });
  });

  it('turns only restart-interrupted dispatches into durable in-doubt outcomes', async () => {
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${sequence += 1}`, now: () => 100 },
    );
    const interrupted = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-mail',
      checkpoint_id: 'checkpoint-1',
    });
    const untouched = await store.createHeld({
      run_id: 'run-2',
      gated_step_id: 'update-crm',
      checkpoint_id: 'checkpoint-2',
    });
    await store.markDispatching(interrupted.action_ref);

    await expect(reconcileInterruptedGatedActionsAtBoot(store)).resolves.toBe(1);

    expect(await store.get(interrupted.action_ref)).toMatchObject({
      status: 'in_doubt',
      result: { reason: 'server_restarted_while_dispatching' },
    });
    expect(await store.get(untouched.action_ref)).toMatchObject({
      status: 'awaiting_approval',
    });
    await expect(reconcileInterruptedGatedActionsAtBoot(store)).resolves.toBe(0);
  });

  it('preserves a dispatch backed by a separately durable replay journal', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-journaled', now: () => 100 },
    );
    const held = await store.createHeld({
      run_id: 'run-journaled',
      gated_step_id: 'peer-question',
      checkpoint_id: 'checkpoint-journaled',
    });
    await store.markDispatching(held.action_ref);

    await expect(reconcileInterruptedGatedActionsAtBoot(store, {
      preserve: (record) => record.action_ref === held.action_ref,
    })).resolves.toBe(0);
    expect(await store.get(held.action_ref)).toMatchObject({ status: 'dispatching' });
  });

  it('does not let late peer evidence rewrite a terminal restart outcome', async () => {
    let index = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${index += 1}`, now: () => 200 },
    );
    const interrupted = await store.createHeld({
      run_id: 'run-interrupted',
      gated_step_id: 'peer-question',
      checkpoint_id: 'checkpoint-interrupted',
    });
    const conflicting = await store.createHeld({
      run_id: 'run-conflicting',
      gated_step_id: 'peer-question',
      checkpoint_id: 'checkpoint-conflicting',
    });
    await store.markDispatching(interrupted.action_ref);
    await store.finish(conflicting.action_ref, {
      status: 'in_doubt',
      status_message: 'Restart interrupted peer delivery.',
      result: {
        reason: 'server_restarted_while_dispatching',
        exchange_ref: 'another-exchange',
      },
    });
    await reconcileInterruptedGatedActionsAtBoot(store);

    await expect(store.confirmPeerHandoff(interrupted.action_ref, {
      run_id: 'run-interrupted',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-interrupted',
    })).resolves.toMatchObject({
      status: 'in_doubt',
      result: { reason: 'server_restarted_while_dispatching' },
    });
    await expect(store.confirmPeerHandoff(conflicting.action_ref, {
      run_id: 'run-conflicting',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-conflicting',
    })).resolves.toMatchObject({
      status: 'in_doubt',
      result: { exchange_ref: 'another-exchange' },
    });
  });

  it('keeps an in-doubt terminal receipt immutable after authenticated peer evidence', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-1', now: () => 200 },
    );
    const held = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'peer-question',
      checkpoint_id: 'checkpoint-1',
    });
    await store.finish(held.action_ref, {
      status: 'in_doubt',
      status_message: 'Peer delivery was uncertain.',
      result: {
        exchange_ref: 'exchange-1',
        status: 'in_doubt',
        reason: 'peer_delivery_threw',
      },
    });

    await expect(store.confirmPeerHandoff(held.action_ref, {
      run_id: 'another-run',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-1',
    })).resolves.toMatchObject({ status: 'in_doubt' });
    await expect(store.confirmPeerHandoff(held.action_ref, {
      run_id: 'run-1',
      gated_step_id: 'peer-question',
      exchange_ref: 'another-exchange',
    })).resolves.toMatchObject({ status: 'in_doubt' });

    const confirmed = await store.confirmPeerHandoff(held.action_ref, {
      run_id: 'run-1',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-1',
    });
    expect(confirmed).toMatchObject({
      status: 'in_doubt',
      result: {
        exchange_ref: 'exchange-1',
        status: 'in_doubt',
      },
    });
    const repeated = await store.confirmPeerHandoff(held.action_ref, {
      run_id: 'run-1',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-1',
    });
    expect(repeated?.revision).toBe(confirmed?.revision);
  });

  it('lets a fast authenticated answer confirm a dispatching receipt with no result yet', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-fast-answer', now: () => 200 },
    );
    const held = await store.createHeld({
      run_id: 'run-fast',
      gated_step_id: 'peer-question',
      checkpoint_id: 'checkpoint-fast',
    });
    await store.markDispatching(held.action_ref);

    await expect(store.confirmPeerHandoff(held.action_ref, {
      run_id: 'run-fast',
      gated_step_id: 'peer-question',
      exchange_ref: 'exchange-fast',
    })).resolves.toMatchObject({
      status: 'dispatched',
      result: {
        exchange_ref: 'exchange-fast',
        confirmed_by: 'authenticated_peer_answer',
      },
      handoff: { kind: 'peer_exchange', ref: 'exchange-fast' },
    });
  });

  it('does not rewrite either recognized or unrelated terminal peer failures', async () => {
    let index = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-${index += 1}`, now: () => 200 },
    );
    const recognized = await store.createHeld({
      run_id: 'run-1', gated_step_id: 'peer-one', checkpoint_id: 'checkpoint-1',
    });
    const unrelated = await store.createHeld({
      run_id: 'run-2', gated_step_id: 'peer-two', checkpoint_id: 'checkpoint-2',
    });
    await store.finish(recognized.action_ref, {
      status: 'failed',
      status_message: 'Outbox write failed.',
      result: {
        exchange_ref: 'exchange-1',
        status: 'failed',
        reason: 'peer_outbox_write_failed',
      },
    });
    await store.finish(unrelated.action_ref, {
      status: 'failed',
      status_message: 'Provider failed.',
      result: { exchange_ref: 'exchange-2', status: 'failed', reason: 'provider_failed' },
    });

    await expect(store.confirmPeerHandoff(recognized.action_ref, {
      run_id: 'run-1', gated_step_id: 'peer-one', exchange_ref: 'exchange-1',
    })).resolves.toMatchObject({ status: 'failed' });
    await expect(store.confirmPeerHandoff(unrelated.action_ref, {
      run_id: 'run-2', gated_step_id: 'peer-two', exchange_ref: 'exchange-2',
    })).resolves.toMatchObject({ status: 'failed' });
  });
});
