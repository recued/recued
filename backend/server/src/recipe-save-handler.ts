/** Recipe-editor authoring seam — `recipe.save` + `recipe.validate` rpc.
 *
 *  The local-UI write half the future inline recipe editor calls: validate
 *  an inline-authored recipe (`recipe.validate`, never persists) and persist
 *  a valid one (`recipe.save`). Mirrors the MCP `recued_saveRecipe` tool
 *  EXACTLY — the same `parseRecipe` walk, the same op-step acceptance via the
 *  shared `checkInlineOpSteps` (D-182: an op-step recipe IS persisted — the
 *  dispatch path lowers + runs it; only a definitively-unrunnable op-step
 *  errors, and an uncovered Tier-P `depends_on` surfaces as a non-blocking
 *  `op_warnings`), and the same `recipeStore.save(..., 'inline')` persistence +
 *  run-time PII posture disclosure.
 *
 *  Owner-only / local-UI — NOT in `MCP_TOOL_CATALOG`. The whole `recipe.*`
 *  namespace is additionally ratchet-gated by the `recipe.` reserved prefix
 *  (`MCP_RESERVED_RPC_PREFIXES`), so authoring writes can never bridge onto
 *  the MCP-channel agent surface. Agents author recipes through the MCP
 *  `recued_saveRecipe` tool, which runs the identical validate + op-step
 *  acceptance logic; this seam is the Kitchen editor's path to the same store. */

