/** Durable approval + execution-receipt store.
 *
 * Production uses this SQLite-backed implementation in place of the gateway's
 * in-memory store. Reviewed args and terminal execution detail are encrypted
 * under the chat sub-DEK. Reviewed-argument AEAD also binds the immutable
 * lookup metadata (`tool`, `args_hash`, target, turn, tier, classification),
 * while correlation/status columns stay plaintext so a new server process can
 * turn orphaned `running` rows into recovery-only `unknown` receipts before
 * serving snapshots.
 */

import type Database from 'better-sqlite3';
import {
  isChatDispatchReason,
  isChatPlanStatus,
  type ChatPlanExecutionReceipt,
  type ChatPlanProposal,
  type ChatPlanRecord,
  type ChatPlanStatus,
  type ToolTier,
} from '@recued/contracts';
import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';
import { planApproval } from '@recued/gateway';
import {
  ChatVaultLockedError,
  type ChatKeyProvider,
} from './chat-store.js';

interface ChatPlanRow {
  plan_id: string;
  session_id: string;
  turn_id: string;
  retry_of_plan_id: string | null;
  message_id: string | null;
  tool: string;
  tier: number;
  classification: string;
  args_encrypted: string;
  args_hash: string;
  target_instance: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
  consumed_at: number | null;
  execution_status: string | null;
  execution_turn_id: string | null;
  execution_blob_encrypted: string | null;
  execution_updated_at: number | null;
}

const isToolTier = (value: number): value is ToolTier =>
  value === 1 || value === 2 || value === 3;

const isClassification = (
  value: string,
): value is ChatPlanProposal['classification'] =>
  value === 'read' || value === 'write' || value === 'unknown';

const isHoldKind = (
  value: unknown,
): value is Extract<
  ChatPlanExecutionReceipt,
  { status: 'held' }
>['hold_kind'] =>
  value === 'approval'
  || value === 'container_pick'
  || value === 'create_plan';

interface PlanPayloadIdentity {
  readonly session_id: string;
  readonly plan_id: string;
  readonly turn_id: string;
  readonly retry_of_plan_id?: string | null;
  readonly tool: string;
  readonly tier: number;
  readonly classification: string;
  readonly args_hash: string;
  readonly target_instance?: string | null;
  readonly created_at: number;
}

const aadForPlanPayload = (
  kind: 'args' | 'execution',
  identity: PlanPayloadIdentity,
): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify(
      kind === 'args'
        ? [
            'recued/v1/chat/plan/args',
            identity.session_id,
            identity.plan_id,
            identity.turn_id,
            identity.tool,
            identity.tier,
            identity.classification,
            identity.args_hash,
            identity.target_instance ?? null,
            identity.created_at,
            ...(identity.retry_of_plan_id !== undefined
              && identity.retry_of_plan_id !== null
              ? ['retry_of_plan_id', identity.retry_of_plan_id]
              : []),
          ]
        : [
            'recued/v1/chat/plan/execution',
            identity.session_id,
            identity.plan_id,
          ],
    ),
  );

const requireKey = (
  getKey: ChatKeyProvider,
  operation: string,
): Uint8Array => {
  const key = getKey();
  if (key === null) throw new ChatVaultLockedError(operation);
  return key;
};

const encodePayload = async (
  value: unknown,
  kind: 'args' | 'execution',
  identity: PlanPayloadIdentity,
  getKey?: ChatKeyProvider,
): Promise<string> => {
  const serialized = JSON.stringify(value) ?? 'null';
  const plaintext = new TextEncoder().encode(serialized);
  if (getKey === undefined) return bytesToBase64(plaintext);
  const ciphertext = await encrypt(
    requireKey(getKey, `encrypt chat plan ${kind}`),
    plaintext,
    aadForPlanPayload(kind, identity),
  );
  return encodeCiphertext(ciphertext);
};

const decodePayload = async (
  blob: string,
  kind: 'args' | 'execution',
  identity: PlanPayloadIdentity,
  getKey?: ChatKeyProvider,
): Promise<unknown> => {
  const plaintext =
    getKey === undefined
      ? base64ToBytes(blob)
      : await decrypt(
          requireKey(getKey, `decrypt chat plan ${kind}`),
          decodeCiphertext(blob),
          aadForPlanPayload(kind, identity),
        );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
};

