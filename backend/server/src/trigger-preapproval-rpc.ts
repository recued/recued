/** D-341 slice B1 — the owner's rpc over triggers' standing pre-approvals: grant one, list
 *  them, end one. Registered in the `collection.contract.` slice, which MCP never reaches: no AI
 *  sees, grants or ends one.
 *
 *  🔑 A GRANT IS CHECKED AGAINST WHAT THE SERVER KNOWS, never the caller's word:
 *  - the recipe is installed, and the version pinned is the installed one, hashed here as a run
 *    hashes it;
 *  - each write is an op the version's own steps call, named as the gate names it
 *    (`recipeStepOps`: an installed recipe is stored lowered, so a step's `op` is not read);
 *  - a recipe that asks an AI may carry one (ruling 8, 2026-11-08): its AI decides what the writes
 *    carry, and the view says so (`ai_steps`);
 *  - the trigger exists and starts that recipe (a webhook bound to it, its schedule, its trigger);
 *    a webhook's door is pinned as it is now, so a door minted again ends the pre-approval.
 *
 *  It has no end date and no use cap (ruling 10): it lasts until the owner ends it.
 *
 *  B3 — a scheduled prompt's runs no recipe: its "recipe" is its prompt, pinned by the version of
 *  its text (`PromptSchedules.promptVersion`), and its writes are its AI's Tier-1 writes, named as
 *  D-329's write rules name them (`readTriggerPreapprovalTier1Op`). Reading a prompt decrypts it,
 *  so the granter is async.
 *
 *  Each decision is audited reserve-class (`trigger_preapproval_granted` / `_revoked`),
 *  best-effort: the decision is the store's, the audit row its record. */

import { createHash } from 'node:crypto';

import {
  RpcError,
  describePromptRecipePreapproval,
  describeTriggerPreapproval,
  describeTriggerPreapprovalTier1Op,
  readTriggerPreapprovalTier1Op,
  normalizeTriggerPreapprovalGrant,
  readTriggerPreapprovalTrigger,
  sameTrigger,
  triggerPreapprovalHasDoor,
  TRIGGER_PREAPPROVAL_TRIGGER_NOUNS,
  TRIGGER_PREAPPROVAL_ALL_WRITES,
  TRIGGER_PREAPPROVAL_ASK_GRANT,
  TRIGGER_PREAPPROVAL_BROWSER_OP,
  TRIGGER_PREAPPROVAL_WHOLE_RECIPE,
  coversWholeRecipe,
  TRIGGER_PREAPPROVAL_BROWSER_PER_RUN,
  isScheduledPromptWrite,
  triggerPreapprovalState,
  type IngredientManifest,
  type NormalizedTriggerPreapprovalGrant,
  type TriggerPreapprovalChoice,
  type TriggerPreapprovalOffer,
  type RecipeDefinition,
  type TriggerPreapprovalRow,
  type TriggerPreapprovalState,
  type TriggerPreapprovalTrigger,
  type TriggerPreapprovalView,
} from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition, type PackOpResolution } from '@recued/recipes';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import { TriggerPreapprovalError, type TriggerPreapprovalStore, type TriggerPreapprovalGrantInput,
  type TriggerPreapprovalGrantDecision } from './storage/trigger-preapproval-store.js';
import {
  recipeAiSteps,
  recipeStepOpLabels,
  recipeStepOps,
  recipeStepWrites,
  type TriggerPreapprovalOpDeps,
} from './trigger-preapproval-ops.js';

/** How a trigger starts a recipe now: for a webhook, the door its runs of the recipe go through
 *  (absent while none is minted). */
export interface TriggerRoute {
  readonly door_contract_id?: string;
}

/** Whether a trigger exists and starts a recipe, from the stores that keep each kind. */
export interface TriggerPreapprovalTargets {
  /** How the trigger starts the recipe, or undefined when it doesn't (or is gone). */
  route(trigger: TriggerPreapprovalTrigger, recipe_id: string): TriggerRoute | undefined;
  /** D-341 slice B2b — the recipes the trigger starts: a schedule's, an event trigger's and an
   *  auto-run's one, every recipe a webhook's bindings run. Empty for a trigger that is gone. */
  recipesOf(trigger: TriggerPreapprovalTrigger): string[];
}

