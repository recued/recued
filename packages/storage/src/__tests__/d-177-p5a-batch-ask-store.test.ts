/** D-177 P5a BatchAskStore lifecycle tests. */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  BatchAskKey,
  BatchAskRecord,
  ExecutionSource,
} from '@recued/contracts';
import {
  createBatchAskStore,
  type BatchAskStore,
  type NewBatchAskMember,
} from '../batch-asks.js';
import { createInMemoryCollection } from '../in-memory.js';

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  turn_id: 'turn-1',
});

const key = (overrides: Partial<BatchAskKey> = {}): BatchAskKey => ({
  unit: { kind: 'turn', id: 'turn:turn-1' },
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat-1',
  risk_tier: 'write',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-1',
  ...overrides,
});

const row = (
  overrides: Partial<
    Omit<
      BatchAskRecord,
      'state' | 'payload_version' | 'member_seq' | 'members' | 'updated_at'
    >
  > = {},
): Parameters<BatchAskStore['create']>[0] => ({
  batch_id: 'batch-1',
  unit_kind: 'turn',
  unit_id: 'turn:turn-1',
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat-1',
  risk_tier: 'write',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-1',
  source: source(),
  current_ask_id: 'ask-v1',
  created_at: 1000,
  ...overrides,
});

const member = (
  overrides: Partial<NewBatchAskMember> = {},
): NewBatchAskMember => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  canonical_payload_hash: 'payload-1',
  summary: 'to=ada@example.com',
  args_preview: { to: 'ada@example.com' },
  ...overrides,
});

let store: BatchAskStore;

beforeEach(() => {
  store = createBatchAskStore(createInMemoryCollection<BatchAskRecord>());
});

const createRow = async (
  batch_id = 'batch-1',
): Promise<BatchAskRecord> =>
  store.create(
    row({
      batch_id,
      current_ask_id: `${batch_id}-ask-v1`,
    }),
    member({
      checkpoint_id: `${batch_id}-checkpoint-1`,
      run_id: `${batch_id}-run-1`,
      canonical_payload_hash: `${batch_id}-payload-1`,
    }),
  );

describe('BatchAskStore create/find', () => {
  it('creates a row once with version 1 and member m1', async () => {
    const created = await createRow();

    expect(created).toMatchObject({
      batch_id: 'batch-1',
      state: 'open',
      payload_version: 1,
      member_seq: 1,
      updated_at: 1000,
    });
    expect(created.members).toEqual([
      expect.objectContaining({
        member_id: 'm1',
        checkpoint_id: 'batch-1-checkpoint-1',
        run_id: 'batch-1-run-1',
      }),
    ]);
    expect(await store.get('batch-1')).toEqual(created);
    await expect(createRow()).rejects.toThrow(/already exists/);
  });

  it('findOpenByKey filters by open state and every key facet', async () => {
    const created = await createRow();

    expect(await store.findOpenByKey(key())).toEqual(created);
    expect(
      await store.findOpenByKey(key({ arg_shape_hash: 'arg-shape-2' })),
    ).toBeNull();
    expect(
      await store.findOpenByKey(key({ operation_id: undefined })),
    ).toBeNull();

    await store.terminalize('batch-1');

    expect(await store.findOpenByKey(key())).toBeNull();
  });
});

describe('BatchAskStore addMember/setCurrentAsk', () => {
  it('adds members with bumped versions and monotonic m2 ids', async () => {
    await createRow();

    const joined = await store.addMember(
      'batch-1',
      member({
        checkpoint_id: 'checkpoint-2',
        run_id: 'run-2',
        canonical_payload_hash: 'payload-2',
        summary: 'to=grace@example.com',
      }),
      2000,
    );

    expect(joined).toMatchObject({
      kind: 'joined',
      member_id: 'm2',
      row: {
        payload_version: 2,
        member_seq: 2,
        updated_at: 2000,
      },
    });
    expect(joined.kind === 'joined' ? joined.row.members.map((m) => m.member_id) : [])
      .toEqual(['m1', 'm2']);
  });

  it('returns not_open when addMember targets a closed row or unknown id', async () => {
    await createRow();
    await store.close('batch-1', 1, 'approve', 3000);

    await expect(store.addMember('batch-1', member(), 4000)).resolves.toEqual({
      kind: 'not_open',
    });
    await expect(store.addMember('missing', member(), 4000)).resolves.toEqual({
      kind: 'not_open',
    });
  });

  it('updates current_ask_id for known rows and no-ops for unknown rows', async () => {
    await createRow();

    await store.setCurrentAsk('batch-1', 'ask-v2');
    await store.setCurrentAsk('missing', 'ask-never');

    expect(await store.get('batch-1')).toMatchObject({
      current_ask_id: 'ask-v2',
    });
  });
});

