/** Discover saved recipes that can receive an accepted response for one form.
 *
 * The contextual Kitchen route knows only the stable form-definition id. It
 * therefore advertises only matches it can prove from that value alone:
 *
 * - an exact `where.form_definition_id` match; or
 * - an otherwise-unscoped canonical accepted-response trigger (all forms).
 *
 * A trigger narrowed only by response id or endpoint id is deliberately not
 * shown. It might happen to apply, but claiming that without carrying more
 * response context into the authoring URL would be misleading.
 */

import {
  FORM_RESPONSE_ON_SHORTHAND,
  validateRecipeEventTriggerEntry,
  type RecipeEventTrigger,
  type ServerRecipeListEntry,
} from '@recued/contracts';
import { isInstalledFormResponseWorkflowTemplate } from './form-response-automation-seed.js';

export type FormResponseAutomationScope =
  | 'this_form'
  | 'this_form_filtered'
  | 'all_forms';

export interface FormResponseAutomationMatch {
  entry: ServerRecipeListEntry;
  scope: FormResponseAutomationScope;
}

export interface FormResponseWorkflowTemplateMatch {
  entry: ServerRecipeListEntry;
  bundle_key: string;
}

const triggerScopeForForm = (
  trigger: RecipeEventTrigger,
  formDefinitionId: string,
): FormResponseAutomationScope | null => {
  if (trigger.on !== FORM_RESPONSE_ON_SHORTHAND) return null;
  // Stored / imported / pack recipe JSON is a runtime boundary. Validation runs
  // when a recipe is authored, but legacy or imported rows can reach discovery
  // directly carrying a malformed `where` — including `where: null`, which the
  // `Record | undefined` field type hides from the compiler and would crash the
  // `Object.keys` read below (throwing out of the whole lookup and hiding every
  // other form's automations). A trigger that could never fire — null / array /
  // non-literal value / unknown key — must not be advertised, exactly as the
  // manual-run picker (form-response-automation-run.ts) and the reconciler's
  // compiler (trigger-sugar.ts) already guard this same boundary.
  if (validateRecipeEventTriggerEntry(trigger).length > 0) return null;

  const where = trigger.where;
  if (where === undefined || Object.keys(where).length === 0) return 'all_forms';
  if (where.form_definition_id === formDefinitionId) {
    return Object.keys(where).some((key) => key !== 'form_definition_id')
      ? 'this_form_filtered'
      : 'this_form';
  }
  return null;
};

/** Return at most one match per installed recipe, preserving server list order.
 * A form-only trigger is the most useful explanation for this entry point; an
 * all-form trigger is more truthful than a form trigger carrying extra filters
 * because it proves the recipe covers the whole stream. */
export const findFormResponseAutomations = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
  formDefinitionId: string,
): FormResponseAutomationMatch[] => {
  const matches: FormResponseAutomationMatch[] = [];

  for (const entry of recipes) {
    const triggers = Array.isArray(entry.recipe?.event_triggers)
      ? entry.recipe.event_triggers
      : [];
    let scope: FormResponseAutomationScope | null = null;
    for (const trigger of triggers) {
      const candidate = triggerScopeForForm(trigger, formDefinitionId);
      if (candidate === 'this_form') {
        scope = candidate;
        break;
      }
      if (
        candidate === 'all_forms'
        || (candidate === 'this_form_filtered' && scope === null)
      ) {
        scope = candidate;
      }
    }
    if (scope !== null) matches.push({ entry, scope });
  }

  return matches;
};

/** Installed inert origins offered by Data → Automate this form. Stable server
 * order is preserved; duplicate recipe ids are collapsed defensively. */
export const findFormResponseWorkflowTemplates = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
): FormResponseWorkflowTemplateMatch[] => {
  const matches: FormResponseWorkflowTemplateMatch[] = [];
  const seen = new Set<string>();
  for (const entry of recipes) {
    if (seen.has(entry.recipe_id) || !isInstalledFormResponseWorkflowTemplate(entry)) continue;
    const bundle = entry.recipe.metadata.recipe_bundle;
    if (bundle === undefined) continue;
    seen.add(entry.recipe_id);
    matches.push({ entry, bundle_key: bundle });
  }
  return matches;
};