/** The targets check over the stores the server keeps: a webhook starts a recipe when one of its
 *  bindings carries a trigger row for it (every row of one recipe carries the same door); a
 *  schedule or an event trigger when it names the recipe; an armed auto-run (B1b) when its dish
 *  is that recipe's and the recipe runs on its own; a reception form (B4) when it is paired with
 *  the recipe, through its door. A store this server lacks starts nothing. */
export const createTriggerPreapprovalTargets = (stores: {
  readonly webhooks?: {
    /** Every recipe some webhook trigger row starts. */
    recipesWithTriggers?(): string[];
    consumersOfRecipe(recipe_id: string): ReadonlyArray<{ readonly snapshot: {
      readonly bindings: ReadonlyArray<{ readonly binding_id: string; readonly ingress_id: string }>;
      readonly triggers: ReadonlyArray<{
        readonly binding_id: string; readonly recipe_id: string; readonly contract_id: string | null;
      }>;
    } }>;
  };
  readonly schedules?: { get(schedule_id: string): { readonly recipe_id: string } | null };
  readonly triggers?: { get(trigger_id: string): { readonly recipe_id: string } | null };
  /** B1b — the recipe a dish's timer runs: the dish's recipe, while that recipe runs on its own
   *  (installed with `auto_run`). Undefined for a dish that is gone or has no timer. */
  readonly timers?: { recipeOf(dish_id: string): string | undefined };
  /** B4 — a reception form's pairing: the recipe its submissions run, and its door (null until
   *  one is minted). Null for a form with no pairing. */
  readonly receptions?: { pairOf(endpoint_id: string): { readonly recipe_id: string; readonly contract_id: string | null } | null };
}): TriggerPreapprovalTargets => {
  const one = (recipe: string | undefined): string[] => (recipe !== undefined ? [recipe] : []);
  const targets: TriggerPreapprovalTargets = {
    recipesOf(trigger) {
      // B3 — a scheduled prompt is its own recipe: the granter reads it (`prompts`).
      if (trigger.kind === 'prompt_schedule') return [];
      if (trigger.kind === 'schedule') return one(stores.schedules?.get(trigger.schedule_id)?.recipe_id);
      if (trigger.kind === 'event_trigger') return one(stores.triggers?.get(trigger.trigger_id)?.recipe_id);
      if (trigger.kind === 'auto_run') return one(stores.timers?.recipeOf(trigger.dish_id));
      if (trigger.kind === 'reception') return one(stores.receptions?.pairOf(trigger.endpoint_id)?.recipe_id);
      return (stores.webhooks?.recipesWithTriggers?.() ?? []).filter((recipe_id) => targets.route(trigger, recipe_id) !== undefined);
    },
    route(trigger, recipe_id) {
      if (trigger.kind === 'prompt_schedule') return undefined;
      if (trigger.kind === 'schedule') return stores.schedules?.get(trigger.schedule_id)?.recipe_id === recipe_id ? {} : undefined;
      if (trigger.kind === 'event_trigger') return stores.triggers?.get(trigger.trigger_id)?.recipe_id === recipe_id ? {} : undefined;
      if (trigger.kind === 'auto_run') return stores.timers?.recipeOf(trigger.dish_id) === recipe_id ? {} : undefined;
      if (trigger.kind === 'reception') {
        const pair = stores.receptions?.pairOf(trigger.endpoint_id) ?? null;
        if (pair === null || pair.recipe_id !== recipe_id) return undefined;
        return pair.contract_id !== null ? { door_contract_id: pair.contract_id } : {};
      }
      for (const { snapshot } of stores.webhooks?.consumersOfRecipe(recipe_id) ?? []) {
        const bound = new Set(snapshot.bindings.filter((b) => b.ingress_id === trigger.ingress_id).map((b) => b.binding_id));
        const row = snapshot.triggers.find((t) => t.recipe_id === recipe_id && bound.has(t.binding_id));
        if (row !== undefined) return row.contract_id !== null ? { door_contract_id: row.contract_id } : {};
      }
      return undefined;
    },
  };
  return targets;
};

