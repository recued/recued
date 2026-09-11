import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type PreapprovalDecisionRequest, type PreapprovalInvocationPath, type RecipeDefinition } from '@recued/contracts';
import type { PreparedFutureExecution, PreparedInvocation, PreapprovalResponder } from '../preapproval-model.js';
import { preapprovalEffectHash, preapprovalHash } from '../preapproval-invocations.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { PreapprovalRepository, type PreapprovalAtomicHooks } from '../storage/preapproval-repository.js';
import type { PreapprovalWorkerAuthority } from '../storage/preapproval-workers.js';

export const ownerResponder: PreapprovalResponder = { channel: 'webclient', key: 'owner-web-token' };
export const fixtureRecipe: RecipeDefinition = {
  recipe_id: 'reviewed-mail', version: 1, ttl: 300,
  metadata: { name: 'Reviewed mail', description: '', author: 'core', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] },
};
export const memberPath = (step: string, iteration = 0): PreapprovalInvocationPath => [
  { kind: 'recipe', recipe_id: 'reviewed-mail', publisher_id: 'core', definition_hash: preapprovalHash(fixtureRecipe) },
  { kind: 'step', phase: 'sequential', step_id: step },
  { kind: 'iteration', index: iteration },
];
export const preparedMember = (overrides: Partial<PreparedInvocation> = {}): PreparedInvocation => {
  const base: Omit<PreparedInvocation, 'effect_hash' | 'review'> = {
    member_id: `pam_${randomUUID()}`, invocation_path: memberPath('send'),
    op_id: 'core.mail.send', ingredient_slug: 'mail-send', family: 'kernel', identity_version: 1,
    definition_hash: preapprovalHash('definition'), binding_hash: preapprovalHash('binding'),
    arguments_hash: preapprovalHash({ to: ['alex@example.com'], body: 'private reviewed content' }),
    condition_hash: preapprovalHash(true), parent_member_id: null, required_child_ids: [], predecessor_member_ids: [],
    resources: [], connection_id: 'mail-account', account_id: 'account-1',
    input: { to: ['alex@example.com'], body: 'private reviewed content' },
    output: {},
    risk: 'write', pre_lift_approval: 'ask',
    ...overrides,
  };
  base.arguments_hash = preapprovalHash(base.input);
  return { ...base, effect_hash: preapprovalEffectHash(base), review: {
    member_id: base.member_id, parent_member_id: base.parent_member_id,
    required_child_ids: base.required_child_ids, invocation_path: base.invocation_path,
    op_id: base.op_id, family: base.family, risk: base.risk, label: 'Reviewed operation', detail: 'The saved version',
    arguments: base.input, conditional: false, eligible: true, reason: null,
    output: base.output, connection_id: base.connection_id, account_id: base.account_id, resources: base.resources,
    ...overrides.review,
  } };
};
export const preparedPlan = (members = [preparedMember()]): PreparedFutureExecution => ({
  schema_version: 1,
  request: { idempotency_key: randomUUID(), subject: { kind: 'recipe', recipe_id: 'reviewed-mail', publisher_id: 'core', config: {} },
    activation: { kind: 'one_shot', run_at: 10_000, time_zone: 'America/Los_Angeles' },
    decision_deadline: 9_000, dispatch_deadline: 15_000 },
  origin: { mode: 'contract', contract_id: 'contract-c', entry: 'kernel', credential_id: 'mcp-token-c',
    entry_tool_grants: ['execute'], recipe_grant_key: null, display_name: 'Contract C', credential_label: 'Office',
    source: { channel: 'mcp', actor: 'contracted_user', contract_id: 'contract-c', mcp_token_id: 'mcp-token-c', agent_id: 'agent-c', tool_call_id: 'draft-turn' } },
  target: { kind: 'one_shot', key: 'schedule-1', incarnation: 'incarnation-1', revision: 1,
    qualifying_sequence: 0, due_at: 10_000, was_enabled: false },
  recipe: { recipe_id: 'reviewed-mail', publisher_id: 'core', display_name: 'Reviewed mail', definition_hash: preapprovalHash(fixtureRecipe) },
  recipe_snapshots: [{ invocation_path: memberPath('send').slice(0, 1), recipe_id: fixtureRecipe.recipe_id,
    publisher_id: 'core', definition_hash: preapprovalHash(fixtureRecipe),
    dispatch_hash: preapprovalHash(fixtureRecipe), definition: fixtureRecipe, effective_config: {} }],
  members, uncovered: [], dependencies: [], interaction_notes: [],
});
export const compoundPlan = (): PreparedFutureExecution => {
  const parentId = `pam_${randomUUID()}`;
  const childId = `pam_${randomUUID()}`;
  const parent = preparedMember({ member_id: parentId, required_child_ids: [childId] });
  const child = preparedMember({ member_id: childId, parent_member_id: parentId,
    invocation_path: [...parent.invocation_path, { kind: 'dependency', slot: 'attachment', index: 0 }],
    op_id: 'core.storage.data-file-read', ingredient_slug: 'data-file-read',
    input: { record_id: 'frozen-file-1', blob_hash: preapprovalHash('bytes') }, risk: 'read' });
  return preparedPlan([parent, child]);
};

