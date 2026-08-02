import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import Database from 'better-sqlite3';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  MCP_ACTION_TABLE,
  createMcpActionStore,
  createSqliteMcpActionCompareAndSet,
  isMcpActionRecord,
  projectMcpActionPublicState,
  type McpActionRecord,
} from '../mcp-action-store.js';

describe('MCP async action store', () => {
  it('mints an opaque token-bound action and hides wrong-principal lookups', async () => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      now: () => 100,
      newActionRef: () => 'mcpact_test',
    });

    const action = await store.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'mail.send',
      kind: 'recipe',
      checkpoint_id: 'cp-1',
    });

    expect(action).toMatchObject({
      action_ref: 'mcpact_test',
      run_id: 'run-1',
      principal_id: 'token-a',
      status: 'awaiting_approval',
      approval_round: 1,
      revision: 1,
    });
    expect(await store.getOwned(action.action_ref, 'token-a')).toEqual(action);
    expect(await store.getOwned(action.action_ref, 'token-b')).toBeNull();
    expect(projectMcpActionPublicState(action)).not.toHaveProperty('principal_id');
  });

  it('keeps one action_ref across another downstream approval gate', async () => {
    let now = 100;
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      now: () => now,
      newActionRef: () => 'mcpact_one_invocation',
    });
    const first = await store.createHeld({
      run_id: 'run-multi',
      principal_id: 'token-a',
      tool_name: 'seller/onboard',
      kind: 'recipe',
      checkpoint_id: 'cp-1',
    });
    now = 200;
    await store.markRunning('run-multi');
    now = 300;
    const second = await store.markAwaiting('run-multi', 'cp-2');

    expect(second).toMatchObject({
      action_ref: first.action_ref,
      current_checkpoint_id: 'cp-2',
      status: 'awaiting_approval',
      approval_round: 2,
      revision: 3,
    });
  });

  it('does not invent another approval round while recovering the same gate', async () => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_same_gate',
    });
    await store.createHeld({
      run_id: 'run-same-gate',
      principal_id: 'token-a',
      tool_name: 'seller/send',
      kind: 'recipe',
    });
    await store.markRunning('run-same-gate');
    const recovered = await store.markAwaiting('run-same-gate', 'cp-original');
    await store.markRunning('run-same-gate');
    const retried = await store.markAwaiting('run-same-gate', 'cp-original');

    expect(recovered?.approval_round).toBe(1);
    expect(retried?.approval_round).toBe(1);
  });

  it('makes terminal state immutable under an at-least-once answer retry', async () => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      now: () => 100,
      newActionRef: () => 'mcpact_terminal',
    });
    await store.createHeld({
      run_id: 'run-terminal',
      principal_id: 'token-a',
      tool_name: 'mail.send',
      kind: 'recipe',
    });
    const completed = await store.finish('run-terminal', {
      status: 'completed',
      status_message: 'done',
      result: { message_id: 'm-1' },
    });
    const lateFailure = await store.finish('run-terminal', {
      status: 'failed',
      status_message: 'late retry',
      result: { error: true },
    });
    await store.markRunning('run-terminal');

    expect(lateFailure).toEqual(completed);
    expect(await store.getByRun('run-terminal')).toEqual(completed);
  });

  it('prevents a second SQLite process from overwriting terminal state', async () => {
    const db = new Database(':memory:');
    try {
      const storeA = createMcpActionStore(
        createSQLiteCollection<McpActionRecord>(db, MCP_ACTION_TABLE),
        {
          newActionRef: () => 'mcpact_cas',
          compareAndSet: createSqliteMcpActionCompareAndSet(db),
        },
      );
      const storeB = createMcpActionStore(
        createSQLiteCollection<McpActionRecord>(db, MCP_ACTION_TABLE),
        { compareAndSet: createSqliteMcpActionCompareAndSet(db) },
      );
      await storeA.createHeld({
        run_id: 'run-cas',
        principal_id: 'token-a',
        tool_name: 'mail.send',
        kind: 'recipe',
        checkpoint_id: 'cp-1',
      });

      await Promise.all([
        storeA.finish('run-cas', {
          status: 'completed',
          status_message: 'exact result retained',
          result: { message_id: 'msg-exact' },
        }),
        storeB.markAwaiting('run-cas', 'cp-stale'),
      ]);

      const final = await storeB.getByRun('run-cas');
      expect(final).toMatchObject({
        status: 'completed',
        status_message: 'exact result retained',
        result: { message_id: 'msg-exact' },
      });
    } finally {
      db.close();
    }
  });

  it('bounds retained result size and expires only terminal records', async () => {
    let now = 10;
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      now: () => now,
      newActionRef: () => 'mcpact_bounded',
      maxResultBytes: 32,
      terminalRetentionMs: 50,
    });
    const action = await store.createHeld({
      run_id: 'run-bounded',
      principal_id: 'token-a',
      tool_name: 'large.result',
      kind: 'recipe',
    });
    now = 20;
    const completed = await store.finish('run-bounded', {
      status: 'completed',
      status_message: 'done',
      result: { body: 'x'.repeat(200) },
    });

    expect(completed?.result_omitted_reason).toBe('size_limit');
    expect(completed?.result).toMatchObject({ result_available: false });
    now = 69;
    expect(await store.getOwned(action.action_ref, 'token-a')).not.toBeNull();
    now = 70;
    expect(await store.getOwned(action.action_ref, 'token-a')).toBeNull();
  });

  it('replaces an undefined deferred result with an explicit receipt', async () => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_undefined',
    });
    await store.createHeld({
      run_id: 'run-undefined',
      principal_id: 'token-a',
      tool_name: 'void.operation',
      kind: 'raw_op',
    });
    const completed = await store.finish('run-undefined', {
      status: 'completed',
      status_message: 'done',
      result: undefined,
    });

    expect(completed).toMatchObject({
      result_omitted_reason: 'not_serializable',
      result: { result_available: false },
    });
  });

  it('publishes persisted revisions while swallowing observer failures', async () => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_events',
    });
    const observer = vi.fn();
    store.subscribe(() => { throw new Error('observer-only'); });
    store.subscribe(observer);

    await store.createHeld({
      run_id: 'run-events',
      principal_id: 'token-a',
      tool_name: 'mail.send',
      kind: 'recipe',
    });
    await store.markRunning('run-events');

    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[0]?.[0]).toMatchObject({ kind: 'created' });
    expect(observer.mock.calls[1]?.[0]).toMatchObject({
      kind: 'updated',
      record: { revision: 2, status: 'running' },
    });
  });

  it('rejects malformed generic-table rows at the narrowing boundary', () => {
    expect(isMcpActionRecord({
      schema_version: 1,
      action_ref: 'mcpact_x',
      run_id: 'run-x',
      principal_id: 'token-a',
      tool_name: 'mail.send',
      kind: 'recipe',
      status: 'completed',
      status_message: 'done',
      approval_round: 1,
      created_at: 1,
      updated_at: 2,
      revision: 2,
      // Terminal state without terminal_at/expires_at is corrupt.
    })).toBe(false);
  });
});