export interface TriggerPreapprovalRpcDeps {
  readonly store?: TriggerPreapprovalStore;
  readonly recipeStore?: { get(recipe_id: string): RecipeDefinition | null };
  readonly targets?: TriggerPreapprovalTargets;
  /** The manifests and the installed packs' catalogs a recipe's ops are named through. */
  readonly manifestOf: (slug: string) => IngredientManifest | null | undefined;
  readonly packs?: () => PackOpResolution | undefined;
  /** The owner's own ruling on an op (D-211), so the trigger's page offers what the gates admit. */
  readonly ownerOverrideOf?: TriggerPreapprovalOpDeps['ownerOverrideOf'];
  /** B3 — the scheduled prompts, by their schedule's id: a prompt's title and the version of its
   *  text now, as a run of it is stamped. Null once removed; a throw (a locked vault) reads as
   *  unknown. */
  readonly prompts?: {
    version(schedule_id: string): Promise<{ readonly title: string; readonly prompt_sha256: string } | null>;
  };
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
}

/** The version a run of this recipe pins, as `handleExecute` hashes it (`authoredRecipeSha256`). */
export const triggerPreapprovalRecipeSha256 = (recipe: RecipeDefinition): string =>
  createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex');

const TRIGGER_NAME = TRIGGER_PREAPPROVAL_TRIGGER_NOUNS;

/** The grants, the list and the revocations, for the owner's rpc and for an ask's answer
 *  (D-341 slice B2: the resumer grants what a held write offered). One path, so an answer is
 *  checked as the rpc checks the owner's request. Each grant is audited, with where it came from. */
export interface TriggerPreapprovalGranter {
  /** Grant what the owner asked for. Rejects with an `RpcError` naming `method`. */
  grant(args: unknown, method: string): Promise<TriggerPreapprovalView>;
  /** Grant what a held write's "Always allow for this …" offered, with the ask's bounds, when the
   *  recipe (or a scheduled prompt's text) and, for a webhook or a form, its door are still what
   *  the hold read. One durable approval selects one grant, including after revocation. */
  grantOffer(offer: TriggerPreapprovalOffer, approval: {
    readonly run_id: string; readonly checkpoint_id: string;
  }): Promise<TriggerPreapprovalView>;
  list(method: string): Promise<TriggerPreapprovalView[]>;
  revoke(args: unknown, method: string): Promise<TriggerPreapprovalView>;
  /** D-341 slice B2b — what a trigger's page may grant: each recipe the trigger starts, its writes
   *  in the owner's words (and which a pre-approval may name), the steps that ask an AI, and this
   *  trigger's pre-approvals for it, newest first. A scheduled prompt (B3) lists its prompt, whose
   *  writes are learned from its asks, so none is on offer. */
  choices(args: unknown, method: string): Promise<{ recipes: TriggerPreapprovalChoice[] }>;
}

/** B3 — what a scheduled prompt's "recipe" is named and versioned by, or `null` once it is removed,
 *  or `undefined` when it cannot be read now (no prompts here, a locked vault). */
type PromptSubject = { readonly title: string; readonly prompt_sha256: string } | null | undefined;
/** B3 — a scheduled prompt's run is its AI's: the page, the card and the ask say so. */
const PROMPT_AI_STEPS: readonly string[] = ['prompt'];

