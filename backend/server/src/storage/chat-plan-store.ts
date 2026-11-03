import { isResourceReview } from '@recued/contracts';
import { isLocalMutationReceiptSummary } from '@recued/contracts';
import { withLocalMutationScope } from '../local-mutation-context.js';
import { createOrdinaryLocalMutationReceipts, reviewedLocalMutationKind } from './ordinary-local-mutation-receipts.js';
import { localMutationSummary } from '../ordinary-local-mutations.js';
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
  type ApprovalValueLabels,
  type ChatPlanExecutionReceipt,
  type ChatPlanMade,
  type ChatPlanProposal,
  type ChatPlanRecord,
  type ChatPlanStatus,
  type MemorySaveConflict,
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
import { heldPlanEditableArgs } from '../chat-plan-edits.js';

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
  resource_review_encrypted: string | null;
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
  /** D-329 — the run of the hold whose ask this proposal answers (`ChatPlanProposal.hold`). */
  hold_run_id: string | null;
  /** D-329 — when that hold expired unanswered (`hold.lapsed_at`). */
  hold_lapsed_at: number | null;
  /** D-329 — the names of the records its args name (`ChatPlanProposal.value_labels`). */
  value_labels_encrypted: string | null;
  /** D-336 slice G — the notes in memory a held save meets (`ChatPlanProposal.memory_conflicts`). */
  memory_conflicts_encrypted: string | null;
}

const chatMutationIdentity = (row: ChatPlanRow): unknown => ({
  plan_id: row.plan_id, session_id: row.session_id, turn_id: row.turn_id,
  retry_of_plan_id: row.retry_of_plan_id, tool: row.tool, tier: row.tier, classification: row.classification,
  args_encrypted: row.args_encrypted, resource_review_encrypted: row.resource_review_encrypted,
  args_hash: row.args_hash, target_instance: row.target_instance, created_at: row.created_at,
  resolved_at: row.resolved_at, consumed_at: row.consumed_at, execution_turn_id: row.execution_turn_id,
});

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

type PlanPayloadKind = 'args' | 'execution' | 'resource_review' | 'value_labels' | 'memory_conflicts';
/** A stored `value_labels`: a name per value of a top-level argument. */
const isValueLabels = (value: unknown): value is ApprovalValueLabels =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((byValue) => byValue !== null && typeof byValue === 'object' && !Array.isArray(byValue)
    && Object.values(byValue).every((name) => typeof name === 'string'));
const MEMORY_CONFLICT_KINDS: ReadonlySet<string> = new Set<MemorySaveConflict['kind']>(['contradicts', 'saved_already', 'also_in_memory']);
/** A stored `memory_conflicts`, each note read on its own: a kind this server knows, an id
 *  and a summary. A note it cannot read is left off and the rest stay, so a kind a later
 *  server adds (as slice J added `saved_already`) hides only itself. Slice O's
 *  `asked_already`, a save still waiting, has no note yet and so no id; nor has its open
 *  item's `asked_again`, a save asked after this one, nor slice S's `contradicts_asked`. */
const readMemoryConflicts = (value: unknown): MemorySaveConflict[] =>
  !Array.isArray(value) ? [] : value.filter((conflict: unknown): conflict is MemorySaveConflict => {
    if (conflict === null || typeof conflict !== 'object') return false;
    const { kind, memory_id, summary } = conflict as { kind?: unknown; memory_id?: unknown; summary?: unknown };
    if (typeof summary !== 'string') return false;
    return kind === 'asked_already' || kind === 'asked_again' || kind === 'contradicts_asked'
      || (typeof kind === 'string' && MEMORY_CONFLICT_KINDS.has(kind) && typeof memory_id === 'string');
  });
