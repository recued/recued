// backend/server/src/form-contract-gate.ts
//
// The D-220 form-field contract check, as ONE implementation shared by every
// act that can arm a `form_response` trigger.
//
// ── Why it lives here and not in the save handler ──────────────────
// It used to be a module-private helper inside `recipe-save-handler.ts`, so the
// `recipe.save` rpc was gated and the MCP `recued_saveRecipe` tool was not —
// even though its own comment claimed to "mirror the local `recipe.save` seam".
// An authenticated MCP caller could save a recipe requiring a field the live
// form does not collect, trigger reconciliation would arm it, and every accepted
// submission would fire the recipe with the declared answer absent.
//
// Two save paths validating one rule is the shape that produces exactly that
// gap: the second path is written by someone reading the first path's summary,
// not its checks. So the rule has one home and both callers ask it.
//
// The verdict is returned rather than thrown, because the callers surface
// failure differently — the rpc raises a typed `RpcError` with a status, the MCP
// tool returns an error string. Throwing here would force one shape on both.

import {
  evaluateFormFieldContract,
  formResponseTriggerFormScope,
  type FormFieldContractFormView,
  type RecipeDefinition,
} from '@recued/contracts';

/** Read a live form definition by id. Absent ⇒ the host cannot check, and the
 *  gate is inert (the same posture the save handler had before). */
export type FormDefinitionReader = (
  form_definition_id: string,
) => FormFieldContractFormView | null;

export type FormContractVerdict =
  /** Nothing to refuse — no declaration, no concrete form, or the form satisfies it. */
  | { readonly kind: 'ok' }
  /** The live form provably does not collect what the recipe reads. */
  | { readonly kind: 'unsatisfied'; readonly message: string }
  /** The form could not be READ, so the pairing is unverified. Fail closed. */
  | { readonly kind: 'unverified'; readonly message: string };

/** Check a recipe about to be saved against every live form it names.
 *
 *  `caller` appears in the message so an owner can tell which act refused.
 *
 *  ⚠ An ABSENT `requires_form_fields` is not a claim and is not checked — most
 *  recipes take no intake form at all. An EMPTY array IS a claim ("this recipe
 *  reads no form fields") and is checked. */
export const checkFormContract = (
  read: FormDefinitionReader | undefined,
  recipe: RecipeDefinition,
  caller: string,
): FormContractVerdict => {
  if (read === undefined) return { kind: 'ok' };
  const declared = recipe.metadata?.requires_form_fields;
  if (!Array.isArray(declared) || declared.length === 0) return { kind: 'ok' };

  const triggers = Array.isArray(recipe.event_triggers) ? recipe.event_triggers : [];

  // ⛔ D-220 / Codex 3.3 — an UNSCOPED `form_response` trigger plus a non-empty
  // `requires_form_fields` is an unsatisfiable standing claim: it asserts that
  // every form on this server, including ones not yet created, collects those
  // fields. Neither later wiring act could close it — the save gate had no
  // concrete form id to check, and the create gate deliberately keeps `all_forms`
  // ADVISORY so one recipe cannot veto every future form.
  //
  // So it is refused HERE, which is the only place the author is present to fix
  // it, and the fix is concrete: name the form. Note this is about the DECLARED
  // requirement, not the trigger — an unscoped trigger with no declaration is
  // untouched, as is a declaration on a scoped trigger.
  for (const trigger of triggers) {
    const on = (trigger as { on?: unknown }).on;
    if (typeof on !== 'string' || !on.startsWith('form_response')) continue;
    const where = (trigger as { where?: Record<string, unknown> }).where;
    const formId = where?.form_definition_id;
    if (typeof formId === 'string' && formId.length > 0) continue;
    return {
      kind: 'unsatisfied',
      message:
        `${caller}: recipe '${recipe.recipe_id}' declares required form answers but its `
        + `'${on}' trigger names no form, so it would run against EVERY form on this server `
        + '— including forms that do not collect those answers, and forms not created yet. '
        + 'Nothing was saved. Scope the trigger with a `where.form_definition_id`, or drop '
        + 'the `requires_form_fields` declaration if the recipe does not need them.',
    };
  }

  for (const trigger of triggers) {
    const where = (trigger as { where?: Record<string, unknown> }).where;
    const formId = where?.form_definition_id;
    if (typeof formId !== 'string' || formId.length === 0) continue;
    const scope = formResponseTriggerFormScope(trigger, formId);
    if (scope !== 'this_form' && scope !== 'this_form_filtered') continue;

    let form: FormFieldContractFormView | null;
    try {
      form = read(formId);
    } catch (error) {
      // ⚠ This used to swallow and carry on, reasoning that the create gate
      // covered the pairing from the other side. That is false for an
      // ALREADY-LIVE form: no later create act ever happens for it, so a
      // transient registry failure was the one window in which a contradictory
      // trigger could be armed. Refusing a save the owner can repeat costs them
      // a click; arming a trigger that silently stores nothing costs them every
      // submission after it.
      return {
        kind: 'unverified',
        message:
          `${caller}: could not read the live form '${formId}' to check recipe `
          + `'${recipe.recipe_id}' against it, so the pairing is unverified and nothing was `
          + `saved. Retry. (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    // A form that does not exist YET is legitimate — the owner may author the
    // recipe first, and the create gate checks the pairing when it appears.
    if (form === null) continue;

    const verdict = evaluateFormFieldContract(declared, form);
    if (verdict.blocking.length === 0) continue;
    return {
      kind: 'unsatisfied',
      message:
        `recipe '${recipe.recipe_id}' reads answers the live form '${formId}' does not collect, `
        + 'so every accepted submission would store nothing. Nothing was saved. '
        + verdict.blocking.map((m) => m.detail).join('; '),
    };
  }
  return { kind: 'ok' };
};

/** Build the reader every save path shares, over the public-endpoint registry.
 *
 *  ⚠ `include_revoked` is deliberately NOT set, so a revoked form reads as
 *  ABSENT: there is nothing live to contradict, and re-creating it is gated by
 *  the create-time check instead.
 *
 *  Extracted so the rpc and MCP wirings cannot drift — the whole point of
 *  finding 3.2 was two save paths built from one summary. */
export const createFormDefinitionReader = (
  list: (filter: { kind: 'intake_form' }) => Iterable<{ metadata?: unknown }>,
  parseConfig: (metadata: unknown) => {
    form_definition: { form_definition_id: string };
  } | null,
): FormDefinitionReader => (form_definition_id: string) => {
  for (const endpoint of list({ kind: 'intake_form' })) {
    const config = parseConfig(endpoint.metadata);
    if (config?.form_definition.form_definition_id === form_definition_id) {
      return config.form_definition as unknown as FormFieldContractFormView;
    }
  }
  return null;
};