export const createTriggerPreapprovalGranter = (deps: TriggerPreapprovalRpcDeps): TriggerPreapprovalGranter => {
  const now = deps.now ?? Date.now;
  const store = (method: string): TriggerPreapprovalStore => {
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: trigger pre-approvals are not wired`, 501);
    return deps.store;
  };
  const persist = (kept: TriggerPreapprovalStore, input: TriggerPreapprovalGrantInput,
    decision?: TriggerPreapprovalGrantDecision) => decision === undefined
    ? { row: kept.grant(input), created: true }
    : kept.grantForDecision(input, decision);
  const audit = (action: ActivityAction, target: string, detail: Record<string, unknown>, at: number): void => {
    if (deps.auditLog === undefined) return;
    void deps.auditLog.logActivity({
      activity_id: '', timestamp: at, action, target, detail: JSON.stringify(detail),
    }).catch(() => undefined);
  };
  const promptOf = async (schedule_id: string): Promise<PromptSubject> => {
    if (deps.prompts === undefined) return undefined;
    try {
      return await deps.prompts.version(schedule_id);
    } catch {
      return undefined;
    }
  };
  /** B3 — a scheduled prompt's row now: ended by the owner, its prompt edited (`outdated`), or the
   *  prompt removed (`detached`). Unreadable now, only its own state is known. */
  const promptStateOf = (row: TriggerPreapprovalRow, prompt: PromptSubject): TriggerPreapprovalState => {
    if (prompt === undefined) return triggerPreapprovalState(row);
    if (prompt === null) return row.revoked_at !== undefined ? 'revoked' : 'detached';
    return triggerPreapprovalState(row, prompt.prompt_sha256);
  };
  /** B6 — a row's own state, then whether its recipe is still the version it was granted for. */
  const stateOfVersion = (row: TriggerPreapprovalRow, recipe: RecipeDefinition | null): TriggerPreapprovalState => {
    const own = triggerPreapprovalState(row, recipe !== null ? triggerPreapprovalRecipeSha256(recipe) : undefined);
    return own !== 'live' ? own : recipe === null ? 'outdated' : 'live';
  };
  /** What a row is now: ended by the owner first, then whether the recipe is still the version it
   *  was granted for, then whether its trigger still starts it (a webhook through the same door). */
  const stateOf = (row: TriggerPreapprovalRow, recipe: RecipeDefinition | null): TriggerPreapprovalState => {
    const own = triggerPreapprovalState(row, recipe !== null ? triggerPreapprovalRecipeSha256(recipe) : undefined);
    if (own !== 'live') return own;
    if (recipe === null) return 'outdated';
    const route = deps.targets?.route(row.trigger, row.recipe_id);
    if (route === undefined) return 'detached';
    return triggerPreapprovalHasDoor(row.trigger.kind) && route.door_contract_id !== row.door_contract_id ? 'detached' : 'live';
  };
  const opDepsNow = () => {
    const packs = deps.packs?.();
    return {
      manifestOf: deps.manifestOf,
      ...(packs !== undefined ? { packs } : {}),
      ...(deps.ownerOverrideOf !== undefined ? { ownerOverrideOf: deps.ownerOverrideOf } : {}),
    };
  };
  const view = async (row: TriggerPreapprovalRow): Promise<TriggerPreapprovalView> => {
    // B6 — a recipe a scheduled prompt starts: the recipe's words, ended by an edit to either.
    if (row.trigger.kind === 'prompt_schedule' && row.prompt_sha256 !== undefined) {
      const prompt = await promptOf(row.trigger.schedule_id);
      const recipe = deps.recipeStore?.get(row.recipe_id) ?? null;
      const labels = recipe !== null ? recipeStepOpLabels(recipe, opDepsNow()) : new Map<string, string>();
      const recipe_name = recipe?.metadata.name ?? row.recipe_id;
      const write_labels = row.writes.map((op) => labels.get(op) ?? op);
      const recipeState = stateOfVersion(row, recipe);
      const promptState = prompt === undefined ? 'live' : prompt === null ? 'detached'
        : prompt.prompt_sha256 === row.prompt_sha256 ? 'live' : 'outdated';
      return {
        ...row,
        state: recipeState !== 'live' ? recipeState : promptState,
        recipe_name,
        write_labels,
        ai_steps: PROMPT_AI_STEPS,
        description: describePromptRecipePreapproval(row, recipe_name, prompt?.title ?? 'a scheduled prompt', write_labels),
      };
    }
    if (row.trigger.kind === 'prompt_schedule') {
      const prompt = await promptOf(row.trigger.schedule_id);
      const recipe_name = prompt?.title ?? 'A scheduled prompt';
      const write_labels = row.writes.map(describeTriggerPreapprovalTier1Op);
      return {
        ...row,
        state: promptStateOf(row, prompt),
        recipe_name,
        write_labels,
        ai_steps: PROMPT_AI_STEPS,
        description: describeTriggerPreapproval(row, recipe_name, write_labels, PROMPT_AI_STEPS),
      };
    }
    const recipe = deps.recipeStore?.get(row.recipe_id) ?? null;
    const opDeps = opDepsNow();
    const labels = recipe !== null ? recipeStepOpLabels(recipe, opDeps) : new Map<string, string>();
    const recipe_name = recipe?.metadata.name ?? row.recipe_id;
    // D-402 ruling 5 — a row covering the whole recipe names its version's writes, those a pre-approval
    // can stand in for.
    const write_labels = coversWholeRecipe(row)
      ? (recipe !== null ? recipeStepWrites(recipe, opDeps).filter((write) => write.offerable).map((write) => write.label) : [])
      : row.writes.map((op) => labels.get(op) ?? op);
    const ai_steps = recipe !== null ? recipeAiSteps(recipe, opDeps) : [];
    return {
      ...row,
      state: stateOf(row, recipe),
      recipe_name,
      write_labels,
      ai_steps,
      description: describeTriggerPreapproval(row, recipe_name, write_labels, ai_steps),
    };
  };
  /** B3 — a scheduled prompt's grant: its own prompt, the version of its text now, and writes its AI
   *  makes, each named as a write rule names it. */
  const grantPrompt = async (
    grant: NormalizedTriggerPreapprovalGrant & { readonly trigger: { readonly kind: 'prompt_schedule'; readonly schedule_id: string } },
    method: string,
    via: 'owner' | 'ask',
    expect?: { readonly recipe_sha256: string },
    decision?: TriggerPreapprovalGrantDecision,
  ): Promise<TriggerPreapprovalView> => {
    const kept = store(method);
    const schedule_id = grant.trigger.schedule_id;
    if (grant.recipe_id !== schedule_id) {
      throw new RpcError('bad_request', `${method}: a scheduled prompt's pre-approval names its own prompt (${schedule_id})`, 400, method);
    }
    const strange = grant.writes.filter((op) => !isScheduledPromptWrite(op));
    if (strange.length > 0) {
      throw new RpcError('bad_request',
        `${method}: a scheduled prompt's pre-approval names its AI's writes as a write rule does, or its browser actions; `
          + `${strange.join(', ')} is not one`,
        400, method);
    }
    const prompt = await promptOf(schedule_id);
    if (prompt === undefined) throw new RpcError('not_configured', `${method}: scheduled prompts cannot be read here`, 501, method);
    if (prompt === null) throw new RpcError('not_found', `${method}: no scheduled prompt ${schedule_id}`, 404, method);
    if (expect !== undefined && expect.recipe_sha256 !== prompt.prompt_sha256) {
      throw new RpcError('bad_request', `${method}: the prompt of ${prompt.title} changed since it asked`, 400, method);
    }
    const at = now();
    const { row, created } = persist(kept, {
      trigger: grant.trigger, recipe_id: schedule_id, recipe_sha256: prompt.prompt_sha256,
      writes: grant.writes, max_per_run: grant.max_per_run, now: at,
    }, decision);
    if (created) audit('trigger_preapproval_granted', row.id, {
      via, trigger: row.trigger, recipe_id: row.recipe_id, recipe_sha256: row.recipe_sha256, writes: row.writes,
      max_per_run: row.max_per_run,
    }, at);
    return view(row);
  };
  /** B6 — a recipe a scheduled prompt started, from its held write's ask: the prompt as its text is
   *  now, the recipe as it is installed now, and the write its step makes, or nothing. */
  const grantPromptRecipe = async (
    offer: TriggerPreapprovalOffer & {
      readonly trigger: { readonly kind: 'prompt_schedule'; readonly schedule_id: string };
      readonly prompt_sha256: string;
    },
    method: string,
    decision: TriggerPreapprovalGrantDecision,
  ): Promise<TriggerPreapprovalView> => {
    const kept = store(method);
    const prompt = await promptOf(offer.trigger.schedule_id);
    if (prompt === undefined) throw new RpcError('not_configured', `${method}: scheduled prompts cannot be read here`, 501, method);
    if (prompt === null) throw new RpcError('not_found', `${method}: no scheduled prompt ${offer.trigger.schedule_id}`, 404, method);
    if (prompt.prompt_sha256 !== offer.prompt_sha256) {
      throw new RpcError('bad_request', `${method}: the prompt of ${prompt.title} changed since it asked`, 400, method);
    }
    const recipe = deps.recipeStore?.get(offer.recipe_id) ?? null;
    if (recipe === null) throw new RpcError('not_found', `${method}: no installed recipe ${offer.recipe_id}`, 404, method);
    if (triggerPreapprovalRecipeSha256(recipe) !== offer.recipe_sha256) {
      throw new RpcError('bad_request', `${method}: ${recipe.metadata.name} changed since it asked`, 400, method);
    }
    if (!new Set(recipeStepOps(recipe, opDepsNow()).values()).has(offer.op)) {
      throw new RpcError('bad_request', `${method}: ${recipe.metadata.name} does not call ${offer.op}`, 400, method);
    }
    const at = now();
    const { row, created } = persist(kept, {
      trigger: offer.trigger, recipe_id: offer.recipe_id, recipe_sha256: offer.recipe_sha256, prompt_sha256: offer.prompt_sha256,
      writes: [offer.op], ...TRIGGER_PREAPPROVAL_ASK_GRANT, now: at,
    }, decision);
    if (created) audit('trigger_preapproval_granted', row.id, {
      via: 'ask', trigger: row.trigger, recipe_id: row.recipe_id, recipe_sha256: row.recipe_sha256,
      prompt_sha256: row.prompt_sha256, writes: row.writes, max_per_run: row.max_per_run,
    }, at);
    return view(row);
  };
  /** A request that passed its shape check, checked against what the server knows, and kept. */
  const grantChecked = async (
    grant: NormalizedTriggerPreapprovalGrant,
    method: string,
    via: 'owner' | 'ask',
    expect?: { readonly recipe_sha256: string; readonly door_contract_id?: string; readonly op?: string },
    decision?: TriggerPreapprovalGrantDecision,
  ): Promise<TriggerPreapprovalView> => {
    if (grant.trigger.kind === 'prompt_schedule') {
      return grantPrompt({ ...grant, trigger: grant.trigger }, method, via, expect, decision);
    }
    const kept = store(method);
    const recipe = deps.recipeStore?.get(grant.recipe_id) ?? null;
    if (recipe === null) throw new RpcError('not_found', `${method}: no installed recipe ${grant.recipe_id}`, 404, method);
    const recipe_sha256 = triggerPreapprovalRecipeSha256(recipe);
    if (expect !== undefined && expect.recipe_sha256 !== recipe_sha256) {
      throw new RpcError('bad_request', `${method}: ${recipe.metadata.name} changed since it asked`, 400, method);
    }
    const opDeps = opDepsNow();
    const ops = new Set(recipeStepOps(recipe, opDeps).values());
    // D-402 ruling 5 — every write of the version: named by the version, so none is strange. An ask's
    // answer still names the write it asked about, which the recipe must call.
    const whole = grant.writes.length === 1 && grant.writes[0] === TRIGGER_PREAPPROVAL_ALL_WRITES;
    if (whole && (ops.size === 0 || (expect?.op !== undefined && !ops.has(expect.op)))) {
      throw new RpcError('bad_request', `${method}: ${recipe.metadata.name} makes no write a pre-approval can name`, 400, method);
    }
    const strange = whole ? [] : grant.writes.filter((op) => !ops.has(op));
    if (strange.length > 0) {
      throw new RpcError('bad_request',
        `${method}: ${recipe.metadata.name} does not call ${strange.join(', ')}; a pre-approval names only the ops its steps call`,
        400, method);
    }
    if (deps.targets === undefined) throw new RpcError('not_configured', `${method}: triggers cannot be checked here`, 501, method);
    const route = deps.targets.route(grant.trigger, grant.recipe_id);
    if (route === undefined) {
      throw new RpcError('bad_request',
        `${method}: that ${TRIGGER_NAME[grant.trigger.kind]} does not start ${recipe.metadata.name}`, 400, method);
    }
    if (triggerPreapprovalHasDoor(grant.trigger.kind) && route.door_contract_id === undefined) {
      throw new RpcError('bad_request', grant.trigger.kind === 'reception'
        ? `${method}: that form cannot run ${recipe.metadata.name} yet; pair it with the recipe again`
        : `${method}: that webhook cannot run ${recipe.metadata.name} yet; install its pack again`, 400, method);
    }
    if (expect !== undefined && triggerPreapprovalHasDoor(grant.trigger.kind) && route.door_contract_id !== expect.door_contract_id) {
      throw new RpcError('bad_request', `${method}: that ${TRIGGER_NAME[grant.trigger.kind]}'s door changed since it asked`, 400, method);
    }
    const at = now();
    const { row, created } = persist(kept, {
      trigger: grant.trigger,
      ...(route.door_contract_id !== undefined ? { door_contract_id: route.door_contract_id } : {}),
      recipe_id: grant.recipe_id, recipe_sha256,
      writes: grant.writes, max_per_run: grant.max_per_run, now: at,
    }, decision);
    if (created) audit('trigger_preapproval_granted', row.id, {
      via,
      trigger: row.trigger,
      ...(row.door_contract_id !== undefined ? { door_contract_id: row.door_contract_id } : {}),
      recipe_id: row.recipe_id, recipe_sha256: row.recipe_sha256, writes: row.writes,
      max_per_run: row.max_per_run,
    }, at);
    return view(row);
  };

  return {
    async grant(args, method) {
      let grant: NormalizedTriggerPreapprovalGrant;
      try {
        grant = normalizeTriggerPreapprovalGrant(args);
      } catch (error) {
        throw new RpcError('bad_request', `${method}: ${(error as Error).message}`, 400, method);
      }
      return grantChecked(grant, method, 'owner');
    },

    async grantOffer(sourceOffer, approval) {
      const method = 'trigger pre-approval from an ask';
      if (!approval || typeof approval.run_id !== 'string' || !approval.run_id
        || typeof approval.checkpoint_id !== 'string' || !approval.checkpoint_id) {
        throw new RpcError('bad_request', `${method}: a durable approval identity is required`, 400);
      }
      const offer = structuredClone(sourceOffer);
      const decision = { approval_ref: JSON.stringify(['preflight', approval.run_id, approval.checkpoint_id]),
        offer_sha256: createHash('sha256').update(canonicalJsonString(offer)).digest('hex') };
      const prior = store(method).getDecision(decision);
      if (prior !== undefined) return view(prior);
      if (offer.trigger.kind === 'prompt_schedule' && offer.prompt_sha256 !== undefined) {
        return grantPromptRecipe({ ...offer, trigger: offer.trigger, prompt_sha256: offer.prompt_sha256 }, method, decision);
      }
      return grantChecked({
        trigger: offer.trigger, recipe_id: offer.recipe_id,
        // B5 — a scheduled prompt's browser actions are a job's many, not one write a run; its AI's own
        // writes keep their grant of one (§7.7). D-402 ruling 10 — a trigger's "Always allow" covers
        // every write of the recipe's version, with no count.
        ...(offer.op === TRIGGER_PREAPPROVAL_BROWSER_OP
          ? { writes: [offer.op], max_per_run: TRIGGER_PREAPPROVAL_BROWSER_PER_RUN }
          : offer.trigger.kind === 'prompt_schedule'
            ? { writes: [offer.op], max_per_run: TRIGGER_PREAPPROVAL_ASK_GRANT.max_per_run }
            : { writes: [TRIGGER_PREAPPROVAL_ALL_WRITES], max_per_run: TRIGGER_PREAPPROVAL_WHOLE_RECIPE }),
      }, method, 'ask', {
        op: offer.op,
        recipe_sha256: offer.recipe_sha256,
        ...(offer.door_contract_id !== undefined ? { door_contract_id: offer.door_contract_id } : {}),
      }, decision);
    },

    async list(method) {
      return Promise.all(store(method).list().map((row) => view(row)));
    },

    async choices(args, method) {
      const trigger = readTriggerPreapprovalTrigger(
        args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as { trigger?: unknown }).trigger : undefined);
      if (trigger === undefined) {
        throw new RpcError('bad_request',
          `${method}: trigger must name a webhook, a schedule, an event trigger, an auto-run, a form or a scheduled prompt by its id`,
          400, method);
      }
      const rows = store(method).list().filter((row) => sameTrigger(row.trigger, trigger));
      // B3 — a scheduled prompt lists its prompt: its writes are learned from its asks, so none is on
      // offer here.
      if (trigger.kind === 'prompt_schedule') {
        const prompt = await promptOf(trigger.schedule_id);
        if (prompt === undefined || prompt === null) return { recipes: [] };
        // B6 — and each recipe it starts that one of its rows names, under the prompt.
        const started = [...new Set(rows.filter((row) => row.prompt_sha256 !== undefined).map((row) => row.recipe_id))];
        return { recipes: [{
          recipe_id: trigger.schedule_id,
          recipe_name: prompt.title,
          ai_steps: PROMPT_AI_STEPS,
          writes: [],
          preapprovals: await Promise.all(rows.filter((row) => row.recipe_id === trigger.schedule_id && row.prompt_sha256 === undefined)
            .map((row) => view(row))),
        }, ...await Promise.all(started.map(async (recipe_id) => ({
          recipe_id,
          recipe_name: deps.recipeStore?.get(recipe_id)?.metadata.name ?? recipe_id,
          ai_steps: PROMPT_AI_STEPS,
          writes: [],
          preapprovals: await Promise.all(rows.filter((row) => row.recipe_id === recipe_id && row.prompt_sha256 !== undefined)
            .map((row) => view(row))),
        })))] };
      }
      if (deps.targets === undefined) throw new RpcError('not_configured', `${method}: triggers cannot be checked here`, 501, method);
      const opDeps = opDepsNow();
      const recipes: TriggerPreapprovalChoice[] = [];
      for (const recipe_id of deps.targets.recipesOf(trigger)) {
        const recipe = deps.recipeStore?.get(recipe_id) ?? null;
        if (recipe === null) continue;
        recipes.push({
          recipe_id,
          recipe_name: recipe.metadata.name,
          ai_steps: recipeAiSteps(recipe, opDeps),
          writes: recipeStepWrites(recipe, opDeps),
          preapprovals: await Promise.all(rows.filter((row) => row.recipe_id === recipe_id).map((row) => view(row))),
          // D-402 ruling 5 — what this page grants: every write of the version.
          grants_whole_recipe: true,
        });
      }
      return { recipes };
    },

    async revoke(args, method) {
      const id = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' || id.trim() === '') throw new RpcError('bad_request', `${method}: id is required`, 400, method);
      const at = now();
      let row: TriggerPreapprovalRow;
      try {
        row = store(method).revoke(id, at);
      } catch (error) {
        if (error instanceof TriggerPreapprovalError) {
          throw new RpcError(error.code, `${method}: ${error.message}`, error.code === 'not_found' ? 404 : 400, method);
        }
        throw error;
      }
      audit('trigger_preapproval_revoked', row.id, { trigger: row.trigger, recipe_id: row.recipe_id, uses: row.uses }, at);
      return view(row);
    },
  };
};