const planShellFromRow = (
  row: ChatPlanRow,
  args: unknown,
): ChatPlanProposal | undefined => {
  if (
    !isToolTier(row.tier)
    || !isClassification(row.classification)
    || !isChatPlanStatus(row.status)
  ) return undefined;
  return {
    plan_id: row.plan_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    ...(row.retry_of_plan_id !== null
      ? { retry_of_plan_id: row.retry_of_plan_id }
      : {}),
    tool: row.tool,
    tier: row.tier,
    classification: row.classification,
    args,
    args_hash: row.args_hash,
    ...(row.target_instance !== null
      ? { target_instance: row.target_instance }
      : {}),
    status: row.status,
    created_at: row.created_at,
    ...(row.resolved_at !== null ? { resolved_at: row.resolved_at } : {}),
    ...(row.consumed_at !== null ? { consumed_at: row.consumed_at } : {}),
  };
};

const decodePlan = async (
  row: ChatPlanRow,
  getKey?: ChatKeyProvider,
): Promise<ChatPlanProposal | undefined> => {
  try {
    const args = await decodePayload(
      row.args_encrypted,
      'args',
      row,
      getKey,
    );
    if (planApproval.computePlanArgsHash(args) !== row.args_hash) {
      return undefined;
    }
    return planShellFromRow(row, args);
  } catch (error) {
    if (error instanceof ChatVaultLockedError) throw error;
    return undefined;
  }
};

const validateExecution = (
  value: unknown,
  expectedStatus: string,
  expectedTurnId: string,
): ChatPlanExecutionReceipt | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status !== expectedStatus
    || candidate.turn_id !== expectedTurnId
  ) return undefined;
  const runAddress =
    typeof candidate.run_id === 'string' && candidate.run_id.length > 0
      ? { run_id: candidate.run_id }
      : {};
  if (candidate.status === 'completed') {
    return typeof candidate.result_ref === 'string'
      ? {
          status: 'completed',
          turn_id: expectedTurnId,
          result_ref: candidate.result_ref,
          ...runAddress,
        }
      : undefined;
  }
  if (candidate.status === 'held') {
    return typeof candidate.result_ref === 'string'
      && isHoldKind(candidate.hold_kind)
      ? {
          status: 'held',
          turn_id: expectedTurnId,
          result_ref: candidate.result_ref,
          hold_kind: candidate.hold_kind,
          ...runAddress,
        }
      : undefined;
  }
  if (candidate.status === 'failed') {
    if (!isChatDispatchReason(candidate.reason)) return undefined;
    return {
      status: 'failed',
      turn_id: expectedTurnId,
      reason: candidate.reason,
      ...(typeof candidate.detail === 'string'
        ? { detail: candidate.detail }
        : {}),
      ...runAddress,
    };
  }
  return undefined;
};

const decodeExecution = async (
  row: ChatPlanRow,
  getKey?: ChatKeyProvider,
): Promise<ChatPlanExecutionReceipt | undefined> => {
  const turn_id = row.execution_turn_id ?? row.turn_id;
  if (row.execution_turn_id === null) {
    return row.consumed_at === null
      ? undefined
      : { status: 'unknown', turn_id };
  }
  if (row.execution_status === 'running') {
    return { status: 'running', turn_id };
  }
  if (row.execution_status === 'unknown') {
    return { status: 'unknown', turn_id };
  }
  if (
    row.execution_status === null
    || row.execution_blob_encrypted === null
  ) {
    return row.consumed_at === null
      ? undefined
      : { status: 'unknown', turn_id };
  }
  try {
    const decoded = await decodePayload(
      row.execution_blob_encrypted,
      'execution',
      row,
      getKey,
    );
    return validateExecution(decoded, row.execution_status, turn_id)
      ?? { status: 'unknown', turn_id };
  } catch (error) {
    if (error instanceof ChatVaultLockedError) throw error;
    return { status: 'unknown', turn_id };
  }
};

/** Build the production store. Factory construction is synchronous; the only
 * boot mutation changes receipts left `running` by a previous process to
 * `unknown`. Payload encryption/decryption stays inside async store methods. */
