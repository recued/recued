/** Durable Chat action recovery.
 *
 * A reviewed action survives reloads and process restarts as history, never as
 * executable work. The atomic spend seeds `running`; a new server process
 * reconciles that ambiguous state to `unknown`, requiring a verify-first retry.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ChatPlanProposal } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import {
  ChatVaultLockedError,
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';

const sessionId = 'session-action-recovery';

const seedSession = (
  db: Database.Database,
  getKey?: () => Uint8Array | null,
): ReturnType<typeof createChatStore> => {
  const chat = createChatStore(db, getKey);
  chat.createSession({ id: sessionId, now: 1_000 });
  return chat;
};

const proposal = (
  overrides: Partial<ChatPlanProposal> = {},
): ChatPlanProposal => {
  const args = overrides.args ?? {
    to: 'owner@example.com',
    subject: 'Recovery check',
    body: 'Send once',
  };
  return {
    plan_id: 'plan-action-recovery',
    session_id: sessionId,
    turn_id: 'turn-proposal',
    tool: 'mail.send',
    tier: 1,
    classification: 'write',
    args,
    args_hash: planApproval.computePlanArgsHash(args),
    status: 'proposed',
    created_at: 2_000,
    ...overrides,
  };
};

describe('durable Chat action recovery', () => {
  it('adds retry lineage to an existing durable plan table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chat_plans (
        plan_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        message_id TEXT,
        tool TEXT NOT NULL,
        tier INTEGER NOT NULL,
        classification TEXT NOT NULL,
        args_encrypted TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        target_instance TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        consumed_at INTEGER,
        execution_status TEXT,
        execution_turn_id TEXT,
        execution_blob_encrypted TEXT,
        execution_updated_at INTEGER
      );
    `);

    expect(() => ensureChatSchema(db)).not.toThrow();
    const columns = new Set(
      (db.prepare('PRAGMA table_info(chat_plans)').all() as Array<{
        name: string;
      }>).map((row) => row.name),
    );
    expect(columns.has('retry_of_plan_id')).toBe(true);
    expect(
      (db.prepare(`
        SELECT COUNT(*) AS count
          FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_chat_plans_retry_origin'
      `).get() as { count: number }).count,
    ).toBe(1);
  });

  it('round-trips the reviewed plan, message link, and terminal receipt', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chat = seedSession(db);
    const firstProcess = createSqliteChatPlanStore(db, undefined, () => 9_000);
    const plan = proposal();

    await firstProcess.put(plan);
    await firstProcess.resolve(plan.plan_id, 'approved', 3_000);
    const spent = await firstProcess.consumeForDispatch!(
      plan.plan_id,
      4_000,
      'turn-execution',
    );
    expect(spent?.consumed_at).toBe(4_000);
    await chat.appendMessage({
      id: 'message-proposal',
      session_id: sessionId,
      role: 'assistant',
      content: 'This action needs approval.',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: {
          server_kind: 'recued',
          version: '1.0.0',
          instance_id: 'test-instance',
        },
      },
      model_used: { provider: 'test', model_id: 'test-model' },
      ts: 5_000,
    });
    chat.createSession({ id: 'session-other', now: 5_100 });
    await chat.appendMessage({
      id: 'message-other-session',
      session_id: 'session-other',
      role: 'assistant',
      content: 'Different thread.',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: {
          server_kind: 'recued',
          version: '1.0.0',
          instance_id: 'test-instance',
        },
      },
      model_used: { provider: 'test', model_id: 'test-model' },
      ts: 5_200,
    });
    await firstProcess.linkTurnToMessage!(
      sessionId,
      plan.turn_id,
      'message-other-session',
    );
    expect(
      db.prepare(`
        SELECT message_id FROM chat_plans WHERE plan_id = ?
      `).get(plan.plan_id),
    ).toEqual({ message_id: null });
    await firstProcess.linkTurnToMessage!(
      sessionId,
      plan.turn_id,
      'message-proposal',
    );
    const completed = {
      status: 'completed' as const,
      turn_id: 'turn-execution',
      result_ref: 'result:mail:1',
      run_id: 'run-mail-1',
    };
    await firstProcess.recordExecution!(plan.plan_id, completed);

    // Rebuilding the store models a server restart. Terminal truth is stable
    // and a late/replayed start cannot regress it.
    const secondProcess = createSqliteChatPlanStore(db, undefined, () => 10_000);
    expect(
      await secondProcess.recordExecution!(plan.plan_id, {
        status: 'running',
        turn_id: 'turn-execution',
      }),
    ).toEqual(completed);
    expect(await secondProcess.listForSession!(sessionId)).toEqual([
      {
        plan: {
          ...plan,
          status: 'approved',
          resolved_at: 3_000,
          consumed_at: 4_000,
        },
        message_id: 'message-proposal',
        execution: completed,
        payload_available: true,
      },
    ]);
  });

  it('atomically spends once and recovers an interrupted run as unknown', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    seedSession(db);
    const firstProcess = createSqliteChatPlanStore(db, undefined, () => 8_000);
    const plan = proposal();
    await firstProcess.put(plan);
    await firstProcess.resolve(plan.plan_id, 'approved', 3_000);

    expect(
      await firstProcess.consumeForDispatch!(
        plan.plan_id,
        4_000,
        'turn-execution',
      ),
    ).toMatchObject({ plan_id: plan.plan_id, consumed_at: 4_000 });
    expect(
      await firstProcess.consumeForDispatch!(
        plan.plan_id,
        4_001,
        'turn-duplicate',
      ),
    ).toBeUndefined();
    expect(
      (await firstProcess.listForSession!(sessionId))[0]?.execution,
    ).toEqual({ status: 'running', turn_id: 'turn-execution' });
    expect(
      await firstProcess.recordExecution!(plan.plan_id, {
        status: 'completed',
        turn_id: 'turn-other',
        result_ref: 'result:wrong-turn',
      }),
    ).toBeUndefined();
    expect(
      (await firstProcess.listForSession!(sessionId))[0]?.execution,
    ).toEqual({ status: 'running', turn_id: 'turn-execution' });

    const secondProcess = createSqliteChatPlanStore(db, undefined, () => 9_000);
    expect(
      (await secondProcess.listForSession!(sessionId))[0]?.execution,
    ).toEqual({ status: 'unknown', turn_id: 'turn-execution' });
    expect(
      await secondProcess.findApprovedForDispatch(
        sessionId,
        plan.tool,
        plan.args_hash,
        9_000,
      ),
    ).toBeUndefined();
    // Recovery presents uncertainty; it does not accept a synthetic replayed
    // start as proof that work resumed.
    expect(
      await secondProcess.recordExecution!(plan.plan_id, {
        status: 'running',
        turn_id: 'turn-execution',
      }),
    ).toEqual({ status: 'unknown', turn_id: 'turn-execution' });

    db.prepare(`
      UPDATE chat_plans SET execution_turn_id = NULL WHERE plan_id = ?
    `).run(plan.plan_id);
    expect(
      (await secondProcess.listForSession!(sessionId))[0]?.execution,
    ).toEqual({ status: 'unknown', turn_id: plan.turn_id });

    const stale = proposal({ plan_id: 'plan-stale-approval' });
    await secondProcess.put(stale);
    await secondProcess.resolve(stale.plan_id, 'approved', 10_000);
    expect(
      await secondProcess.consumeForDispatch!(
        stale.plan_id,
        10_000 + planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS + 1,
        'turn-stale-execution',
      ),
    ).toBeUndefined();
  });

  it('persists fresh-approval lineage and binds it to a retryable origin', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(6);
    const getKey = (): Uint8Array => key;
    seedSession(db, getKey);
    const store = createSqliteChatPlanStore(db, getKey);
    const origin = proposal();
    await store.put(origin);
    await store.resolve(origin.plan_id, 'approved', 3_000);
    await store.consumeForDispatch!(
      origin.plan_id,
      4_000,
      'turn-origin-execution',
    );
    await store.recordExecution!(origin.plan_id, {
      status: 'unknown',
      turn_id: 'turn-origin-execution',
    });

    const fresh = proposal({
      plan_id: 'plan-fresh-approval',
      turn_id: 'turn-verify-before-retry',
      retry_of_plan_id: origin.plan_id,
      created_at: 5_000,
    });
    await store.put(fresh);

    expect(await store.get(fresh.plan_id)).toEqual(fresh);
    expect(await store.listForSession!(sessionId)).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({ plan_id: origin.plan_id }),
        execution: {
          status: 'unknown',
          turn_id: 'turn-origin-execution',
        },
      }),
      {
        plan: fresh,
        payload_available: true,
      },
    ]);
    expect(
      db.prepare(`
        SELECT retry_of_plan_id FROM chat_plans WHERE plan_id = ?
      `).get(fresh.plan_id),
    ).toEqual({ retry_of_plan_id: origin.plan_id });

    // Lineage is part of new-row payload authentication. Removing it cannot
    // turn the same encrypted arguments into an unrelated ordinary proposal.
    db.prepare(`
      UPDATE chat_plans SET retry_of_plan_id = NULL WHERE plan_id = ?
    `).run(fresh.plan_id);
    await expect(store.get(fresh.plan_id)).resolves.toBeUndefined();

    await expect(store.put(proposal({
      plan_id: 'plan-invalid-retry-origin',
      retry_of_plan_id: 'missing-origin',
    }))).rejects.toThrow(/invalid retry origin/);

    const cancelledRun = proposal({
      plan_id: 'plan-owner-cancelled-run',
      turn_id: 'turn-owner-cancelled',
    });
    await store.put(cancelledRun);
    await store.resolve(cancelledRun.plan_id, 'approved', 6_000);
    await store.consumeForDispatch!(
      cancelledRun.plan_id,
      7_000,
      'turn-owner-cancelled-execution',
    );
    await store.recordExecution!(cancelledRun.plan_id, {
      status: 'failed',
      turn_id: 'turn-owner-cancelled-execution',
      reason: 'run_cancelled',
    });
    await expect(store.put(proposal({
      plan_id: 'plan-must-not-retry-cancelled-run',
      retry_of_plan_id: cancelledRun.plan_id,
    }))).rejects.toThrow(/is not retryable/);
  });

  it('allows exactly one winner when dispatchers spend concurrently', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    seedSession(db);
    const store = createSqliteChatPlanStore(db);
    const plan = proposal();
    await store.put(plan);
    await store.resolve(plan.plan_id, 'approved', 3_000);

    const attempts = await Promise.all([
      store.consumeForDispatch!(plan.plan_id, 4_000, 'turn-first'),
      store.consumeForDispatch!(plan.plan_id, 4_001, 'turn-second'),
    ]);

    expect(attempts.filter((attempt) => attempt !== undefined)).toHaveLength(1);
    const record = (await store.listForSession!(sessionId))[0]!;
    expect(record.execution?.status).toBe('running');
    expect(['turn-first', 'turn-second']).toContain(record.execution?.turn_id);
  });

  it('does not spend approval when the reviewed payload cannot decrypt', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(3);
    let unlocked = true;
    const getKey = (): Uint8Array | null => unlocked ? key : null;
    seedSession(db, getKey);
    const store = createSqliteChatPlanStore(db, getKey);
    const plan = proposal();
    await store.put(plan);
    await store.resolve(plan.plan_id, 'approved', 3_000);

    unlocked = false;
    await expect(
      store.consumeForDispatch!(plan.plan_id, 4_000, 'turn-execution'),
    ).rejects.toBeInstanceOf(ChatVaultLockedError);
    expect(
      db.prepare(`
        SELECT consumed_at, execution_status
          FROM chat_plans
         WHERE plan_id = ?
      `).get(plan.plan_id),
    ).toEqual({ consumed_at: null, execution_status: null });
  });

  it('keeps unreadable proposals unapprovable but still cancellable', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(4);
    const getKey = (): Uint8Array => key;
    seedSession(db, getKey);
    const store = createSqliteChatPlanStore(db, getKey);
    const plan = proposal();
    await store.put(plan);
    db.prepare(`
      UPDATE chat_plans
         SET args_encrypted = 'corrupt-payload'
       WHERE plan_id = ?
    `).run(plan.plan_id);

    await expect(
      store.resolve(plan.plan_id, 'approved', 3_000),
    ).resolves.toBeUndefined();
    expect(
      db.prepare(`
        SELECT status FROM chat_plans WHERE plan_id = ?
      `).get(plan.plan_id),
    ).toEqual({ status: 'proposed' });

    await expect(
      store.resolve(plan.plan_id, 'cancelled', 4_000),
    ).resolves.toMatchObject({
      plan_id: plan.plan_id,
      args: null,
      status: 'cancelled',
      resolved_at: 4_000,
    });
  });

  it('lists all pending sessions as safe shells when reviewed payloads are unavailable', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(6);
    let unlocked = true;
    const getKey = (): Uint8Array | null => unlocked ? key : null;
    const chat = seedSession(db, getKey);
    chat.createSession({ id: 'session-other-pending', now: 1_100 });
    await chat.appendMessage({
      id: 'message-linked',
      session_id: 'session-other-pending',
      role: 'assistant',
      content: 'Review this pending action.',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: {
          server_kind: 'recued',
          version: '1.0.0',
          instance_id: 'test-instance',
        },
      },
      model_used: { provider: 'test', model_id: 'test-model' },
      ts: 1_200,
    });
    const store = createSqliteChatPlanStore(db, getKey);
    const unreadable = proposal({
      plan_id: 'plan-unreadable-pending',
      created_at: 2_000,
    });
    const linked = proposal({
      plan_id: 'plan-linked-pending',
      session_id: 'session-other-pending',
      turn_id: 'turn-linked',
      created_at: 3_000,
    });
    const resolved = proposal({
      plan_id: 'plan-resolved-excluded',
      turn_id: 'turn-resolved',
      created_at: 1_500,
    });
    await store.put(unreadable);
    await store.put(linked);
    await store.put(resolved);
    await store.linkTurnToMessage!(
      linked.session_id,
      linked.turn_id,
      'message-linked',
    );
    await store.resolve(resolved.plan_id, 'cancelled', 4_000);
    db.prepare(`
      UPDATE chat_plans
         SET args_encrypted = 'corrupt-payload'
       WHERE plan_id = ?
    `).run(unreadable.plan_id);

    expect(await store.listPendingRecords!()).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({
          plan_id: unreadable.plan_id,
          args: null,
          status: 'proposed',
        }),
        payload_available: false,
      }),
      {
        plan: linked,
        message_id: 'message-linked',
        payload_available: true,
      },
    ]);

    unlocked = false;
    await expect(store.listPendingRecords!()).resolves.toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({ plan_id: unreadable.plan_id }),
        payload_available: false,
      }),
      expect.objectContaining({
        plan: expect.objectContaining({
          plan_id: linked.plan_id,
          args: null,
        }),
        message_id: 'message-linked',
        payload_available: false,
      }),
    ]);
  });

  it('encrypts reviewed args and receipt detail, failing closed on bad keys', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(7);
    const getKey = (): Uint8Array => key;
    seedSession(db, getKey);
    const store = createSqliteChatPlanStore(db, getKey, () => 8_000);
    const secret = 'ACTION-RECOVERY-SECRET';
    const plan = proposal({
      args: { to: 'owner@example.com', body: secret },
    });

    await expect(store.put({
      ...plan,
      plan_id: 'plan-mismatched-hash',
      args_hash: 'mismatched-hash',
    })).rejects.toThrow(/args_hash does not match reviewed args/);
    await store.put(plan);
    await store.resolve(plan.plan_id, 'approved', 3_000);
    await store.consumeForDispatch!(plan.plan_id, 4_000, 'turn-execution');
    await store.recordExecution!(plan.plan_id, {
      status: 'failed',
      turn_id: 'turn-execution',
      reason: 'execution_error',
      detail: secret,
    });

    const raw = db.prepare(`
      SELECT args_encrypted, execution_blob_encrypted
        FROM chat_plans
       WHERE plan_id = ?
    `).get(plan.plan_id) as {
      args_encrypted: string;
      execution_blob_encrypted: string;
    };
    expect(raw.args_encrypted).not.toContain(secret);
    expect(raw.execution_blob_encrypted).not.toContain(secret);
    expect(await store.get(plan.plan_id)).toMatchObject({ args: plan.args });

    db.prepare(`
      UPDATE chat_plans SET args_hash = 'tampered-hash' WHERE plan_id = ?
    `).run(plan.plan_id);
    await expect(store.get(plan.plan_id)).resolves.toBeUndefined();
    db.prepare(`
      UPDATE chat_plans SET args_hash = ? WHERE plan_id = ?
    `).run(plan.args_hash, plan.plan_id);
    await expect(store.get(plan.plan_id)).resolves.toMatchObject({
      args: plan.args,
    });

    const wrongKey = new Uint8Array(32);
    wrongKey.fill(9);
    const unreadable = createSqliteChatPlanStore(db, () => wrongKey);
    expect(await unreadable.listForSession!(sessionId)).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({ args: null }),
        execution: {
          status: 'unknown',
          turn_id: 'turn-execution',
        },
        payload_available: false,
      }),
    ]);

    const locked = createSqliteChatPlanStore(db, () => null);
    await expect(locked.listForSession!(sessionId)).rejects.toBeInstanceOf(
      ChatVaultLockedError,
    );
  });

  it('can close running to unknown without a key when terminal detail cannot encrypt', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const key = new Uint8Array(32);
    key.fill(5);
    let unlocked = true;
    const getKey = (): Uint8Array | null => unlocked ? key : null;
    seedSession(db, getKey);
    const store = createSqliteChatPlanStore(db, getKey);
    const plan = proposal();
    await store.put(plan);
    await store.resolve(plan.plan_id, 'approved', 3_000);
    await store.consumeForDispatch!(plan.plan_id, 4_000, 'turn-execution');

    unlocked = false;
    await expect(
      store.recordExecution!(plan.plan_id, {
        status: 'failed',
        turn_id: 'turn-execution',
        reason: 'execution_error',
        detail: 'sensitive provider detail',
      }),
    ).rejects.toBeInstanceOf(ChatVaultLockedError);
    await expect(
      store.recordExecution!(plan.plan_id, {
        status: 'unknown',
        turn_id: 'turn-execution',
      }),
    ).resolves.toEqual({
      status: 'unknown',
      turn_id: 'turn-execution',
    });

    unlocked = true;
    expect((await store.listForSession!(sessionId))[0]?.execution).toEqual({
      status: 'unknown',
      turn_id: 'turn-execution',
    });
  });

  it('deletes action history with its owning chat session', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chat = seedSession(db);
    const store = createSqliteChatPlanStore(db);
    await store.put(proposal());

    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM chat_plans').get() as {
        count: number;
      }).count,
    ).toBe(1);
    expect(chat.deleteSession(sessionId)).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM chat_plans').get() as {
        count: number;
      }).count,
    ).toBe(0);
  });
});