import type {
  HandlerSlice,
  LocalRecipeWebhookDoorStatus,
  LocalRecipeWebhookStatus,
  RecipeDefinition,
  ServerRpcRegistry,
  WebhookIngressBindingSelection,
} from '@recued/contracts';
import {
  RpcError,
  evaluateFormFieldContract,
  formResponseTriggerFormScope,
  type FormFieldContractFormView,
} from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';
import { assessRecipePiiPosture } from './auto-pii-apply.js';
import { checkFormContract } from './form-contract-gate.js';
import { checkInlineOpSteps } from './op-step-save-check.js';
import { deriveResolvedRecipeCapability } from './derive-recipe-capability.js';
import {
  D201_WEBHOOK_RUNTIME_UNAVAILABLE,
  hasNonEmptyWebhookDeclarations,
} from './webhook-declaration-gate.js';
import type { RecipeStore } from './recipe-store.js';
import { RecipePackOwnershipError } from './recipe-store.js';
import {
  describeWebhookDoorRefusal,
  reconcileWebhookDoors,
  type WebhookDoorEnrollDeps,
  type WebhookDoorOutcome,
} from './webhook-door-enroll.js';
import {
  WebhookConsumerStoreError,
  type WebhookConsumerSnapshot,
  type WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import type { WsClient } from './ws-server.js';

export interface RecipeSaveHandlerDeps {
  store: RecipeStore;
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-209 #1 W2b — the webhook DOOR substrate: mints the derived
   *  `contract.anonymous` door a webhook recipe's dispatches run under, after
   *  the cross-store save succeeds. Absent (partial harnesses) ⇒ no door is
   *  minted and no door state is surfaced — dispatch stays fail-closed. */
  webhookDoor?: WebhookDoorEnrollDeps;
  /** D-220 Slice A2b — resolve a `form_definition_id` to the LIVE intake form's
   *  field set, or null when no live form claims it.
   *
   *  `recipe.save` is where a reactive `form_response.accepted` trigger is
   *  ARMED, and arming is the act this gate belongs on: the owner is present,
   *  and refusing costs them an uncompleted save rather than disarming a trigger
   *  that already works. (That was the open question when this check was
   *  imagined at the reconciler instead — a reconciler runs at boot with no owner
   *  and existing state, where disarming is destructive and ignoring is silent.
   *  Gating the act sidesteps it entirely.)
   *
   *  Absent ⇒ the check is SKIPPED. There is no form set to compare against, so
   *  there is nothing to fail closed about; and the companion gate on
   *  `reception.endpoint.create` (A2c) still refuses a form that breaks an armed
   *  recipe, so the ring stays closed from the other side. */
  formDefinitionReader?: (form_definition_id: string) => FormFieldContractFormView | null;
}

const webhookStoreError = (method: string, error: unknown): RpcError => {
  if (!(error instanceof WebhookConsumerStoreError)) {
    return new RpcError('internal_error', `${method}: webhook binding storage failed`, 500);
  }
  if (error.code === 'invalid') {
    return new RpcError('bad_request', `${method}: ${error.message}`, 400);
  }
  if (error.code === 'not_found') {
    return new RpcError('not_found', `${method}: ${error.message}`, 404);
  }
  if (error.code === 'not_ready'
    || error.code === 'cleanup_required'
    || error.code === 'conflict') {
    return new RpcError('webhook_not_ready', `${method}: ${error.message}`, 409);
  }
  return new RpcError('internal_error', `${method}: webhook binding storage is unavailable`, 500);
};

/** The publisher the recipe's trigger rows were written under. `recipe.save`
 *  stamps `publisher_id ?? 'kitchen'` on both the stored row and the trigger
 *  rows, so the stored row is the authoritative read-back. */
const storedPublisher = (deps: RecipeSaveHandlerDeps, recipeId: string): string =>
  deps.store.getStored(recipeId)?.publisher_id || 'kitchen';

/** D-209 #1 W2b — map a save-time enrollment outcome onto the wire shape. */
const doorStatusFromOutcome = (
  outcome: WebhookDoorOutcome,
): LocalRecipeWebhookDoorStatus => {
  if (outcome.kind === 'minted') {
    return {
      state: 'minted',
      contract_id: outcome.contract_id,
      operation_ids: [...outcome.operation_ids],
      added: [...outcome.added],
      removed: [...outcome.removed],
    };
  }
  if (outcome.kind === 'refused') {
    return {
      state: 'refused',
      refusal: {
        reason: outcome.refusal.reason,
        step_id: outcome.refusal.step_id,
        detail: describeWebhookDoorRefusal(outcome.refusal),
      },
    };
  }
  // A store fault after the save committed — same fail-closed posture as a
  // crash in the mint window; the remedy is the same re-save.
  return { state: 'missing' };
};

/** D-209 #1 W2b — the door's CURRENT state, recomputed from stores (the
 *  status / arm / disarm read path; the save path prefers the enrollment
 *  outcome it just produced, which additionally carries the diff). */
const localWebhookDoorStatus = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
): LocalRecipeWebhookDoorStatus => {
  const door = deps.webhookDoor!;
  const config = door.resolveConfig(recipe.recipe_id);
  const dispatchRecipe = door.resolveDoorRecipe?.(recipe, config ?? {})
    ?? { ok: true as const, recipe };
  if (!dispatchRecipe.ok) {
    return {
      state: 'refused',
      refusal: {
        reason: 'dispatch_unresolvable',
        step_id: '<recipe>',
        detail: dispatchRecipe.reason,
      },
    };
  }
  const resolveOp = dispatchRecipe.resolveOp ?? door.resolveOp;
  const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
    ...(config === undefined ? {} : { config }),
    ...(resolveOp === undefined ? {} : { resolveOp }),
  });
  if (!derived.ok) {
    return {
      state: 'refused',
      refusal: {
        reason: derived.refusal.reason,
        step_id: derived.refusal.step_id,
        detail: describeWebhookDoorRefusal(derived.refusal),
      },
    };
  }
  const contractId = door.consumerStore.doorContractIdForRecipe(
    'local_recipe',
    recipe.recipe_id,
    recipe.recipe_id,
    storedPublisher(deps, recipe.recipe_id),
  );
  const def = contractId === null ? null : door.definitionStore.get(contractId);
  if (contractId === null || def === null
    || (def.revoked_at !== undefined && def.revoked_at !== null)) {
    return { state: 'missing' };
  }
  return {
    state: 'minted',
    contract_id: contractId,
    operation_ids: [...(def.scope?.operation_ids ?? [])],
  };
};

