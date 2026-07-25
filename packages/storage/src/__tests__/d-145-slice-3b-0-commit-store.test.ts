/** D-145 engine-wiring slice 3b.0 - D-153 commit shape lock store. */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Commit, ExecutionSource } from '@recued/contracts';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitStore,
  type PendingCommitInput,
} from '../index.js';

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const pendingInput = (
  overrides: Partial<PendingCommitInput> = {},
): PendingCommitInput => ({
  commit_id: 'commit-1',
  kind: 'action',
  ingredient: 'mail',
  tool: 'send',
  args: { to: 'ada@example.com' },
  source: source(),
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  request_id: 'request-1',
  cognition_session_id: 'cog-1',
  predecessor_commit_id: 'commit-0',
  dispatch_depth: 1,
  idempotency_key: 'idem-1',
  dispatched_at: 1_700_000_000_000,
  ...overrides,
});

const commit = (overrides: Partial<Commit> = {}): Commit => ({
  ...pendingInput({ commit_id: overrides.commit_id ?? 'commit-1' }),
  status: 'pending',
  ...overrides,
});

let backing: Collection<Commit>;
let store: CommitStore;

beforeEach(() => {
  backing = createInMemoryCollection<Commit>();
  store = createCommitStore(backing);
});

describe('createCommitStore writePending 3b.0 fields', () => {
  it('strips cached and detail from dirty pending rows', async () => {
    const clean = pendingInput({ commit_id: 'commit-pending' });
    const dirty = {
      ...clean,
      cached: true,
      detail: { x: 1 },
    } as unknown as PendingCommitInput;

    await store.writePending(dirty);

    expect(await store.get('commit-pending')).toEqual({
      ...clean,
      status: 'pending',
    });
  });
});

describe('createCommitStore recordOutcome 3b.0 fields', () => {
  it('stores cached true when the outcome includes cached true', async () => {
    const input = pendingInput({ commit_id: 'commit-cached' });
    await store.writePending(input);

    await store.recordOutcome('commit-cached', {
      status: 'succeeded',
      completed_at: 1_700_000_000_125,
      cached: true,
    });

    expect(await store.get('commit-cached')).toEqual({
      ...input,
      status: 'succeeded',
      completed_at: 1_700_000_000_125,
      duration_ms: 125,
      cached: true,
    });
  });

  it('stores detail when the outcome includes detail', async () => {
    const input = pendingInput({ commit_id: 'commit-detail' });
    await store.writePending(input);

    await store.recordOutcome('commit-detail', {
      status: 'succeeded',
      completed_at: 1_700_000_000_225,
      detail: { code: 'ok' },
    });

    expect(await store.get('commit-detail')).toEqual({
      ...input,
      status: 'succeeded',
      completed_at: 1_700_000_000_225,
      duration_ms: 225,
      detail: { code: 'ok' },
    });
  });

  it('omits cached when the outcome omits cached', async () => {
    await store.writePending(pendingInput({ commit_id: 'commit-no-cached' }));

    await store.recordOutcome('commit-no-cached', {
      status: 'succeeded',
      completed_at: 1_700_000_000_325,
    });

    const row = await store.get('commit-no-cached');
    expect(row).toMatchObject({
      commit_id: 'commit-no-cached',
      status: 'succeeded',
    });
    expect(row).not.toHaveProperty('cached');
  });

  it('omits detail when the outcome omits detail', async () => {
    await store.writePending(pendingInput({ commit_id: 'commit-no-detail' }));

    await store.recordOutcome('commit-no-detail', {
      status: 'succeeded',
      completed_at: 1_700_000_000_425,
    });

    const row = await store.get('commit-no-detail');
    expect(row).toMatchObject({
      commit_id: 'commit-no-detail',
      status: 'succeeded',
    });
    expect(row).not.toHaveProperty('detail');
  });

  it('stores cached true and detail when the outcome includes both', async () => {
    const input = pendingInput({ commit_id: 'commit-both' });
    await store.writePending(input);

    await store.recordOutcome('commit-both', {
      status: 'succeeded',
      completed_at: 1_700_000_000_525,
      cached: true,
      detail: { code: 'ok' },
    });

    expect(await store.get('commit-both')).toEqual({
      ...input,
      status: 'succeeded',
      completed_at: 1_700_000_000_525,
      duration_ms: 525,
      cached: true,
      detail: { code: 'ok' },
    });
  });
});

describe('createCommitStore sweepPendingToInDoubt 3b.0 fields', () => {
  it('strips cached and detail from swept non-terminal rows', async () => {
    await backing.set('pending-dirty', commit({
      commit_id: 'pending-dirty',
      status: 'pending',
      cached: true,
      detail: { x: 1 },
    }));

    const swept = await store.sweepPendingToInDoubt();

    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      commit_id: 'pending-dirty',
      status: 'in_doubt',
    });
    expect(swept[0]).not.toHaveProperty('cached');
    expect(swept[0]).not.toHaveProperty('detail');
    expect(await store.get('pending-dirty')).toEqual(swept[0]);
  });
});