export const createTriggerPreapprovalRpcHandlers = (deps: TriggerPreapprovalRpcDeps & {
  /** The granter to use; built from `deps` when absent. Composition shares one with the resumer. */
  readonly granter?: TriggerPreapprovalGranter;
}) => {
  const granter = deps.granter ?? createTriggerPreapprovalGranter(deps);
  return {
    'collection.contract.grantTriggerPreapproval': async (args: unknown): Promise<{ preapproval: TriggerPreapprovalView }> =>
      ({ preapproval: await granter.grant(args, 'collection.contract.grantTriggerPreapproval') }),

    'collection.contract.listTriggerPreapprovals': async (): Promise<{ preapprovals: TriggerPreapprovalView[] }> =>
      ({ preapprovals: await granter.list('collection.contract.listTriggerPreapprovals') }),

    'collection.contract.revokeTriggerPreapproval': async (args: unknown): Promise<{ preapproval: TriggerPreapprovalView }> =>
      ({ preapproval: await granter.revoke(args, 'collection.contract.revokeTriggerPreapproval') }),

    'collection.contract.triggerPreapprovalChoices': async (args: unknown): Promise<{ recipes: TriggerPreapprovalChoice[] }> =>
      granter.choices(args, 'collection.contract.triggerPreapprovalChoices'),
  };
};
