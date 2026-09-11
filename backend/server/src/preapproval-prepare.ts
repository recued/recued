/** D-261 preparation is a bounded, read-only inventory walk. It never invokes
 * the engine, a transform, an ingredient, a model, or a provider for a preview.
 * Binding descriptions come from the host's actual dispatcher resolvers. */
import { randomUUID } from 'node:crypto';
import {
  PREAPPROVAL_LIMITS, RpcError, collectRefs, isRef, parsePreparePreapproval,
  parsePreapprovalJson, preapprovalChildPath, preapprovalStepPath, resolveDeep, resolveValue, stepType,
  type IngredientManifest, type NamespaceStores, type PreparePreapproval,
  type PreapprovalInvocationPath, type PreapprovalJson, type RecipeDefinition,
} from '@recued/contracts';
import { evaluateCondition, extractVariableDefault, isPrototypeSensitiveKey } from '@recued/engine';
import { mergeManifestStepInput, mergeManifestStepOutput } from '@recued/ingredients';
import { resolveCanonicalRecipeForDispatch, type DispatchResolveDeps } from './dispatch-canonical-resolve.js';
import { mergeRecipeConfigLayers } from './recipe-effective-config.js';
import {
  preapprovalEffectHash, preapprovalHash, validatePreparedFutureExecution,
} from './preapproval-invocations.js';
import type {
  PreparedFutureExecution, PreparedInvocation, PreparedRecipeSnapshot, PreapprovalDependency,
  PreapprovalOrigin, PreapprovalTargetBinding,
} from './preapproval-model.js';

export interface PreapprovalRecipeSource {
  definition: RecipeDefinition;
  publisher_id: string;
  /** Authenticated source stores supply these layers, not request fields. */
  install_config?: Record<string, unknown>;
  bound_dish?: { config_overlay: Record<string, unknown>; group_overlay?: Record<string, unknown> };
  dependencies: PreapprovalDependency[];
}
export interface PreapprovalResolvedCall {
  material: Omit<PreparedInvocation, 'member_id' | 'invocation_path' | 'arguments_hash' | 'effect_hash'
    | 'condition_hash' | 'parent_member_id' | 'required_child_ids' | 'predecessor_member_ids' | 'review'>;
  review: { label: string; detail: string; ineligible_reason: string | null };
  /** Trusted resolvers must explicitly assert complete child inventory. */
  child_inventory: { complete: true } | { complete: false; reason: string };
  children: Array<{ slot: string; index: number; call: PreapprovalResolvedCall }>;
  /** Set only by a dispatcher whose child calls are independent. */
  parallel_children?: true;
  nested_recipe: { recipe_id: string; publisher_id: string; config: Record<string, PreapprovalJson> } | null;
  dependencies: PreapprovalDependency[];
}
export type PreapprovalCallDescription =
  | { kind: 'resolved'; call: PreapprovalResolvedCall }
  | { kind: 'unresolved'; op_id: string | null; reason: string; subtree: boolean };
export interface PreapprovalPreparationDeps {
  loadRecipe(recipeId: string, publisherId: string): PreapprovalRecipeSource | null;
  /** The mail service exposes a persisted draft as its trusted frozen send
   * recipe. No draft-save/send effect is performed by preparation. */
  loadDraft?(draftId: string, revision: number): PreapprovalRecipeSource | null;
  dispatch: Omit<DispatchResolveDeps, 'config'>;
  manifest(slug: string, version?: number): IngredientManifest | null;
  describe(input: {
    manifest: IngredientManifest; slug: string; input: Record<string, PreapprovalJson>;
    output: Record<string, string>;
    connection_name: string; catalog: boolean; origin: PreapprovalOrigin;
    recipe: PreparedRecipeSnapshot; path: PreapprovalInvocationPath;
  }): PreapprovalCallDescription;
}

const unresolved = (message: string): never => { throw new RpcError('preapproval_unresolved', message, 409); };
const jsonObject = (value: unknown): Record<string, PreapprovalJson> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unresolved('An operation input is not a concrete object.');
  return parsePreapprovalJson(value) as Record<string, PreapprovalJson>;
};
const runtimeRefs = (value: unknown): boolean => collectRefs(value).some(ref => ref.ns !== 'config' && ref.ns !== 'item');
const unresolvedRefs = (value: unknown, stores: NamespaceStores): boolean => runtimeRefs(value)
  || collectRefs(value).some(ref => resolveValue(`{{${ref.ns}${ref.path ? `.${ref.path}` : ''}}}`, stores) === undefined);
