import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJSONStringify } from '@recued/crypto';
import { describeMissingUnattended, missingUnattendedSettings, parseRecipe } from '@recued/recipes';
import { RpcError, COMMITMENT_FULFILL_FROM_STATES, COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES,
  type ApprovalLinkConfig, type ApprovalWorkflowContinueInput, type ApprovalWorkflowContinueResult,
  type ApprovalWorkflowTargetsResult, type ApprovalWorkflowTargetKind,
  type RecipeDefinition, type Task, type Commitment } from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { StoredRecipe } from './types.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import type { ApprovalIntentStore } from './storage/reception-approval-store.js';
import type { ReceptionApprovalEffect } from './ports/reception/processors/approval-link-processor.js';
import { parseApprovalLinkConfig } from './ports/reception/transformations/approval-link.js';

const digest = (value: unknown): string => createHash('sha256').update(canonicalJSONStringify(value)).digest('hex');
// Each status is written at its throw: D-313's ratchet reads a literal status only,
// and a step would otherwise see this refusal as a network error.
const fail = (message: string): never => { throw new RpcError('approval_workflow_invalid', message, 409); };
// Core review recipes need Reception's private trigger payload. An owner's
// recipe can use the same word in its name without becoming one of those.
const isReceptionReviewRecipe = (row: Pick<StoredRecipe, 'publisher_id' | 'pack_slug' | 'recipe_id'>): boolean =>
  row.publisher_id === 'recued-core'
  && (row.pack_slug?.startsWith('reception-') === true || /(^|\/)reception-/.test(row.recipe_id));
export interface ApprovalWorkflowRecipeSnapshot {
  recipe: RecipeDefinition;
  config: Record<string, unknown>;
  connections: Record<string, string>;
}
export interface ApprovalWorkflowPlan {
  target_kind: ApprovalWorkflowTargetKind;
  target_id: string;
  snapshot: Task | Commitment | ApprovalWorkflowRecipeSnapshot;
  config_hash: string;
  summary: string;
  plan_hash: string;
}
interface ResponseRow {
  intent_id: string;
  endpoint_id: string;
  outcome_hash: string;
  state: 'received' | 'starting' | 'continued' | 'failed';
  result_json: string | null;
}
export interface ApprovalWorkflowServiceDeps {
  db: Database.Database;
  work: WorkEntityStore;
  recipes: Pick<RecipeStore, 'get' | 'listStored'>;
  endpoints: Pick<PublicEndpointRegistryStore, 'findById'>;
  intents: Pick<ApprovalIntentStore, 'findById'>;
  recipeSnapshot: (id: string) => ApprovalWorkflowRecipeSnapshot;
  runRecipe?: (snapshot: ApprovalWorkflowRecipeSnapshot, runId: string) => Promise<void>;
  resolved?: (kind: 'task' | 'commitment', before: Task | Commitment, after: Task | Commitment) => void;
  now: () => number;
}