const aadForPlanPayload = (
  kind: PlanPayloadKind,
  identity: PlanPayloadIdentity,
): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify(
      kind === 'args' || kind === 'resource_review' || kind === 'value_labels' || kind === 'memory_conflicts'
        ? [
            'recued/v1/chat/plan/' + kind,
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
  kind: PlanPayloadKind,
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
  kind: PlanPayloadKind,
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
    ...(typeof row.hold_run_id === 'string' && row.hold_run_id.length > 0
      ? {
          hold: {
            run_id: row.hold_run_id,
            ...(typeof row.hold_lapsed_at === 'number' ? { lapsed_at: row.hold_lapsed_at } : {}),
          },
          // D-336 slice E — what the owner may change on its card while approving it.
          ...(heldPlanEditableArgs(row.tool) !== undefined ? { editable_args: heldPlanEditableArgs(row.tool) } : {}),
        }
      : {}),
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
    const review = row.resource_review_encrypted == null ? undefined
      : await decodePayload(row.resource_review_encrypted, 'resource_review', row, getKey);
    if (review !== undefined && !isResourceReview(review)) return undefined;
    // Display only: names that do not read back leave the card its ids.
    const labels = row.value_labels_encrypted == null ? undefined
      : await decodePayload(row.value_labels_encrypted, 'value_labels', row, getKey).catch((error: unknown) => {
        if (error instanceof ChatVaultLockedError) throw error;
        return undefined;
      });
    // Display only too: notes that do not read back leave the card without them.
    const conflicts = row.memory_conflicts_encrypted == null ? undefined
      : await decodePayload(row.memory_conflicts_encrypted, 'memory_conflicts', row, getKey).catch((error: unknown) => {
        if (error instanceof ChatVaultLockedError) throw error;
        return undefined;
      });
    const plan = planShellFromRow(row, args);
    const notes = readMemoryConflicts(conflicts);
    return plan && {
      ...plan,
      ...(review ? { resource_review: review } : {}),
      ...(isValueLabels(labels) ? { value_labels: labels } : {}),
      ...(notes.length > 0 ? { memory_conflicts: notes } : {}),
    };
  } catch (error) {
    if (error instanceof ChatVaultLockedError) throw error;
    return undefined;
  }
};