export const createSqliteChatPlanStore = (
  db: Database.Database,
  getKey?: ChatKeyProvider,
  now: () => number = Date.now,
): planApproval.PlanApprovalStore => {
  db.prepare(`
    UPDATE chat_plans
       SET execution_status = 'unknown',
           execution_updated_at = @now
     WHERE execution_status = 'running'
  `).run({ now: now() });

  const getRow = db.prepare<{ plan_id: string }>(
    'SELECT * FROM chat_plans WHERE plan_id = @plan_id',
  );
  const listPendingRows = db.prepare<{ session_id: string }>(`
    SELECT * FROM chat_plans
     WHERE session_id = @session_id AND status = 'proposed'
     ORDER BY created_at ASC, rowid ASC
  `);
  const listAllPendingRows = db.prepare(`
    SELECT * FROM chat_plans
     WHERE status = 'proposed'
     ORDER BY created_at ASC, plan_id ASC
  `);
  const listSessionRows = db.prepare<{ session_id: string }>(`
    SELECT * FROM chat_plans
     WHERE session_id = @session_id
     ORDER BY created_at ASC, rowid ASC
  `);
  const findLatestRow = db.prepare<{
    session_id: string;
    turn_id: string;
    tool: string;
    args_hash: string;
  }>(`
    SELECT * FROM chat_plans
     WHERE session_id = @session_id
       AND turn_id = @turn_id
       AND tool = @tool
       AND args_hash = @args_hash
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `);
  const findApprovedRow = db.prepare<{
    session_id: string;
    tool: string;
    args_hash: string;
    cutoff: number;
  }>(`
    SELECT * FROM chat_plans
     WHERE session_id = @session_id
       AND tool = @tool
       AND args_hash = @args_hash
       AND status = 'approved'
       AND consumed_at IS NULL
       AND COALESCE(resolved_at, created_at) >= @cutoff
     ORDER BY COALESCE(resolved_at, created_at) DESC, rowid DESC
     LIMIT 1
  `);
  const insertPlan = db.prepare(`
    INSERT INTO chat_plans (
      plan_id, session_id, turn_id, retry_of_plan_id, message_id,
      tool, tier, classification,
      args_encrypted, args_hash, target_instance, status, created_at,
      resolved_at, consumed_at, execution_status, execution_turn_id,
      execution_blob_encrypted, execution_updated_at
    ) VALUES (
      @plan_id, @session_id, @turn_id, @retry_of_plan_id, NULL,
      @tool, @tier, @classification,
      @args_encrypted, @args_hash, @target_instance, @status, @created_at,
      @resolved_at, @consumed_at, NULL, NULL, NULL, NULL
    )
    ON CONFLICT(plan_id) DO NOTHING
  `);
  const resolvePlan = db.prepare(`
    UPDATE chat_plans
       SET status = @status,
           resolved_at = @resolved_at
     WHERE plan_id = @plan_id AND status = 'proposed'
  `);
  const consumePlan = db.prepare(`
    UPDATE chat_plans
       SET consumed_at = @consumed_at,
           execution_status = 'running',
           execution_turn_id = @execution_turn_id,
           execution_blob_encrypted = NULL,
           execution_updated_at = @consumed_at
     WHERE plan_id = @plan_id
       AND status = 'approved'
       AND consumed_at IS NULL
       AND COALESCE(resolved_at, created_at) >= @cutoff
  `);
  const markConsumedPlan = db.prepare(`
    UPDATE chat_plans
       SET consumed_at = @consumed_at,
           execution_status = CASE
             WHEN @execution_turn_id IS NULL THEN execution_status
             ELSE 'running'
           END,
           execution_turn_id = COALESCE(@execution_turn_id, execution_turn_id),
           execution_blob_encrypted = CASE
             WHEN @execution_turn_id IS NULL THEN execution_blob_encrypted
             ELSE NULL
           END,
           execution_updated_at = CASE
             WHEN @execution_turn_id IS NULL THEN execution_updated_at
             ELSE @consumed_at
           END
     WHERE plan_id = @plan_id
       AND status = 'approved'
       AND consumed_at IS NULL
  `);
  const linkTurn = db.prepare(`
    UPDATE chat_plans
       SET message_id = @message_id
     WHERE session_id = @session_id
       AND turn_id = @turn_id
       AND message_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM chat_messages
          WHERE message_id = @message_id
            AND session_id = @session_id
       )
  `);
  const updateExecution = db.prepare(`
    UPDATE chat_plans
       SET execution_status = @execution_status,
           execution_turn_id = @execution_turn_id,
           execution_blob_encrypted = @execution_blob_encrypted,
           execution_updated_at = @execution_updated_at
     WHERE plan_id = @plan_id
       AND consumed_at IS NOT NULL
       AND (execution_status IS NULL OR execution_status = 'running')
  `);

  const rowFor = (plan_id: string): ChatPlanRow | undefined =>
    getRow.get({ plan_id }) as ChatPlanRow | undefined;

  const get = async (
    plan_id: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = rowFor(plan_id);
    return row === undefined ? undefined : decodePlan(row, getKey);
  };

  const listPending = async (
    session_id: string,
  ): Promise<ReadonlyArray<ChatPlanProposal>> => {
    const rows = listPendingRows.all({ session_id }) as ChatPlanRow[];
    const plans = await Promise.all(rows.map((row) => decodePlan(row, getKey)));
    return plans.filter((plan): plan is ChatPlanProposal => plan !== undefined);
  };

  const findLatest = async (
    session_id: string,
    turn_id: string,
    tool: string,
    args_hash: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = findLatestRow.get({
      session_id,
      turn_id,
      tool,
      args_hash,
    }) as ChatPlanRow | undefined;
    return row === undefined ? undefined : decodePlan(row, getKey);
  };

  const findApprovedForDispatch = async (
    session_id: string,
    tool: string,
    args_hash: string,
    at: number,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = findApprovedRow.get({
      session_id,
      tool,
      args_hash,
      cutoff: at - planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS,
    }) as ChatPlanRow | undefined;
    return row === undefined ? undefined : decodePlan(row, getKey);
  };

  const put = async (plan: ChatPlanProposal): Promise<void> => {
    if (planApproval.computePlanArgsHash(plan.args) !== plan.args_hash) {
      throw new Error(
        `chat-plan-store: args_hash does not match reviewed args for ${plan.plan_id}`,
      );
    }
    if (plan.retry_of_plan_id !== undefined) {
      const origin = rowFor(plan.retry_of_plan_id);
      if (
        origin === undefined
        || origin.session_id !== plan.session_id
        || origin.status !== 'approved'
        || origin.consumed_at === null
        || (
          origin.execution_status !== 'unknown'
          && origin.execution_status !== 'failed'
        )
      ) {
        throw new Error(
          `chat-plan-store: invalid retry origin ${plan.retry_of_plan_id}`,
        );
      }
      if (await decodePlan(origin, getKey) === undefined) {
        throw new Error(
          `chat-plan-store: retry origin ${plan.retry_of_plan_id} payload is unavailable`,
        );
      }
      if (origin.execution_status === 'failed') {
        const receipt = await decodeExecution(origin, getKey);
        if (
          receipt?.status !== 'failed'
          || receipt.reason === 'run_cancelled'
        ) {
          throw new Error(
            `chat-plan-store: retry origin ${plan.retry_of_plan_id} is not retryable`,
          );
        }
      }
    }
    const args_encrypted = await encodePayload(
      plan.args,
      'args',
      plan,
      getKey,
    );
    insertPlan.run({
      ...plan,
      args_encrypted,
      retry_of_plan_id: plan.retry_of_plan_id ?? null,
      target_instance: plan.target_instance ?? null,
      resolved_at: plan.resolved_at ?? null,
      consumed_at: plan.consumed_at ?? null,
    });
  };

  const resolve = async (
    plan_id: string,
    status: 'approved' | 'cancelled',
    resolved_at: number,
  ): Promise<ChatPlanProposal | undefined> => {
    const before = rowFor(plan_id);
    if (before === undefined) return undefined;
    let decoded: ChatPlanProposal | undefined;
    try {
      decoded = await decodePlan(before, getKey);
    } catch (error) {
      // Cancelling is always the safe terminal choice and requires no reviewed
      // payload. Approval must still fail closed while the Chat vault is
      // locked; a corrupt payload likewise remains unapprovable.
      if (status !== 'cancelled') throw error;
    }
    if (status === 'approved' && decoded === undefined) return undefined;

    resolvePlan.run({ plan_id, status, resolved_at });
    const current = rowFor(plan_id);
    if (current === undefined) return undefined;
    return planShellFromRow(current, decoded?.args ?? null);
  };

  const markConsumed = async (
    plan_id: string,
    consumed_at: number,
    execution_turn_id?: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const before = rowFor(plan_id);
    if (
      before === undefined
      || before.status !== 'approved'
    ) return undefined;
    if (before.consumed_at !== null) return decodePlan(before, getKey);
    // Decrypt and verify the reviewed payload before mutating the spend. If
    // the vault locks at this boundary, the approval remains reusable rather
    // than becoming a misleading `running` receipt with no dispatch.
    const decoded = await decodePlan(before, getKey);
    if (decoded === undefined) return undefined;
    markConsumedPlan.run({
      plan_id,
      consumed_at,
      execution_turn_id: execution_turn_id ?? null,
    });
    const current = rowFor(plan_id);
    return current === undefined
      ? undefined
      : planShellFromRow(current, decoded.args);
  };

  const consumeForDispatch = async (
    plan_id: string,
    consumed_at: number,
    execution_turn_id: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const before = rowFor(plan_id);
    if (
      before === undefined
      || before.status !== 'approved'
      || before.consumed_at !== null
    ) return undefined;
    // Keep crypto before the atomic SQL spend: a key transition must fail
    // without consuming permission or claiming that execution started.
    const decoded = await decodePlan(before, getKey);
    if (decoded === undefined) return undefined;
    const result = consumePlan.run({
      plan_id,
      consumed_at,
      execution_turn_id,
      cutoff:
        consumed_at - planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS,
    });
    if (result.changes !== 1) return undefined;
    return { ...decoded, consumed_at };
  };

  const listForSession = async (
    session_id: string,
  ): Promise<ReadonlyArray<ChatPlanRecord>> => {
    const rows = listSessionRows.all({ session_id }) as ChatPlanRow[];
    return Promise.all(rows.map(async (row): Promise<ChatPlanRecord> => {
      const decoded = await decodePlan(row, getKey);
      const plan =
        decoded
        ?? planShellFromRow(row, null)
        ?? {
          plan_id: row.plan_id,
          session_id: row.session_id,
          turn_id: row.turn_id,
          tool: row.tool,
          tier: 1,
          classification: 'unknown',
          args: null,
          args_hash: row.args_hash,
          status: 'cancelled' as ChatPlanStatus,
          created_at: row.created_at,
        };
      const execution = await decodeExecution(row, getKey);
      return {
        plan,
        ...(row.message_id !== null ? { message_id: row.message_id } : {}),
        ...(execution !== undefined ? { execution } : {}),
        payload_available: decoded !== undefined,
      };
    }));
  };

  const listPendingRecords = async (): Promise<
    ReadonlyArray<ChatPlanRecord>
  > => {
    const rows = listAllPendingRows.all() as ChatPlanRow[];
    return Promise.all(rows.map(async (row): Promise<ChatPlanRecord> => {
      let decoded: ChatPlanProposal | undefined;
      try {
        decoded = await decodePlan(row, getKey);
      } catch (error) {
        // The global inbox must remain truthful and cancellable while the Chat
        // vault is locked. Approval stays disabled because the exact reviewed
        // payload is unavailable; no plaintext or execution authority leaks.
        if (!(error instanceof ChatVaultLockedError)) throw error;
      }
      const plan =
        decoded
        ?? planShellFromRow(row, null)
        ?? {
          plan_id: row.plan_id,
          session_id: row.session_id,
          turn_id: row.turn_id,
          ...(row.retry_of_plan_id !== null
            ? { retry_of_plan_id: row.retry_of_plan_id }
            : {}),
          tool: row.tool,
          tier: isToolTier(row.tier) ? row.tier : 1,
          classification: 'unknown',
          args: null,
          args_hash: row.args_hash,
          status: 'proposed' as const,
          created_at: row.created_at,
        };
      return {
        plan,
        ...(row.message_id !== null ? { message_id: row.message_id } : {}),
        payload_available: decoded !== undefined,
      };
    }));
  };

  const linkTurnToMessage = async (
    session_id: string,
    turn_id: string,
    message_id: string,
  ): Promise<void> => {
    linkTurn.run({ session_id, turn_id, message_id });
  };

  const recordExecution = async (
    plan_id: string,
    execution: ChatPlanExecutionReceipt,
  ): Promise<ChatPlanExecutionReceipt | undefined> => {
    const before = rowFor(plan_id);
    if (before === undefined || before.consumed_at === null) return undefined;
    if (
      before.execution_turn_id !== null
      && before.execution_turn_id !== execution.turn_id
    ) return undefined;
    if (
      before.execution_status !== null
      && before.execution_status !== 'running'
    ) {
      return decodeExecution(before, getKey);
    }
    const blob =
      execution.status === 'running' || execution.status === 'unknown'
        ? null
        : await encodePayload(execution, 'execution', before, getKey);
    const result = updateExecution.run({
      plan_id,
      execution_status: execution.status,
      execution_turn_id: execution.turn_id,
      execution_blob_encrypted: blob,
      execution_updated_at: now(),
    });
    if (result.changes !== 1) {
      const current = rowFor(plan_id);
      return current === undefined ? undefined : decodeExecution(current, getKey);
    }
    return execution;
  };

  return {
    get,
    listPending,
    findLatest,
    findApprovedForDispatch,
    markConsumed,
    consumeForDispatch,
    put,
    resolve,
    listPendingRecords,
    listForSession,
    linkTurnToMessage,
    recordExecution,
  };
};
