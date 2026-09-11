/** D-261 durable authority. All decisions, activations and dispatch claims
 * serialize on the realm connection. No network/crypto await occurs inside a
 * write transaction, and no dispatch permit exists before its receipt commits. */
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PREAPPROVAL_LIMITS, RpcError,
  type Checkpoint, type PreparePreapproval,
  type PreapprovalDecisionReceipt, type PreapprovalDecisionRequest,
  type PreapprovalExecutionStatus, type PreapprovalGrantStatus,
  type PreapprovalInspection, type PreapprovalMemberOutcome, type PreapprovalMemberStatus,
  type PreapprovalProposalStatus, type PreapprovalResult, type PreapprovalReview,
  type PreapprovalSelection,
} from '@recued/contracts';
import type {
  OrdinaryRecipeContinuation, PreparedFutureExecution, PreparedInvocation, PreapprovalActivationRecord,
  PreapprovalExecutionBinding, PreapprovalPollBinding, PreapprovalMemberClaim, PreapprovalOrigin, PreapprovalResponder,
  PreapprovalValidationStage,
} from '../preapproval-model.js';
import {
  preapprovalHash, preapprovalOriginKey, preapprovalPathKey, preapprovalReviewDigest,
  preapprovalEffectHash, isPreapprovalMemberEligible, selectPreapprovalMembers, validatePreparedFutureExecution,
} from '../preapproval-invocations.js';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { PreapprovalWorkerAuthority } from './preapproval-workers.js';
import { invalidatePreapprovalLineage } from './preapproval-lineage.js';
import { siblingAutomationNote } from '../preapproval-sibling-notes.js';
import { createPreapprovalCheckpointParticipant, preapprovalCheckpointHash } from './preapproval-checkpoints.js';
import { createPreapprovalLimits, type PreapprovalRequestLimits } from '../preapproval-limits.js';
import { canonicalJSONStringifyStrict } from '@recued/crypto';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { initializePreapprovalLifecycle } from './preapproval-lifecycle.js';

export interface PreapprovalAtomicHooks {
  /** Must read authoritative DB rows on this connection, not cached snapshots. */
  validateLive(plan: PreparedFutureExecution, stage: PreapprovalValidationStage, member?: PreparedInvocation): void;
  validateOrdinaryRecipe?(plan: PreparedFutureExecution, continuation: OrdinaryRecipeContinuation): void;
  validateResponder(responder: PreapprovalResponder): void;
  /** Parks the legacy row and retains immutable snapshot references atomically. */
  activate(plan: PreparedFutureExecution, activation: PreapprovalActivationRecord): void;
  /** Persist the exact occurrence in the SAME transaction as the root claim. */
  selectOccurrence(plan: PreparedFutureExecution, candidate: {
    future_execution_ref: string; occurrence_key: string; occurrence_sequence: number; payload_hash: string;
  }): number;
  stop(plan: PreparedFutureExecution, futureRef: string, reason: string): void;
  /** Creates the real gated-action/pending-commit records in this transaction. */
  createDispatch(claim: Omit<PreapprovalMemberClaim, 'action_ref' | 'commit_id'>,
    member: PreparedInvocation, plan: PreparedFutureExecution): { action_ref: string; commit_id: string | null };
  settleDispatch(claim: PreapprovalMemberClaim,
    outcome: { status: 'succeeded' | 'failed' | 'in_doubt'; message: string; result: unknown }): void;
}
export interface PreapprovalRepositoryOptions {
  codec: PreapprovalCodec;
  hooks: PreapprovalAtomicHooks;
  workers: PreapprovalWorkerAuthority;
  now?: () => number;
  limits?: Partial<PreapprovalRequestLimits>;
}
interface ExecutionRow {
  future_ref: string; proposal_id: string; origin_key: string;
  target_kind: string; target_key: string; target_incarnation: string; target_revision: number;
  selector_sequence: number; occurrence_key: string | null;
  snapshot_hash: string; snapshot_ciphertext: string;
  state: PreapprovalExecutionStatus; revision: number; lineage: string;
  not_before: number; dispatch_deadline: number;
  root_run_id: string | null; worker_id: string | null; fence: number;
  stop_requested: number; status_reason: string | null; checkpoint_id: string | null; occurrence_hash: string;
  created_at: number; updated_at: number;
}
interface ProposalRow {
  proposal_id: string; future_ref: string; origin_key: string; idempotency_key: string;
  input_digest: string; selected_json: string; review_digest: string;
  revision: number; status: PreapprovalProposalStatus; decision_deadline: number;
  created_at: number; updated_at: number;
}
interface GrantRow {
  grant_id: string; future_ref: string; proposal_id: string; decision_id: string;
  status: PreapprovalGrantStatus; revision: number; expires_at: number;
}
interface MemberRow {
  grant_id: string; member_id: string; future_ref: string; path_key: string;
  parent_member_id: string | null; state: PreapprovalMemberStatus;
  attempt_id: string | null; idempotency_key: string | null;
  parent_attempt_id: string | null; action_ref: string | null; commit_id: string | null;
  actual_run_id: string | null; result_ciphertext: string | null;
  revision: number; updated_at: number;
}
interface NestedCallRow {
  run_id: string; future_ref: string; parent_path: string; parent_member_id: string | null;
  state: 'running' | 'held' | 'completed'; checkpoint_id: string | null; result_ciphertext: string | null;
}
interface DecisionRow {
  decision_id: string; proposal_id: string; future_ref: string; grant_id: string | null;
  responder_key: string; responder_channel: PreapprovalResponder['channel'];
  request_id: string; request_digest: string; proposal_revision: number;
  review_digest: string; decision: PreapprovalDecisionReceipt['decision']; decided_at: number;
}
interface ChallengeRow {
  challenge_hash: string; proposal_id: string; proposal_revision: number;
  review_digest: string; responder_key: string; responder_channel: string;
  lineage: string; expires_at: number; consumed_decision_id: string | null;
}
export interface PreapprovalOutboxItem {
  event_id: string; future_ref: string; kind: string; payload_json: string;
  state: 'pending' | 'leased' | 'done'; worker_id: string | null; lease_until: number;
}
export interface PreapprovalReconciliation {
  evidence_id: string; future_execution_ref: string; member_id: string;
  attempt_id: string; action_ref: string; adapter: string; evidence_digest: string;
  outcome: 'succeeded' | 'failed'; observed_at: number;
}
export interface PreapprovalRecoveryResult {
  future_execution_ref: string;
  status: 'worker_live' | 'worker_unknown' | 'checkpoint_required' | 'unchanged' | 'stopped';
  execution_status: PreapprovalExecutionStatus;
}
export interface PreapprovalPrompt {
  ask_id: string; proposal_id: string; proposal_revision: number; review_digest: string;
}
export interface PreapprovalDelivery {
  delivery_id: string; proposal_id: string; proposal_revision: number; review_digest: string;
  connection_id: string; owner_sender: string; conversation_id: string; vendor_message_id: string; lineage: string;
}
export interface PreapprovalTelegramCallback {
  ask_id: string; connection_id: string; owner_sender: string; conversation_id: string;
  vendor_message_id: string; vendor_event_id: string; decision: PreapprovalDecisionReceipt['decision'];
}
interface OrdinaryRecipeRow { run_id: string; future_ref: string; snapshot_ciphertext: string; snapshot_hash: string; json_size: number }
interface LoadedPlan { execution: ExecutionRow; proposal: ProposalRow; plan: PreparedFutureExecution;
  ordinary: Array<{ row: OrdinaryRecipeRow; value: OrdinaryRecipeContinuation }> }
interface PollRow {
  poll_id: string; future_ref: string; run_id: string; worker_id: string; fence: number;
  state: 'polling' | 'held' | 'qualified' | 'finished'; checkpoint_id: string | null; checkpoint_hash: string | null;
}

function fail(code: string, message: string, status = 409): never { throw new RpcError(code, message, status); }
const assertSync = (result: unknown): void => {
  if (result !== undefined) throw new Error('Pre-approval atomic hooks must finish synchronously.');
};
const selectedIds = (row: ProposalRow): string[] => JSON.parse(row.selected_json) as string[];
const terminalMember = (state: PreapprovalMemberStatus): boolean => state !== 'available' && state !== 'dispatching';

export class PreapprovalRepository {
  private readonly now: () => number;
  private readonly codec: PreapprovalCodec;
  private readonly hooks: PreapprovalAtomicHooks;
  private readonly workers: PreapprovalWorkerAuthority;
  private readonly checkpoints: ReturnType<typeof createPreapprovalCheckpointParticipant>;
  readonly limits: ReturnType<typeof createPreapprovalLimits>;