const localWebhookStatus = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
  /** The save path passes the enrollment outcome it just produced so the
   *  response carries the capability diff; read paths recompute from stores. */
  doorOutcome?: WebhookDoorOutcome,
): LocalRecipeWebhookStatus => {
  const declared = hasNonEmptyWebhookDeclarations(recipe);
  const requirements = recipe.webhook_requirements ?? [];
  const rows = deps.webhookConsumerStore?.listBindings({
    consumer_kind: 'local_recipe',
    consumer_id: recipe.recipe_id,
  }) ?? [];
  const expected = new Set(requirements.map((requirement) => requirement.binding));
  const configured = declared
    && requirements.length > 0
    && rows.length === expected.size
    && rows.every((row) => expected.has(row.logical_binding));
  const door = declared && deps.webhookDoor !== undefined
    ? doorOutcome !== undefined
      ? doorStatusFromOutcome(doorOutcome)
      : localWebhookDoorStatus(deps, recipe)
    : undefined;
  return {
    declared,
    configured,
    armed: configured
      && (recipe.webhook_triggers?.length ?? 0) > 0
      && (deps.webhookConsumerStore?.isConsumerEnabled(
        'local_recipe',
        recipe.recipe_id,
      ) ?? false),
    bindings: rows.map((row) => ({
      binding: row.logical_binding,
      ingress_id: row.ingress_id,
    })),
    ...(door !== undefined ? { door } : {}),
  };
};

const requireLocalRecipe = (
  deps: RecipeSaveHandlerDeps,
  method: string,
  recipeId: unknown,
  requireLocalAuthority = true,
): RecipeDefinition => {
  if (typeof recipeId !== 'string'
    || recipeId.length === 0
    || recipeId.length > 256
    || /[\u0000-\u001f\u007f]/.test(recipeId)) {
    throw new RpcError('bad_request', `${method}: recipe_id has invalid shape`, 400);
  }
  const recipe = deps.store.get(recipeId);
  if (!recipe) {
    throw new RpcError('not_found', `${method}: recipe not found`, 404);
  }
  if (!requireLocalAuthority) return recipe;
  const stored = deps.store.getStored(recipeId);
  if (!stored) {
    throw new RpcError(
      'invalid_state',
      `${method}: save the bundled recipe locally before arming webhook authority`,
      409,
    );
  }
  if (stored.pack_slug != null) {
    throw new RpcError(
      'invalid_state',
      `${method}: pack-owned webhook authority is managed by pack installation`,
      409,
    );
  }
  return recipe;
};

/** Validate without persisting. Never throws — the editor renders the issue
 *  list inline as the author types. `ok` is true iff the recipe parses with
 *  no error-severity issues (warn / info are non-blocking, same as the
 *  validator). D-182: op-step recipes are accepted; `checkInlineOpSteps` adds
 *  the two checks `parseRecipe` can't make (an unregistered closed-kind kernel
 *  op → error; an uncovered Tier-P `depends_on` → warn), surfaced as issues so
 *  the editor renders them live. */
export const validateRecipeInline = (
  recipe: RecipeDefinition,
): { ok: boolean; issues: Array<{ path?: string; message: string; severity: string }> } => {
  const parsed = parseRecipe(recipe);
  const issues = parsed.issues.map((i) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
  }));
  const opCheck = checkInlineOpSteps(recipe);
  for (const message of opCheck.errors) issues.push({ path: '', message, severity: 'error' });
  for (const message of opCheck.warnings) issues.push({ path: '', message, severity: 'warn' });
  const ok = parsed.ok && !issues.some((i) => i.severity === 'error');
  return { ok, issues };
};

/** Validate + persist an inline-authored recipe. Throws `RpcError`
 *  (`bad_request` / 400) on a validation failure or an inline op-step. */
/** D-220 Slice A2b — the first armed-trigger/form contradiction, as an
 *  owner-facing sentence, or null when there is none.
 *
 *  `this_form` AND `this_form_filtered` are both checked.
 *
 *  ⚠ The filtered case was originally exempted on the reasoning that an extra
 *  filter "may never fire on that form". That was WRONG, and adversarial review
 *  (Codex, 2026-07-29) showed why: a runtime accepted-response event carries BOTH
 *  `endpoint_id` and `form_definition_id` (`form-response-events.ts:46`), and the
 *  trigger compiler turns a `where` into exact equality filters — so a trigger
 *  naming this form plus its live endpoint fires with CERTAINTY, not
 *  contingently. An extra filter narrows which responses match; it does not
 *  exempt the contract from holding for the ones that do.
 *
 *  `all_forms` remains unchecked here: resolving it would mean comparing the
 *  contract against every live form, which needs a list-all reader this dep does
 *  not have. It is reported by the `preview_draft` advisory instead. */
