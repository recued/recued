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
  LocalRecipeWebhookDoorPreview,
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
import { createHash } from 'node:crypto';
import { canonicalJsonString, parseRecipe } from '@recued/recipes';
import { closedByOwner, doorCapabilityChanged } from './mint-door-contract.js';
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
  currentRecipeDoorId,
  deriveWebhookDoorCapability,
  describeWebhookDoorRefusal,
  followMainDishWebhookDoors,
  ownerDoorClosing,
  ownerLeftDoorClosed,
  reconcileWebhookDoors,
  type WebhookDoorEnrollDeps,
  type WebhookDoorOutcome,
} from './webhook-door-enroll.js';
import {
  recipeRowStamp,
  WebhookConsumerStoreError,
  type WebhookConsumerSnapshot,
  type WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import type { WsClient } from './ws-server.js';
import { recipeRemainsStored } from './webhook-replacement-finish.js';
import { RecordsNonOwnerExposureError } from './records/non-owner-exposure.js';

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

/** D-201 Slice 10S (10Q finding 10) — the draft as the keep-on consent covers
 *  it: SHA-256 over its canonical form. 10M took the recipe's 32-bit cache
 *  hash (`hashRecipe`, FNV-1a), whose own comment says to use SHA-256 for
 *  integrity: two drafts differing only in description shared a consent. */
const draftDigest = (recipe: RecipeDefinition): string =>
  createHash('sha256').update(canonicalJsonString(recipe)).digest('hex');

/** The publisher the recipe's trigger rows were written under. `recipe.save`
 *  stamps `publisher_id ?? 'kitchen'` on both the stored row and the trigger
 *  rows, so the stored row is the authoritative read-back. */
const storedPublisher = (deps: RecipeSaveHandlerDeps, recipeId: string): string =>
  deps.store.getStored(recipeId)?.publisher_id || 'kitchen';

/** D-209 #1 W2b — map a save-time enrollment outcome onto the wire shape.
 *  Exported for its test (D-201 Slice 10AX): a door kept closed is its owner's. */
export const doorStatusFromOutcome = (
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
  // D-201 Slice 10AF (10AE finding 16) — a door its owner closed, kept closed:
  // as the status call reads it. It read as missing.
  // D-201 Slice 10AX (10AS finding 13) — its owner's, as the card says.
  if (outcome.kind === 'kept_revoked') return { ...CLOSED_DOOR, closed_by_owner: true };
  // A store fault after the save committed — same fail-closed posture as a
  // crash in the mint window; the remedy is the same re-save.
  return { state: 'missing' };
};

/** D-201 Slice 10AF (10AE finding 16) — a closed door, as `missing` with
 *  `closed`: a Kitchen before 10AC reads an unknown `state` as an open door
 *  ("Anything let through from now on can start this Recipe"), and `missing`
 *  as one that lets nothing through, which a closed door is. */
const CLOSED_DOOR: LocalRecipeWebhookDoorStatus = Object.freeze({ state: 'missing', closed: true }) as LocalRecipeWebhookDoorStatus;

/** D-209 #1 W2b — the door's CURRENT state, recomputed from stores (the
 *  status / arm / disarm read path; the save path prefers the enrollment
 *  outcome it just produced, which additionally carries the diff). */
const localWebhookDoorStatus = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
): LocalRecipeWebhookDoorStatus => {
  const door = deps.webhookDoor!;
  const publisher = storedPublisher(deps, recipe.recipe_id);
  const contractId = door.consumerStore.doorContractIdForRecipe(
    'local_recipe',
    recipe.recipe_id,
    recipe.recipe_id,
    publisher,
  );
  // D-201 Slice 10AX (10AS finding 13) — its owner's closing, read as the card
  // reads it, said beside a refusal too: a version that cannot have a door,
  // under its owner's closing, read "refused" here and "you closed it" there.
  const closing = ownerDoorClosing(door, 'local_recipe', recipe.recipe_id, recipe.recipe_id, publisher);
  const ownerFacts = closing === null ? {} : {
    closed_by_owner: true as const,
    ...(contractId === null ? { no_door: true as const } : {}),
    ...(closing === 'answer' ? { no_door_yet: true as const } : {}),
  };
  // D-201 Slice 10AF (10AE finding 15) — a recipe its exposure check refuses
  // cannot have a door as it stands, as the card says (`refused`). It read as
  // missing, and Kitchen's switch was offered and failed `webhook_not_ready`.
  try {
    door.preflightNonOwnerRecipeExposure?.(recipe, 'webhook');
  } catch (error) {
    if (error instanceof RecordsNonOwnerExposureError) {
      return {
        state: 'refused',
        refusal: { reason: 'exposure_refused', step_id: '<recipe>', detail: error.message },
        ...ownerFacts,
      };
    }
    throw error;
  }
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
      ...ownerFacts,
    };
  }
  const resolveOp = dispatchRecipe.resolveOp ?? door.resolveOp;
  // D-320 phase 3 (3b) — the config the run will resolve connections against,
  // each slot's empty setting filled as the run fills it (`settleDoorConnections`).
  const doorConfig = 'config' in dispatchRecipe && dispatchRecipe.config !== undefined
    ? dispatchRecipe.config
    : config;
  const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
    ...(doorConfig === undefined ? {} : { config: doorConfig }),
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
      ...ownerFacts,
    };
  }
  // D-201 Slice 10AO (10AM finding 13) — rows that carry no door read as the
  // card and Kitchen's question read them (`ownerLeftDoorClosed`): closed when
  // the owner closed the door the recipe had last, or kept their closing for a
  // door not made yet. It read the rows only, and said "missing" where the
  // card said closed and the question refused `door_revoked`.
  // D-201 Slice 10AX (10AS finding 13) — and which: no door now (`no_door`),
  // closed before one was made (`no_door_yet`), as the card says. "The door
  // behind this webhook is closed" read here where the card said there was none.
  if (contractId === null) {
    return closing !== null ? { ...CLOSED_DOOR, ...ownerFacts } : { state: 'missing' };
  }
  const def = door.definitionStore.get(contractId);
  if (def === null) return { state: 'missing' };
  // D-201 Slice 10AC (10AA finding 9) — closed, which Kitchen's switch opens
  // again, as the card's "Open its door" does. It read as missing, and Kitchen
  // offered no switch, telling the owner to save again.
  // D-201 Slice 10AX (10AS finding 13) — whose closing, as the card says.
  if (def.revoked_at !== undefined && def.revoked_at !== null) {
    return closedByOwner(def) ? { ...CLOSED_DOOR, closed_by_owner: true } : CLOSED_DOOR;
  }
  return {
    state: 'minted',
    contract_id: contractId,
    operation_ids: [...(def.scope?.operation_ids ?? [])],
  };
};

