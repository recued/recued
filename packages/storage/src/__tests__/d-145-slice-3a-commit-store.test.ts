/** D-145 engine-wiring slice 3a — D-153 atomic commit store. */

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

describe('createCommitStore writePending', () => {
  it('stores a sanitized pending row and get round-trips it', async () => {
    const clean = pendingInput({ commit_id: 'commit-pending' });
    const dirty = {
      ...clean,
      status: 'succeeded',
      output: { provider_id: 'msg-1' },
      completed_at: clean.dispatched_at + 25,
      duration_ms: 25,
    } as unknown as PendingCommitInput;

    await store.writePending(dirty);

    expect(await store.get('commit-pending')).toEqual({
      ...clean,
      status: 'pending',
    });
  });

  it('throws when commit_id already exists', async () => {
    await store.writePending(pendingInput({ commit_id: 'duplicate' }));

    await expect(store.writePending(pendingInput({ commit_id: 'duplicate' })))
      .rejects.toThrow(/already written/);
  });
});

describe('createCommitStore recordOutcome', () => {
  it('transitions a pending commit to a terminal status and derives duration', async () => {
    const input = pendingInput({
      commit_id: 'commit-success',
      dispatched_at: 1_700_000_000_000,
    });
    await store.writePending(input);

    await store.recordOutcome('commit-success', {
      status: 'succeeded',
      output: { provider_id: 'msg-1' },
      completed_at: 1_700_000_000_350,
    });

    expect(await store.get('commit-success')).toEqual({
      ...input,
      status: 'succeeded',
      output: { provider_id: 'msg-1' },
      completed_at: 1_700_000_000_350,
      duration_ms: 350,
    });
  });

  it('omits output when absent but stores explicit null output', async () => {
    await store.writePending(pendingInput({ commit_id: 'no-output' }));
    await store.recordOutcome('no-output', {
      status: 'failed',
      completed_at: 1_700_000_000_200,
    });

    const noOutput = await store.get('no-output');
    expect(noOutput).toMatchObject({ commit_id: 'no-output', status: 'failed' });
    expect(noOutput).not.toHaveProperty('output');

    await store.writePending(pendingInput({ commit_id: 'null-output' }));
    await store.recordOutcome('null-output', {
      status: 'cancelled',
      output: null,
      completed_at: 1_700_000_000_300,
    });

    expect(await store.get('null-output')).toHaveProperty('output', null);
  });

  it('throws for unknown commit_id and already-terminal commits', async () => {
    await expect(store.recordOutcome('missing', {
      status: 'failed',
      completed_at: 1_700_000_000_100,
    })).rejects.toThrow(/not found/);

    await store.writePending(pendingInput({ commit_id: 'once-only' }));
    await store.recordOutcome('once-only', {
      status: 'succeeded',
      completed_at: 1_700_000_000_100,
    });

    await expect(store.recordOutcome('once-only', {
      status: 'failed',
      completed_at: 1_700_000_000_200,
    })).rejects.toThrow(/already terminal/);
  });
});

describe('createCommitStore sweepPendingToInDoubt', () => {
  it('sweeps pending and running commits without fabricating completion timing', async () => {
    await backing.set('pending-old', commit({
      commit_id: 'pending-old',
      status: 'pending',
      dispatched_at: 100,
      completed_at: 900,
      duration_ms: 800,
    }));
    await backing.set('running-new', commit({
      commit_id: 'running-new',
      status: 'running',
      dispatched_at: 200,
      completed_at: 950,
      duration_ms: 750,
    }));
    await backing.set('terminal', commit({
      commit_id: 'terminal',
      status: 'succeeded',
      dispatched_at: 50,
      completed_at: 75,
      duration_ms: 25,
    }));

    const swept = await store.sweepPendingToInDoubt();

    expect(swept.map((c) => c.commit_id)).toEqual(['pending-old', 'running-new']);
    for (const row of swept) {
      expect(row.status).toBe('in_doubt');
      expect(row).not.toHaveProperty('completed_at');
      expect(row).not.toHaveProperty('duration_ms');
      expect(await store.get(row.commit_id)).toEqual(row);
    }
    expect(await store.get('terminal')).toMatchObject({
      commit_id: 'terminal',
      status: 'succeeded',
      completed_at: 75,
      duration_ms: 25,
    });
  });

  it('is idempotent after the first sweep', async () => {
    await backing.set('pending', commit({
      commit_id: 'pending',
      status: 'pending',
      dispatched_at: 100,
    }));

    expect((await store.sweepPendingToInDoubt()).map((c) => c.commit_id))
      .toEqual(['pending']);
    expect(await store.sweepPendingToInDoubt()).toEqual([]);
  });
});