const isCatalog = (manifest: IngredientManifest): boolean => Object.keys(manifest.operations ?? {}).length > 0;

/** The same frozen program/config construction is used for reviewed recipes
 * and for ordinary nested continuations discovered later. This grants nothing. */
export const prepareRecipeSnapshot = (loaded: PreapprovalRecipeSource, requested: Record<string, unknown>,
  entryPath: PreapprovalInvocationPath, dispatchDeps: PreapprovalPreparationDeps['dispatch']): PreparedRecipeSnapshot => {
  if (entryPath.length > 60) return unresolved('The nested recipe graph exceeds its limit.');
  // Exchange delivery creates a separate post-run carrier and normal hold.
  // Until that carrier has a frozen continuation, it cannot escape this run's
  // reviewed lifecycle or be silently labelled part of complete coverage.
  if (loaded.definition.output.exchange) return unresolved('Post-run exchange delivery requires a frozen continuation before this recipe can be reviewed.');
  const config = mergeRecipeConfigLayers({ requested, install: loaded.install_config, bound_dish: loaded.bound_dish });
  for (const [key, value] of Object.entries(loaded.definition.variables)) {
    if (isPrototypeSensitiveKey(key)) return unresolved('A recipe variable uses an invalid name.');
    if (!Object.hasOwn(config, key)) {
      const defaultValue = extractVariableDefault(value);
      if (defaultValue !== undefined) config[key] = defaultValue;
    }
  }
  const effectiveConfig = jsonObject(config);
  const dispatch = resolveCanonicalRecipeForDispatch(loaded.definition, { ...dispatchDeps, config: effectiveConfig });
  if (!dispatch.ok) return unresolved(dispatch.reason);
  const definitionHash = preapprovalHash(parsePreapprovalJson(loaded.definition));
  return { invocation_path: [...entryPath, { kind: 'recipe', recipe_id: loaded.definition.recipe_id,
    publisher_id: loaded.publisher_id, definition_hash: definitionHash }],
    recipe_id: loaded.definition.recipe_id, publisher_id: loaded.publisher_id, definition_hash: definitionHash,
    dispatch_hash: preapprovalHash(parsePreapprovalJson(dispatch.recipe)),
    definition: structuredClone(dispatch.recipe), effective_config: effectiveConfig };
};