/** D-336 slice Q — a completed receipt's record of what it made, read as off a stored hold. */
const isChatPlanMade = (value: unknown): value is ChatPlanMade => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const made = value as Record<string, unknown>;
  return made.kind === 'contact'
    ? typeof made.target_id === 'string' && made.target_id !== '' && typeof made.name === 'string'
    : made.kind === 'memory' && typeof made.memory_id === 'string' && made.memory_id !== '';
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
          ...(isLocalMutationReceiptSummary(candidate.local_receipt) ? { local_receipt: candidate.local_receipt } : {}),
          ...(['running', 'failed', 'unknown'].includes(String(candidate.recovered_from))
            ? { recovered_from: candidate.recovered_from as 'running' | 'failed' | 'unknown' } : {}),
          ...(isChatPlanMade(candidate.made) ? { made: candidate.made } : {}),
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
): planApproval.PlanApprovalStore & {
  listForTurn(session_id: string, turn_id: string): Promise<ReadonlyArray<ChatPlanRecord>>;
} => {
  const localMutations = createOrdinaryLocalMutationReceipts(db, now);
  const withLocalProof = (row: ChatPlanRow, execution: ChatPlanExecutionReceipt | undefined): ChatPlanExecutionReceipt | undefined => {
    const proof = localMutations.proof('chat_plan', row.plan_id, chatMutationIdentity(row));
    if (!proof) {
      if (execution?.status !== 'completed') return execution;
      const { local_receipt: _savedSummary, recovered_from: _savedRecovery, ...history } = execution;
      return history;
    }
    const receipt = localMutationSummary(proof);
    return { status: 'completed', turn_id: row.execution_turn_id ?? row.turn_id,
      result_ref: execution?.status === 'completed' ? execution.result_ref : 'local-mutation:' + receipt.receipt_id,
      local_receipt: receipt,
      ...(execution?.status === 'running' || execution?.status === 'failed' || execution?.status === 'unknown'
        ? { recovered_from: execution.status }
        : execution?.status === 'completed' && execution.recovered_from ? { recovered_from: execution.recovered_from } : {}),
      ...(execution && 'run_id' in execution && execution.run_id ? { run_id: execution.run_id } : {}) };
  };
  const readExecution = async (row: ChatPlanRow) => withLocalProof(row, await decodeExecution(row, getKey));
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
  const listTurnRows = db.prepare<{ session_id: string; turn_id: string }>(`
    SELECT * FROM chat_plans WHERE session_id = @session_id AND turn_id = @turn_id
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
       -- D-329: a held proposal runs from its hold when approved. A re-issue
       -- spending the same approval would run it twice.
       AND hold_run_id IS NULL
     ORDER BY COALESCE(resolved_at, created_at) DESC, rowid DESC
     LIMIT 1
  `);
  const findHoldRunRow = db.prepare<{ run_id: string }>(`
    SELECT * FROM chat_plans
     WHERE hold_run_id = @run_id
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `);
  const findPendingHeldRow = db.prepare<{
    session_id: string;
    tool: string;
    args_hash: string;
  }>(`
    SELECT * FROM chat_plans
     WHERE session_id = @session_id
       AND tool = @tool
       AND args_hash = @args_hash
       AND status = 'proposed'
       AND hold_run_id IS NOT NULL
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `);
  const lapseHoldRun = db.prepare(`
    UPDATE chat_plans
       SET status = 'cancelled',
           resolved_at = @lapsed_at,
           hold_lapsed_at = @lapsed_at
     WHERE plan_id = @plan_id AND hold_run_id = @run_id AND status = 'proposed'
  `);
  const answerMessageRow = db.prepare<{ plan_id: string }>(
    'SELECT message_id FROM chat_plans WHERE plan_id = @plan_id',
  );
  const unlinkHoldRun = db.prepare(`
    UPDATE chat_plans
       SET hold_run_id = NULL
     WHERE plan_id = @plan_id AND hold_run_id = @run_id
  `);
  const addConflictRun = db.prepare(`
    UPDATE chat_plans
       SET memory_conflicts_encrypted = @memory_conflicts_encrypted
     WHERE plan_id = @plan_id AND status = 'proposed' AND args_hash = @args_hash
  `);
  const editHeldRun = db.prepare(`
    UPDATE chat_plans
       SET args_encrypted = @args_encrypted,
           args_hash = @args_hash,
           resource_review_encrypted = @resource_review_encrypted,
           value_labels_encrypted = @value_labels_encrypted,
           memory_conflicts_encrypted = @memory_conflicts_encrypted
     WHERE plan_id = @plan_id AND hold_run_id = @run_id AND status = 'proposed'
       AND args_hash = @prior_args_hash
  `);
  const insertPlan = db.prepare(`
    INSERT INTO chat_plans (
      plan_id, session_id, turn_id, retry_of_plan_id, message_id,
      tool, tier, classification,
      args_encrypted, resource_review_encrypted, args_hash, target_instance, status, created_at,
      resolved_at, consumed_at, execution_status, execution_turn_id,
      execution_blob_encrypted, execution_updated_at, hold_run_id, value_labels_encrypted,
      memory_conflicts_encrypted
    ) VALUES (
      @plan_id, @session_id, @turn_id, @retry_of_plan_id, NULL,
      @tool, @tier, @classification,
      @args_encrypted, @resource_review_encrypted, @args_hash, @target_instance, @status, @created_at,
      @resolved_at, @consumed_at, NULL, NULL, NULL, NULL, @hold_run_id, @value_labels_encrypted,
      @memory_conflicts_encrypted
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
        || localMutations.proof('chat_plan', origin.plan_id, chatMutationIdentity(origin)) !== null
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
      resource_review_encrypted: plan.resource_review
        ? await encodePayload(plan.resource_review, 'resource_review', plan, getKey) : null,
      retry_of_plan_id: plan.retry_of_plan_id ?? null,
      target_instance: plan.target_instance ?? null,
      resolved_at: plan.resolved_at ?? null,
      consumed_at: plan.consumed_at ?? null,
      hold_run_id: plan.hold?.run_id ?? null,
      value_labels_encrypted: plan.value_labels
        ? await encodePayload(plan.value_labels, 'value_labels', plan, getKey) : null,
      memory_conflicts_encrypted: plan.memory_conflicts !== undefined && plan.memory_conflicts.length > 0
        ? await encodePayload(plan.memory_conflicts, 'memory_conflicts', plan, getKey) : null,
    });
  };

  const unlinkHold = async (
    plan_id: string,
    run_id: string,
  ): Promise<ChatPlanProposal | undefined> => {
    unlinkHoldRun.run({ plan_id, run_id });
    const row = rowFor(plan_id);
    return row === undefined ? undefined : decodePlan(row, getKey);
  };

  /** D-336 slice E — the owner's change to a held proposal, made while approving it. Its
   *  reviewed payloads are sealed to its args hash, so each is sealed again to the new one;
   *  a proposal answered or changed meanwhile is left as it is. Slice G: the notes it met
   *  were for the relationship as proposed, so they go. */
  const editHeld = async (
    plan_id: string,
    run_id: string,
    args: Record<string, unknown>,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = rowFor(plan_id);
    if (row === undefined || row.status !== 'proposed' || row.hold_run_id !== run_id) return undefined;
    const current = await decodePlan(row, getKey);
    if (current === undefined) return undefined;
    const args_hash = planApproval.computePlanArgsHash(args);
    const identity = { ...row, args_hash };
    // D-336 slice G — the notes a save met were found for its claim: a change of it drops
    // them, and a change of the summary alone leaves them true.
    const claimOf = (a: unknown) => JSON.stringify((a as { claim?: unknown } | null | undefined)?.claim ?? null);
    const conflicts = current.memory_conflicts !== undefined && claimOf(current.args) === claimOf(args)
      ? current.memory_conflicts : undefined;
    const changed = editHeldRun.run({
      plan_id,
      run_id,
      prior_args_hash: row.args_hash,
      args_hash,
      args_encrypted: await encodePayload(args, 'args', identity, getKey),
      resource_review_encrypted: current.resource_review
        ? await encodePayload(current.resource_review, 'resource_review', identity, getKey) : null,
      value_labels_encrypted: current.value_labels
        ? await encodePayload(current.value_labels, 'value_labels', identity, getKey) : null,
      memory_conflicts_encrypted: conflicts !== undefined
        ? await encodePayload(conflicts, 'memory_conflicts', identity, getKey) : null,
    });
    if (changed.changes === 0) return undefined;
    const next = rowFor(plan_id);
    return next === undefined ? undefined : decodePlan(next, getKey);
  };

  /** D-336 slice O's open item — a later save of the same fact, asked while this one waits
   *  (`asked_again`): added to a still-proposed plan's conflicts, once. Sealed to the plan as
   *  the rest are; `undefined` for a plan gone or answered. */
  const addMemoryConflict = async (
    plan_id: string,
    conflict: MemorySaveConflict,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = rowFor(plan_id);
    if (row === undefined || row.status !== 'proposed') return undefined;
    const current = await decodePlan(row, getKey);
    if (current === undefined) return undefined;
    const present = current.memory_conflicts ?? [];
    if (present.some((had) => had.kind === conflict.kind && had.summary === conflict.summary)) return current;
    const changed = addConflictRun.run({
      plan_id,
      args_hash: row.args_hash,
      memory_conflicts_encrypted: await encodePayload([...present, conflict], 'memory_conflicts', row, getKey),
    });
    if (changed.changes === 0) return undefined;
    const next = rowFor(plan_id);
    return next === undefined ? undefined : decodePlan(next, getKey);
  };

  const findByHoldRun = async (
    run_id: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = findHoldRunRow.get({ run_id }) as ChatPlanRow | undefined;
    // The shell, not the decoded plan: settling a hold must not depend on the
    // reviewed args decrypting (a locked vault still gets its outcome).
    if (row === undefined) return undefined;
    return await decodePlan(row, getKey).catch(() => undefined) ?? planShellFromRow(row, null);
  };

  const lapseHold = async (
    plan_id: string,
    run_id: string,
    lapsed_at: number,
  ): Promise<ChatPlanProposal | undefined> => {
    lapseHoldRun.run({ plan_id, run_id, lapsed_at });
    const row = rowFor(plan_id);
    // The shell when the payload cannot be read: nothing runs from a lapsed plan.
    if (row === undefined) return undefined;
    return await decodePlan(row, getKey).catch(() => undefined) ?? planShellFromRow(row, null);
  };

  const findPendingHeld = async (
    session_id: string,
    tool: string,
    args_hash: string,
  ): Promise<ChatPlanProposal | undefined> => {
    const row = findPendingHeldRow.get({ session_id, tool, args_hash }) as ChatPlanRow | undefined;
    return row === undefined ? undefined : decodePlan(row, getKey);
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

  const readRecords = async (rows: ChatPlanRow[]): Promise<ReadonlyArray<ChatPlanRecord>> => {
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
      const execution = await readExecution(row);
      return {
        plan,
        ...(row.message_id !== null ? { message_id: row.message_id } : {}),
        ...(execution !== undefined ? { execution } : {}),
        payload_available: decoded !== undefined,
      };
    }));
  };
  const listForSession = (session_id: string): Promise<ReadonlyArray<ChatPlanRecord>> =>
    readRecords(listSessionRows.all({ session_id }) as ChatPlanRow[]);
  const listForTurn = (session_id: string, turn_id: string): Promise<ReadonlyArray<ChatPlanRecord>> =>
    readRecords(listTurnRows.all({ session_id, turn_id }) as ChatPlanRow[]);

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
      return readExecution(before);
    }
    execution = withLocalProof(before, execution) ?? execution;
    // Facts can close a running claim even if the vault locked after the data
    // commit. Persist only uncertainty metadata; inspection adds the proof.
    if (execution.status === 'completed' && execution.local_receipt && getKey && getKey() === null) {
      execution = { status: 'unknown', turn_id: execution.turn_id };
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
      return current === undefined ? undefined : readExecution(current);
    }
    return withLocalProof(before, execution);
  };

  return {
    async runLocalMutation(plan_id, turn_id, source, validate, dispatch) {
      const before = rowFor(plan_id);
      if (!before || before.status !== 'approved' || before.consumed_at === null
        || before.execution_status !== 'running' || before.execution_turn_id !== turn_id) {
        throw new Error('The local Chat action does not own a consumed dispatch.');
      }
      const plan = await decodePlan(before, getKey);
      if (!plan) throw new Error('The original reviewed Chat action is unavailable.');
      if (!plan.resource_review || !reviewedLocalMutationKind(plan.resource_review)) return withLocalMutationScope(undefined, dispatch);
      const current = () => {
        if (getKey) requireKey(getKey, 'commit reviewed Chat mutation');
        const row = rowFor(plan_id);
        if (!row || row.status !== 'approved' || row.execution_status !== 'running') {
          throw new Error('The reviewed Chat mutation is no longer owned by this dispatch.');
        }
        return chatMutationIdentity(row);
      };
      validate();
      const scope = localMutations.begin({ owner: 'chat_plan', ref: plan_id,
        identity: chatMutationIdentity(before), source, review: plan.resource_review, current, validate });
      return withLocalMutationScope(scope, dispatch);
    },
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
    listForTurn,
    linkTurnToMessage,
    recordExecution,
    unlinkHold,
    editHeld,
    addMemoryConflict,
    findByHoldRun,
    lapseHold,
    findPendingHeld,
    answerMessageId: async (plan_id: string): Promise<string | undefined> => {
      const row = answerMessageRow.get({ plan_id }) as { message_id: string | null } | undefined;
      return row?.message_id ?? undefined;
    },
  };
};