  constructor(private readonly db: Database.Database, options: PreapprovalRepositoryOptions) {
    this.now = options.now ?? Date.now;
    this.codec = options.codec;
    this.hooks = options.hooks;
    this.workers = options.workers;
    this.checkpoints = createPreapprovalCheckpointParticipant(db);
    this.limits = createPreapprovalLimits(db, options.limits);
    initializePreapprovalLifecycle(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS preapproval_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), lineage TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preapproval_executions (
        future_ref TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE,
        origin_key TEXT NOT NULL, target_kind TEXT NOT NULL, target_key TEXT NOT NULL,
        target_incarnation TEXT NOT NULL, target_revision INTEGER NOT NULL,
        selector_sequence INTEGER NOT NULL, occurrence_key TEXT, occurrence_hash TEXT NOT NULL DEFAULT '',
        snapshot_hash TEXT NOT NULL, snapshot_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, lineage TEXT NOT NULL,
        not_before INTEGER NOT NULL, dispatch_deadline INTEGER NOT NULL,
        root_run_id TEXT, worker_id TEXT, fence INTEGER NOT NULL DEFAULT 0,
        stop_requested INTEGER NOT NULL DEFAULT 0, status_reason TEXT, checkpoint_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS preapproval_execution_target
        ON preapproval_executions(target_kind, target_key, target_incarnation);
      CREATE INDEX IF NOT EXISTS preapproval_execution_due
        ON preapproval_executions(state, not_before, dispatch_deadline);
      CREATE TABLE IF NOT EXISTS preapproval_proposals (
        proposal_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL UNIQUE,
        origin_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
        selected_json TEXT NOT NULL, review_digest TEXT NOT NULL,
        revision INTEGER NOT NULL, status TEXT NOT NULL, decision_deadline INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(origin_key, idempotency_key));
      CREATE TABLE IF NOT EXISTS preapproval_retired_reviews (
        future_ref TEXT PRIMARY KEY, summary_ciphertext TEXT NOT NULL, summary_hash TEXT NOT NULL, retired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preapproval_grants (
        grant_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL UNIQUE,
        proposal_id TEXT NOT NULL UNIQUE, decision_id TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preapproval_members (
        grant_id TEXT NOT NULL, member_id TEXT NOT NULL, future_ref TEXT NOT NULL,
        path_key TEXT NOT NULL, parent_member_id TEXT, state TEXT NOT NULL,
        attempt_id TEXT UNIQUE, idempotency_key TEXT UNIQUE, parent_attempt_id TEXT,
        action_ref TEXT UNIQUE, commit_id TEXT, actual_run_id TEXT, result_ciphertext TEXT,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(grant_id, member_id), UNIQUE(future_ref, path_key));
      CREATE TABLE IF NOT EXISTS preapproval_decisions (
        decision_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE,
        future_ref TEXT NOT NULL, grant_id TEXT, responder_key TEXT NOT NULL,
        responder_channel TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL, review_digest TEXT NOT NULL,
        decision TEXT NOT NULL, decided_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preapproval_challenges (
        challenge_hash TEXT PRIMARY KEY, proposal_id TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL, review_digest TEXT NOT NULL,
        responder_key TEXT NOT NULL, responder_channel TEXT NOT NULL,
        lineage TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_decision_id TEXT);
      CREATE INDEX IF NOT EXISTS preapproval_challenge_expiry ON preapproval_challenges(expires_at);
      CREATE TABLE IF NOT EXISTS preapproval_run_links (
        run_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, root_run_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL, entry_path TEXT NOT NULL, fence INTEGER NOT NULL,
        UNIQUE(future_ref, entry_path));
      CREATE TABLE IF NOT EXISTS preapproval_run_checkpoints (
        checkpoint_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, run_id TEXT NOT NULL,
        fence INTEGER NOT NULL, checkpoint_hash TEXT NOT NULL, members_hash TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preapproval_nested_calls (
        run_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, parent_path TEXT NOT NULL,
        parent_member_id TEXT, state TEXT NOT NULL, checkpoint_id TEXT, result_ciphertext TEXT,
        UNIQUE(future_ref, parent_path));
      CREATE TABLE IF NOT EXISTS preapproval_ordinary_recipes (
        run_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, snapshot_ciphertext TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, json_size INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS preapproval_ordinary_recipes_future ON preapproval_ordinary_recipes(future_ref);
      CREATE TABLE IF NOT EXISTS preapproval_dependencies (
        future_ref TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
        incarnation TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
        until_phase TEXT NOT NULL DEFAULT 'terminal',
        PRIMARY KEY(future_ref, kind, key, incarnation));
      CREATE INDEX IF NOT EXISTS preapproval_dependency_lookup
        ON preapproval_dependencies(kind, key, incarnation);
      CREATE TABLE IF NOT EXISTS preapproval_polls (
        poll_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
        worker_id TEXT NOT NULL, fence INTEGER NOT NULL, state TEXT NOT NULL,
        checkpoint_id TEXT, checkpoint_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS preapproval_polls_future ON preapproval_polls(future_ref, state);
      CREATE INDEX IF NOT EXISTS preapproval_polls_history ON preapproval_polls(future_ref, state, updated_at);
      CREATE TABLE IF NOT EXISTS preapproval_reconciliations (
        evidence_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, member_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, action_ref TEXT NOT NULL, evidence_digest TEXT NOT NULL,
        outcome TEXT NOT NULL, observed_at INTEGER NOT NULL, adapter TEXT NOT NULL DEFAULT '',
        UNIQUE(attempt_id, evidence_digest));
      CREATE TABLE IF NOT EXISTS preapproval_deliveries (
        delivery_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, proposal_revision INTEGER NOT NULL,
        review_digest TEXT NOT NULL, connection_id TEXT NOT NULL, owner_sender TEXT NOT NULL,
        conversation_id TEXT NOT NULL, vendor_message_id TEXT NOT NULL, lineage TEXT NOT NULL,
        UNIQUE(connection_id, conversation_id, vendor_message_id));
      CREATE TABLE IF NOT EXISTS preapproval_review_links (
        delivery_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, proposal_revision INTEGER NOT NULL,
        review_digest TEXT NOT NULL, connection_id TEXT NOT NULL, owner_sender TEXT NOT NULL,
        conversation_id TEXT NOT NULL, vendor_message_id TEXT NOT NULL, lineage TEXT NOT NULL,
        UNIQUE(connection_id, conversation_id, vendor_message_id));
      CREATE TABLE IF NOT EXISTS preapproval_prompts (
        ask_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, proposal_revision INTEGER NOT NULL,
        review_digest TEXT NOT NULL, UNIQUE(proposal_id, proposal_revision));
      CREATE TABLE IF NOT EXISTS preapproval_vendor_decisions (
        connection_id TEXT NOT NULL, event_id TEXT NOT NULL, input_digest TEXT NOT NULL,
        decision_id TEXT NOT NULL, PRIMARY KEY(connection_id, event_id));
      CREATE TABLE IF NOT EXISTS preapproval_mutations (
        request_id TEXT NOT NULL, responder_key TEXT NOT NULL, input_digest TEXT NOT NULL,
        future_ref TEXT NOT NULL, PRIMARY KEY(request_id, responder_key));
      CREATE TABLE IF NOT EXISTS preapproval_outbox (
        event_id TEXT PRIMARY KEY, future_ref TEXT NOT NULL, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', worker_id TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0);
    `);
    if (!(db.prepare('PRAGMA table_info(preapproval_reconciliations)').all() as { name: string }[])
      .some(column => column.name === 'adapter')) {
      try { db.exec("ALTER TABLE preapproval_reconciliations ADD COLUMN adapter TEXT NOT NULL DEFAULT ''"); }
      catch (error) {
        if (!(db.prepare('PRAGMA table_info(preapproval_reconciliations)').all() as { name: string }[])
          .some(column => column.name === 'adapter')) throw error;
      }
    }
    db.prepare('INSERT OR IGNORE INTO preapproval_state(singleton, lineage) VALUES(1, ?)').run(randomUUID());
    if (!(db.prepare('PRAGMA table_info(preapproval_executions)').all() as { name: string }[])
      .some(column => column.name === 'occurrence_hash')) {
      try { db.exec("ALTER TABLE preapproval_executions ADD COLUMN occurrence_hash TEXT NOT NULL DEFAULT ''"); }
      catch (error) {
        if (!(db.prepare('PRAGMA table_info(preapproval_executions)').all() as { name: string }[])
          .some(column => column.name === 'occurrence_hash')) throw error;
      }
    }
  }

  private lineage(): string {
    return (this.db.prepare('SELECT lineage FROM preapproval_state WHERE singleton = 1').get() as { lineage: string }).lineage;
  }
  private execution(futureRef: string): ExecutionRow {
    return this.db.prepare('SELECT * FROM preapproval_executions WHERE future_ref = ?').get(futureRef) as ExecutionRow
      ?? fail('not_found', 'The future execution no longer exists.', 404);
  }
  private proposal(proposalId: string): ProposalRow {
    return this.db.prepare('SELECT * FROM preapproval_proposals WHERE proposal_id = ?').get(proposalId) as ProposalRow
      ?? fail('not_found', 'The pre-approval proposal no longer exists.', 404);
  }
  private grant(futureRef: string): GrantRow | null {
    return this.db.prepare('SELECT * FROM preapproval_grants WHERE future_ref = ?').get(futureRef) as GrantRow | undefined ?? null;
  }
  private result(proposal: ProposalRow, plan: PreparedFutureExecution): PreapprovalResult {
    const selected = selectedIds(proposal);
    const uncovered = plan.uncovered.length + plan.members.length - selected.length;
    return { proposal_id: proposal.proposal_id, revision: proposal.revision,
      future_execution_ref: proposal.future_ref, status: proposal.status,
      coverage: uncovered === 0 ? 'complete' : 'partial', eligible_members: selected.length, uncovered_calls: uncovered };
  }
  private resultFromInspection(value: PreapprovalInspection): PreapprovalResult {
    return { proposal_id: value.proposal_id, revision: value.revision, future_execution_ref: value.future_execution_ref,
      status: value.status, coverage: value.coverage, eligible_members: value.eligible_members, uncovered_calls: value.uncovered_calls };
  }
  private async retiredInspection(proposalId: string): Promise<PreapprovalInspection | null> {
    const futureRef = this.proposal(proposalId).future_ref;
    const row = this.db.prepare('SELECT summary_ciphertext,summary_hash FROM preapproval_retired_reviews WHERE future_ref=?')
      .get(futureRef) as { summary_ciphertext: string; summary_hash: string } | undefined;
    if (!row) return null;
    const value = await this.codec.open(row.summary_ciphertext) as { schema_version: number; inspection: PreapprovalInspection };
    if (value.schema_version !== 1 || preapprovalHash(value) !== row.summary_hash
      || value.inspection.proposal_id !== proposalId || value.inspection.future_execution_ref !== futureRef) {
      fail('preapproval_stale', 'The retained outcome is invalid.');
    }
    return value.inspection;
  }
  private async load(proposalId: string): Promise<LoadedPlan> {
    const proposal = this.proposal(proposalId);
    const execution = this.execution(proposal.future_ref);
    if (!execution.snapshot_ciphertext) fail('preapproval_expired', 'The retained review content has expired. Its terminal outcome remains available.');
    const ordinaryRows = this.ordinaryRecipeRows(execution.future_ref);
    const value = await this.codec.open(execution.snapshot_ciphertext);
    if (preapprovalHash(value) !== execution.snapshot_hash) fail('preapproval_stale', 'The prepared snapshot is corrupt.');
    const plan = value as PreparedFutureExecution;
    validatePreparedFutureExecution(plan);
    const ordinary = await Promise.all(ordinaryRows.map(async row => {
      const value = await this.codec.open(row.snapshot_ciphertext) as OrdinaryRecipeContinuation;
      if (preapprovalHash(value) !== row.snapshot_hash || value.schema_version !== 1) fail('preapproval_stale', 'The nested continuation is corrupt.');
      return { row, value };
    }));
    return { proposal, execution, plan, ordinary };
  }
  private ordinaryRecipeRows(futureRef: string): OrdinaryRecipeRow[] {
    return this.db.prepare('SELECT * FROM preapproval_ordinary_recipes WHERE future_ref=? ORDER BY run_id').all(futureRef) as OrdinaryRecipeRow[];
  }
  async loadExecution(futureRef: string): Promise<PreparedFutureExecution> {
    return (await this.load(this.execution(futureRef).proposal_id)).plan;
  }
  inspectExecution(futureRef: string): Promise<PreapprovalInspection> {
    return this.inspect(this.execution(futureRef).proposal_id);
  }
  private current(loaded: LoadedPlan): { execution: ExecutionRow; proposal: ProposalRow } {
    this.codec.assertUnlocked();
    const execution = this.execution(loaded.execution.future_ref);
    const proposal = this.proposal(execution.proposal_id);
    if (execution.snapshot_hash !== loaded.execution.snapshot_hash
      || execution.snapshot_ciphertext !== loaded.execution.snapshot_ciphertext
      || execution.lineage !== this.lineage()) fail('preapproval_stale', 'The prepared execution changed or belongs to a restored server.');
    // Another parallel ordinary child may add its own immutable continuation.
    // It grants nothing and is validated in its insertion transaction. Existing
    // rows may neither disappear nor change across the crypto await.
    const ordinaryRows = new Map(this.ordinaryRecipeRows(execution.future_ref).map(row => [row.run_id, row]));
    if (loaded.ordinary.some(item => preapprovalHash(ordinaryRows.get(item.row.run_id) ?? null) !== preapprovalHash(item.row))) {
      fail('preapproval_stale', 'A nested continuation changed while loading.');
    }
    return { execution, proposal };
  }
  private enqueue(futureRef: string, revision: number, kind: string, payload: Record<string, string | number>): void {
    this.db.prepare('INSERT OR IGNORE INTO preapproval_outbox(event_id, future_ref, kind, payload_json) VALUES(?, ?, ?, ?)')
      .run(`${futureRef}:${revision}:${kind}`, futureRef, kind, JSON.stringify(payload));
  }
  private live(plan: PreparedFutureExecution, stage: PreapprovalValidationStage, member?: PreparedInvocation): void {
    assertSync(this.hooks.validateLive(plan, stage, member));
  }
  private liveLoaded(loaded: LoadedPlan, stage: PreapprovalValidationStage, member?: PreparedInvocation): void {
    this.live(loaded.plan, stage, member);
    for (const { value } of loaded.ordinary) this.validateOrdinaryRecipe(loaded.plan, value);
  }
  private validateOrdinaryRecipe(plan: PreparedFutureExecution, value: OrdinaryRecipeContinuation): void {
    if (!this.hooks.validateOrdinaryRecipe) fail('preapproval_unsupported', 'Ordinary nested continuations are unavailable.');
    assertSync(this.hooks.validateOrdinaryRecipe(plan, value));
  }
  private responder(responder: PreapprovalResponder): void {
    if (!responder.key || (responder.channel !== 'webclient' && responder.channel !== 'telegram')) {
      fail('preapproval_invalid_proof', 'A trusted owner response is required.', 403);
    }
    assertSync(this.hooks.validateResponder(responder));
  }
  private decisionReceipt(row: DecisionRow): PreapprovalDecisionReceipt {
    return { decision_id: row.decision_id, proposal_id: row.proposal_id,
      future_execution_ref: row.future_ref, grant_id: row.grant_id,
      proposal_revision: row.proposal_revision, review_digest: row.review_digest,
      decision: row.decision, decided_at: row.decided_at,
      execution_status: this.execution(row.future_ref).state };
  }

  async preparedRequest(request: PreparePreapproval, origin: PreapprovalOrigin): Promise<PreapprovalResult | null> {
    const prior = this.db.prepare('SELECT * FROM preapproval_proposals WHERE origin_key = ? AND idempotency_key = ?')
      .get(preapprovalOriginKey(origin), request.idempotency_key) as ProposalRow | undefined;
    if (prior) {
      if (prior.input_digest !== preapprovalHash(request)) fail('preapproval_idempotency_conflict', 'This request key was used for different content.');
      // ⛔⛔ A REPLAY IS AN IDEMPOTENCY REPLAY, NOT A STATUS QUERY. Both returns
      // below used to read the CURRENT status, which made re-calling with the
      // same key a polling loop: a caller could watch `awaiting_owner →
      // approved` and learn, per request, that its framing worked. That is a
      // clean reward signal on the owner's decision, handed to whatever asked —
      // and `core.preapproval.request` is grantable to contracts, so the model
      // holding it is exactly who would be trained by it.
      //
      // 🔑 A REPLAY RETURNS WHAT CREATION RETURNED. A proposal is always born
      // `awaiting_owner`, so that is the honest answer to "you already made this
      // request", and it is what the caller already saw. The channel closes
      // without removing anything the caller was legitimately told.
      //
      // ⚠ THE COST, STATED: a replay can no longer distinguish "still pending"
      // from "decided", including a denied or retired proposal. That is
      // deliberate — the decision is the owner's to report, not the request
      // path's to leak. The owner reads live state through `preapproval.get` /
      // `preapproval.list`, both in `MCP_RESERVED_RPC_PREFIXES` and therefore
      // unreachable from the MCP channel. Uniform rather than origin-branched on
      // purpose: no consumer of a prepare RESULT reads `status` (the owner
      // webclient uses `proposal_id` to navigate), so an exception for "trusted"
      // callers would buy nothing and is the kind that erodes.
      const asCreated = (value: PreapprovalResult): PreapprovalResult => ({ ...value, status: 'awaiting_owner' });
      const retired = await this.retiredInspection(prior.proposal_id);
      if (retired) return asCreated(this.resultFromInspection(retired));
      const stored = await this.load(prior.proposal_id);
      return asCreated(this.result(this.proposal(prior.proposal_id), stored.plan));
    }
    return null;
  }

  async prepare(plan: PreparedFutureExecution, notifyOwner: boolean): Promise<PreapprovalResult> {
    validatePreparedFutureExecution(plan);
    const prior = await this.preparedRequest(plan.request, plan.origin);
    if (prior) return prior;
    const originKey = preapprovalOriginKey(plan.origin);
    const digest = preapprovalHash(plan.request);
    const selected = selectPreapprovalMembers(plan);
    const ciphertext = await this.codec.seal(plan);
    const snapshotHash = preapprovalHash(plan);
    this.db.transaction(() => {
      this.codec.assertUnlocked();
      const raced = this.db.prepare('SELECT * FROM preapproval_proposals WHERE origin_key = ? AND idempotency_key = ?')
        .get(originKey, plan.request.idempotency_key) as ProposalRow | undefined;
      if (raced) {
        if (raced.input_digest !== digest) fail('preapproval_idempotency_conflict', 'This request key was used for different content.');
        // A concurrent preparer may mint different member IDs. Return the row
        // outside this transaction after decrypting its own immutable plan.
        return raced.proposal_id;
      }
      this.live(plan, 'prepare');
      const limits = this.limits();
      if (plan.members.length + plan.uncovered.length > limits.candidate_calls
        || Buffer.byteLength(canonicalJSONStringifyStrict(plan), 'utf8') > limits.plan_bytes) {
        fail('preapproval_limit_exceeded', 'The review exceeds the owner-configured request limit.', 429);
      }
      const now = this.now();
      const notBefore = plan.target.due_at ?? now;
      if (now >= plan.request.decision_deadline || plan.request.dispatch_deadline <= notBefore
        || (plan.target.due_at !== null && plan.request.decision_deadline > plan.target.due_at)) {
        fail('preapproval_expired', 'The review or dispatch window has already passed.');
      }
      const counts = this.db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN origin_key = ? THEN 1 ELSE 0 END), 0) AS origin
        FROM preapproval_proposals WHERE status = 'awaiting_owner' AND decision_deadline > ?`)
        .get(originKey, now) as { total: number; origin: number };
      const recent = this.db.prepare('SELECT COUNT(*) AS total FROM preapproval_proposals WHERE origin_key = ? AND created_at > ?')
        .get(originKey, now - 60_000) as { total: number };
      if (counts.total >= limits.pending_per_realm || counts.origin >= limits.pending_per_origin
        || recent.total >= limits.requests_per_minute) fail('preapproval_limit_exceeded', 'Too many pending pre-approval requests.', 429);
      const futureRef = `paf_${randomUUID()}`;
      const proposalId = `pap_${randomUUID()}`;
      const reviewDigest = preapprovalReviewDigest({ proposal_id: proposalId, future_execution_ref: futureRef,
        revision: 1, snapshot_hash: snapshotHash, selected_member_ids: selected });
      this.db.prepare(`INSERT INTO preapproval_executions(future_ref, proposal_id, origin_key,
        target_kind, target_key, target_incarnation, target_revision, selector_sequence,
        snapshot_hash, snapshot_ciphertext, state, revision, lineage, not_before, dispatch_deadline, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?, ?, ?, ?)`)
        .run(futureRef, proposalId, originKey, plan.target.kind, plan.target.key, plan.target.incarnation,
          plan.target.revision, plan.target.qualifying_sequence, snapshotHash, ciphertext,
          this.lineage(), notBefore, plan.request.dispatch_deadline, now, now);
      this.db.prepare(`INSERT INTO preapproval_proposals(proposal_id, future_ref, origin_key,
        idempotency_key, input_digest, selected_json, review_digest, revision, status, decision_deadline, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 1, 'awaiting_owner', ?, ?, ?)`)
        .run(proposalId, futureRef, originKey, plan.request.idempotency_key, digest, JSON.stringify(selected),
          reviewDigest, plan.request.decision_deadline, now, now);
      for (const dependency of plan.dependencies) {
        this.db.prepare(`INSERT INTO preapproval_dependencies(future_ref, kind, key, incarnation, revision, content_hash, until_phase)
          VALUES(?, ?, ?, ?, ?, ?, ?)`)
          .run(futureRef, dependency.kind, dependency.key, dependency.incarnation, dependency.revision,
            dependency.content_hash, dependency.until_phase);
      }
      if (notifyOwner) this.enqueue(futureRef, 1, 'review_requested', { proposal_id: proposalId });
      return this.result(this.proposal(proposalId), plan);
    }).immediate();
    return this.preparedResult(originKey, plan.request.idempotency_key);
  }

  private async preparedResult(originKey: string, key: string): Promise<PreapprovalResult> {
    const row = this.db.prepare('SELECT * FROM preapproval_proposals WHERE origin_key = ? AND idempotency_key = ?')
      .get(originKey, key) as ProposalRow;
    const retired = await this.retiredInspection(row.proposal_id);
    if (retired) return this.resultFromInspection(retired);
    const loaded = await this.load(row.proposal_id);
    return this.result(this.proposal(row.proposal_id), loaded.plan);
  }

  async select(request: PreapprovalSelection, responder: PreapprovalResponder): Promise<PreapprovalResult> {
    const loaded = await this.load(request.proposal_id);
    const selected = selectPreapprovalMembers(loaded.plan, request.member_ids);
    return this.db.transaction(() => {
      const { proposal } = this.current(loaded);
      this.responder(responder);
      if (proposal.status !== 'awaiting_owner' || proposal.revision !== request.expected_revision) fail('preapproval_stale', 'This review changed. Open the current proposal.');
      if (this.now() >= proposal.decision_deadline) fail('preapproval_expired', 'This review has expired.');
      const revision = proposal.revision + 1;
      const digest = preapprovalReviewDigest({ proposal_id: proposal.proposal_id,
        future_execution_ref: proposal.future_ref, revision,
        snapshot_hash: loaded.execution.snapshot_hash, selected_member_ids: selected });
      this.db.prepare('UPDATE preapproval_proposals SET selected_json = ?, review_digest = ?, revision = ?, updated_at = ? WHERE proposal_id = ?')
        .run(JSON.stringify(selected), digest, revision, this.now(), proposal.proposal_id);
      this.db.prepare('DELETE FROM preapproval_challenges WHERE proposal_id = ? AND consumed_decision_id IS NULL').run(proposal.proposal_id);
      this.enqueue(proposal.future_ref, revision, 'review_changed', { proposal_id: proposal.proposal_id });
      return this.result(this.proposal(proposal.proposal_id), loaded.plan);
    }).immediate();
  }

  async review(proposalId: string, responder: PreapprovalResponder): Promise<PreapprovalReview> {
    const loaded = await this.load(proposalId);
    let validPendingOwnerRequest = false;
    return this.guarded(loaded, () => {
      const { proposal, execution } = this.current(loaded);
      this.responder(responder);
      if (proposal.status !== 'awaiting_owner') fail('preapproval_stale', 'This proposal already has an outcome.');
      validPendingOwnerRequest = true;
      const now = this.now();
      if (now >= proposal.decision_deadline) fail('preapproval_expired', 'This review has expired.');
      this.liveLoaded(loaded, 'decide');
      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(now + PREAPPROVAL_LIMITS.challenge_ms, proposal.decision_deadline);
      this.db.prepare('DELETE FROM preapproval_challenges WHERE expires_at <= ? AND consumed_decision_id IS NULL').run(now);
      this.db.prepare(`INSERT INTO preapproval_challenges(challenge_hash, proposal_id, proposal_revision,
        review_digest, responder_key, responder_channel, lineage, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(preapprovalHash(challenge), proposalId, proposal.revision, proposal.review_digest,
          responder.key, responder.channel, execution.lineage, expiresAt);
      return { ...this.reviewDetails(proposal, execution, loaded.plan), challenge, challenge_expires_at: expiresAt };
    }, () => validPendingOwnerRequest);
  }

  /** D-261 § 9.1 — the plan's own notes plus the advisory sibling line.
   *
   *  ⛔ Appended to a COPY. The plan is the sealed reviewed material and its
   *  `interaction_notes` are part of what `snapshot_hash` covers; mutating it
   *  here would change sealed material to carry an unsealed observation.
   *  Best-effort: a sweep that throws must not fail the owner's review — the
   *  note is a courtesy and its absence is the safe outcome. */
  private withSiblingNote(plan: PreparedFutureExecution): string[] {
    const notes = [...plan.interaction_notes];
    try {
      const note = siblingAutomationNote(this.db, {
        recipe_id: plan.recipe.recipe_id,
        // Only a clock target has a schedule row to exclude from its own
        // sweep. `next_auto_run` / `next_trigger` key on recipe / trigger id,
        // which is not a `schedule_id` — excluding by it would be a no-op
        // match against an unrelated namespace.
        target_schedule_id: plan.target.kind === 'next_schedule' || plan.target.kind === 'one_shot'
          ? plan.target.key : null,
        dish_id: this.boundDishId(plan),
        due_at: plan.target.due_at,
      });
      if (note) notes.push(note);
    } catch { /* advisory only — never break a review */ }
    return notes;
  }

  /** The dish this plan's target dispatches as, or `null` for a dishless run.
   *  Read from the pinned `dish` dependency rather than from the live
   *  schedule row: the pin is what the owner REVIEWED, and the live row may
   *  already have moved. */
  private boundDishId(plan: PreparedFutureExecution): string | null {
    const pin = plan.dependencies.find(dependency => dependency.kind === 'dish');
    return pin ? pin.key : null;
  }

  private reviewDetails(proposal: ProposalRow, execution: ExecutionRow, plan: PreparedFutureExecution):
    Omit<PreapprovalReview, 'challenge' | 'challenge_expires_at'> {
      return { ...this.result(proposal, plan), review_digest: proposal.review_digest,
        requested_through: { contract_id: plan.origin.mode === 'contract' ? plan.origin.contract_id : null,
          display_name: plan.origin.display_name, credential_label: plan.origin.credential_label },
        recipe: { recipe_id: plan.recipe.recipe_id, publisher_id: plan.recipe.publisher_id, display_name: plan.recipe.display_name },
        activation: plan.request.activation, decision_deadline: proposal.decision_deadline,
        scheduled_for: plan.target.due_at,
        time_zone: plan.request.activation.kind === 'one_shot' ? plan.request.activation.time_zone : 'UTC',
        dispatch_deadline: execution.dispatch_deadline, members: plan.members.map(member => member.review),
        selected_member_ids: selectedIds(proposal), uncovered: plan.uncovered,
        interaction_notes: this.withSiblingNote(plan) };
  }

  /** Reserve before notification delivery so restarts and outbox retries
   * reuse the exact prompt. Notification content carries only this locator. */
  reservePrompt(proposalId: string): PreapprovalPrompt | null {
    this.codec.assertUnlocked();
    return this.db.transaction(() => {
      const proposal = this.proposal(proposalId);
      const execution = this.execution(proposal.future_ref);
      if (proposal.status !== 'awaiting_owner' || execution.lineage !== this.lineage()) return null;
      if (this.now() >= proposal.decision_deadline) {
        this.stopRow(execution, 'preapproval_expired', 'expired');
        return null;
      }
      const existing = this.db.prepare('SELECT * FROM preapproval_prompts WHERE proposal_id = ? AND proposal_revision = ?')
        .get(proposalId, proposal.revision) as PreapprovalPrompt | undefined;
      if (existing) return existing;
      const prompt: PreapprovalPrompt = { ask_id: `ask-${randomUUID()}`, proposal_id: proposalId,
        proposal_revision: proposal.revision, review_digest: proposal.review_digest };
      this.db.prepare('INSERT INTO preapproval_prompts VALUES(?, ?, ?, ?)')
        .run(prompt.ask_id, proposalId, prompt.proposal_revision, prompt.review_digest);
      return prompt;
    }).immediate();
  }

  listPrompts(proposalId: string): PreapprovalPrompt[] {
    return this.db.prepare('SELECT * FROM preapproval_prompts WHERE proposal_id = ? ORDER BY proposal_revision')
      .all(proposalId) as PreapprovalPrompt[];
  }

  validatePrompt(askId: string, payload: Record<string, unknown>): PreapprovalPrompt {
    const prompt = this.db.prepare('SELECT * FROM preapproval_prompts WHERE ask_id = ?').get(askId) as PreapprovalPrompt | undefined;
    if (!prompt || preapprovalHash(payload) !== preapprovalHash({ proposal_id: prompt.proposal_id,
      proposal_revision: prompt.proposal_revision, review_digest: prompt.review_digest })) {
      fail('preapproval_invalid_proof', 'The notification does not identify its reserved review.', 403);
    }
    return prompt;
  }

  projectPrompt(askId: string, payload: Record<string, unknown>):
    { kind: 'pending' } | { kind: 'stopped' } | { kind: 'decision'; receipt: PreapprovalDecisionReceipt; channel: PreapprovalResponder['channel'] } {
    const prompt = this.validatePrompt(askId, payload);
    const proposal = this.proposal(prompt.proposal_id);
    if (proposal.revision !== prompt.proposal_revision || proposal.review_digest !== prompt.review_digest) return { kind: 'stopped' };
    const decision = this.db.prepare('SELECT * FROM preapproval_decisions WHERE proposal_id = ?').get(proposal.proposal_id) as DecisionRow | undefined;
    if (decision) return { kind: 'decision', receipt: this.decisionReceipt(decision), channel: decision.responder_channel };
    return { kind: proposal.status === 'awaiting_owner' ? 'pending' : 'stopped' };
  }

  getPrompt(askId: string): PreapprovalPrompt | null {
    return this.db.prepare('SELECT * FROM preapproval_prompts WHERE ask_id = ?').get(askId) as PreapprovalPrompt | undefined ?? null;
  }

  reviewTelegram(proposalId: string, connectionId: string, ownerSender: string): Promise<PreapprovalReview> {
    return this.review(proposalId, this.telegramResponder(connectionId, ownerSender));
  }

  listDeliveries(proposalId: string): PreapprovalDelivery[] {
    return this.db.prepare('SELECT * FROM preapproval_deliveries WHERE proposal_id = ? ORDER BY delivery_id')
      .all(proposalId) as PreapprovalDelivery[];
  }

  listReviewLinks(proposalId: string): PreapprovalDelivery[] {
    return this.db.prepare('SELECT * FROM preapproval_review_links WHERE proposal_id = ? ORDER BY delivery_id')
      .all(proposalId) as PreapprovalDelivery[];
  }

  /** A link acknowledges notification delivery only. It is deliberately in
   * a separate table that the decision proof lookup never consults. */
  recordReviewLink(prompt: PreapprovalPrompt, input: Pick<PreapprovalDelivery,
    'connection_id' | 'owner_sender' | 'conversation_id' | 'vendor_message_id'>): PreapprovalDelivery {
    return this.recordReviewNotification(prompt, input, 'link');
  }

  /** Called only after a supported adapter delivered the full matching
   * review. A callback before this commit must be retried, not guessed. */
  recordDelivery(prompt: PreapprovalPrompt, input: Pick<PreapprovalDelivery,
    'connection_id' | 'owner_sender' | 'conversation_id' | 'vendor_message_id'>): PreapprovalDelivery {
    return this.recordReviewNotification(prompt, input, 'review');
  }

  private recordReviewNotification(prompt: PreapprovalPrompt, input: Pick<PreapprovalDelivery,
    'connection_id' | 'owner_sender' | 'conversation_id' | 'vendor_message_id'>, kind: 'review' | 'link'): PreapprovalDelivery {
    const table = kind === 'review' ? 'preapproval_deliveries' : 'preapproval_review_links';
    return this.db.transaction(() => {
      this.codec.assertUnlocked();
      this.validatePrompt(prompt.ask_id, { proposal_id: prompt.proposal_id,
        proposal_revision: prompt.proposal_revision, review_digest: prompt.review_digest });
      const proposal = this.proposal(prompt.proposal_id);
      const execution = this.execution(proposal.future_ref);
      if (proposal.revision !== prompt.proposal_revision || proposal.review_digest !== prompt.review_digest
        || execution.lineage !== this.lineage() || proposal.status !== 'awaiting_owner'
        || this.now() >= proposal.decision_deadline) fail('preapproval_stale', 'The delivered review is no longer current.');
      for (const value of Object.values(input)) if (typeof value !== 'string' || !value.trim() || value.length > 256) {
        fail('preapproval_invalid_proof', 'The delivery has no verified owner/message identity.', 403);
      }
      this.responder(this.telegramResponder(input.connection_id, input.owner_sender));
      const prior = this.db.prepare(`SELECT * FROM ${table}
        WHERE connection_id = ? AND conversation_id = ? AND vendor_message_id = ?`)
        .get(input.connection_id, input.conversation_id, input.vendor_message_id) as PreapprovalDelivery | undefined;
      if (prior) {
        if (prior.proposal_id !== prompt.proposal_id || prior.proposal_revision !== prompt.proposal_revision
          || prior.review_digest !== prompt.review_digest || prior.owner_sender !== input.owner_sender
          || prior.lineage !== execution.lineage) fail('preapproval_stale', 'That vendor message already belongs to a different review.');
        return prior;
      }
      const delivery: PreapprovalDelivery = { ...input, delivery_id: `pdl_${randomUUID()}`,
        proposal_id: prompt.proposal_id, proposal_revision: prompt.proposal_revision,
        review_digest: prompt.review_digest, lineage: execution.lineage };
      this.db.prepare(`INSERT INTO ${table} VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(delivery.delivery_id, delivery.proposal_id, delivery.proposal_revision, delivery.review_digest,
          delivery.connection_id, delivery.owner_sender, delivery.conversation_id, delivery.vendor_message_id, delivery.lineage);
      return delivery;
    }).immediate();
  }

  private telegramResponder(connectionId: string, sender: string): PreapprovalResponder {
    return { channel: 'telegram', key: preapprovalHash(['telegram', connectionId, sender]),
      connection_id: connectionId, owner_sender: sender };
  }

  /** Host-only authenticated Telegram ingress. No callback proof or approved
   * field is exposed to the kernel, RPCs or the model. Both owner channels use
   * the same decision/activation transaction below. */
  async decideTelegram(input: PreapprovalTelegramCallback): Promise<PreapprovalDecisionReceipt> {
    for (const value of Object.values(input)) if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      fail('preapproval_invalid_proof', 'The callback has no verified owner/message identity.', 403);
    }
    if (!['approve', 'deny', 'cancel'].includes(input.decision)) fail('preapproval_invalid_proof', 'Unknown review decision.', 403);
    const prompt = this.getPrompt(input.ask_id) ?? fail('preapproval_invalid_proof', 'This callback has no reserved review.', 403);
    const inputDigest = preapprovalHash(input);
    const responder = this.telegramResponder(input.connection_id, input.owner_sender);
    return this.applyDecision({ proposal_id: prompt.proposal_id, expected_revision: prompt.proposal_revision,
      review_digest: prompt.review_digest, decision: input.decision,
      request_id: `pav_${preapprovalHash([input.connection_id, input.vendor_event_id]).slice(7)}` }, responder, {
      validate: (execution, proposal) => {
        const delivery = this.db.prepare(`SELECT * FROM preapproval_deliveries
          WHERE connection_id = ? AND conversation_id = ? AND vendor_message_id = ?`)
          .get(input.connection_id, input.conversation_id, input.vendor_message_id) as PreapprovalDelivery | undefined;
        if (!delivery || delivery.owner_sender !== input.owner_sender || delivery.proposal_id !== proposal.proposal_id
          || delivery.proposal_revision !== prompt.proposal_revision || delivery.review_digest !== prompt.review_digest
          || delivery.lineage !== execution.lineage) fail('preapproval_invalid_proof', 'The callback does not match the delivered owner review.', 403);
        const prior = this.db.prepare('SELECT input_digest FROM preapproval_vendor_decisions WHERE connection_id = ? AND event_id = ?')
          .get(input.connection_id, input.vendor_event_id) as { input_digest: string } | undefined;
        if (prior && prior.input_digest !== inputDigest) fail('preapproval_decision_conflict', 'That vendor event already records a different decision.');
      },
      consume: decisionId => {
        this.db.prepare('INSERT INTO preapproval_vendor_decisions VALUES(?, ?, ?, ?)')
          .run(input.connection_id, input.vendor_event_id, inputDigest, decisionId);
      },
    });
  }

  async decide(request: PreapprovalDecisionRequest, responder: PreapprovalResponder): Promise<PreapprovalDecisionReceipt> {
    return this.applyDecision(request, responder, {
      validate: (execution, proposal, replay) => {
        if (replay) return; // Original challenge consumption is in the receipt.
        const challenge = this.db.prepare('SELECT * FROM preapproval_challenges WHERE challenge_hash = ?')
          .get(preapprovalHash(request.challenge)) as ChallengeRow | undefined;
        if (!challenge || challenge.proposal_id !== proposal.proposal_id
          || challenge.proposal_revision !== proposal.revision || challenge.review_digest !== proposal.review_digest
          || challenge.responder_key !== responder.key || challenge.responder_channel !== responder.channel
          || challenge.lineage !== execution.lineage || challenge.expires_at <= this.now() || challenge.consumed_decision_id !== null) {
          fail('preapproval_invalid_proof', 'Open this review through your authenticated owner surface.', 403);
        }
      },
      consume: decisionId => {
        this.db.prepare('UPDATE preapproval_challenges SET consumed_decision_id = ? WHERE challenge_hash = ? AND consumed_decision_id IS NULL')
          .run(decisionId, preapprovalHash(request.challenge));
      },
    });
  }

  private async applyDecision(request: Omit<PreapprovalDecisionRequest, 'challenge'>, responder: PreapprovalResponder,
    proof: { validate(execution: ExecutionRow, proposal: ProposalRow, replay: boolean): void; consume(decisionId: string): void },
  ): Promise<PreapprovalDecisionReceipt> {
    const replay = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM preapproval_decisions WHERE proposal_id=?').get(request.proposal_id) as DecisionRow | undefined;
      if (!existing) return null;
      this.codec.assertUnlocked(); this.responder(responder);
      const proposal = this.proposal(request.proposal_id), execution = this.execution(proposal.future_ref);
      if (execution.lineage !== this.lineage()) fail('preapproval_stale', 'This decision belongs to a restored server.');
      proof.validate(execution, proposal, true);
      if (existing.request_id !== request.request_id || existing.request_digest !== preapprovalHash(request)
        || existing.responder_key !== responder.key || existing.responder_channel !== responder.channel) {
        fail('preapproval_decision_conflict', 'This proposal already has an owner decision.');
      }
      return this.decisionReceipt(existing);
    }).immediate();
    if (replay) return replay;
    const loaded = await this.load(request.proposal_id);
    let validatedOwnerRequest = false;
    return this.guarded(loaded, () => {
      const { execution, proposal } = this.current(loaded);
      this.responder(responder);
      const requestDigest = preapprovalHash(request);
      const existing = this.db.prepare('SELECT * FROM preapproval_decisions WHERE proposal_id = ?')
        .get(request.proposal_id) as DecisionRow | undefined;
      proof.validate(execution, proposal, existing !== undefined);
      if (existing) {
        if (existing.request_id === request.request_id && existing.request_digest === requestDigest
          && existing.responder_key === responder.key && existing.responder_channel === responder.channel) return this.decisionReceipt(existing);
        fail('preapproval_decision_conflict', 'This proposal already has an owner decision.');
      }
      const now = this.now();
      if (proposal.status !== 'awaiting_owner' || execution.state !== 'prepared'
        || proposal.revision !== request.expected_revision || proposal.review_digest !== request.review_digest) {
        fail('preapproval_stale', 'The action or review changed before approval.');
      }
      validatedOwnerRequest = true;
      if (now >= proposal.decision_deadline) fail('preapproval_expired', 'This review has expired.');
      // Denial/cancellation grants nothing and remains possible if the target
      // or originating contract has disappeared while the owner reviewed it.
      if (request.decision === 'approve') this.liveLoaded(loaded, 'decide');
      const selected = request.decision === 'approve' ? selectPreapprovalMembers(loaded.plan, selectedIds(proposal)) : [];
      const decisionId = `pad_${randomUUID()}`;
      const grantId = request.decision === 'approve' ? `pag_${randomUUID()}` : null;
      this.db.prepare(`INSERT INTO preapproval_decisions(decision_id, proposal_id, future_ref, grant_id,
        responder_key, responder_channel, request_id, request_digest, proposal_revision, review_digest, decision, decided_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decisionId, proposal.proposal_id, proposal.future_ref, grantId, responder.key, responder.channel,
          request.request_id, requestDigest, proposal.revision, proposal.review_digest, request.decision, now);
      proof.consume(decisionId);
      const status: PreapprovalProposalStatus = request.decision === 'approve' ? 'approved' : request.decision === 'deny' ? 'denied' : 'cancelled';
      this.db.prepare('UPDATE preapproval_proposals SET status = ?, updated_at = ? WHERE proposal_id = ?')
        .run(status, now, proposal.proposal_id);
      if (grantId !== null) {
        this.db.prepare(`INSERT INTO preapproval_grants(grant_id, future_ref, proposal_id, decision_id, status, revision, expires_at)
          VALUES(?, ?, ?, ?, 'active', 1, ?)`)
          .run(grantId, proposal.future_ref, proposal.proposal_id, decisionId, execution.dispatch_deadline);
        for (const memberId of selected) {
          const member = loaded.plan.members.find(item => item.member_id === memberId)!;
          this.db.prepare(`INSERT INTO preapproval_members(grant_id, member_id, future_ref, path_key,
            parent_member_id, state, revision, updated_at) VALUES(?, ?, ?, ?, ?, 'available', 1, ?)`)
            .run(grantId, memberId, proposal.future_ref, preapprovalPathKey(member.invocation_path), member.parent_member_id, now);
        }
        const notBefore = loaded.plan.target.due_at ?? now;
        assertSync(this.hooks.activate(loaded.plan, { future_execution_ref: proposal.future_ref,
          proposal_id: proposal.proposal_id, grant_id: grantId, accepted_at: now, not_before: notBefore }));
        this.db.prepare(`UPDATE preapproval_executions SET state = 'active', not_before = ?, revision = revision + 1,
          updated_at = ? WHERE future_ref = ?`).run(notBefore, now, proposal.future_ref);
      } else {
        assertSync(this.hooks.stop(loaded.plan, proposal.future_ref, status));
        this.db.prepare(`UPDATE preapproval_executions SET state = 'cancelled', status_reason = ?,
          revision = revision + 1, updated_at = ? WHERE future_ref = ?`).run(status, now, proposal.future_ref);
      }
      this.enqueue(proposal.future_ref, proposal.revision, 'decision', { decision_id: decisionId, proposal_id: proposal.proposal_id });
      return this.decisionReceipt(this.db.prepare('SELECT * FROM preapproval_decisions WHERE decision_id = ?').get(decisionId) as DecisionRow);
    }, () => validatedOwnerRequest);
  }

  private stopRow(execution: ExecutionRow, reason: string,
    status: 'cancelled' | 'expired' | 'invalidated'): void {
    if (['succeeded', 'partial', 'failed', 'cancelled', 'expired', 'invalidated'].includes(execution.state)) return;
    const now = this.now();
    const inFlight = this.db.prepare(`SELECT COUNT(*) AS count FROM preapproval_members
      WHERE future_ref = ? AND state IN ('dispatching', 'in_doubt')`).get(execution.future_ref) as { count: number };
    const hasBoundRun = execution.root_run_id !== null && ['running', 'in_doubt'].includes(execution.state);
    const completed = this.db.prepare("SELECT 1 FROM preapproval_members WHERE future_ref=? AND state='succeeded' LIMIT 1")
      .get(execution.future_ref);
    // A durable hold surrendered execution and has no live dispatch. Cancel
    // or expire it now; a dead worker is not needed to retire a waiting ask.
    const state = inFlight.count > 0 || hasBoundRun ? execution.state : completed ? 'partial' : status;
    this.db.prepare(`UPDATE preapproval_executions SET stop_requested = 1, state = ?, status_reason = ?,
      revision = revision + 1, updated_at = ? WHERE future_ref = ?`).run(state, reason, now, execution.future_ref);
    this.db.prepare(`UPDATE preapproval_proposals SET status = ?, updated_at = ?
      WHERE future_ref = ? AND status = 'awaiting_owner'`).run(status, now, execution.future_ref);
    this.db.prepare(`UPDATE preapproval_grants SET status = ?, revision = revision + 1
      WHERE future_ref = ? AND status = 'active'`).run(status === 'cancelled' ? 'revoked' : status, execution.future_ref);
    this.db.prepare(`UPDATE preapproval_members SET state = ?, revision = revision + 1, updated_at = ?
      WHERE future_ref = ? AND state = 'available'`).run(status, now, execution.future_ref);
    this.db.prepare('DELETE FROM preapproval_challenges WHERE proposal_id = ? AND consumed_decision_id IS NULL').run(execution.proposal_id);
    this.enqueue(execution.future_ref, execution.revision + 1, 'execution_stopped', { reason });
  }

  /** A failed admission invalidates the still-unused plan even if a policy or
   * target is later changed back. The savepoint first rolls back partial claims. */
  private guarded<T>(loaded: LoadedPlan, operation: () => T, mayInvalidate: () => boolean = () => true): T {
    const outcome = this.db.transaction((): { value: T } | { error: unknown } => {
      try { return { value: this.db.transaction(operation)() }; }
      catch (error) {
        if (mayInvalidate() && error instanceof RpcError && ['preapproval_stale', 'preapproval_expired',
          'preapproval_authority_changed', 'preapproval_cancelled'].includes(error.code)) {
          this.stopRow(this.execution(loaded.execution.future_ref), error.code,
            error.code === 'preapproval_expired' ? 'expired' : error.code === 'preapproval_cancelled' ? 'cancelled' : 'invalidated');
        }
        return { error };
      }
    }).immediate();
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  private checkRun(execution: ExecutionRow, binding: PreapprovalExecutionBinding, settling = false): void {
    this.workers.assertCurrent(binding.worker_id);
    if (execution.root_run_id !== binding.root_run_id || execution.worker_id !== binding.worker_id
      || execution.fence !== binding.fence || execution.lineage !== this.lineage()) {
      fail('preapproval_already_claimed', 'This worker does not own the selected execution.');
    }
    if (!settling && (execution.stop_requested || execution.state !== 'running')) {
      fail('preapproval_cancelled', 'The selected execution is no longer runnable.');
    }
    if (binding.run_id !== binding.root_run_id) {
      const link = this.db.prepare(`SELECT run_id FROM preapproval_run_links
        WHERE run_id = ? AND future_ref = ? AND root_run_id = ? AND fence = ?`)
        .get(binding.run_id, execution.future_ref, binding.root_run_id, binding.fence);
      if (!link) fail('preapproval_already_claimed', 'The nested run is not part of this execution.');
    }
    if (!settling && this.now() >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window has expired.');
  }

  /** A qualification poll has no run/member reservation. Check the current
   * reviewed target and original authority before allowing its ordinary reads. */
  async beginAutoRunPoll(futureRef: string, workerId: string) {
    const loaded = await this.load(this.execution(futureRef).proposal_id);
    return this.guarded(loaded, () => {
      this.liveAutoRunPoll(loaded);
      this.workers.assertCurrent(workerId);
      const outstanding = this.db.prepare("SELECT count(*) AS count FROM preapproval_polls WHERE future_ref=? AND state IN ('polling','held')")
        .get(futureRef) as { count: number };
      if (outstanding.count >= PREAPPROVAL_LIMITS.candidate_calls) fail('preapproval_limit_exceeded', 'Too many unfinished qualification polls.');
      const binding: PreapprovalPollBinding = { poll_id: `papoll_${randomUUID()}`, future_execution_ref: futureRef,
        run_id: randomUUID(), worker_id: workerId, fence: 1 };
      this.db.prepare(`INSERT INTO preapproval_polls(poll_id,future_ref,run_id,worker_id,fence,state,created_at,updated_at)
        VALUES(?,?,?,?,1,'polling',?,?)`).run(binding.poll_id, futureRef, binding.run_id, workerId, this.now(), this.now());
      return { binding, plan: structuredClone(loaded.plan) };
    });
  }

  private liveAutoRunPoll(loaded: LoadedPlan): void {
    const { execution } = this.current(loaded);
    if (loaded.plan.target.kind !== 'next_auto_run') fail('preapproval_stale', 'This target is not an automatic run.');
    if (execution.stop_requested || this.grant(execution.future_ref)?.status !== 'active') fail('preapproval_cancelled', 'The approval is no longer active.');
    if (execution.state !== 'active') fail('preapproval_already_claimed', 'Another execution already owns this approval.');
    if (this.now() >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window has expired.');
    this.liveLoaded(loaded, 'run');
  }

  pollForRun(runId: string): string | null {
    return (this.db.prepare('SELECT poll_id FROM preapproval_polls WHERE run_id=?').get(runId) as { poll_id: string } | undefined)?.poll_id ?? null;
  }

  private checkPoll(binding: PreapprovalPollBinding, qualified = false): PollRow {
    this.workers.assertCurrent(binding.worker_id);
    const row = this.db.prepare('SELECT * FROM preapproval_polls WHERE poll_id=?').get(binding.poll_id) as PollRow | undefined;
    if (!row || row.future_ref !== binding.future_execution_ref || row.run_id !== binding.run_id
      || row.worker_id !== binding.worker_id || row.fence !== binding.fence
      || (row.state !== 'polling' && !(qualified && row.state === 'qualified'))) {
      fail('preapproval_already_claimed', 'This qualification poll no longer owns its continuation.');
    }
    return row;
  }

  async validatePoll(binding: PreapprovalPollBinding): Promise<void> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    this.guarded(loaded, () => { this.checkPoll(binding); this.liveAutoRunPoll(loaded); });
  }

  finishPoll(binding: PreapprovalPollBinding): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE preapproval_polls SET state='finished',updated_at=? WHERE poll_id=? AND worker_id=? AND fence=? AND state='polling'`)
        .run(this.now(), binding.poll_id, binding.worker_id, binding.fence);
      const retired = this.db.prepare(`SELECT checkpoint_id,run_id FROM preapproval_polls
        WHERE future_ref=? AND state='finished' ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ?`)
        .all(binding.future_execution_ref, PREAPPROVAL_LIMITS.candidate_calls) as Array<{ checkpoint_id: string | null; run_id: string }>;
      for (const poll of retired) if (poll.checkpoint_id) {
        // A checkpoint key may have been replaced. Retire only this poll's
        // exact stored run, in the same transaction as its history link.
        this.db.prepare("DELETE FROM checkpoints WHERE key=? AND json_valid(data) AND json_extract(data,'$.run_id')=?")
          .run(poll.checkpoint_id, poll.run_id);
      }
      this.db.prepare(`DELETE FROM preapproval_polls WHERE poll_id IN (SELECT poll_id FROM preapproval_polls
        WHERE future_ref=? AND state='finished' ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ?)`)
        .run(binding.future_execution_ref, PREAPPROVAL_LIMITS.candidate_calls);
    }).immediate();
  }

  stopOversizedTrigger(futureRef: string): void {
    if (!this.db.inTransaction) throw new Error('Trigger overflow must stop its activation atomically with ingress.');
    const execution = this.execution(futureRef);
    if (execution.target_kind !== 'next_trigger' || execution.state !== 'active') fail('preapproval_stale', 'This trigger no longer owns the event window.');
    this.stopRow(execution, 'preapproval_limit_exceeded', 'invalidated');
  }

  async holdPoll(binding: PreapprovalPollBinding, checkpoint: Checkpoint): Promise<void> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    this.guarded(loaded, () => {
      this.checkPoll(binding); this.liveAutoRunPoll(loaded);
      if (checkpoint.execution_phase !== 'trigger' || checkpoint.preapproval_candidate_ref !== binding.poll_id
        || checkpoint.preapproval_execution_ref || checkpoint.run_id !== binding.run_id
        || checkpoint.recipe_id !== loaded.plan.recipe.recipe_id) fail('preapproval_stale', 'This checkpoint does not own the watcher poll.');
      this.checkpoints.write(checkpoint);
      this.db.prepare(`UPDATE preapproval_polls SET state='held',checkpoint_id=?,checkpoint_hash=?,updated_at=? WHERE poll_id=?`)
        .run(checkpoint.checkpoint_id, preapprovalCheckpointHash(checkpoint), this.now(), binding.poll_id);
    });
  }

  async resumePoll(checkpoint: Checkpoint, workerId: string) {
    const pollId = this.pollForRun(checkpoint.run_id);
    if (!pollId || checkpoint.preapproval_candidate_ref !== pollId || checkpoint.preapproval_execution_ref) {
      fail('preapproval_stale', 'The checkpoint does not identify its original watcher poll.');
    }
    const initial = this.db.prepare('SELECT * FROM preapproval_polls WHERE poll_id=?').get(pollId) as PollRow;
    const loaded = await this.load(this.execution(initial.future_ref).proposal_id);
    let verifiedCheckpoint = false;
    return this.guarded(loaded, () => {
      this.workers.assertCurrent(workerId);
      const row = this.db.prepare('SELECT * FROM preapproval_polls WHERE poll_id=?').get(pollId) as PollRow;
      if (row.state !== 'held') fail('preapproval_already_claimed', 'Another continuation already owns this watcher hold.');
      if (row.checkpoint_id !== checkpoint.checkpoint_id || row.checkpoint_hash !== preapprovalCheckpointHash(checkpoint)) {
        fail('preapproval_stale', 'The watcher checkpoint changed.');
      }
      verifiedCheckpoint = true;
      this.liveAutoRunPoll(loaded);
      const binding: PreapprovalPollBinding = { poll_id: pollId, future_execution_ref: row.future_ref,
        run_id: row.run_id, worker_id: workerId, fence: row.fence + 1 };
      this.db.prepare(`UPDATE preapproval_polls SET state='polling',worker_id=?,fence=?,checkpoint_id=NULL,checkpoint_hash=NULL,updated_at=? WHERE poll_id=?`)
        .run(workerId, binding.fence, this.now(), pollId);
      return { binding, plan: structuredClone(loaded.plan) };
    }, () => verifiedCheckpoint);
  }

  async claimRun(input: { future_execution_ref: string; run_id: string; worker_id: string;
    occurrence_key: string; occurrence_sequence: number; payload_hash?: string;
    poll_binding?: PreapprovalPollBinding }): Promise<PreapprovalExecutionBinding> {
    const loaded = await this.load(this.execution(input.future_execution_ref).proposal_id);
    return this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.workers.assertCurrent(input.worker_id);
      if (loaded.plan.target.kind === 'next_auto_run') {
        const poll = input.poll_binding;
        if (!poll || poll.future_execution_ref !== input.future_execution_ref || poll.run_id !== input.run_id
          || poll.worker_id !== input.worker_id || input.occurrence_key !== `poll:${poll.poll_id}:${poll.fence}`) {
          fail('preapproval_stale', 'An automatic run requires its exact qualifying poll.');
        }
        this.checkPoll(poll, true);
      } else if (input.poll_binding) fail('preapproval_stale', 'This activation is not a qualification poll.');
      const grant = this.grant(execution.future_ref);
      const now = this.now();
      if (execution.stop_requested || grant?.status !== 'active') fail('preapproval_cancelled', 'The approval is no longer active.');
      if (execution.state === 'running' && execution.root_run_id === input.run_id
        && execution.worker_id === input.worker_id && execution.occurrence_key === input.occurrence_key) {
        if (execution.occurrence_hash !== (input.payload_hash ?? preapprovalHash(null))) {
          fail('preapproval_stale', 'The selected event payload changed.');
        }
        if (now >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window has expired.');
        this.liveLoaded(loaded, 'run');
        return { future_execution_ref: execution.future_ref, root_run_id: input.run_id,
          run_id: input.run_id, worker_id: input.worker_id, fence: execution.fence };
      }
      if (execution.state !== 'active') fail('preapproval_already_claimed', 'Another execution already owns this approval.');
      if (now < execution.not_before) fail('preapproval_unresolved', 'This execution is not due yet.');
      if (now >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window has expired.');
      if (!input.run_id || !input.worker_id || !input.occurrence_key || !Number.isSafeInteger(input.occurrence_sequence)
        || input.occurrence_sequence < 0) fail('preapproval_unresolved', 'Missing durable occurrence or worker identity.');
      if (loaded.plan.target.due_at !== null && input.occurrence_key !== `due:${loaded.plan.target.due_at}`) {
        fail('preapproval_stale', 'This is not the reviewed schedule occurrence.');
      }
      if ((execution.target_kind === 'next_trigger' || execution.target_kind === 'next_auto_run')
        && input.occurrence_sequence <= execution.selector_sequence) fail('preapproval_unresolved', 'This candidate precedes the selected execution window.');
      this.liveLoaded(loaded, 'run');
      const sequence = this.hooks.selectOccurrence(loaded.plan, { ...input,
        payload_hash: input.payload_hash ?? preapprovalHash(null) });
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Occurrence selection did not finish synchronously.');
      const fence = execution.fence + 1;
      if (input.poll_binding) this.db.prepare(`UPDATE preapproval_polls SET state='qualified',updated_at=? WHERE poll_id=?`)
        .run(now, input.poll_binding.poll_id);
      this.db.prepare(`UPDATE preapproval_executions SET state = 'running', root_run_id = ?, worker_id = ?,
        fence = ?, occurrence_key = ?, occurrence_hash = ?, revision = revision + 1, updated_at = ?
        WHERE future_ref = ? AND state = 'active'`).run(input.run_id, input.worker_id, fence,
        input.occurrence_key, input.payload_hash ?? preapprovalHash(null), now, execution.future_ref);
      this.enqueue(execution.future_ref, execution.revision + 1, 'execution_started', { run_id: input.run_id });
      return { future_execution_ref: execution.future_ref, root_run_id: input.run_id,
        run_id: input.run_id, worker_id: input.worker_id, fence };
    });
  }

  async bindNestedRun(binding: PreapprovalExecutionBinding, nestedRunId: string,
    entryPath: PreparedInvocation['invocation_path'], parentClaim: PreapprovalMemberClaim | null,
    ordinary?: OrdinaryRecipeContinuation): Promise<PreapprovalExecutionBinding> {
    if (ordinary && Buffer.byteLength(JSON.stringify(ordinary)) > PREAPPROVAL_LIMITS.plan_bytes) {
      fail('preapproval_limit_exceeded', 'The ordinary nested continuation exceeds the snapshot limit.');
    }
    const ordinaryCiphertext = ordinary ? await this.codec.seal(ordinary) : null;
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    return this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, binding);
      const key = preapprovalPathKey(entryPath);
      const prepared = loaded.plan.recipe_snapshots.some(snapshot => snapshot.invocation_path.length > 1
        && preapprovalPathKey(snapshot.invocation_path) === key);
      if ((!ordinary && !prepared) || (ordinary && (prepared || parentClaim
        || preapprovalPathKey(ordinary.snapshot.invocation_path) !== key))) {
        fail('preapproval_stale', 'The nested recipe was not part of the reviewed execution.');
      }
      const parentPath = preapprovalPathKey(entryPath.slice(0, -2));
      const parent = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref = ? AND path_key = ?')
        .get(execution.future_ref, parentPath) as MemberRow | undefined;
      if (parentClaim ? (!parent || parent.state !== 'dispatching' || parent.actual_run_id !== binding.run_id
        || parentClaim.future_execution_ref !== binding.future_execution_ref || parentClaim.run_id !== binding.run_id
        || parentClaim.worker_id !== binding.worker_id || parentClaim.fence !== binding.fence
        || parent.attempt_id !== parentClaim.attempt_id || parent.action_ref !== parentClaim.action_ref
        || parent.path_key !== parentPath) : parent !== undefined) {
        fail('preapproval_stale', 'The nested recipe does not belong to this parent attempt.');
      }
      this.liveLoaded(loaded, 'run');
      if (ordinary) {
        const path = entryPath.slice(0, -2);
        if (!loaded.plan.uncovered.some(item => item.subtree && item.invocation_path.length <= path.length
          && preapprovalPathKey(path.slice(0, item.invocation_path.length)) === preapprovalPathKey(item.invocation_path))) {
          fail('preapproval_stale', 'The nested recipe is not inside an explicitly uncovered subtree.');
        }
        this.validateOrdinaryRecipe(loaded.plan, ordinary);
        const rows = this.ordinaryRecipeRows(execution.future_ref);
        if (rows.length + loaded.plan.recipe_snapshots.length >= PREAPPROVAL_LIMITS.candidate_calls
          || rows.reduce((total, row) => total + row.json_size, Buffer.byteLength(JSON.stringify(ordinary))) > PREAPPROVAL_LIMITS.plan_bytes) {
          fail('preapproval_limit_exceeded', 'The ordinary nested continuation limit was reached.');
        }
      }
      const existing = this.db.prepare('SELECT run_id, parent_run_id FROM preapproval_run_links WHERE future_ref = ? AND entry_path = ?')
        .get(execution.future_ref, key) as { run_id: string; parent_run_id: string } | undefined;
      if (existing && (existing.run_id !== nestedRunId || existing.parent_run_id !== binding.run_id)) {
        fail('preapproval_already_claimed', 'A different nested run already owns this invocation.');
      }
      if (!existing) this.db.prepare(`INSERT INTO preapproval_run_links(run_id, future_ref, root_run_id,
        parent_run_id, entry_path, fence) VALUES(?, ?, ?, ?, ?, ?)`)
        .run(nestedRunId, execution.future_ref, binding.root_run_id, binding.run_id, key, binding.fence);
      this.db.prepare(`INSERT OR IGNORE INTO preapproval_nested_calls(run_id,future_ref,parent_path,parent_member_id,state)
        VALUES(?,?,?,?,'running')`).run(nestedRunId, execution.future_ref, parentPath, parentClaim?.member_id ?? null);
      if (ordinary && !existing) {
        this.db.prepare(`INSERT INTO preapproval_ordinary_recipes(run_id,future_ref,snapshot_ciphertext,snapshot_hash,json_size)
          VALUES(?,?,?,?,?)`).run(nestedRunId, execution.future_ref, ordinaryCiphertext, preapprovalHash(ordinary), Buffer.byteLength(JSON.stringify(ordinary)));
        for (const pin of ordinary.dependencies) this.db.prepare(`INSERT OR IGNORE INTO preapproval_dependencies
          (future_ref,kind,key,incarnation,revision,content_hash,until_phase) VALUES(?,?,?,?,?,?,'terminal')`)
          .run(execution.future_ref, pin.kind, pin.key, pin.incarnation, pin.revision, pin.content_hash);
      }
      return { ...binding, run_id: nestedRunId };
    });
  }

  runContext(binding: PreapprovalExecutionBinding): { entry_path: string; parent_attempt_id: string | null } | null {
    this.checkRun(this.execution(binding.future_execution_ref), binding);
    if (binding.run_id === binding.root_run_id) return null;
    const link = this.db.prepare('SELECT entry_path FROM preapproval_run_links WHERE run_id=? AND future_ref=?')
      .get(binding.run_id, binding.future_execution_ref) as { entry_path: string };
    const entry = JSON.parse(link.entry_path) as PreparedInvocation['invocation_path'];
    const parent = this.db.prepare('SELECT attempt_id FROM preapproval_members WHERE future_ref=? AND path_key=?')
      .get(binding.future_execution_ref, preapprovalPathKey(entry.slice(0, -2))) as { attempt_id: string | null } | undefined;
    return { entry_path: link.entry_path, parent_attempt_id: parent?.attempt_id ?? null };
  }

  async runSnapshot(binding: PreapprovalExecutionBinding) {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    return this.guarded(loaded, () => {
      this.checkRun(this.current(loaded).execution, binding);
      this.liveLoaded(loaded, 'run');
      const context = this.runContext(binding);
      const snapshot = this.snapshotForRun(loaded, binding);
      if (!snapshot) fail('preapproval_stale', 'The run has no frozen recipe continuation.');
      return { snapshot, context };
    });
  }
  private snapshotForRun(loaded: LoadedPlan, binding: PreapprovalExecutionBinding) {
    if (binding.run_id === binding.root_run_id) return loaded.plan.recipe_snapshots[0];
    const link = this.db.prepare('SELECT entry_path FROM preapproval_run_links WHERE run_id=? AND future_ref=?')
      .get(binding.run_id, binding.future_execution_ref) as { entry_path: string } | undefined;
    return link && (loaded.plan.recipe_snapshots.find(item => preapprovalPathKey(item.invocation_path) === link.entry_path)
      ?? loaded.ordinary.find(item => item.row.run_id === binding.run_id
        && preapprovalPathKey(item.value.snapshot.invocation_path) === link.entry_path)?.value.snapshot);
  }

  async nestedInvocation(binding: PreapprovalExecutionBinding, parentPath: PreparedInvocation['invocation_path']) {
    this.checkRun(this.execution(binding.future_execution_ref), binding);
    const row = this.db.prepare(`SELECT n.* FROM preapproval_nested_calls n JOIN preapproval_run_links l ON l.run_id=n.run_id
      WHERE n.future_ref=? AND n.parent_path=? AND l.parent_run_id=?`)
      .get(binding.future_execution_ref, preapprovalPathKey(parentPath), binding.run_id) as NestedCallRow | undefined;
    if (!row) return null;
    const result: unknown = row.result_ciphertext ? await this.codec.open(row.result_ciphertext) : null;
    this.checkRun(this.execution(binding.future_execution_ref), binding);
    const fresh = this.db.prepare('SELECT * FROM preapproval_nested_calls WHERE run_id=?').get(row.run_id) as NestedCallRow;
    if (preapprovalHash(fresh) !== preapprovalHash(row)) fail('preapproval_already_claimed', 'The nested invocation changed while loading its result.');
    let claim: PreapprovalMemberClaim | null = null;
    if (row.parent_member_id) {
      const member = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref=? AND member_id=?')
        .get(binding.future_execution_ref, row.parent_member_id) as MemberRow;
      if (!member.attempt_id || !member.idempotency_key || !member.action_ref || member.actual_run_id !== binding.run_id) {
        fail('preapproval_stale', 'The nested invocation lost its original parent attempt.');
      }
      claim = { ...binding, member_id: member.member_id, grant_id: member.grant_id, attempt_id: member.attempt_id,
        idempotency_key: member.idempotency_key, action_ref: member.action_ref, commit_id: member.commit_id,
        parent_attempt_id: member.parent_attempt_id };
    }
    return { ...row, result, claim };
  }

  async completeNestedRun(binding: PreapprovalExecutionBinding, result: unknown, resumeParent = false): Promise<void> {
    const ciphertext = await this.codec.seal(result);
    this.db.transaction(() => {
      const execution = this.execution(binding.future_execution_ref);
      this.checkRun(execution, binding, true);
      const row = this.db.prepare('SELECT * FROM preapproval_nested_calls WHERE run_id=?').get(binding.run_id) as NestedCallRow | undefined;
      if (!row || row.future_ref !== binding.future_execution_ref) fail('preapproval_stale', 'The nested run disappeared.');
      if (row.state === 'completed') fail('preapproval_already_claimed', 'The nested result was already recorded.');
      this.db.prepare(`UPDATE preapproval_nested_calls SET state='completed',result_ciphertext=? WHERE run_id=?`)
        .run(ciphertext, binding.run_id);
      if (execution.stop_requested && execution.state === 'running'
        && !this.db.prepare("SELECT 1 FROM preapproval_nested_calls WHERE future_ref=? AND state='running' LIMIT 1").get(execution.future_ref)) {
        const root = this.db.prepare(`SELECT checkpoint_id,checkpoint_hash FROM preapproval_run_checkpoints
          WHERE future_ref=? AND run_id=? AND state='waiting' ORDER BY rowid DESC LIMIT 1`)
          .get(execution.future_ref, execution.root_run_id) as { checkpoint_id: string; checkpoint_hash: string } | undefined;
        const checkpoint = root && this.checkpoints.read(root.checkpoint_id);
        if (checkpoint?.preapproval_nested_wait && preapprovalCheckpointHash(checkpoint) === root!.checkpoint_hash) {
          // The last resumed child has drained and every ancestor is already
          // waiting. Cancellation forbids waking the parent just to finish its
          // bookkeeping; retire the group with this durable child result.
          this.finishRunRow(execution, 'failed');
        }
      }
      if (resumeParent && !execution.stop_requested && execution.state === 'running') {
        const link = this.db.prepare('SELECT parent_run_id FROM preapproval_run_links WHERE run_id=?')
          .get(binding.run_id) as { parent_run_id: string };
        const held = this.db.prepare(`SELECT checkpoint_id,checkpoint_hash FROM preapproval_run_checkpoints WHERE future_ref=? AND run_id=?
          AND state='waiting' ORDER BY rowid DESC LIMIT 1`).get(execution.future_ref, link.parent_run_id) as { checkpoint_id: string; checkpoint_hash: string } | undefined;
        const checkpoint = held && this.checkpoints.read(held.checkpoint_id);
        if (!checkpoint || preapprovalCheckpointHash(checkpoint) !== held!.checkpoint_hash
          || checkpoint.preapproval_nested_wait?.child_run_id !== binding.run_id) fail('preapproval_stale', 'The parent continuation disappeared.');
        // The child result and release to its already-waiting parent commit
        // together. A crash here needs no new owner decision or child replay.
        this.db.prepare("UPDATE preapproval_run_checkpoints SET state='ready',fence=?,members_hash=? WHERE checkpoint_id=?")
          .run(binding.fence, this.memberWatermark(execution.future_ref), checkpoint.checkpoint_id);
        this.db.prepare("UPDATE preapproval_executions SET state='held',checkpoint_id=?,revision=revision+1,updated_at=? WHERE future_ref=?")
          .run(checkpoint.checkpoint_id, this.now(), execution.future_ref);
        this.enqueue(execution.future_ref, execution.revision + 1, 'execution_held', { checkpoint_id: checkpoint.checkpoint_id, child_completed: 1 });
      }
    }).immediate();
  }

  /** Only routing attempts may remain open across a nested hold. All actual
   * effects, including parallel prefetches, must have drained. */
  private hasUnresolvedEffects(futureRef: string): boolean {
    return this.db.prepare(`SELECT 1 FROM preapproval_members m WHERE m.future_ref=?
      AND m.state NOT IN ('available','succeeded','skipped') AND NOT (m.state='dispatching' AND EXISTS (
        SELECT 1 FROM preapproval_nested_calls n WHERE n.future_ref=m.future_ref AND n.parent_member_id=m.member_id AND n.state IN ('held','completed')))
      LIMIT 1`).get(futureRef) !== undefined;
  }

  private sealHold(execution: ExecutionRow, root: Checkpoint): void {
    if (root.run_id !== execution.root_run_id || this.hasUnresolvedEffects(execution.future_ref)) {
      fail('preapproval_in_doubt', 'A running or unresolved effect cannot be checkpointed for replay.');
    }
    let leaf = root;
    const visited = new Set<string>();
    while (leaf.preapproval_nested_wait) {
      if (visited.has(leaf.run_id)) fail('preapproval_stale', 'The nested checkpoint chain contains a cycle.');
      visited.add(leaf.run_id);
      const child = this.db.prepare(`SELECT n.* FROM preapproval_nested_calls n JOIN preapproval_run_links l ON l.run_id=n.run_id
        WHERE n.run_id=? AND n.future_ref=? AND l.parent_run_id=? AND l.fence=?`)
        .get(leaf.preapproval_nested_wait.child_run_id, execution.future_ref, leaf.run_id, execution.fence) as NestedCallRow | undefined;
      if (!child || child.state !== 'held' || !child.checkpoint_id) fail('preapproval_stale', 'The child no longer owns this wait.');
      const next = this.checkpoints.read(child.checkpoint_id);
      if (!next || next.run_id !== child.run_id || next.preapproval_execution_ref !== execution.future_ref) {
        fail('preapproval_stale', 'The nested checkpoint chain is incomplete.');
      }
      const stored = this.db.prepare('SELECT checkpoint_hash FROM preapproval_run_checkpoints WHERE checkpoint_id=? AND state IN (\'staged\',\'waiting\')')
        .get(next.checkpoint_id) as { checkpoint_hash: string } | undefined;
      if (!stored || stored.checkpoint_hash !== preapprovalCheckpointHash(next)) fail('preapproval_stale', 'A nested checkpoint changed.');
      leaf = next;
    }
    this.db.prepare("UPDATE preapproval_run_checkpoints SET state='waiting' WHERE future_ref=? AND state='staged'").run(execution.future_ref);
    this.db.prepare("UPDATE preapproval_run_checkpoints SET state='held',members_hash=?,fence=? WHERE checkpoint_id=? AND state='waiting'")
      .run(this.memberWatermark(execution.future_ref), execution.fence, leaf.checkpoint_id);
    this.db.prepare(`UPDATE preapproval_executions SET state='held',checkpoint_id=?,revision=revision+1,updated_at=? WHERE future_ref=?`)
      .run(leaf.checkpoint_id, this.now(), execution.future_ref);
    this.enqueue(execution.future_ref, execution.revision + 1, 'execution_held', { checkpoint_id: leaf.checkpoint_id, root_checkpoint_id: root.checkpoint_id });
  }

  canPublishCheckpoint(checkpointId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM preapproval_executions e JOIN preapproval_run_checkpoints c ON c.future_ref=e.future_ref
      WHERE c.checkpoint_id=? AND c.state='held' AND e.state='held' AND e.checkpoint_id=c.checkpoint_id AND e.stop_requested=0
        AND e.dispatch_deadline>? AND EXISTS(SELECT 1 FROM preapproval_grants g WHERE g.future_ref=e.future_ref AND g.status='active')`)
      .get(checkpointId, this.now()) !== undefined;
  }

  canDeferCheckpoint(checkpointId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM preapproval_run_checkpoints c JOIN preapproval_executions e ON e.future_ref=c.future_ref
      WHERE c.checkpoint_id=? AND c.state IN ('staged','waiting','held') AND e.state IN ('running','held')
        AND e.stop_requested=0 AND e.dispatch_deadline>?`).get(checkpointId, this.now()) !== undefined;
  }

  checkpointWasStopped(checkpointId: string, runId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM preapproval_executions e WHERE (e.stop_requested=1
      OR e.state IN ('succeeded','partial','failed','in_doubt','cancelled','expired','invalidated')) AND (
        EXISTS(SELECT 1 FROM preapproval_run_checkpoints c WHERE c.future_ref=e.future_ref AND c.checkpoint_id=? AND c.run_id=?)
        OR EXISTS(SELECT 1 FROM preapproval_polls p WHERE p.future_ref=e.future_ref AND p.checkpoint_id=? AND p.run_id=?))`)
      .get(checkpointId, runId, checkpointId, runId) !== undefined;
  }

  pendingNestedParents(): string[] {
    return (this.db.prepare(`SELECT c.checkpoint_id FROM preapproval_run_checkpoints c JOIN preapproval_executions e ON e.future_ref=c.future_ref
      WHERE c.state='ready' AND e.state='held' AND e.checkpoint_id=c.checkpoint_id AND e.stop_requested=0 ORDER BY c.rowid LIMIT 100`)
      .all() as Array<{ checkpoint_id: string }>).map(row => row.checkpoint_id);
  }

  async claimReadyNestedParent(checkpointId: string, workerId: string) {
    const row = this.db.prepare('SELECT future_ref FROM preapproval_run_checkpoints WHERE checkpoint_id=?')
      .get(checkpointId) as { future_ref: string } | undefined;
    if (!row) fail('preapproval_already_claimed', 'The parent continuation no longer exists.');
    const loaded = await this.load(this.execution(row.future_ref).proposal_id);
    return this.guarded(loaded, () => {
      const execution = this.current(loaded).execution;
      this.workers.assertCurrent(workerId);
      const held = this.db.prepare('SELECT * FROM preapproval_run_checkpoints WHERE checkpoint_id=?').get(checkpointId) as {
        state: string; fence: number; checkpoint_hash: string; members_hash: string; run_id: string };
      if (execution.state !== 'held' || execution.checkpoint_id !== checkpointId || held.state !== 'ready' || held.fence !== execution.fence) {
        fail('preapproval_already_claimed', 'The parent continuation was already claimed.');
      }
      const checkpoint = this.checkpoints.read(checkpointId);
      if (!checkpoint?.preapproval_nested_wait || checkpoint.run_id !== held.run_id
        || preapprovalCheckpointHash(checkpoint) !== held.checkpoint_hash || this.memberWatermark(row.future_ref) !== held.members_hash) {
        fail('preapproval_stale', 'The parent continuation changed.');
      }
      if (execution.stop_requested || this.grant(row.future_ref)?.status !== 'active') fail('preapproval_cancelled', 'The execution was stopped.');
      if (this.now() >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window expired.');
      const child = this.db.prepare(`SELECT n.* FROM preapproval_nested_calls n JOIN preapproval_run_links l ON l.run_id=n.run_id
        WHERE n.run_id=? AND n.future_ref=? AND l.parent_run_id=?`)
        .get(checkpoint.preapproval_nested_wait.child_run_id, row.future_ref, checkpoint.run_id) as NestedCallRow | undefined;
      if (!child || child.state !== 'completed' || !child.result_ciphertext) fail('preapproval_stale', 'The child has no durable result.');
      this.liveLoaded(loaded, 'run');
      const fence = execution.fence + 1;
      this.db.prepare("UPDATE preapproval_run_checkpoints SET state='claimed' WHERE checkpoint_id=? AND state='ready'").run(checkpointId);
      this.db.prepare("UPDATE preapproval_executions SET state='running',checkpoint_id=NULL,worker_id=?,fence=?,revision=revision+1,updated_at=? WHERE future_ref=?")
        .run(workerId, fence, this.now(), row.future_ref);
      this.db.prepare('UPDATE preapproval_run_links SET fence=? WHERE future_ref=?').run(fence, row.future_ref);
      this.enqueue(row.future_ref, execution.revision + 1, 'execution_resumed', { checkpoint_id: checkpointId, child_completed: 1 });
      return { binding: { future_execution_ref: row.future_ref, root_run_id: execution.root_run_id!, run_id: held.run_id, worker_id: workerId, fence }, checkpoint };
    });
  }

  async sealResumedNestedHold(binding: PreapprovalExecutionBinding): Promise<void> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    this.guarded(loaded, () => {
      const execution = this.current(loaded).execution;
      this.checkRun(execution, binding);
      const row = this.db.prepare(`SELECT checkpoint_id FROM preapproval_run_checkpoints WHERE future_ref=? AND run_id=?
        AND state='waiting' ORDER BY rowid DESC LIMIT 1`).get(execution.future_ref, binding.root_run_id) as { checkpoint_id: string } | undefined;
      const checkpoint = row && this.checkpoints.read(row.checkpoint_id);
      if (!checkpoint) fail('preapproval_stale', 'The parent continuation disappeared.');
      this.liveLoaded(loaded, 'run');
      this.sealHold(execution, checkpoint);
    });
  }

  async resumeNestedParent(binding: PreapprovalExecutionBinding) {
    const execution = this.execution(binding.future_execution_ref);
    this.checkRun(execution, binding, true);
    if (!execution.checkpoint_id) fail('preapproval_already_claimed', 'The parent continuation was already claimed.');
    return this.claimReadyNestedParent(execution.checkpoint_id, binding.worker_id);
  }

  async claimMember(binding: PreapprovalExecutionBinding, actual: PreparedInvocation,
    parentAttemptId: string | null = null): Promise<PreapprovalMemberClaim> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    return this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, binding);
      const grant = this.grant(execution.future_ref);
      if (!grant || grant.status !== 'active') fail('preapproval_cancelled', 'The approval is no longer active.');
      const path = preapprovalPathKey(actual.invocation_path);
      const recipeIndex = actual.invocation_path.map(segment => segment.kind === 'recipe').lastIndexOf(true);
      const recipePath = preapprovalPathKey(actual.invocation_path.slice(0, recipeIndex + 1));
      if (recipeIndex === 0) {
        if (binding.run_id !== binding.root_run_id) fail('preapproval_stale', 'A nested run cannot claim a root invocation.');
      } else {
        const link = this.db.prepare('SELECT entry_path FROM preapproval_run_links WHERE run_id = ? AND future_ref = ?')
          .get(binding.run_id, execution.future_ref) as { entry_path: string } | undefined;
        if (!link || link.entry_path !== recipePath) fail('preapproval_stale', 'This invocation belongs to a different nested run.');
      }
      const expected = loaded.plan.members.find(member => preapprovalPathKey(member.invocation_path) === path);
      if (!expected || expected.op_id !== actual.op_id || expected.effect_hash !== actual.effect_hash
        || actual.effect_hash !== preapprovalEffectHash(actual) || actual.arguments_hash !== preapprovalHash(actual.input)
        || expected.member_id !== actual.member_id || expected.parent_member_id !== actual.parent_member_id
        || preapprovalHash(expected.required_child_ids) !== preapprovalHash(actual.required_child_ids)
        || preapprovalHash(expected.predecessor_member_ids) !== preapprovalHash(actual.predecessor_member_ids)) {
        fail('preapproval_stale', 'The operation differs from the reviewed invocation.');
      }
      if (!isPreapprovalMemberEligible(actual)) fail('preapproval_authority_changed', 'This operation now requires a fresh decision.');
      this.liveLoaded(loaded, 'member', actual);
      const row = this.db.prepare('SELECT * FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
        .get(grant.grant_id, actual.member_id) as MemberRow | undefined;
      if (!row) fail('preapproval_stale', 'This invocation was not included in the owner decision.');
      if (row.state !== 'available') fail('preapproval_already_claimed', 'This invocation has already been claimed or sealed.');
      if (row.parent_member_id !== null) {
        const parent = this.db.prepare('SELECT * FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
          .get(grant.grant_id, row.parent_member_id) as MemberRow | undefined;
        if (!parent || parent.state !== 'dispatching' || parent.attempt_id !== parentAttemptId || parentAttemptId === null) {
          fail('preapproval_stale', 'The required read does not belong to this live parent attempt.');
        }
        if (parent.actual_run_id !== binding.run_id) {
          const link = this.db.prepare('SELECT parent_run_id FROM preapproval_run_links WHERE run_id = ? AND future_ref = ?')
            .get(binding.run_id, execution.future_ref) as { parent_run_id: string } | undefined;
          if (!link || link.parent_run_id !== parent.actual_run_id) fail('preapproval_stale', 'The parent attempt belongs to another run.');
        }
      } else if (parentAttemptId !== null) fail('preapproval_stale', 'An unrelated parent cannot supply this invocation.');
      for (const predecessor of expected.predecessor_member_ids) {
        const prior = this.db.prepare('SELECT state FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
          .get(grant.grant_id, predecessor) as { state: PreapprovalMemberStatus } | undefined;
        if (prior?.state !== 'succeeded') fail('preapproval_stale', 'A required child ran out of order.');
      }
      const initial: Omit<PreapprovalMemberClaim, 'action_ref' | 'commit_id'> = {
        ...binding, grant_id: grant.grant_id, member_id: row.member_id,
        attempt_id: `pat_${randomUUID()}`, idempotency_key: `d261_${randomUUID()}`, parent_attempt_id: parentAttemptId,
      };
      const receipt = this.hooks.createDispatch(initial, actual, loaded.plan);
      if (!receipt || typeof receipt.action_ref !== 'string' || !receipt.action_ref
        || (receipt.commit_id !== null && typeof receipt.commit_id !== 'string')) throw new Error('Dispatch receipt was not committed synchronously.');
      const changed = this.db.prepare(`UPDATE preapproval_members SET state = 'dispatching', attempt_id = ?,
        idempotency_key = ?, parent_attempt_id = ?, action_ref = ?, commit_id = ?, actual_run_id = ?,
        revision = revision + 1, updated_at = ? WHERE grant_id = ? AND member_id = ? AND state = 'available'`)
        .run(initial.attempt_id, initial.idempotency_key, parentAttemptId, receipt.action_ref, receipt.commit_id,
          binding.run_id, this.now(), grant.grant_id, row.member_id);
      if (changed.changes !== 1) fail('preapproval_already_claimed', 'Another dispatcher claimed this invocation.');
      this.enqueue(execution.future_ref, row.revision + 1, `member:${row.member_id}`, { action_ref: receipt.action_ref });
      return { ...initial, action_ref: receipt.action_ref, commit_id: receipt.commit_id };
    });
  }

  /** Revalidate a same-operation delegate/provider handoff without consuming a
   * second member. A parent can reach its effect only after required reads. */
  async validateClaim(claim: PreapprovalMemberClaim, requireChildren = false): Promise<void> {
    const loaded = await this.load(this.execution(claim.future_execution_ref).proposal_id);
    this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, claim);
      const row = this.db.prepare('SELECT * FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
        .get(claim.grant_id, claim.member_id) as MemberRow | undefined;
      if (!row || row.state !== 'dispatching' || row.attempt_id !== claim.attempt_id
        || row.actual_run_id !== claim.run_id || row.action_ref !== claim.action_ref) {
        fail('preapproval_already_claimed', 'The invocation claim is no longer owned by this attempt.');
      }
      const member = loaded.plan.members.find(item => item.member_id === claim.member_id)!;
      this.liveLoaded(loaded, 'member', member);
      if (requireChildren) for (const childId of member.required_child_ids) {
        const child = this.db.prepare('SELECT state, parent_attempt_id FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
          .get(claim.grant_id, childId) as { state: PreapprovalMemberStatus; parent_attempt_id: string | null } | undefined;
        if (child?.state !== 'succeeded' || child.parent_attempt_id !== claim.attempt_id) {
          fail('preapproval_stale', 'The operation cannot proceed before its required child calls succeed.');
        }
      }
    });
  }

  async settleMember(claim: PreapprovalMemberClaim,
    outcome: { status: 'succeeded' | 'failed' | 'in_doubt'; message: string; result: unknown }): Promise<void> {
    const ciphertext = await this.codec.seal(outcome);
    const loaded = await this.load(this.execution(claim.future_execution_ref).proposal_id);
    this.db.transaction(() => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, claim, true);
      const row = this.db.prepare('SELECT * FROM preapproval_members WHERE grant_id = ? AND member_id = ?')
        .get(claim.grant_id, claim.member_id) as MemberRow | undefined;
      if (!row || row.attempt_id !== claim.attempt_id || row.action_ref !== claim.action_ref
        || row.actual_run_id !== claim.run_id) fail('preapproval_already_claimed', 'The outcome does not belong to this attempt.');
      if (terminalMember(row.state)) return;
      if (row.state !== 'dispatching') fail('preapproval_already_claimed', 'The invocation was never dispatched.');
      assertSync(this.hooks.settleDispatch(claim, outcome));
      this.db.prepare(`UPDATE preapproval_members SET state = ?, result_ciphertext = ?, revision = revision + 1,
        updated_at = ? WHERE grant_id = ? AND member_id = ? AND state = 'dispatching'`)
        .run(outcome.status, ciphertext, this.now(), claim.grant_id, claim.member_id);
      if (outcome.status !== 'succeeded') this.stopRow(execution,
        outcome.status === 'in_doubt' ? 'preapproval_in_doubt' : 'member_failed', 'invalidated');
      this.enqueue(execution.future_ref, row.revision + 1, `member:${row.member_id}`, { action_ref: claim.action_ref });
    }).immediate();
  }

  /** Run ids are host-issued, but even a legacy resumer must not enter an
   * owned run without reacquiring its exact checkpoint/fence. */
  executionForRun(runId: string): string | null {
    const root = this.db.prepare('SELECT future_ref FROM preapproval_executions WHERE root_run_id = ?')
      .get(runId) as { future_ref: string } | undefined;
    const nested = root ?? this.db.prepare('SELECT future_ref FROM preapproval_run_links WHERE run_id = ?')
      .get(runId) as { future_ref: string } | undefined;
    return nested?.future_ref ?? null;
  }

  async validateRun(binding: PreapprovalExecutionBinding): Promise<void> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    this.guarded(loaded, () => {
      this.checkRun(this.current(loaded).execution, binding);
      this.liveLoaded(loaded, 'run');
    });
  }

  /** Restriction at the final ordinary egress seam, after its normal op gate
   * may have consumed C's last permitted use. Do not re-spend or reinterpret
   * that budget as a new approval. Dependency revocation writers stop this
   * same execution; full source validation still precedes the ordinary call. */
  assertRunActive(binding: PreapprovalExecutionBinding): void {
    const expired = this.db.transaction(() => {
      this.codec.assertUnlocked();
      const execution = this.execution(binding.future_execution_ref);
      this.checkRun(execution, binding);
      if (this.now() < execution.dispatch_deadline) return false;
      this.stopRow(execution, 'preapproval_expired', 'expired'); return true;
    }).immediate();
    if (expired) fail('preapproval_expired', 'The dispatch window expired.');
  }

  cancelCheckpoint(checkpoint: Checkpoint, reason: string): void {
    this.db.transaction(() => {
      if (checkpoint.preapproval_candidate_ref) {
        const poll = this.db.prepare('SELECT * FROM preapproval_polls WHERE poll_id=?').get(checkpoint.preapproval_candidate_ref) as PollRow | undefined;
        if (!poll || poll.state !== 'held' || poll.run_id !== checkpoint.run_id || poll.checkpoint_id !== checkpoint.checkpoint_id) return;
        if (poll.checkpoint_hash !== preapprovalCheckpointHash(checkpoint)) fail('preapproval_stale', 'The checkpoint does not own this watcher hold.');
        this.db.prepare(`UPDATE preapproval_polls SET state='finished',updated_at=? WHERE poll_id=?`).run(this.now(), poll.poll_id);
        return;
      }
      const futureRef = this.executionForRun(checkpoint.run_id);
      if (!futureRef) return;
      const execution = this.execution(futureRef);
      if (execution.state !== 'held' || execution.checkpoint_id !== checkpoint.checkpoint_id) return;
      const held = this.db.prepare('SELECT checkpoint_hash FROM preapproval_run_checkpoints WHERE checkpoint_id=? AND state=\'held\'')
        .get(checkpoint.checkpoint_id) as { checkpoint_hash: string } | undefined;
      if (!held || held.checkpoint_hash !== preapprovalCheckpointHash(checkpoint)) fail('preapproval_stale', 'The checkpoint does not own this hold.');
      this.stopRow(execution, reason, 'cancelled');
    }).immediate();
  }

  private memberWatermark(futureRef: string): string {
    return preapprovalHash(this.db.prepare(`SELECT member_id,state,attempt_id,parent_attempt_id,
      actual_run_id,revision,result_ciphertext FROM preapproval_members WHERE future_ref = ? ORDER BY member_id`)
      .all(futureRef));
  }

  /** The engine has drained before this call. Persist its real checkpoint and
   * surrender the running fence in one transaction, before an ask can appear. */
  async holdRun(binding: PreapprovalExecutionBinding, checkpoint: Checkpoint): Promise<void> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, binding, true);
      const snapshot = this.snapshotForRun(loaded, binding);
      if (checkpoint.raw_op || checkpoint.preapproval_execution_ref !== execution.future_ref
        || checkpoint.run_id !== binding.run_id || !snapshot
        || checkpoint.recipe_id !== snapshot.recipe_id || !checkpoint.gated_step_id) {
        fail('preapproval_stale', 'This checkpoint does not describe the bound recipe hold.');
      }
      const hash = preapprovalCheckpointHash(checkpoint);
      const prior = this.db.prepare('SELECT * FROM preapproval_run_checkpoints WHERE checkpoint_id = ?')
        .get(checkpoint.checkpoint_id) as { future_ref: string; fence: number; checkpoint_hash: string; state: string } | undefined;
      if (execution.state === 'held' && execution.checkpoint_id === checkpoint.checkpoint_id && prior
        && prior.future_ref === execution.future_ref && prior.fence === binding.fence
        && prior.checkpoint_hash === hash && prior.state === 'held') return;
      this.checkRun(execution, binding);
      this.liveLoaded(loaded, 'run');
      this.checkpoints.write(checkpoint);
      this.db.prepare(`INSERT INTO preapproval_run_checkpoints(checkpoint_id,future_ref,run_id,fence,
        checkpoint_hash,members_hash,state,created_at) VALUES(?,?,?,?,?,?,'staged',?)`)
        .run(checkpoint.checkpoint_id, execution.future_ref, binding.run_id, binding.fence,
          hash, this.memberWatermark(execution.future_ref), this.now());
      if (binding.run_id !== binding.root_run_id) {
        this.db.prepare("UPDATE preapproval_nested_calls SET state='held',checkpoint_id=? WHERE run_id=?")
          .run(checkpoint.checkpoint_id, binding.run_id);
      } else this.sealHold(execution, checkpoint);
    });
  }

  /** Called only after the normal answer path verifies its durable decision.
   * A held worker explicitly surrendered execution; no liveness timeout or
   * process death is needed to transfer that fence. A second claimant loses. */
  async resumeRun(checkpoint: Checkpoint, workerId: string): Promise<PreapprovalExecutionBinding | null> {
    const futureRef = this.executionForRun(checkpoint.run_id);
    if (!futureRef) {
      if (checkpoint.preapproval_execution_ref) fail('preapproval_stale', 'The reviewed execution no longer exists.');
      return null;
    }
    const loaded = await this.load(this.execution(futureRef).proposal_id);
    return this.guarded(loaded, () => {
      const { execution } = this.current(loaded);
      this.workers.assertCurrent(workerId);
      const held = this.db.prepare('SELECT * FROM preapproval_run_checkpoints WHERE checkpoint_id = ?')
        .get(checkpoint.checkpoint_id) as { future_ref: string; run_id: string; fence: number;
          checkpoint_hash: string; members_hash: string; state: string } | undefined;
      if (checkpoint.preapproval_execution_ref !== futureRef || execution.state !== 'held'
        || execution.checkpoint_id !== checkpoint.checkpoint_id
        || !held || held.state !== 'held' || held.future_ref !== futureRef || held.run_id !== checkpoint.run_id
        || checkpoint.preapproval_nested_wait || held.fence !== execution.fence) {
        fail('preapproval_already_claimed', 'This checkpoint no longer owns the reviewed execution.');
      }
      const stored = this.checkpoints.read(checkpoint.checkpoint_id);
      if (!stored || preapprovalHash(stored) !== preapprovalHash(checkpoint)
        || preapprovalCheckpointHash(stored) !== held.checkpoint_hash
        || this.memberWatermark(futureRef) !== held.members_hash) {
        fail('preapproval_stale', 'The held state or completed effects changed.');
      }
      if (execution.stop_requested || this.grant(futureRef)?.status !== 'active') {
        fail('preapproval_cancelled', 'This reviewed execution was stopped.');
      }
      if (this.now() >= execution.dispatch_deadline) fail('preapproval_expired', 'The dispatch window has expired.');
      this.liveLoaded(loaded, 'run');
      const fence = execution.fence + 1;
      this.db.prepare("UPDATE preapproval_run_checkpoints SET state='claimed' WHERE checkpoint_id=? AND state='held'")
        .run(checkpoint.checkpoint_id);
      this.db.prepare(`UPDATE preapproval_executions SET state='running', checkpoint_id=NULL, worker_id=?,
        fence=?, revision=revision+1, updated_at=? WHERE future_ref=?`)
        .run(workerId, fence, this.now(), futureRef);
      this.db.prepare('UPDATE preapproval_run_links SET fence=? WHERE future_ref=?').run(fence, futureRef);
      this.db.prepare("UPDATE preapproval_nested_calls SET state='running' WHERE run_id=? AND state='held'").run(held.run_id);
      this.enqueue(futureRef, execution.revision + 1, 'execution_resumed', { checkpoint_id: checkpoint.checkpoint_id });
      return { future_execution_ref: futureRef, root_run_id: execution.root_run_id!, run_id: held.run_id, worker_id: workerId, fence };
    });
  }

  async finishRun(binding: PreapprovalExecutionBinding, reported: 'succeeded' | 'failed' | 'in_doubt'): Promise<PreapprovalExecutionStatus> {
    const loaded = await this.load(this.execution(binding.future_execution_ref).proposal_id);
    return this.db.transaction(() => {
      const { execution } = this.current(loaded);
      this.checkRun(execution, binding, true);
      return this.finishRunRow(execution, reported);
    }).immediate();
  }

  private finishRunRow(execution: ExecutionRow, reported: 'succeeded' | 'failed' | 'in_doubt'): PreapprovalExecutionStatus {
      if (!this.db.inTransaction) throw new Error('Run completion requires the realm transaction.');
      if (execution.state !== 'running' && execution.state !== 'held') return execution.state;
      const members = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref = ?')
        .all(execution.future_ref) as MemberRow[];
      const uncertain = reported === 'in_doubt' || members.some(member => member.state === 'in_doubt' || member.state === 'dispatching');
      const succeeded = members.some(member => member.state === 'succeeded');
      const failed = reported === 'failed' || execution.stop_requested !== 0 || members.some(member => member.state === 'failed');
      const state: PreapprovalExecutionStatus = uncertain ? 'in_doubt' : failed ? (succeeded ? 'partial' : 'failed') : 'succeeded';
      const now = this.now();
      this.db.prepare(`UPDATE preapproval_members SET state = 'skipped', revision = revision + 1,
        updated_at = ? WHERE future_ref = ? AND state = 'available'`).run(now, execution.future_ref);
      this.db.prepare(`UPDATE preapproval_executions SET state = ?, revision = revision + 1,
        updated_at = ? WHERE future_ref = ?`).run(state, now, execution.future_ref);
      this.db.prepare(`UPDATE preapproval_grants SET status = 'exhausted', revision = revision + 1
        WHERE future_ref = ? AND status = 'active'`).run(execution.future_ref);
      this.enqueue(execution.future_ref, execution.revision + 1, 'execution_finished', { state });
      return state;
  }

  /** Boot bookkeeping only. This never dispatches, changes an uncertain
   * receipt to success, or makes a consumed member available. A held run with
   * a checkpoint must use the separate exact-checkpoint resume protocol. */
  async recoverInterruptedExecution(futureRef: string, recoveryWorkerId: string): Promise<PreapprovalRecoveryResult> {
    const loaded = await this.load(this.execution(futureRef).proposal_id);
    const outcome = { status: 'in_doubt' as const,
      message: 'The execution process ended before recording the outcome.', result: null };
    const ciphertext = await this.codec.seal(outcome);
    return this.db.transaction(() => {
      this.workers.assertCurrent(recoveryWorkerId);
      const { execution } = this.current(loaded);
      const result = (status: PreapprovalRecoveryResult['status']): PreapprovalRecoveryResult => ({
        future_execution_ref: futureRef, status, execution_status: this.execution(futureRef).state,
      });
      if (!['running', 'held'].includes(execution.state) || !execution.root_run_id || !execution.worker_id) return result('unchanged');
      const workerStatus = this.workers.status(execution.worker_id);
      if (workerStatus !== 'gone') return result(workerStatus === 'live' ? 'worker_live' : 'worker_unknown');
      const members = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref = ?').all(futureRef) as MemberRow[];
      const dispatching = members.filter(member => member.state === 'dispatching');
      // A checkpoint is necessary, never by itself sufficient. Its consumed
      // member watermark, content and all original authority are revalidated
      // on resume. Do not steal a run here just because a pointer exists.
      if (!this.hasUnresolvedEffects(futureRef) && !execution.stop_requested && execution.state === 'held' && execution.checkpoint_id
        && !members.some(member => member.state === 'in_doubt')) return result('checkpoint_required');
      const now = this.now();
      for (const row of dispatching) {
        if (!row.attempt_id || !row.idempotency_key || !row.action_ref || !row.actual_run_id) {
          throw new Error('Interrupted pre-approval member is missing its durable attempt identity.');
        }
        const claim: PreapprovalMemberClaim = {
          future_execution_ref: futureRef, root_run_id: execution.root_run_id, run_id: row.actual_run_id,
          worker_id: execution.worker_id, fence: execution.fence, grant_id: row.grant_id,
          member_id: row.member_id, attempt_id: row.attempt_id, idempotency_key: row.idempotency_key,
          action_ref: row.action_ref, commit_id: row.commit_id, parent_attempt_id: row.parent_attempt_id,
        };
        assertSync(this.hooks.settleDispatch(claim, outcome));
        this.db.prepare(`UPDATE preapproval_members SET state = 'in_doubt', result_ciphertext = ?,
          revision = revision + 1, updated_at = ? WHERE grant_id = ? AND member_id = ? AND state = 'dispatching'`)
          .run(ciphertext, now, row.grant_id, row.member_id);
        this.enqueue(futureRef, row.revision + 1, `member:${row.member_id}`, { action_ref: row.action_ref });
      }
      this.stopRow(execution, dispatching.length ? 'preapproval_in_doubt' : 'preapproval_checkpoint_missing', 'invalidated');
      const uncertain = dispatching.length > 0 || members.some(member => member.state === 'in_doubt');
      const state: PreapprovalExecutionStatus = uncertain ? 'in_doubt'
        : members.some(member => member.state === 'succeeded') ? 'partial' : 'invalidated';
      this.db.prepare(`UPDATE preapproval_executions SET state = ?, worker_id = ?, fence = fence + 1,
        revision = revision + 1, updated_at = ? WHERE future_ref = ?`)
        .run(state, recoveryWorkerId, now, futureRef);
      this.enqueue(futureRef, execution.revision + 2, 'execution_recovered', { state });
      return result('stopped');
    }).immediate();
  }

  async recoverInterruptedRuns(recoveryWorkerId: string, limit = 100, afterFutureRef = ''): Promise<PreapprovalRecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail('bad_request', 'Invalid recovery batch size.', 400);
    this.workers.assertCurrent(recoveryWorkerId);
    const rows = this.db.prepare(`SELECT future_ref FROM preapproval_executions
      WHERE state IN ('running', 'held') AND future_ref > ? ORDER BY future_ref LIMIT ?`)
      .all(afterFutureRef, limit) as { future_ref: string }[];
    const results: PreapprovalRecoveryResult[] = [];
    for (const row of rows) results.push(await this.recoverInterruptedExecution(row.future_ref, recoveryWorkerId));
    return results;
  }

  /** Host-only evidence from a verified provider outcome adapter. The adapter
   * must obtain the observation under the original live read authority. This
   * append-only record is not a dispatch/resume permit and cannot grant one. */
  async recordReconciliation(input: Omit<PreapprovalReconciliation, 'evidence_id'>): Promise<PreapprovalReconciliation> {
    if (!input.adapter || input.adapter.length > 200 || !/^sha256:[a-f0-9]{64}$/.test(input.evidence_digest)
      || !['succeeded', 'failed'].includes(input.outcome) || !Number.isSafeInteger(input.observed_at)
      || input.observed_at < 0 || input.observed_at > this.now()) fail('bad_request', 'Invalid provider reconciliation evidence.', 400);
    const loaded = await this.load(this.execution(input.future_execution_ref).proposal_id);
    return this.db.transaction(() => {
      const { execution } = this.current(loaded);
      const member = loaded.plan.members.find(item => item.member_id === input.member_id);
      const row = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref = ? AND member_id = ?')
        .get(execution.future_ref, input.member_id) as MemberRow | undefined;
      if (!member || row?.state !== 'in_doubt' || row.attempt_id !== input.attempt_id || row.action_ref !== input.action_ref) {
        fail('preapproval_in_doubt', 'The evidence does not identify the original uncertain attempt.');
      }
      this.liveLoaded(loaded, 'reconcile', member);
      const prior = this.db.prepare(`SELECT evidence_id, future_ref AS future_execution_ref, member_id,
        attempt_id, action_ref, adapter, evidence_digest, outcome, observed_at
        FROM preapproval_reconciliations WHERE attempt_id = ?`).all(input.attempt_id) as PreapprovalReconciliation[];
      if (prior.some(item => item.outcome !== input.outcome)) fail('preapproval_in_doubt', 'Conflicting provider evidence requires owner review.');
      const replay = prior.find(item => item.evidence_digest === input.evidence_digest);
      if (replay) {
        if (replay.adapter !== input.adapter || replay.observed_at !== input.observed_at) {
          fail('preapproval_stale', 'This evidence digest is already bound to a different observation.');
        }
        return replay;
      }
      const evidence: PreapprovalReconciliation = { ...input, evidence_id: `pae_${randomUUID()}` };
      this.db.prepare(`INSERT INTO preapproval_reconciliations(evidence_id, future_ref, member_id, attempt_id,
        action_ref, evidence_digest, outcome, observed_at, adapter) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(evidence.evidence_id, input.future_execution_ref, input.member_id, input.attempt_id,
          input.action_ref, input.evidence_digest, input.outcome, input.observed_at, input.adapter);
      this.enqueue(execution.future_ref, row.revision, `reconciliation:${evidence.evidence_id}`, { action_ref: row.action_ref });
      return evidence;
    }).immediate();
  }

  /** Synchronous lifecycle entry points can participate in the target writer's
   * transaction. The legacy target is already parked; later cleanup uses outbox. */
  cancelExecution(futureRef: string, reason = 'preapproval_cancelled'): void {
    this.db.transaction(() => this.stopRow(this.execution(futureRef), reason, 'cancelled')).immediate();
  }
  invalidateDependency(kind: string, key: string, incarnation?: string): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT DISTINCT e.* FROM preapproval_executions e
        LEFT JOIN preapproval_dependencies d ON d.future_ref = e.future_ref
        WHERE ((e.target_kind = ? AND e.target_key = ? AND (? IS NULL OR e.target_incarnation = ?))
          OR (d.kind = ? AND d.key = ? AND (? IS NULL OR d.incarnation = ?)
            AND (d.until_phase = 'terminal' OR e.state = 'prepared')))
          AND e.state IN ('prepared','active','running','held','in_doubt')`)
        .all(kind, key, incarnation ?? null, incarnation ?? null, kind, key, incarnation ?? null, incarnation ?? null) as ExecutionRow[];
      for (const execution of rows) this.stopRow(execution, 'preapproval_stale', 'invalidated');
      return rows.length;
    }).immediate();
  }

  async inspect(proposalId: string, includeReview = true): Promise<PreapprovalInspection> {
    const retired = await this.retiredInspection(proposalId);
    if (retired) return retired;
    const loaded = await this.load(proposalId);
    const proposal = this.proposal(proposalId);
    const execution = this.execution(proposal.future_ref);
    const grant = this.grant(proposal.future_ref);
    const decision = this.db.prepare('SELECT * FROM preapproval_decisions WHERE proposal_id = ?')
      .get(proposalId) as DecisionRow | undefined;
    const rows = this.db.prepare('SELECT * FROM preapproval_members WHERE future_ref = ?').all(proposal.future_ref) as MemberRow[];
    const members: PreapprovalMemberOutcome[] = [];
    for (const member of loaded.plan.members) {
      if (!selectedIds(proposal).includes(member.member_id)) continue;
      const row = rows.find(value => value.member_id === member.member_id);
      let message: string | null = null;
      if (row?.result_ciphertext) {
        const result = await this.codec.open(row.result_ciphertext) as { message?: unknown };
        if (typeof result.message === 'string') message = result.message;
      }
      const evidence = row?.attempt_id ? this.db.prepare(`SELECT outcome FROM preapproval_reconciliations
        WHERE attempt_id = ? ORDER BY observed_at DESC, evidence_id DESC LIMIT 1`).get(row.attempt_id) as { outcome: 'succeeded' | 'failed' } | undefined : undefined;
      members.push({ member_id: member.member_id, parent_member_id: member.parent_member_id,
        op_id: member.op_id, label: member.review.label, status: row?.state ?? 'available',
        action_ref: row?.action_ref ?? null, commit_id: row?.commit_id ?? null, run_id: row?.actual_run_id ?? null,
        status_message: message, reconciled_outcome: evidence?.outcome ?? null });
    }
    return { ...this.result(proposal, loaded.plan), execution_status: execution.state,
      ...(includeReview ? { reviewed: this.reviewDetails(proposal, execution, loaded.plan) } : {}),
      status_reason: execution.status_reason, grant: grant ? { grant_id: grant.grant_id, revision: grant.revision, status: grant.status } : null,
      decision: decision ? this.decisionReceipt(decision) : null, members,
      created_at: proposal.created_at, updated_at: Math.max(proposal.updated_at, execution.updated_at) };
  }

  async list(cursor: string, limit: number): Promise<{ proposals: PreapprovalInspection[]; next_cursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PREAPPROVAL_LIMITS.list_max) fail('bad_request', 'Invalid page size.', 400);
    const rows = this.db.prepare('SELECT proposal_id FROM preapproval_proposals WHERE proposal_id > ? ORDER BY proposal_id LIMIT ?')
      .all(cursor, limit + 1) as Array<{ proposal_id: string }>;
    const page = rows.slice(0, limit);
    const proposals = await Promise.all(page.map(row => this.inspect(row.proposal_id, false)));
    return { proposals, next_cursor: rows.length > limit ? page[page.length - 1]!.proposal_id : null };
  }

  async revoke(input: { grant_id: string; expected_revision: number; request_id: string },
    responder: PreapprovalResponder): Promise<PreapprovalInspection> {
    const futureRef = this.db.transaction(() => {
      this.responder(responder);
      const inputDigest = preapprovalHash(input);
      const prior = this.db.prepare('SELECT * FROM preapproval_mutations WHERE request_id = ? AND responder_key = ?')
        .get(input.request_id, responder.key) as { input_digest: string; future_ref: string } | undefined;
      if (prior) {
        if (prior.input_digest !== inputDigest) fail('preapproval_idempotency_conflict', 'This revocation request key was already used.');
        return prior.future_ref;
      }
      const grant = this.db.prepare('SELECT * FROM preapproval_grants WHERE grant_id = ?').get(input.grant_id) as GrantRow | undefined;
      if (!grant) fail('not_found', 'This approval no longer exists.', 404);
      if (grant.revision !== input.expected_revision) fail('preapproval_stale', 'The approval changed. Refresh its current state.');
      this.stopRow(this.execution(grant.future_ref), 'preapproval_cancelled', 'cancelled');
      this.db.prepare('INSERT INTO preapproval_mutations(request_id, responder_key, input_digest, future_ref) VALUES(?, ?, ?, ?)')
        .run(input.request_id, responder.key, inputDigest, grant.future_ref);
      return grant.future_ref;
    }).immediate();
    return this.inspect(this.execution(futureRef).proposal_id);
  }

  expire(): number {
    return this.db.transaction(() => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT e.* FROM preapproval_executions e JOIN preapproval_proposals p
        ON p.proposal_id = e.proposal_id WHERE e.state IN ('prepared','active','running','held')
        AND e.stop_requested = 0 AND (e.dispatch_deadline <= ? OR (e.state = 'prepared' AND p.decision_deadline <= ?))`)
        .all(now, now) as ExecutionRow[];
      for (const execution of rows) this.stopRow(execution, 'preapproval_expired', 'expired');
      this.db.prepare('DELETE FROM preapproval_challenges WHERE expires_at <= ? AND consumed_decision_id IS NULL').run(now);
      return rows.length;
    }).immediate();
  }

  /** Retain compact terminal outcomes and request/decision tombstones, while
   * dropping expired private execution material. Uncertain effects keep their
   * evidence for reconciliation. No row capable of running is eligible. */
  async retireReviewContent(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('bad_request', 'Invalid retention batch size.', 400);
    const cutoff = this.now() - GATED_ACTION_TERMINAL_RETENTION_MS;
    const eligible = `e.state IN ('succeeded','partial','failed','cancelled','expired','invalidated')
      AND e.snapshot_ciphertext<>'' AND e.updated_at<=?
      AND NOT EXISTS(SELECT 1 FROM preapproval_members m WHERE m.future_ref=e.future_ref AND m.state IN ('dispatching','in_doubt'))
      AND NOT EXISTS(SELECT 1 FROM preapproval_outbox o WHERE o.future_ref=e.future_ref AND o.state<>'done')`;
    const candidates = this.db.prepare(`SELECT e.* FROM preapproval_executions e WHERE ${eligible} ORDER BY e.updated_at LIMIT ?`)
      .all(cutoff, limit) as ExecutionRow[];
    let count = 0;
    for (const candidate of candidates) {
      const inspection = await this.inspect(candidate.proposal_id);
      const { reviewed, ...outcome } = inspection;
      const summary = { schema_version: 1, inspection: { ...outcome,
        members: outcome.members.map(member => ({ ...member, status_message: null })),
        retired_review: { at: this.now(), recipe_name: reviewed?.recipe.display_name ?? 'Reviewed execution' } } };
      const ciphertext = await this.codec.seal(summary);
      count += this.db.transaction(() => {
        this.codec.assertUnlocked();
        const current = this.db.prepare(`SELECT e.* FROM preapproval_executions e WHERE e.future_ref=? AND ${eligible}`)
          .get(candidate.future_ref, cutoff) as ExecutionRow | undefined;
        if (!current || preapprovalHash(current) !== preapprovalHash(candidate)) return 0;
        this.db.prepare(`INSERT INTO preapproval_retired_reviews(future_ref,summary_ciphertext,summary_hash,retired_at) VALUES(?,?,?,?)`)
          .run(current.future_ref, ciphertext, preapprovalHash(summary), summary.inspection.retired_review.at);
        this.db.prepare("UPDATE preapproval_executions SET snapshot_ciphertext='' WHERE future_ref=?").run(current.future_ref);
        this.db.prepare('UPDATE preapproval_members SET result_ciphertext=NULL WHERE future_ref=?').run(current.future_ref);
        this.db.prepare('UPDATE preapproval_nested_calls SET result_ciphertext=NULL WHERE future_ref=?').run(current.future_ref);
        this.db.prepare(`DELETE FROM checkpoints WHERE json_valid(data) AND EXISTS (
          SELECT 1 FROM (
            SELECT checkpoint_id,run_id FROM preapproval_run_checkpoints WHERE future_ref=?
            UNION SELECT checkpoint_id,run_id FROM preapproval_polls WHERE future_ref=? AND checkpoint_id IS NOT NULL
          ) owned WHERE owned.checkpoint_id=checkpoints.key AND owned.run_id=json_extract(checkpoints.data,'$.run_id'))`)
          .run(current.future_ref, current.future_ref);
        for (const table of ['preapproval_ordinary_recipes', 'preapproval_dependencies', 'preapproval_trigger_candidates']) {
          // Names are fixed host literals, never input or persisted content.
          this.db.prepare(`DELETE FROM ${table} WHERE future_ref=?`).run(current.future_ref);
        }
        return 1;
      }).immediate();
    }
    return count;
  }

  /** Archive restore must call this before any scheduler starts. Rotating the
   * lineage never restores a parked legacy automation or a consumed member. */
  invalidateRestoredLineage(): void {
    invalidatePreapprovalLineage(this.db, this.hooks.settleDispatch, this.now());
  }

  takeOutbox(workerId: string, limit = 25): PreapprovalOutboxItem[] {
    if (!workerId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('bad_request', 'Invalid outbox claim.', 400);
    return this.db.transaction(() => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT * FROM preapproval_outbox WHERE state = 'pending'
        OR (state = 'leased' AND lease_until <= ?) ORDER BY event_id LIMIT ?`).all(now, limit) as PreapprovalOutboxItem[];
      for (const row of rows) this.db.prepare(`UPDATE preapproval_outbox SET state = 'leased', worker_id = ?, lease_until = ?
        WHERE event_id = ?`).run(workerId, now + 60_000, row.event_id);
      return rows.map((row): PreapprovalOutboxItem => ({ ...row, state: 'leased', worker_id: workerId, lease_until: now + 60_000 }));
    }).immediate();
  }
  finishOutbox(eventId: string, workerId: string): boolean {
    return this.db.prepare(`UPDATE preapproval_outbox SET state = 'done', lease_until = 0
      WHERE event_id = ? AND state = 'leased' AND worker_id = ?`).run(eventId, workerId).changes === 1;
  }
}