/** Plans and receipts live with the owner. No visitor fields select a destination. */
export const createApprovalWorkflowService = (deps: ApprovalWorkflowServiceDeps) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS reception_approval_workflow (
    endpoint_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reception_approval_workflow_response (
    intent_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, outcome_hash TEXT NOT NULL,
    state TEXT NOT NULL, result_json TEXT);`);

  const localTarget = (kind: 'task' | 'commitment', id: string): Task | Commitment => {
    const row = kind === 'task' ? deps.work.readTask(id) : deps.work.readCommitment(id);
    if (!row || row.deleted_at !== undefined) return fail('The selected work item is no longer available.');
    const source = deps.work.getSource(row.source_id);
    if (source?.source_kind !== 'builtin' || !source.write_capable) {
      return fail('Choose local Recued work. Connected-service work uses a saved recipe.');
    }
    if (kind === 'task' && (row as Task).done) return fail('The selected task is already complete.');
    if (kind === 'commitment') {
      const c = row as Commitment;
      if (!COMMITMENT_FULFILL_FROM_STATES.has(c.lifecycle_state)
        || c.lifecycle_state === 'expired' && !COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES.has(c.expiry_policy)) {
        return fail('This commitment cannot be fulfilled in its current state.');
      }
    }
    return row;
  };
  const inspect = (config: ApprovalLinkConfig): ApprovalWorkflowPlan => {
    const { target_kind: kind, target_id: id, on_approve_action: action } = config.on_action;
    if (!kind || config.action_kind !== 'approve_wording' || (action !== 'fire_recipe' && action !== 'mark_resolved')
      || (action === 'fire_recipe' ? kind !== 'recipe' : kind !== 'task' && kind !== 'commitment')) {
      throw new RpcError('approval_workflow_invalid', 'Choose accept/reject and an explicit workflow target.', 400);
    }
    let snapshot: ApprovalWorkflowPlan['snapshot'];
    let label: string;
    if (kind === 'recipe') {
      const stored = deps.recipes.listStored().find(row => row.recipe_id === id);
      if (!stored || isReceptionReviewRecipe(stored)) {
        return fail('Choose a saved, installed recipe. Reception review recipes cannot be a destination.');
      }
      snapshot = deps.recipeSnapshot(id);
      const parsed = parseRecipe(snapshot.recipe);
      if (!parsed.ok) return fail('The selected recipe is invalid. Open it in Recipes before creating a link.');
      const missing = missingUnattendedSettings(snapshot.recipe, snapshot.config);
      if (missing.length > 0) {
        return fail(`Set ${describeMissingUnattended(missing)} in the recipe's main dish before creating a link.`);
      }
      label = snapshot.recipe.metadata.name;
    } else {
      snapshot = localTarget(kind, id);
      label = kind === 'task' ? (snapshot as Task).title : (snapshot as Commitment).statement;
    }
    // The response wording is part of the binding, as are the saved settings.
    const { workflow_binding_hash: _binding, ...on_action } = config.on_action;
    const config_hash = digest({ ...config, on_action });
    const summary = `${kind === 'recipe' ? 'Run recipe' : kind === 'task' ? 'Complete task' : 'Fulfill commitment'}: ${label}\n`
      + `Target: ${id}\nCustomer prompt: ${config.prompt}\n`
      + (kind === 'recipe' ? 'Use the saved main-dish settings. The recipe keeps its normal operation approvals.' : 'Update this local work item after your approval.');
    const material = { target_kind: kind, target_id: id, snapshot, config_hash, summary };
    return { ...material, plan_hash: digest(material) };
  };
  const loadPlan = (endpointId: string): ApprovalWorkflowPlan | null => {
    const row = deps.db.prepare('SELECT plan_json FROM reception_approval_workflow WHERE endpoint_id=?')
      .get(endpointId) as { plan_json: string } | undefined;
    return row ? JSON.parse(row.plan_json) as ApprovalWorkflowPlan : null;
  };
  const checkedEndpoint = (endpointId: string, plan: ApprovalWorkflowPlan) => {
    const endpoint = deps.endpoints.findById(endpointId);
    if (!endpoint || endpoint.kind !== 'approval_link' || endpoint.revoked_at !== null || !endpoint.enabled
      || endpoint.expires_at === null || endpoint.expires_at <= deps.now()) return fail('The approval link is closed or expired.');
    const config = parseApprovalLinkConfig(endpoint.metadata);
    if (!config || config.on_action.workflow_binding_hash !== plan.plan_hash
      || inspect(config).plan_hash !== plan.plan_hash) return fail('The approval target or its settings changed. Create a new link.');
    return config;
  };

  return {
    inspect,
    bind(endpointId: string, plan: ApprovalWorkflowPlan) {
      deps.db.prepare('INSERT INTO reception_approval_workflow (endpoint_id,plan_hash,plan_json) VALUES (?,?,?)')
        .run(endpointId, plan.plan_hash, JSON.stringify(plan));
    },
    targets(): ApprovalWorkflowTargetsResult {
      const targets: ApprovalWorkflowTargetsResult['targets'] = [];
      const isWritableLocal = (sourceId: string) => {
        const source = deps.work.getSource(sourceId);
        return source?.source_kind === 'builtin' && source.write_capable;
      };
      const taskRows = deps.work.listTasks({ limit: 1000 });
      const commitmentRows = deps.work.listCommitments({ limit: 1000 });
      const tasks = taskRows.filter(row => !row.done && row.deleted_at === undefined && isWritableLocal(row.source_id));
      const commitments = commitmentRows.filter(row => row.deleted_at === undefined && isWritableLocal(row.source_id)
        && COMMITMENT_FULFILL_FROM_STATES.has(row.lifecycle_state)
        && (row.lifecycle_state !== 'expired' || COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES.has(row.expiry_policy)));
      tasks.slice(0, 100).forEach(row => targets.push({ kind: 'task', id: row.id, label: row.title }));
      commitments.slice(0, 100).forEach(row => targets.push({ kind: 'commitment', id: row.id, label: row.statement }));
      const recipes = deps.recipes.listStored().filter(row => !isReceptionReviewRecipe(row));
      recipes.slice(0, 100).forEach(row => {
        const recipe = deps.recipes.get(row.recipe_id);
        if (recipe) targets.push({ kind: 'recipe', id: row.recipe_id, label: recipe.metadata.name });
      });
      return { targets, truncated: tasks.length > 100 || commitments.length > 100 || recipes.length > 100
        || taskRows.length === 1000 || commitmentRows.length === 1000 };
    },
    /** Called only by the decrypting drain. A decline queues no effect. */
    recordResponse(effect: ReceptionApprovalEffect): ApprovalWorkflowContinueInput | null | undefined {
      const plan = loadPlan(effect.endpoint_id);
      if (!plan) return undefined; // A legacy untyped link cannot be guessed or retargeted.
      const intent = deps.intents.findById(effect.intent_id);
      if (!intent || intent.endpoint_id !== effect.endpoint_id || intent.target_id !== plan.target_id
        || intent.action_kind !== 'approve_wording' || intent.consumed_at === null || !intent.consumed_outcome_encrypted
        || effect.target_id !== plan.target_id || !/^(approve|reject(?::.*)?)$/s.test(effect.outcome)
        || effect.affirmative !== (effect.outcome === 'approve')) return fail('The customer response does not match this workflow.');
      if (!effect.affirmative) return null;
      // Keep a changed target visible for owner review; continue rechecks it.
      deps.db.prepare(`INSERT OR IGNORE INTO reception_approval_workflow_response
        (intent_id,endpoint_id,outcome_hash,state) VALUES (?,?,?,'received')`)
        .run(effect.intent_id, effect.endpoint_id, digest(intent.consumed_outcome_encrypted));
      return { endpoint_id: effect.endpoint_id, intent_id: effect.intent_id,
        expected_plan_hash: plan.plan_hash, summary: plan.summary };
    },
    async continue(input: ApprovalWorkflowContinueInput): Promise<ApprovalWorkflowContinueResult> {
      let transition: { kind: 'task' | 'commitment'; before: Task | Commitment; after: Task | Commitment } | undefined;
      const prepared = deps.db.transaction(() => {
        const plan = loadPlan(input.endpoint_id);
        if (!plan || input.expected_plan_hash !== plan.plan_hash || input.summary !== plan.summary) {
          return fail('The reviewed workflow plan was changed.');
        }
        const receipt = deps.db.prepare('SELECT * FROM reception_approval_workflow_response WHERE intent_id=?')
          .get(input.intent_id) as ResponseRow | undefined;
        const intent = deps.intents.findById(input.intent_id);
        if (!receipt || receipt.endpoint_id !== input.endpoint_id || !intent || intent.endpoint_id !== input.endpoint_id
          || intent.action_kind !== 'approve_wording' || intent.consumed_at === null
          || !intent.consumed_outcome_encrypted || receipt.outcome_hash !== digest(intent.consumed_outcome_encrypted)) {
          return fail('This workflow has no recorded customer acceptance.');
        }
        if (receipt.state === 'continued' && receipt.result_json) {
          return { result: { ...JSON.parse(receipt.result_json) as ApprovalWorkflowContinueResult, already_continued: true } };
        }
        if (receipt.state !== 'received') return fail('This workflow already started. Review its run before taking another action.');
        checkedEndpoint(input.endpoint_id, plan);
        const result: ApprovalWorkflowContinueResult = { target_kind: plan.target_kind,
          target_id: plan.target_id, already_continued: false };
        if (plan.target_kind === 'recipe') {
          if (!deps.runRecipe) throw new RpcError('approval_workflow_invalid', 'Recipe execution is unavailable on this server.', 503);
          deps.db.prepare("UPDATE reception_approval_workflow_response SET state='starting' WHERE intent_id=?").run(input.intent_id);
          return { plan, result };
        }
        const before = localTarget(plan.target_kind, plan.target_id);
        const now = deps.now();
        const after = plan.target_kind === 'task'
          ? deps.work.writeTask({ ...before as Task, done: true, completed_at: now, updated_at: now }, now)
          : deps.work.writeCommitment({ ...before as Commitment, lifecycle_state: 'fulfilled', state_changed_at: now,
            lifecycle_changed_at: now, updated_at: now }, now);
        transition = { kind: plan.target_kind, before, after };
        deps.db.prepare("UPDATE reception_approval_workflow_response SET state='continued',result_json=? WHERE intent_id=?")
          .run(JSON.stringify(result), input.intent_id);
        return { result };
      }).immediate();
      if (!prepared.plan) {
        if (transition) deps.resolved?.(transition.kind, transition.before, transition.after);
        return prepared.result;
      }
      const child_run_id = `reception-approved-recipe-${input.intent_id}`;
      try {
        await deps.runRecipe!(prepared.plan.snapshot as ApprovalWorkflowRecipeSnapshot, child_run_id);
        const result = { ...prepared.result, child_run_id };
        deps.db.prepare("UPDATE reception_approval_workflow_response SET state='continued',result_json=? WHERE intent_id=?")
          .run(JSON.stringify(result), input.intent_id);
        return result;
      } catch (error) {
        // A failed/crashed dispatch is never retried automatically. The receipt
        // and deterministic child run identify the attempt for owner review.
        deps.db.prepare("UPDATE reception_approval_workflow_response SET state='failed',result_json=? WHERE intent_id=?")
          .run(JSON.stringify({ ...prepared.result, child_run_id }), input.intent_id);
        throw error;
      }
    },
  };
};
export type ApprovalWorkflowService = ReturnType<typeof createApprovalWorkflowService>;