export const saveRecipeInline = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
  publisher_id?: string,
  webhookBindings?: readonly WebhookIngressBindingSelection[],
): {
  saved: true;
  recipe_id: string;
  version: number;
  name: string;
  /** D-182 — non-blocking op-step advisories (an uncovered Tier-P `depends_on`).
   *  Present only when there is something to surface; the recipe still saved. */
  op_warnings?: string[];
  pii?: {
    headline?: string;
    auto_protected?: string[];
    warnings?: string[];
    infos?: string[];
  };
  webhook?: LocalRecipeWebhookStatus;
} => {
  // Validate against the recipe schema before accepting — reject on any
  // error-severity issue (warn / info are non-blocking).
  const parsed = parseRecipe(recipe);
  if (!parsed.ok || parsed.issues.some((i) => i.severity === 'error')) {
    const errs = parsed.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.path !== '' ? i.path : '<root>'}: ${i.message}`);
    throw new RpcError('bad_request', `Recipe validation failed:\n${errs.join('\n')}`, 400);
  }

  // D-182 — op-step recipes ARE accepted inline (the dispatch path lowers + runs
  // them: kernel ops self-contained, Tier-P against the installed-pack universe,
  // CRM ops once a connection slot binds at run). The only definitively-
  // unrunnable case is an unregistered closed-kind kernel op — reject exactly
  // that; an uncovered Tier-P `depends_on` is a non-blocking advisory.
  const opCheck = checkInlineOpSteps(recipe);
  if (opCheck.errors.length > 0) {
    throw new RpcError(
      'bad_request',
      `Recipe op-step validation failed:\n${opCheck.errors.join('\n')}`,
      400,
    );
  }

  // ── D-220 Slice A2b — does the form this recipe ARMS onto carry its answers? ──
  //
  // A recipe reads named answers by STATIC path (`record.values.<name>`), so
  // arming it onto a form that spells a required field differently makes that
  // read resolve `undefined`, a `default` transform cover for it, and every
  // accepted submission "succeed" having stored nothing.
  //
  // Refuse HERE, at the arming act, where the owner is standing — not at fire,
  // where only a visitor is.
  //
  // ⚠ A trigger naming a form that does NOT exist yet is fine: authoring the
  // recipe before creating the form is a legitimate order, and A2c gates the
  // form when it arrives. Only a LIVE form can contradict the declaration.
  // D-220 — ONE implementation, shared with the MCP save path. See
  // `form-contract-gate.ts` for why it is not a private helper here.
  const formContract = checkFormContract(deps.formDefinitionReader, recipe, 'recipe.save');
  if (formContract.kind === 'unverified') {
    throw new RpcError('form_contract_unverified', formContract.message, 503);
  }
  if (formContract.kind === 'unsatisfied') {
    throw new RpcError('form_contract_unsatisfied', formContract.message, 409);
  }

  const publisher = publisher_id ?? 'kitchen';
  const hasWebhook = hasNonEmptyWebhookDeclarations(recipe);
  const existingStored = deps.store.getStored(recipe.recipe_id);
  const existingRecipe = deps.store.get(recipe.recipe_id);
  if (existingStored?.pack_slug != null
    && existingRecipe !== null
    && hasNonEmptyWebhookDeclarations(existingRecipe)) {
    throw new RpcError(
      'invalid_state',
      'recipe.save: change recipe_id to fork this pack-owned webhook recipe before saving',
      409,
    );
  }
  if (!hasWebhook && webhookBindings !== undefined && webhookBindings.length > 0) {
    throw new RpcError(
      'bad_request',
      'recipe.save: webhook_bindings require webhook declarations',
      400,
    );
  }
  if (hasWebhook && (!deps.webhookConsumerStore || webhookBindings === undefined)) {
    throw new RpcError('bad_request', D201_WEBHOOK_RUNTIME_UNAVAILABLE, 400);
  }

  let priorWebhook: WebhookConsumerSnapshot | null = null;
  if (deps.webhookConsumerStore) {
    try {
      const hasExistingAuthority = deps.webhookConsumerStore.listBindings({
        consumer_kind: 'local_recipe',
        consumer_id: recipe.recipe_id,
      }).length > 0;
      if (hasWebhook || hasExistingAuthority) {
        // Empty replacement is the declaration-removal path. Unlike an
        // immediate remove it keeps prior claims detached (not cancelled)
        // until the recipe row succeeds, so a failed cross-store save can
        // restore the complete previous authority window. Ordinary recipes
        // with no prior authority never enter the webhook clock/DB mutation.
        priorWebhook = deps.webhookConsumerStore.replaceConsumer({
          consumer_kind: 'local_recipe',
          consumer_id: recipe.recipe_id,
          requirements: hasWebhook ? recipe.webhook_requirements ?? [] : [],
          selections: hasWebhook ? webhookBindings ?? [] : [],
          recipes: hasWebhook
            ? [{
                recipe_id: recipe.recipe_id,
                publisher_id: publisher,
                webhook_triggers: recipe.webhook_triggers ?? [],
              }]
            : [],
          enabled: false,
        });
      }
    } catch (error) {
      throw webhookStoreError('recipe.save', error);
    }
  }

  try {
    deps.store.save(recipe, publisher, 'inline');
  } catch (error) {
    if (priorWebhook && deps.webhookConsumerStore) {
      try {
        deps.webhookConsumerStore.restoreConsumer(priorWebhook);
      } catch {
        throw new RpcError(
          'internal_error',
          'recipe.save: recipe persistence failed and webhook authority rollback failed',
          500,
        );
      }
    }
    // D-247 D6 — the store's pack-ownership refusal is a legitimate 409, not an
    // internal error. Rethrowing it raw surfaces "something broke" to an owner
    // whose actual problem is "fork it first", which is a refusal nobody can act
    // on. Mapped AFTER the rollback above so the webhook authority is restored
    // either way.
    if (error instanceof RecipePackOwnershipError) {
      throw new RpcError('invalid_state', `recipe.save: ${error.message}`, 409);
    }
    throw error;
  }
  if (priorWebhook && deps.webhookConsumerStore) {
    try {
      // The binding store deliberately leaves prior claims detached until the
      // recipe row commits, so a failed save can restore them exactly. Once the
      // cross-store save succeeds, cancel that superseded work and release its
      // decoded-payload retention pins.
      deps.webhookConsumerStore.finalizeConsumerReplacement(priorWebhook);
    } catch (error) {
      throw webhookStoreError('recipe.save', error);
    }
  }

  // D-209 #1 W2b — the DOOR. Strictly after the cross-store save committed:
  // a mint placed inside/before `replaceConsumer` would leak an orphan live
  // door when the save fails and rolls back. Never blocks the save (drafts
  // save; a refused/failed door leaves the trigger rows NULL-stamped, which
  // denies at dispatch and reads as "door missing — re-save" in status).
  let doorOutcome: WebhookDoorOutcome | undefined;
  if (deps.webhookDoor !== undefined && priorWebhook !== null) {
    try {
      doorOutcome = reconcileWebhookDoors(
        {
          consumer_kind: 'local_recipe',
          consumer_id: recipe.recipe_id,
          prior: priorWebhook,
          // The declaration-removal path (a save that DROPPED the webhook
          // block) enrolls nothing — every prior door just retires.
          recipes: hasWebhook
            ? [{ recipe_id: recipe.recipe_id, publisher_id: publisher, recipe }]
            : [],
          // The save rpc is owner-only local UI (the `recipe.` reserved
          // prefix keeps it off MCP), so the minting authority is the owner.
          mintedBy: 'user_self',
          retireReason: hasWebhook ? 'resaved' : 'webhook_declarations_removed',
        },
        deps.webhookDoor,
      ).get(recipe.recipe_id);
    } catch (error) {
      doorOutcome = {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // § 7 surfacing — disclose the saved recipe's run-time PII posture so the
  // editor learns it at the save boundary (which AI steps Recued
  // auto-protects vs which still leak identifiers). Fail-safe (never blocks
  // the save result); omitted when there is nothing to disclose.
  const pii = assessRecipePiiPosture(recipe);
  return {
    saved: true,
    recipe_id: recipe.recipe_id,
    version: recipe.version ?? 1,
    name: recipe.metadata?.name ?? recipe.recipe_id,
    ...(opCheck.warnings.length > 0 ? { op_warnings: opCheck.warnings } : {}),
    ...(pii !== null
      ? {
          pii: {
            ...(pii.headline !== '' ? { headline: pii.headline } : {}),
            ...(pii.auto_protected.length > 0
              ? { auto_protected: pii.auto_protected.map((l) => l.message) }
              : {}),
            ...(pii.warnings.length > 0
              ? { warnings: pii.warnings.map((l) => l.message) }
              : {}),
            ...(pii.infos.length > 0 ? { infos: pii.infos.map((l) => l.message) } : {}),
          },
        }
      : {}),
    ...(hasWebhook ? { webhook: localWebhookStatus(deps, recipe, doorOutcome) } : {}),
  };
};

export const handleLocalRecipeWebhookStatus = (
  deps: RecipeSaveHandlerDeps,
  args: { recipe_id: string },
): { webhook: LocalRecipeWebhookStatus } => {
  const method = 'recipe.webhook.status';
  const recipe = requireLocalRecipe(deps, method, args?.recipe_id, false);
  return { webhook: localWebhookStatus(deps, recipe) };
};

const setLocalRecipeWebhookArmed = (
  deps: RecipeSaveHandlerDeps,
  method: 'recipe.webhook.arm' | 'recipe.webhook.disarm',
  args: { recipe_id: string },
  armed: boolean,
): { webhook: LocalRecipeWebhookStatus } => {
  const recipe = requireLocalRecipe(deps, method, args?.recipe_id);
  if (!deps.webhookConsumerStore) {
    throw new RpcError('not_configured', `${method}: webhook consumer store unavailable`, 501);
  }
  const status = localWebhookStatus(deps, recipe);
  if (!status.declared || !status.configured) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: save exact owner-selected ingress bindings first`,
      409,
    );
  }
  if (armed && (recipe.webhook_triggers?.length ?? 0) === 0) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: recipe has no webhook trigger declarations to arm`,
      409,
    );
  }
  // D-209 #1 W2b — arming is the consent gesture, so it must not produce a
  // webhook that LOOKS live but denies every dispatch at the contract floor.
  // A missing/revoked door (a crash in the save's mint window, or a recipe
  // saved before the door substrate existed) refuses with the remedy.
  if (armed && deps.webhookDoor !== undefined) {
    const contractId = deps.webhookDoor.consumerStore.doorContractIdForRecipe(
      'local_recipe',
      recipe.recipe_id,
      recipe.recipe_id,
      storedPublisher(deps, recipe.recipe_id),
    );
    const def = contractId === null
      ? null
      : deps.webhookDoor.definitionStore.get(contractId);
    if (def === null || (def.revoked_at !== undefined && def.revoked_at !== null)) {
      throw new RpcError(
        'webhook_not_ready',
        `${method}: webhook door contract missing — re-save the recipe to mint it`,
        409,
      );
    }
  }
  try {
    deps.webhookConsumerStore.setConsumerEnabled(
      'local_recipe',
      recipe.recipe_id,
      armed,
    );
  } catch (error) {
    throw webhookStoreError(method, error);
  }
  return { webhook: localWebhookStatus(deps, recipe) };
};

export const handleLocalRecipeWebhookArm = (
  deps: RecipeSaveHandlerDeps,
  args: { recipe_id: string },
): { webhook: LocalRecipeWebhookStatus } =>
  setLocalRecipeWebhookArmed(deps, 'recipe.webhook.arm', args, true);

export const handleLocalRecipeWebhookDisarm = (
  deps: RecipeSaveHandlerDeps,
  args: { recipe_id: string },
): { webhook: LocalRecipeWebhookStatus } =>
  setLocalRecipeWebhookArmed(deps, 'recipe.webhook.disarm', args, false);

export type RecipeSaveMethods =
  | 'recipe.save'
  | 'recipe.validate'
  | 'recipe.webhook.status'
  | 'recipe.webhook.arm'
  | 'recipe.webhook.disarm';

export const makeRecipeSaveHandlers = (
  deps: RecipeSaveHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipeSaveMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'recipe.save',
      'recipe.validate',
      'recipe.webhook.status',
      'recipe.webhook.arm',
      'recipe.webhook.disarm',
    ],
    handlers: {
      'recipe.save': async (req) => saveRecipeInline(
        deps,
        req.recipe,
        req.publisher_id,
        req.webhook_bindings,
      ),
      'recipe.validate': async (req) => validateRecipeInline(req.recipe),
      'recipe.webhook.status': async (req) =>
        handleLocalRecipeWebhookStatus(deps, req),
      'recipe.webhook.arm': async (req) => handleLocalRecipeWebhookArm(deps, req),
      'recipe.webhook.disarm': async (req) =>
        handleLocalRecipeWebhookDisarm(deps, req),
    },
  };
};