/** D-201 Slice 10AJ (10AI finding 2) — whether a save switched off keeps the
 *  door its triggers carry, as its door step decides it: that door is open, the
 *  exposure check passes, and this version derives the same door, so the step
 *  reuses it with the owner's switch-offs (D-201 Slice 10S). Any doubt reads as
 *  a new door, which starts clean. */
const webhookSaveKeepsItsDoor = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
  publisher: string,
): boolean => {
  const door = deps.webhookDoor;
  if (door === undefined) return false;
  try {
    const currentId = door.consumerStore.doorContractIdForRecipe(
      'local_recipe',
      recipe.recipe_id,
      recipe.recipe_id,
      publisher,
    );
    const current = currentId === null ? null : door.definitionStore.get(currentId);
    if (current === null || (current.revoked_at !== undefined && current.revoked_at !== null)) return false;
    door.preflightNonOwnerRecipeExposure?.(recipe, 'webhook');
    const derived = deriveWebhookDoorCapability({ recipe_id: recipe.recipe_id, recipe }, door);
    return derived.ok && !doorCapabilityChanged(current, derived.capability).changed;
  } catch {
    return false;
  }
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
  const status = declared && deps.webhookDoor !== undefined
    ? doorOutcome !== undefined
      ? doorStatusFromOutcome(doorOutcome)
      : localWebhookDoorStatus(deps, recipe)
    : undefined;
  // D-201 Slice 10S (10Q finding 12) — what the owner switched off on it, which
  // the switch-on list must not show as let through.
  // D-201 Slice 10Y (10V finding 20) — only an operation the door has: a
  // switch-off carried onto a door without it (it stays, should a later
  // version take it back) is not one of this door's. And one it took back is
  // not listed as added: it stays off, so the save did not change that.
  const doorOperations = new Set(status?.operation_ids ?? []);
  const switchedOff = status?.state === 'minted' && status.contract_id !== undefined
    ? deps.webhookDoor!.grantEntryStore.listForContract(status.contract_id)
      .filter((row) => row.granted === false && doorOperations.has(row.entry_key))
      .map((row) => row.entry_key)
      .sort()
    : [];
  const door = status !== undefined && switchedOff.length > 0
    ? {
        ...status,
        switched_off: switchedOff,
        ...(status.added !== undefined
          ? { added: status.added.filter((entry) => !switchedOff.includes(entry)) }
          : {}),
      }
    : status;
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

/** Shared authoring admission for ordinary saves and reviewed releases. Runs
 * schema, op-step and live form-contract checks without persisting a recipe;
 * returns non-blocking op warnings for the caller to disclose. */
export const assertRecipeAuthoringGates = (deps: Pick<RecipeSaveHandlerDeps,'formDefinitionReader'>, recipe: RecipeDefinition, caller = 'recipe.save'): string[] => {
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
  const formContract = checkFormContract(deps.formDefinitionReader, recipe, caller);
  if (formContract.kind === 'unverified') {
    throw new RpcError('form_contract_unverified', formContract.message, 503);
  }
  if (formContract.kind === 'unsatisfied') {
    throw new RpcError('form_contract_unsatisfied', formContract.message, 409);
  }

  return opCheck.warnings;
};

/** Validate and persist an inline-authored recipe through the ordinary store. */
export const saveRecipeInline = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
  publisher_id?: string,
  webhookBindings?: readonly WebhookIngressBindingSelection[],
  /** D-201 Slice 10I — the owner's answer to the save's question. */
  webhookOn?: boolean,
  /** D-201 Slice 10M — the `consent` of the question answered. */
  webhookConsent?: string,
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
  // D-201 Slice 10M — the draft as the client sent it: the gates below
  // normalize it in place, and the keep-on question hashed it as sent.
  const receivedHash = webhookOn === true ? draftDigest(recipe) : undefined;
  const opWarnings = assertRecipeAuthoringGates(deps,recipe);

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
  // D-201 Slice 10I — "save and keep its webhook on": the owner answered the
  // save's question, which is the consent switching it on gives, for exactly
  // the version being saved. Every check switching it on makes, made before
  // anything changes: a recipe that cannot be on refuses here, not halfway.
  const keepOn = webhookOn === true;
  if (keepOn) {
    if (!hasWebhook || (recipe.webhook_triggers?.length ?? 0) === 0) {
      throw new RpcError(
        'webhook_not_ready',
        'recipe.save: only a recipe with a webhook trigger can keep its webhook on',
        409,
      );
    }
    // D-201 Slice 10S (10Q finding 5) — the question was asked of the door and
    // history under the publisher the recipe was saved with, and a save acts
    // under the one it names: keeping it on keeps that publisher. No client
    // names another; a caller that does saves with the webhook switched off.
    if (existingStored !== null && (existingStored.publisher_id || 'kitchen') !== publisher) {
      throw new RpcError(
        'webhook_not_ready',
        `recipe.save: keeping its webhook on keeps the publisher it was saved under ('${existingStored.publisher_id || 'kitchen'}'); `
          + 'save under it, or save and switch the webhook off',
        409,
      );
    }
    // D-201 Slice 10M — only an answer to the question as it stands now. A
    // webhook switched off since, in another tab, is not switched back on.
    if (deps.webhookConsumerStore?.isConsumerEnabled('local_recipe', recipe.recipe_id) !== true) {
      throw new RpcError(
        'webhook_consent_stale',
        'recipe.save: its webhook was switched off since you were asked; save again',
        409,
      );
    }
    const preview = previewLocalWebhookDoor(deps, recipe, webhookBindings, receivedHash, publisher);
    if (preview?.state === 'refused') {
      // D-201 Slice 10S (10Q finding 11) — the owner answered a question that
      // offered keeping it on (a refused one offers no such answer), so this
      // changed since: a door revoked under Contracts, say. Stale, so Kitchen
      // asks again and shows why. Without an answer it was never askable.
      throw new RpcError(
        webhookConsent !== undefined ? 'webhook_consent_stale' : 'webhook_not_ready',
        `recipe.save: this version cannot keep its webhook on: ${preview.refusal?.detail ?? 'it cannot have a webhook door'}`,
        409,
      );
    }
    // What the save would allow, against what the owner was shown: any change
    // (the draft, a connection or setting, a door revoked or an operation
    // switched off under Contracts, the history) asks again.
    if (preview !== null && preview.consent !== webhookConsent) {
      throw new RpcError(
        'webhook_consent_stale',
        'recipe.save: what keeping its webhook on would allow changed since you were asked; save again to see it',
        409,
      );
    }
  }

  // D-201 Slice 10AJ (10AI finding 2) — read before the replacement moves the
  // triggers: whether this save, switched off, keeps the door they carry.
  const saveKeepsItsDoor = hasWebhook && !keepOn && webhookSaveKeepsItsDoor(deps, recipe, publisher);
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
          // D-201 Slice 10AD (10AA finding 21) — as the start would finish it.
          recipeRemains: (recipeId, publisherId) => recipeRemainsStored(deps.store, recipeId, publisherId),
          requirements: hasWebhook ? recipe.webhook_requirements ?? [] : [],
          selections: hasWebhook ? webhookBindings ?? [] : [],
          recipes: hasWebhook
            ? [{
                recipe_id: recipe.recipe_id,
                publisher_id: publisher,
                webhook_triggers: recipe.webhook_triggers ?? [],
              }]
            : [],
          // Saved on when the owner kept it on, so a save that keeps the
          // webhook setup continues its bindings and keeps their waiting
          // deliveries and dead letters (Slice 10F's rule); else off. A
          // replacement saved on makes every check switching it on makes (a
          // way in that is on, its profile, registration mode, environment,
          // events and paired connection) and refuses before writing a row.
          enabled: keepOn,
          // D-201 Slice 10AF (10AE finding 5) — switched off, a save starts its
          // door clean (D-201 Slice 10M): what the owner did to the door it had
          // is forgotten with the replacement itself, so a door step that fails
          // after it does not bring that back at the next switch-on. A save that
          // drops the webhook keeps it as the door the recipe had last.
          // D-201 Slice 10AJ (10AI finding 2) — unless it keeps its door: an
          // unchanged door that is open, which the door step reuses with the
          // owner's switch-offs (10S). Forgotten, a fault in that step left the
          // next switch-on nothing to carry them from, so it granted them again.
          ...(hasWebhook && !keepOn && !saveKeepsItsDoor ? { forget_last_doors: true } : {}),
          // D-201 Slice 10X — the row as it stands, so a start finishing this
          // replacement can tell whether the save committed.
          prior_recipe_stamp: recipeRowStamp(existingStored),
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
          // D-201 Slice 10M (the owner's call) — kept on, what the owner
          // switched off under Contracts stays off, as a pack update keeps it;
          // the question listed them. Switched off, a save starts the door
          // clean, and switching it on shows it whole.
          ...(keepOn ? { keepOwnerRevoked: true } : {}),
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
  if (priorWebhook && deps.webhookConsumerStore) {
    try {
      // The binding store deliberately leaves prior claims detached until the
      // recipe row commits, so a failed save can restore them exactly. Once the
      // cross-store save succeeds, cancel that superseded work and release its
      // decoded-payload retention pins.
      // D-201 Slice 10S (10Q finding 4) — a save keeps the recipe: what it no
      // longer takes closes as saved with a different setup, not as removed.
      // D-201 Slice 10U (10Q finding 9) — after the door, not before it: the
      // record this clears then stands until the door does, so a process that
      // dies before the door leaves the next start a record to make it from.
      // Before, a death between the two re-homed the rows onto triggers with
      // no door, and the first poll cancelled them unseen.
      // D-201 Slice 10AH (10AE finding 26) — asked as the replace above, the
      // start and the next save ask it (`recipeRemainsStored`): the recipe as
      // stored, under the publisher the trigger names. A save under another
      // publisher closed as saved differently here and as removed by the start.
      deps.webhookConsumerStore.finalizeConsumerReplacement(priorWebhook, {
        recipeRemains: (recipeId, publisherId) => recipeRemainsStored(deps.store, recipeId, publisherId),
      });
    } catch (error) {
      throw webhookStoreError('recipe.save', error);
    }
  }

  // D-201 Slice 10X — kept on, a mint the checks before the save did not
  // foresee (a store fault) leaves the webhook on: the switch is the owner's
  // (the owner's ruling of 2026-11-19), and its deliveries are kept for the
  // owner (`door_missing`) while the status, Kitchen and the webhook's card say
  // the door is missing. 10I switched it off, closing what it carried.

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
    ...(opWarnings.length > 0 ? { op_warnings: opWarnings } : {}),
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

/** D-201 Slice 10I — the door `recipe` would get if saved now: the same two
 *  steps the mint takes (the non-owner exposure check, then the derivation),
 *  compared with the door its saved version has. A draft never touches a
 *  store here. */
/** D-201 Slices 10I + 10M — the keep-on question, computed as the save acts:
 *  the door's diff by the mint's own function over every axis it names
 *  (operations, ingredients, connections), what the owner switched off (kept
 *  off), each slot's message access that widens, what happens to the history,
 *  whether the webhook is on, and `consent`, a digest of all of it with the
 *  draft, which the save checks before it acts. Before 10M it compared
 *  operation ids only, so a door could gain a connection, an ingredient or an
 *  operation the owner had switched off unshown (10L finding 1). */
const previewLocalWebhookDoor = (
  deps: RecipeSaveHandlerDeps,
  recipe: RecipeDefinition,
  webhookBindings?: readonly WebhookIngressBindingSelection[],
  /** The draft's hash as received, when the caller has changed it since. */
  receivedHash?: string,
  /** D-201 Slice 10Y (10V finding 22) — the publisher the save names, if it
   *  names one; a save naming none saves as `kitchen`. */
  publisherId?: string,
): LocalRecipeWebhookDoorPreview | null => {
  const door = deps.webhookDoor;
  if (door === undefined) return null;
  // D-201 Slice 10Y (10V finding 21) — on a refusal too: a webhook switched off
  // since, in another tab, is not "on" above a draft that cannot keep it on.
  const armed = deps.webhookConsumerStore?.isConsumerEnabled('local_recipe', recipe.recipe_id) === true;
  const refused = (reason: string, detail: string, stepId = '<recipe>'): LocalRecipeWebhookDoorPreview => ({
    state: 'refused',
    refusal: { reason, step_id: stepId, detail },
    armed,
  });
  // D-201 Slice 10S (10Q finding 13) — as the save refuses it: with no
  // trigger nothing could start it, so it cannot stay on. 10M offered it.
  if ((recipe.webhook_triggers?.length ?? 0) === 0) {
    return refused('not_ready', 'this version has no webhook trigger');
  }
  // D-201 Slice 10Y (10V finding 22) — the question is asked as the save acts:
  // under the publisher it names, which keeping it on must keep (10S). It asked
  // under the stored one, whatever the save would name.
  const publisher = publisherId ?? 'kitchen';
  const savedUnder = deps.store.getStored(recipe.recipe_id);
  if (savedUnder !== null && (savedUnder.publisher_id || 'kitchen') !== publisher) {
    return refused(
      'not_ready',
      `it was saved under the publisher '${savedUnder.publisher_id || 'kitchen'}', and this save is under '${publisher}'`,
    );
  }
  try {
    door.preflightNonOwnerRecipeExposure?.(recipe, 'webhook');
  } catch (error) {
    return refused('exposure_refused', error instanceof Error ? error.message : String(error));
  }
  let derived: ReturnType<typeof deriveWebhookDoorCapability>;
  try {
    derived = deriveWebhookDoorCapability({ recipe_id: recipe.recipe_id, recipe }, door);
  } catch (error) {
    return refused('dispatch_unresolvable', error instanceof Error ? error.message : String(error));
  }
  if (!derived.ok) {
    return refused(derived.refusal.reason, describeWebhookDoorRefusal(derived.refusal), derived.refusal.step_id);
  }
  // The door the save's door step starts from: the one on its triggers now,
  // else the newest it had. D-201 Slice 10AJ (10AI finding 4) — it read the
  // triggers only, so with rows a fault left door-less the question showed a
  // fresh door while the save kept the owner's closing or switch-offs.
  const currentId = savedUnder === null
    ? null
    : currentRecipeDoorId(door, 'local_recipe', recipe.recipe_id, recipe.recipe_id, publisher);
  const current = currentId === null ? null : door.definitionStore.get(currentId);
  // Closed by its owner, as the save keeps it (`closedByOwner`): a door Recued
  // retired is made again, so the question diffs against it instead.
  // D-201 Slice 10AO (10AM findings 1 and 13) — read as the card, Kitchen's
  // status and the save's door step read it (`ownerLeftDoorClosed`): rows
  // that carry no door are in the state the owner's kept switch left them.
  if (savedUnder !== null
    && ownerLeftDoorClosed(door, 'local_recipe', recipe.recipe_id, recipe.recipe_id, publisher)) {
    // Kept on, the owner's revoke stands (the save keeps it): nothing could run.
    return refused(
      'door_revoked',
      // D-201 Slice 10X (10V finding 12) — a remedy the owner can take: the
      // Contracts route has no switch for a derived door, and a revoke is final.
      // D-201 Slice 10AF (10AE finding 14) — the remedy Kitchen gives since
      // 10AC: switching it off and on again lost what was waiting for it.
      'its door is closed, so a save cannot keep it on. Open its door first, on its webhook in Settings → Connections → Webhooks or with its switch here, then save again: what is waiting for it is kept',
    );
  }
  const diff = doorCapabilityChanged(current, derived.capability);
  // D-201 Slice 10Y (10V finding 20) — only an operation this version's door
  // has: one it no longer takes is carried off, and is nothing it could do.
  const derivedOperations = new Set(derived.capability.operation_ids);
  const keptOff = currentId === null
    ? []
    : door.grantEntryStore.listForContract(currentId)
      .filter((row) => row.granted === false && derivedOperations.has(row.entry_key))
      .map((row) => row.entry_key)
      .sort();
  let history: 'kept' | 'closed' | 'none' | undefined;
  let historyTriggers: NonNullable<LocalRecipeWebhookDoorPreview['history_triggers']> | undefined;
  let widened: string[] = [];
  const consumerStore = deps.webhookConsumerStore;
  if (consumerStore !== undefined && webhookBindings !== undefined) {
    try {
      const planned = consumerStore.previewReplacement({
        consumer_kind: 'local_recipe',
        consumer_id: recipe.recipe_id,
        requirements: recipe.webhook_requirements ?? [],
        selections: webhookBindings,
        recipes: [{
          recipe_id: recipe.recipe_id,
          publisher_id: publisher,
          webhook_triggers: recipe.webhook_triggers ?? [],
        }],
      });
      history = planned.history;
      historyTriggers = planned.triggers;
      widened = planned.widened;
    } catch (error) {
      return refused('not_ready', error instanceof Error ? error.message : String(error));
    }
  }
  const operationIds = [...derived.capability.operation_ids].sort();
  const shown = {
    recipe: receivedHash ?? draftDigest(recipe),
    door: currentId,
    operation_ids: operationIds,
    ingredient_ids: [...derived.capability.ingredient_ids].sort(),
    connection_names: [...derived.capability.connection_names].sort(),
    added: diff.added,
    removed: diff.removed,
    widened,
    kept_off: keptOff,
    history: history ?? null,
    history_triggers: historyTriggers ?? null,
    armed,
  };
  return {
    state: 'derivable',
    operation_ids: operationIds,
    added: diff.added,
    removed: diff.removed,
    widened,
    kept_off: keptOff,
    ...(history !== undefined ? { history } : {}),
    ...(historyTriggers !== undefined ? { history_triggers: historyTriggers } : {}),
    armed,
    consent: createHash('sha256').update(JSON.stringify(shown)).digest('hex'),
  };
};

export const handleLocalRecipeWebhookPreview = (
  deps: RecipeSaveHandlerDeps,
  args: {
    recipe: RecipeDefinition;
    webhook_bindings?: ReadonlyArray<WebhookIngressBindingSelection>;
    publisher_id?: string;
  },
): { door: LocalRecipeWebhookDoorPreview | null } => {
  const method = 'recipe.webhook.preview';
  const recipe = args?.recipe;
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)
    || typeof (recipe as { recipe_id?: unknown }).recipe_id !== 'string'
    || (recipe as { recipe_id: string }).recipe_id.length === 0
    || (recipe as { recipe_id: string }).recipe_id.length > 256) {
    throw new RpcError('bad_request', `${method}: recipe must be a recipe with a recipe_id`, 400);
  }
  if (!hasNonEmptyWebhookDeclarations(recipe)) return { door: null };
  const bindings = args.webhook_bindings;
  if (bindings !== undefined && !Array.isArray(bindings)) {
    throw new RpcError('bad_request', `${method}: webhook_bindings must be a list`, 400);
  }
  // D-201 Slice 10Y (10V finding 22) — the publisher the save would name.
  const publisherId = args.publisher_id;
  if (publisherId !== undefined && (typeof publisherId !== 'string' || publisherId.length === 0)) {
    throw new RpcError('bad_request', `${method}: publisher_id must be a non-empty string`, 400);
  }
  return { door: previewLocalWebhookDoor(deps, recipe, bindings, undefined, publisherId) };
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
  if (armed && deps.webhookDoor !== undefined) {
    const door = deps.webhookDoor;
    const doorLive = (): boolean => {
      const contractId = door.consumerStore.doorContractIdForRecipe(
        'local_recipe',
        recipe.recipe_id,
        recipe.recipe_id,
        storedPublisher(deps, recipe.recipe_id),
      );
      const def = contractId === null ? null : door.definitionStore.get(contractId);
      return def !== null && (def.revoked_at === undefined || def.revoked_at === null);
    };
    if (!doorLive()) {
      // D-201 Slice 10X — switching it on is the owner's control (the owner's
      // ruling of 2026-11-19): a door that is missing (a crash in the save's
      // mint window, a recipe saved before the door substrate) or was closed is
      // made again, as the webhook's switch in Connections → Webhooks makes it.
      // What the owner switched off under Contracts stays off. Before 10X it
      // refused, telling the owner to save again.
      const made = followMainDishWebhookDoors(
        { recipe_id: recipe.recipe_id, recipe },
        { ...door, consumerStore: deps.webhookConsumerStore },
        { mintedBy: 'user_self', retireReason: 'owner_reopened', reopen: true },
      ).find((change) => change.recipe_id === recipe.recipe_id);
      if (!doorLive()) {
        throw new RpcError(
          'webhook_not_ready',
          `${method}: its webhook door could not be made: ${made?.reason ?? 'save the recipe again, then switch it on'}`,
          409,
        );
      }
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
  | 'recipe.webhook.disarm'
  | 'recipe.webhook.preview';

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
      'recipe.webhook.preview',
    ],
    handlers: {
      'recipe.save': async (req) => saveRecipeInline(
        deps,
        req.recipe,
        req.publisher_id,
        req.webhook_bindings,
        req.webhook_on === true,
        typeof req.webhook_consent === 'string' ? req.webhook_consent : undefined,
      ),
      'recipe.validate': async (req) => validateRecipeInline(req.recipe),
      'recipe.webhook.status': async (req) =>
        handleLocalRecipeWebhookStatus(deps, req),
      'recipe.webhook.arm': async (req) => handleLocalRecipeWebhookArm(deps, req),
      'recipe.webhook.disarm': async (req) =>
        handleLocalRecipeWebhookDisarm(deps, req),
      'recipe.webhook.preview': async (req) =>
        handleLocalRecipeWebhookPreview(deps, req),
    },
  };
};
