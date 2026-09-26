/** Build the unsaved Kitchen draft behind Data -> Form response -> Automate.
 *
 * The route carries only the stable form-definition id. It never carries the
 * opened response id, visitor identity, or answer values: the declarative
 * trigger receives a privacy-minimized routing record and the explicit
 * owner-only reader fetches the accepted response at run time.
 */

import type {
  RecipeDefinition,
  ServerRecipeFullEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';
import {
  FORM_RESPONSE_ON_SHORTHAND,
  parseRecipeBundleKey,
} from '@recued/contracts';

export const FORM_RESPONSE_READER_OP = 'core.data.form-response.get' as const;
export const FORM_RESPONSE_EVENT_RECORD_ID_REF =
  '{{context.event.payload.record_id}}' as const;

/** Public pack recipes opt into the exact-form clone affordance explicitly.
 * A tag alone is not enough: discovery also verifies an installed carrier,
 * inert triggers, and the canonical accepted-response reader below. */
export const FORM_RESPONSE_WORKFLOW_TEMPLATE_TAG =
  'form-response-template' as const;

const DRAFT_KEY_PATTERN = /^[a-f0-9]{32}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEmptyOptionalArray = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);

const assertSeedIdentity = (formDefinitionId: string, draftKey: string): void => {
  if (formDefinitionId.trim().length === 0) {
    throw new Error('form response automation requires a form definition id');
  }
  if (!DRAFT_KEY_PATTERN.test(draftKey)) {
    throw new Error('form response automation requires a 128-bit lowercase hex draft key');
  }
};

const hasCanonicalAcceptedResponseReader = (recipe: Record<string, unknown>): boolean => {
  if (!Array.isArray(recipe.prefetch_steps)) return false;
  return recipe.prefetch_steps.some((step) => {
    if (!isRecord(step) || !isRecord(step.args)) return false;
    return step.op === FORM_RESPONSE_READER_OP
      && step.args.submission_id === FORM_RESPONSE_EVENT_RECORD_ID_REF;
  });
};

/** Everything a `recipe.list` ROW can prove about a form-response workflow
 * template: installed, inert, and its carrier's identity. A pack install
 * persists the selected member and `recipe.list` returns that stored row as
 * `pair-sync`; bundled availability or an inline authoring row is not proof
 * that the owner installed its carrier.
 *
 * ⛔ NOT THE WHOLE TEST. The canonical accepted-response reader lives in
 * `prefetch_steps`, and a list row has carried no step bodies since f95faec10.
 * A row that passes here is a CANDIDATE; {@link isInstalledFormResponseWorkflowTemplate}
 * decides, against the body `recipe.get` returns. */
export const isFormResponseWorkflowTemplateCandidate = (
  entry: ServerRecipeListEntry | ServerRecipeFullEntry,
): boolean => {
  if (entry.source !== 'pair-sync' || !isRecord(entry.recipe)) return false;
  const recipe = entry.recipe;
  if (!isRecord(recipe.metadata)) return false;
  const bundle = recipe.metadata.recipe_bundle;
  const bundleParts = typeof bundle === 'string' ? parseRecipeBundleKey(bundle) : null;
  return recipe.recipe_id === entry.recipe_id
    && recipe.version === entry.version
    && bundleParts?.publisher === entry.publisher_id
    && Array.isArray(recipe.metadata.tags)
    && recipe.metadata.tags.includes(FORM_RESPONSE_WORKFLOW_TEMPLATE_TAG)
    && isEmptyOptionalArray(recipe.event_triggers)
    && isEmptyOptionalArray(recipe.webhook_triggers)
    && recipe.auto_run === undefined
    && isEmptyOptionalArray(recipe.trigger_steps);
};

/** An installed, inert form-response workflow template, proven against its
 * FULL body: a candidate whose prefetch reads the accepted response the
 * trigger names. Typed to the body-carrying entry on purpose. Passed a list
 * row, the reader check would see no `prefetch_steps` and refuse every
 * template, which is what happened after the list was trimmed. */
export const isInstalledFormResponseWorkflowTemplate = (
  entry: ServerRecipeFullEntry,
): boolean =>
  isFormResponseWorkflowTemplateCandidate(entry)
  && isRecord(entry.recipe)
  && hasCanonicalAcceptedResponseReader(entry.recipe as unknown as Record<string, unknown>);

/** Generate a fresh local store key for each starter. `recipe.save` is an
 * intentional upsert, so a deterministic id derived only from the form would
 * let a later blank starter overwrite the form's existing automation. */
export const createFormResponseAutomationDraftKey = (): string => {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new Error('form response automation requires secure random values');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** A runnable authoring starting point, not a persisted recipe. The owner can
 * rename it and add effects before Save; the shell treats it as dirty from the
 * moment it mounts so leaving cannot silently discard the draft. */
export const createFormResponseAutomationSeed = (
  formDefinitionId: string,
  draftKey: string,
): RecipeDefinition => {
  assertSeedIdentity(formDefinitionId, draftKey);

  // `form_definition_id` is intentionally only non-empty in the intake
  // contract. Keep its exact bytes in the trigger, but do not copy arbitrary id
  // content into the author-facing metadata or slug: a valid id may contain
  // markup, controls, or words rejected by the recipe content policy.
  return {
    recipe_id: `handle-form-${draftKey}-responses`,
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Deal with form answers you accept',
      description: 'Runs after you accept an answer from this form.',
      author: 'local',
      supported_platforms: [],
    },
    variables: {},
    event_triggers: [{
      on: FORM_RESPONSE_ON_SHORTHAND,
      where: { form_definition_id: formDefinitionId },
    }],
    prefetch_steps: [{
      id: 'form_response',
      op: FORM_RESPONSE_READER_OP,
      args: { submission_id: FORM_RESPONSE_EVENT_RECORD_ID_REF },
    }],
    steps: [],
    output: { render: [] },
  };
};

/** Clone one installed pack origin into a fresh local exact-form draft.
 *
 * The deep clone preserves every step-body string byte-for-byte — notably the
 * `data.shared.recipe.<sanitized-bundle>.*` literals. Only install identity and
 * local trigger identity change: `metadata.recipe_bundle` is dropped,
 * `fork_of` records provenance, and one literal form-definition trigger is
 * materialized disarmed by the normal recipe-save/trigger-reconcile path.
 */
export const createFormResponseAutomationFromWorkflowTemplate = (
  // ⛔ THE FULL ENTRY (`recipe.get`), never a list row: this CLONES the body,
  // and a list row has no steps to clone.
  entry: ServerRecipeFullEntry,
  formDefinitionId: string,
  draftKey: string,
): RecipeDefinition => {
  assertSeedIdentity(formDefinitionId, draftKey);
  if (!isInstalledFormResponseWorkflowTemplate(entry)) {
    throw new Error('form response workflow template must be installed, inert, and canonical');
  }

  const cloned = JSON.parse(JSON.stringify(entry.recipe)) as RecipeDefinition;
  const sourceMetadata = entry.recipe.metadata;
  const metadata = {
    ...cloned.metadata,
    author: 'local',
    fork_of: {
      recipe_id: entry.recipe.recipe_id,
      author: sourceMetadata.author || entry.publisher_id,
      version: entry.recipe.version,
    },
  };
  delete metadata.recipe_bundle;

  return {
    ...cloned,
    recipe_id: `handle-form-${draftKey}-responses`,
    version: 1,
    metadata,
    event_triggers: [{
      on: FORM_RESPONSE_ON_SHORTHAND,
      where: { form_definition_id: formDefinitionId },
    }],
  };
};