export const prepareFutureExecution = (input: {
  request: PreparePreapproval; origin: PreapprovalOrigin; target: PreapprovalTargetBinding;
}, deps: PreapprovalPreparationDeps): PreparedFutureExecution => {
  const request = parsePreparePreapproval(input.request);
  if (request.activation.kind !== input.target.kind) return unresolved('The activation does not match its resolved target.');
  const subject = request.subject;
  const source = subject.kind === 'recipe'
    ? deps.loadRecipe(subject.recipe_id, subject.publisher_id)
    : deps.loadDraft?.(subject.draft_id, subject.draft_revision);
  if (!source) return unresolved('The saved recipe or draft is unavailable.');
  if (subject.kind === 'recipe' && (source.publisher_id !== subject.publisher_id
    || source.definition.recipe_id !== subject.recipe_id)) return unresolved('The installed recipe identity changed.');
  const rootHash = preapprovalHash(parsePreapprovalJson(source.definition));
  const plan: PreparedFutureExecution = {
    schema_version: 1, request, origin: structuredClone(input.origin), target: structuredClone(input.target),
    recipe: { recipe_id: source.definition.recipe_id, publisher_id: source.publisher_id,
      display_name: source.definition.metadata.name, definition_hash: rootHash },
    recipe_snapshots: [], members: [], uncovered: [], dependencies: [], interaction_notes: [],
  };
  const pins = new Map<string, PreapprovalDependency>();
  let visitedSteps = 0;
  const limit = (): void => {
    if (plan.members.length + plan.uncovered.length > PREAPPROVAL_LIMITS.candidate_calls
      || visitedSteps > PREAPPROVAL_LIMITS.candidate_calls * 10) {
      throw new RpcError('preapproval_limit_exceeded', 'The execution has too many review candidates.', 400);
    }
  };
  const addDependencies = (dependencies: PreapprovalDependency[]): void => {
    for (const pin of dependencies) {
      const key = preapprovalHash([pin.kind, pin.key, pin.incarnation]);
      const prior = pins.get(key);
      if (prior && (prior.revision !== pin.revision || prior.content_hash !== pin.content_hash)) {
        return unresolved('A dependency changed during preparation.');
      }
      pins.set(key, { ...pin, until_phase: prior?.until_phase === 'terminal' ? 'terminal' : pin.until_phase });
    }
  };
  /** Record a call the owner cannot be asked about, WITH THE REMEDY.
   *
   *  🔑 EVERY REASON BELOW HAS ONE CAUSE: a value the recipe produces later.
   *  The review-time namespaces are `{ config, vault: {}, context: {}, meta: {},
   *  step: {} }` — `config` resolves and `step` is empty by construction — so a
   *  `{{step.find.0.id}}` argument is not "unknown", it is DEFERRED. The owner's
   *  ruling (2026-09-07) turns that into two paths and no third mechanism:
   *
   *    · **Single op** — the proposer designates the value, it arrives as
   *      config, the ref resolves, and the ordinary argument freeze covers the
   *      call. There is nothing to pin beyond the arguments themselves; an
   *      earlier draft of this area proposed an "entity id" primitive for
   *      exactly this case and it was inventing machinery for a call that is
   *      simply under-specified.
   *    · **Whole recipe** — the anchor is the DISH, and it is already pinned:
   *      `preapproval-recipe-sources.ts` pins the bound dish, its group
   *      overlay, and even the ABSENCE of a default dish, so material that
   *      changes after review invalidates it.
   *
   *  ⛔ A refusal that names only the failure leaves the proposer to guess, and
   *  the guess ("prepare again") is always wrong here — nothing changes on a
   *  retry. Each reason therefore says what to supply, or that the call falls
   *  through to the ordinary run-time gate. A recipe intended for single-op
   *  pre-approval has to expose its target as a variable; one that computes the
   *  target from an earlier step is telling you it is a whole-recipe decision.
   *  See D-261 § Authoring for single-op pre-approval. */
  const uncover = (path: PreapprovalInvocationPath, reason: string, opId: string | null = null, subtree = true): void => {
    plan.uncovered.push({ invocation_path: path, op_id: opId, reason, subtree }); limit();
  };
  const append = (description: PreapprovalResolvedCall, path: PreapprovalInvocationPath,
    parentId: string | null, condition: unknown, conditional: boolean, ancestors: Set<string>): PreparedInvocation => {
    limit();
    if (path.length > 64) return unresolved('The invocation graph is too deeply nested.');
    const material = description.material;
    const memberId = `pam_${randomUUID()}`;
    let reason = description.review.ineligible_reason;
    if (!description.child_inventory.complete) reason = description.child_inventory.reason;
    if (material.identity_version !== 1) reason = 'The dispatcher identity version is not supported.';
    // `always` / `destructive` are reviewable — see `isPreapprovalMemberEligible`.
    // A missing approval intent is not: nobody declared it, so nobody can
    // reason about it, and the owner is shown that rather than a guess.
    if (material.pre_lift_approval === null) reason ??= 'This operation declares no approval intent.';
    const base: Omit<PreparedInvocation, 'effect_hash' | 'review'> = {
      ...material, input: jsonObject(material.input), member_id: memberId, invocation_path: path,
      arguments_hash: preapprovalHash(material.input), condition_hash: preapprovalHash(condition),
      parent_member_id: parentId, required_child_ids: [], predecessor_member_ids: [],
    };
    const member: PreparedInvocation = { ...base, effect_hash: preapprovalEffectHash(base), review: {
      member_id: memberId, parent_member_id: parentId, required_child_ids: [], invocation_path: path,
      op_id: material.op_id, family: material.family, risk: material.risk, label: description.review.label,
      detail: description.review.detail, arguments: base.input, conditional, eligible: reason === null, reason,
      output: base.output, connection_id: base.connection_id, account_id: base.account_id, resources: base.resources,
    } };
    plan.members.push(member); limit(); addDependencies(description.dependencies);
    addDependencies(material.resources.map(pin => ({ ...pin, until_phase: 'terminal' })));
    const childSlots = new Set<string>();
    for (const child of description.children) {
      if (!child.slot || !Number.isSafeInteger(child.index) || child.index < 0
        || childSlots.has(`${child.slot}:${child.index}`)) return unresolved('The dispatcher described an invalid child occurrence.');
      childSlots.add(`${child.slot}:${child.index}`);
      const added = append(child.call, preapprovalChildPath(path, child.slot, child.index), memberId, condition, conditional, ancestors);
      const predecessor = member.required_child_ids.at(-1);
      if (!description.parallel_children && predecessor) added.predecessor_member_ids = [predecessor];
      member.required_child_ids.push(added.member_id);
    }
    if (description.nested_recipe) {
      const nested = description.nested_recipe;
      const nestedSource = deps.loadRecipe(nested.recipe_id, nested.publisher_id);
      if (!nestedSource || nestedSource.definition.recipe_id !== nested.recipe_id || nestedSource.publisher_id !== nested.publisher_id) {
        member.review.eligible = false; member.review.reason = 'The nested recipe is unavailable.';
        uncover(preapprovalChildPath(path, 'recipe', 0), member.review.reason);
      } else {
        const priorUncovered = plan.uncovered.length;
        const roots = visitRecipe(nestedSource, nested.config, preapprovalChildPath(path, 'recipe', 0), memberId, ancestors);
        member.required_child_ids.push(...roots);
        if (plan.uncovered.length !== priorUncovered) {
          member.review.eligible = false; member.review.reason = 'The nested recipe contains unresolved calls.';
        }
      }
    }
    member.review.required_child_ids = [...member.required_child_ids];
    return member;
  };
  const visitRecipe = (loaded: PreapprovalRecipeSource, requested: Record<string, unknown>,
    entryPath: PreapprovalInvocationPath, parentId: string | null, ancestors: Set<string>): string[] => {
    const sourceKey = preapprovalHash([loaded.publisher_id, loaded.definition.recipe_id]);
    if (ancestors.has(sourceKey)) return unresolved('The nested recipe graph contains a cycle.');
    if (entryPath.length > 60 || plan.recipe_snapshots.length >= PREAPPROVAL_LIMITS.candidate_calls) {
      return unresolved('The nested recipe graph exceeds its limit.');
    }
    const held = new Set([...ancestors, sourceKey]);
    const snapshot = prepareRecipeSnapshot(loaded, requested, entryPath, deps.dispatch);
    const path = snapshot.invocation_path;
    const effectiveConfig = snapshot.effective_config;
    plan.recipe_snapshots.push(snapshot); addDependencies(loaded.dependencies);
    const roots: string[] = [];
    const stores: NamespaceStores = { config: effectiveConfig, vault: {}, context: {}, meta: {}, step: {} };
    const visitStep = (step: Record<string, unknown>, phase: 'trigger' | 'prefetch' | 'sequential', iterations: number[]): void => {
      visitedSteps++; limit();
      if (typeof step.id !== 'string' || !step.id) return unresolved('A recipe step has no identity.');
      const stepPath = preapprovalStepPath(path, phase, step.id, iterations);
      const skip = step.skip_when as Parameters<typeof evaluateCondition>[0] | undefined;
      // Use the engine's condition evaluator. Dynamic conditions pin the
      // candidate but do not supply arguments or synthesize a prior result.
      const canEvaluateSkip = skip !== undefined && !runtimeRefs(skip)
        && !collectRefs(skip).some(ref => ref.ns === 'item' && stores.item === undefined);
      if (canEvaluateSkip && evaluateCondition(skip!, stores)) return;
      if (step.foreach !== undefined && step.foreach !== null) {
        if (unresolvedRefs(step.foreach, stores)) { uncover(stepPath, 'The loop inventory depends on a future value. Supply the list in the proposal config to review these calls; left as it is, each asks at run time.'); return; }
        const items = resolveValue(step.foreach, stores);
        if (!Array.isArray(items)) { uncover(stepPath, 'The loop inventory is not a frozen array. Supply a literal array in the proposal config — a list the recipe builds later cannot be enumerated now.'); return; }
        if (items.length > PREAPPROVAL_LIMITS.candidate_calls) return unresolved('The loop exceeds the review call limit.');
        const inner = { ...step }; delete inner.foreach;
        const previous = stores.item;
        try {
          for (let index = 0; index < items.length; index++) {
            stores.item = items[index]; visitStep(inner, phase, [...iterations, index]);
          }
        } finally { stores.item = previous; }
        return;
      }
      // Transforms and guards are not executed for a preview. Their outputs
      // remain unresolved; a later material step.* argument is uncovered.
      if (stepType(step) !== 'ingredient') return;
      if (unresolvedRefs(step.ingredient, stores)) { uncover(stepPath, 'The operation depends on a future value. Name the ingredient in the proposal config rather than deriving it from an earlier step.'); return; }
      const slug = typeof step.ingredient === 'string'
        ? String((isRef(step.ingredient) ? resolveValue(step.ingredient, stores) : step.ingredient) ?? '') : '';
      const manifest = deps.manifest(slug, typeof step.ingredient_version === 'number' ? step.ingredient_version : undefined);
      if (!manifest) { uncover(stepPath, 'The installed operation definition is unavailable. Install the pack that defines this operation, then prepare again.'); return; }
      const rawInput = step.input ?? {};
      if (unresolvedRefs(rawInput, stores)) { uncover(stepPath, 'The operation arguments depend on a future value. Designate them in the proposal config; a recipe that computes an argument from an earlier step cannot have that call reviewed on its own.'); return; }
      const supplied = typeof rawInput === 'string' && isRef(rawInput) ? resolveValue(rawInput, stores) : rawInput;
      const stepInput = jsonObject(supplied);
      const catalog = isCatalog(manifest);
      const merged = catalog ? stepInput : mergeManifestStepInput(manifest.input, stepInput, { trustedSurfaceDispatch: false });
      if (unresolvedRefs(merged, stores)) { uncover(stepPath, 'A material default depends on a live namespace. Pin the value in the proposal config — a live read can change between review and dispatch.'); return; }
      // Catalog operation selectors are static in the real runner. Only args
      // are interpolated; resolving the selector here would review another op.
      const resolvedInput = catalog
        ? { ...merged, ...(merged.args === undefined ? {} : { args: resolveDeep(merged.args, stores) }) }
        : resolveDeep(merged, stores);
      const rawConnection = step.connection ?? stepInput.connection;
      if (rawConnection !== undefined && unresolvedRefs(rawConnection, stores)) { uncover(stepPath, 'The connection is not fixed. Name one connection in the proposal config rather than deriving it from an earlier step.'); return; }
      const connection = rawConnection === undefined ? '' : resolveValue(rawConnection, stores);
      if (typeof connection !== 'string') { uncover(stepPath, 'The connection does not resolve to one named binding. Give the step a single named connection in the proposal config.'); return; }
      let concrete: Record<string, PreapprovalJson>;
      try { concrete = jsonObject(resolvedInput); } catch { uncover(stepPath, 'A required operation input has no frozen value. Supply it in the proposal config.'); return; }
      if (collectRefs(catalog ? { operation: concrete.operation ?? null, args: concrete.args ?? {} } : concrete).length > 0) {
        uncover(stepPath, 'A material input retains unresolved references. Supply the referenced values in the proposal config.'); return;
      }
      const output = mergeManifestStepOutput(manifest.output, step.output as Record<string, string> | undefined);
      const description = deps.describe({ manifest, slug, input: concrete, connection_name: connection,
        output, catalog, origin: plan.origin, recipe: snapshot, path: stepPath });
      if (description.kind === 'unresolved') {
        uncover(stepPath, description.reason, description.op_id, description.subtree); return;
      }
      const member = append({ ...description.call, material: { ...description.call.material, output } }, stepPath, parentId,
        { skip_when: skip ?? null, fail_on: step.fail_on ?? null }, skip !== undefined && !canEvaluateSkip, held);
      roots.push(member.member_id);
    };
    // Repeated watcher qualification is ordinary. The selected auto-run claims
    // after qualification and must never spend this group on polling itself.
    const triggerSteps = parentId !== null || request.activation.kind !== 'next_auto_run'
      ? snapshot.definition.trigger_steps ?? [] : [];
    for (const step of triggerSteps) visitStep(step as unknown as Record<string, unknown>, 'trigger', []);
    for (const step of snapshot.definition.prefetch_steps ?? []) visitStep(step as unknown as Record<string, unknown>, 'prefetch', []);
    for (const step of snapshot.definition.steps) visitStep(step as Record<string, unknown>, 'sequential', []);
    return roots;
  };
  visitRecipe(source, subject.kind === 'recipe' ? subject.config : {}, [], null, new Set());
  plan.dependencies = [...pins.values()];
  if (request.activation.kind === 'next_auto_run') plan.interaction_notes.push('Qualification checks keep their ordinary approval rules before this execution is selected.');
  validatePreparedFutureExecution(plan);
  return plan;
};