describe('BatchAskStore close/markAnswered', () => {
  it('closes only the matching open version and records answer metadata', async () => {
    await createRow();

    await expect(store.close('batch-1', 2, 'approve', 3000)).resolves.toEqual({
      kind: 'stale',
    });

    const closed = await store.close('batch-1', 1, 'approve', 3000);

    expect(closed).toMatchObject({
      kind: 'closed',
      row: {
        state: 'closing',
        answer_option: 'approve',
        answered_version: 1,
        answered_at: 3000,
        updated_at: 3000,
      },
    });
  });

  it('re-enters only for the same version and option, and reports not_found', async () => {
    await createRow();
    await store.close('batch-1', 1, 'approve', 3000);

    expect(await store.close('batch-1', 1, 'approve', 4000)).toMatchObject({
      kind: 'reentry',
      row: {
        answer_option: 'approve',
        answered_version: 1,
      },
    });
    expect(await store.close('batch-1', 1, 'deny', 4000)).toEqual({
      kind: 'stale',
    });
    expect(await store.close('batch-1', 2, 'approve', 4000)).toEqual({
      kind: 'stale',
    });
    expect(await store.close('missing', 1, 'approve', 4000)).toEqual({
      kind: 'not_found',
    });
  });

  it('marks answered idempotently', async () => {
    await createRow();
    await store.close('batch-1', 1, 'deny', 3000);

    await store.markAnswered('batch-1');
    await store.markAnswered('batch-1');
    await store.markAnswered('missing');

    expect(await store.get('batch-1')).toMatchObject({
      state: 'answered',
      answer_option: 'deny',
    });
  });
});

describe('BatchAskStore removeMember/terminalize/list', () => {
  it('rolls back only the last member and restores the payload version', async () => {
    await createRow();
    await store.addMember('batch-1', member({ checkpoint_id: 'checkpoint-2' }), 2000);
    await store.addMember('batch-1', member({ checkpoint_id: 'checkpoint-3' }), 3000);

    await expect(store.removeMember('batch-1', 'm2')).resolves.toBe(
      'not_rolled_back',
    );
    await expect(store.removeMember('batch-1', 'm3')).resolves.toBe('rolled_back');

    expect(await store.get('batch-1')).toMatchObject({
      payload_version: 2,
      member_seq: 3,
      members: [
        expect.objectContaining({ member_id: 'm1' }),
        expect.objectContaining({ member_id: 'm2' }),
      ],
    });

    await expect(store.removeMember('batch-1', 'm2')).resolves.toBe('rolled_back');
    expect(await store.get('batch-1')).toMatchObject({
      payload_version: 1,
      member_seq: 3,
      members: [expect.objectContaining({ member_id: 'm1' })],
    });
    await expect(store.removeMember('batch-1', 'm1')).resolves.toBe(
      'not_rolled_back',
    );
  });

  it('guards rollback for unknown or non-open rows', async () => {
    await createRow();
    await store.close('batch-1', 1, 'approve', 3000);

    await expect(store.removeMember('batch-1', 'm1')).resolves.toBe(
      'not_rolled_back',
    );
    await expect(store.removeMember('missing', 'm1')).resolves.toBe(
      'not_rolled_back',
    );
  });

  it('terminalizes only open rows and lists oldest first', async () => {
    await createRow('batch-new');
    await store.create(row({ batch_id: 'batch-old', created_at: 500 }), member());
    await store.close('batch-new', 1, 'approve', 3000);

    await store.terminalize('batch-old');
    await store.terminalize('batch-new');
    await store.terminalize('missing');

    expect(await store.get('batch-old')).toMatchObject({ state: 'answered' });
    expect(await store.get('batch-new')).toMatchObject({ state: 'closing' });
    expect((await store.list()).map((r) => r.batch_id)).toEqual([
      'batch-old',
      'batch-new',
    ]);
  });
});