/** Repository tests deliberately model synchronous participants with real SQL
 * tables. They prove atomicity, not production gateway/provider composition. */
export const repositoryFixture = (db: Database.Database, state = { now: 1_000, locked: false },
  overrides: Partial<PreapprovalAtomicHooks> = {}, workers: PreapprovalWorkerAuthority = {
    assertCurrent(id) { if (!id) throw new Error('Missing fixture worker'); }, status: () => 'live',
  }) => {
  db.exec(`CREATE TABLE IF NOT EXISTS d261_test_authority(id INTEGER PRIMARY KEY, allowed INTEGER NOT NULL, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO d261_test_authority VALUES(1, 1, 1);
    CREATE TABLE IF NOT EXISTS d261_test_activation(future_ref TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS d261_test_receipt(action_ref TEXT PRIMARY KEY, attempt_id TEXT UNIQUE, status TEXT NOT NULL);`);
  const codec = createPreapprovalCodec(() => state.locked ? null : new Uint8Array(32).fill(7));
  const hooks: PreapprovalAtomicHooks = {
    validateLive(plan) {
      const authority = db.prepare('SELECT * FROM d261_test_authority WHERE id = 1').get() as { allowed: number; revision: number } | undefined;
      if (!authority?.allowed) throw new RpcError('preapproval_authority_changed', 'The original contract was revoked.', 403);
      if (authority.revision !== plan.target.revision) throw new RpcError('preapproval_stale', 'Target changed.', 409);
    },
    validateResponder(responder) {
      if (responder.key !== ownerResponder.key || responder.channel !== ownerResponder.channel) {
        throw new RpcError('preapproval_invalid_proof', 'Not the enrolled owner.', 403);
      }
    },
    activate(_plan, activation) { db.prepare('INSERT INTO d261_test_activation VALUES(?)').run(activation.future_execution_ref); },
    selectOccurrence(_plan, candidate) { return candidate.occurrence_sequence; },
    stop() {},
    createDispatch(claim) {
      const action_ref = `action-${claim.attempt_id}`;
      db.prepare("INSERT INTO d261_test_receipt VALUES(?, ?, 'dispatching')").run(action_ref, claim.attempt_id);
      return { action_ref, commit_id: null };
    },
    settleDispatch(claim, outcome) {
      db.prepare("UPDATE d261_test_receipt SET status = ? WHERE action_ref = ? AND attempt_id = ? AND status = 'dispatching'")
        .run(outcome.status, claim.action_ref, claim.attempt_id);
    },
    ...overrides,
  };
  const repository = new PreapprovalRepository(db, { codec, hooks, workers, now: () => state.now });
  return { repository, codec, state, hooks };
};
export const decisionInput = async (repository: PreapprovalRepository, proposalId: string): Promise<PreapprovalDecisionRequest> => {
  const review = await repository.review(proposalId, ownerResponder);
  return { proposal_id: proposalId, expected_revision: review.revision, review_digest: review.review_digest,
    challenge: review.challenge, decision: 'approve', request_id: randomUUID() };
};