describe('createCommitStore list queries', () => {
  it('filters tier queries, orders newest dispatch first, respects limit, and rejects empty ids', async () => {
    const rows: Commit[] = [
      commit({
        commit_id: 'old',
        dispatched_at: 100,
        correlation_id: 'corr-a',
        channel_session_id: 'channel-a',
        cognition_session_id: 'cog-a',
      }),
      commit({
        commit_id: 'mid',
        dispatched_at: 200,
        correlation_id: 'corr-a',
        channel_session_id: 'channel-b',
        cognition_session_id: 'cog-a',
      }),
      commit({
        commit_id: 'new',
        dispatched_at: 300,
        correlation_id: 'corr-a',
        channel_session_id: 'channel-a',
        cognition_session_id: 'cog-b',
      }),
      commit({
        commit_id: 'other',
        dispatched_at: 400,
        correlation_id: 'corr-b',
        channel_session_id: 'channel-b',
        cognition_session_id: 'cog-a',
      }),
    ];
    for (const row of rows) await backing.set(row.commit_id, row);

    expect((await store.listByCorrelation('corr-a')).map((c) => c.commit_id))
      .toEqual(['new', 'mid', 'old']);
    expect((await store.listByCorrelation('corr-a', 2)).map((c) => c.commit_id))
      .toEqual(['new', 'mid']);
    expect(await store.listByCorrelation('')).toEqual([]);

    expect((await store.listByChannelSession('channel-a')).map((c) => c.commit_id))
      .toEqual(['new', 'old']);
    expect((await store.listByChannelSession('channel-a', 1)).map((c) => c.commit_id))
      .toEqual(['new']);
    expect(await store.listByChannelSession('')).toEqual([]);

    expect((await store.listByCognitionSession('cog-a')).map((c) => c.commit_id))
      .toEqual(['other', 'mid', 'old']);
    expect((await store.listByCognitionSession('cog-a', 2)).map((c) => c.commit_id))
      .toEqual(['other', 'mid']);
    expect(await store.listByCognitionSession('')).toEqual([]);
  });

  it('listByRun filters by request_id, orders newest dispatch first, respects limit, and rejects empty run ids', async () => {
    const rows: Commit[] = [
      commit({
        commit_id: 'old-run-a',
        request_id: 'run-a',
        dispatched_at: 100,
      }),
      commit({
        commit_id: 'new-run-a',
        request_id: 'run-a',
        dispatched_at: 300,
      }),
      commit({
        commit_id: 'other-run',
        request_id: 'run-b',
        dispatched_at: 400,
      }),
      commit({
        commit_id: 'mid-run-a',
        request_id: 'run-a',
        dispatched_at: 200,
      }),
    ];
    for (const row of rows) await backing.set(row.commit_id, row);

    expect((await store.listByRun('run-a')).map((c) => c.commit_id))
      .toEqual(['new-run-a', 'mid-run-a', 'old-run-a']);
    expect((await store.listByRun('run-a', 2)).map((c) => c.commit_id))
      .toEqual(['new-run-a', 'mid-run-a']);
    expect(await store.listByRun('')).toEqual([]);
  });

  it('listPending returns only non-terminal commits oldest dispatch first', async () => {
    const rows: Commit[] = [
      commit({ commit_id: 'terminal', status: 'failed', dispatched_at: 50 }),
      commit({ commit_id: 'pending-old', status: 'pending', dispatched_at: 100 }),
      commit({ commit_id: 'running-mid', status: 'running', dispatched_at: 200 }),
      commit({ commit_id: 'pending-new', status: 'pending', dispatched_at: 300 }),
    ];
    for (const row of rows) await backing.set(row.commit_id, row);

    expect((await store.listPending()).map((c) => c.commit_id))
      .toEqual(['pending-old', 'running-mid', 'pending-new']);
  });

  it('size reflects the total commit count', async () => {
    expect(await store.size()).toBe(0);
    await store.writePending(pendingInput({ commit_id: 'a' }));
    await store.writePending(pendingInput({ commit_id: 'b' }));
    expect(await store.size()).toBe(2);
  });
});
