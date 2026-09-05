import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';

import { createRpcDispatcher } from '../rpc-dispatcher.js';
import {
  handleGatedActionGet,
  handleGatedActionList,
  makeExecutionFeedHandlers,
  type ExecutionFeedRpcDeps,
} from '../execution-feed-handler.js';
import {
  createGatedActionStore,
  type GatedActionRecord,
} from '../gated-action-store.js';
import type { WsClient } from '../ws-server.js';

const client = (instance_id: string | null): WsClient => ({
  ...(instance_id !== null ? { instance_id } : {}),
} as unknown as WsClient);

describe('execution.action RPC', () => {
  it('returns the full stable approval group even when receipt pagination selects one member', async () => {
    let now = 100;
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        now: () => now,
        newActionRef: () => `action-${sequence += 1}`,
      },
    );
    const first = await store.createHeld({
      run_id: 'run-1',
      gated_step_id: 'send-one',
      checkpoint_id: 'checkpoint-1',
    });
    now += 1;
    const second = await store.createHeld({
      run_id: 'run-2',
      gated_step_id: 'send-two',
      checkpoint_id: 'checkpoint-2',
    });
    now += 1;
    await store.linkApproval(first.action_ref, 'batch-1', 'ask-v2');
    now += 1;
    await store.linkApproval(second.action_ref, 'batch-1', 'ask-v2');
    now += 1;
    await store.finish(first.action_ref, {
      status: 'succeeded',
      status_message: 'Completed.',
      result: { id: 'message-1' },
      observed: { items: 1, succeeded: 1, failed: 0 },
    });
    now += 1;
    await store.finish(second.action_ref, {
      status: 'failed',
      status_message: 'Refused.',
      result: { error: 'refused' },
      observed: { items: 1, succeeded: 0, failed: 1 },
    });
    const deps = { gatedActionStore: store } as unknown as ExecutionFeedRpcDeps;

    const listed = await handleGatedActionList(deps, { limit: 1 });

    expect(listed.receipts).toHaveLength(1);
    expect(listed.receipts[0]?.action_ref).toBe(second.action_ref);
    expect(listed.receipts[0]).not.toHaveProperty('result');
    expect(listed.groups).toEqual([
      expect.objectContaining({
        approval_ref: 'batch-1',
        status: 'partial',
        terminal: true,
        action_refs: [second.action_ref, first.action_ref],
        items: 2,
        succeeded: 1,
        failed: 1,
      }),
    ]);

    const fetched = await handleGatedActionGet(deps, {
      action_ref: first.action_ref,
    });
    expect(fetched.receipt.result).toEqual({ id: 'message-1' });
    expect(fetched.group.action_refs).toEqual([second.action_ref, first.action_ref]);
  });

  it('keeps action receipts behind the paired-owner RPC gate', async () => {
    const get = async () => {
      throw new Error('must not read');
    };
    const deps = {
      gatedActionStore: { get },
    } as unknown as ExecutionFeedRpcDeps;
    const slice = makeExecutionFeedHandlers(deps)!;
    const dispatch = createRpcDispatcher(slice.handlers as never, {});

    const result = await dispatch(
      'execution.action.get',
      { action_ref: 'action-1' },
      client(null),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });

  it('keyset-pages every terminal receipt without overlap', async () => {
    let now = 100;
    let sequence = 0;
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        now: () => now,
        newActionRef: () => `action-${sequence += 1}`,
      },
    );
    for (let index = 1; index <= 5; index += 1) {
      now = 100 + index;
      const held = await store.createHeld({
        run_id: `run-${index}`,
        gated_step_id: 'send',
        checkpoint_id: `checkpoint-${index}`,
      });
      await store.finish(held.action_ref, {
        status: 'succeeded',
        status_message: 'Completed.',
        result: { ok: true },
        observed: { items: 1, succeeded: 1, failed: 0 },
      });
    }
    const deps = { gatedActionStore: store } as unknown as ExecutionFeedRpcDeps;
    const seen: string[] = [];
    let before: NonNullable<Parameters<typeof handleGatedActionList>[1]>['before'];
    do {
      const page = await handleGatedActionList(deps, {
        status: ['succeeded'],
        limit: 2,
        ...(before !== undefined ? { before } : {}),
      });
      seen.push(...page.receipts.map((row) => row.action_ref));
      before = page.next_cursor;
    } while (before !== undefined);

    expect(seen).toEqual([
      'action-5',
      'action-4',
      'action-3',
      'action-2',
      'action-1',
    ]);
    expect(new Set(seen).size).toBe(5);
  });

  it('resumes an old-epoch cursor at the restored lineage floor', async () => {
    const backing = createInMemoryCollection<GatedActionRecord>();
    await backing.set('restored-action', {
      schema_version: 1,
      action_ref: 'restored-action',
      approval_ref: 'restored-action',
      run_id: 'restored-run',
      gated_step_id: 'send',
      status: 'succeeded',
      status_message: 'Inherited completion.',
      current_checkpoint_id: 'restored-checkpoint',
      created_at: 1,
      updated_at: 1,
      change_seq: 5,
      revision: 2,
      terminal_at: 1,
      expires_at: Number.MAX_SAFE_INTEGER,
      result: { ok: true },
    });
    let sequence = 10;
    const store = createGatedActionStore(backing, {
      newActionRef: () => 'new-action',
      nextChangeSeq: async () => sequence += 1,
      changeClock: () => ({ epoch: 'restored-epoch', floor: 10 }),
    });
    const held = await store.createHeld({
      run_id: 'new-run', gated_step_id: 'send', checkpoint_id: 'new-checkpoint',
    });
    await store.finish(held.action_ref, {
      status: 'succeeded',
      status_message: 'Post-restore completion.',
      result: { ok: true },
    });

    const listed = await handleGatedActionList(
      { gatedActionStore: store } as unknown as ExecutionFeedRpcDeps,
      { since_change_epoch: 'displaced-epoch', since_change_seq: 100 },
    );

    expect(listed).toMatchObject({
      change_epoch: 'restored-epoch',
      change_floor: 10,
    });
    expect(listed.receipts.map((row) => row.action_ref)).toEqual(['new-action']);
  });

  it('rejects malformed action filters and missing stores', async () => {
    const store = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
    );
    const deps = { gatedActionStore: store } as unknown as ExecutionFeedRpcDeps;

    await expect(handleGatedActionList(deps, { status: ['unknown' as never] }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleGatedActionList(deps, {
      before: { change_seq: Number.NaN, action_ref: '' },
    }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleGatedActionList(deps, { since_change_epoch: '' }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleGatedActionList(deps, { since_change_seq: -1 }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleGatedActionGet(deps, { action_ref: '' }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleGatedActionList({} as ExecutionFeedRpcDeps, {}))
      .rejects.toMatchObject({ code: 'not_configured', status: 503 });
  });
});
