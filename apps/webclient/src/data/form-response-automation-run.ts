/** Manual continuation helpers for one already accepted form response.
 *
 * Data owns the full accepted response but must not pass its answers, visitor
 * identity, frozen definition, or private metadata into generic recipe
 * discovery/execution context. These helpers evaluate canonical trigger
 * routing and reconstruct only the event projection a reactive watcher would
 * have received.
 */

import {
  compileTriggerSugarEntry,
  FORM_RESPONSE_CREATED_EVENT_PATTERN,
  FORM_RESPONSE_EVENT_ENTITY_TYPE,
  FORM_RESPONSE_EVENT_PLATFORM,
  FORM_RESPONSE_EVENT_SLUG,
  FORM_RESPONSE_ON_SHORTHAND,
  matchesTriggerDispatchFilter,
  validateRecipeEventTriggerEntry,
  type FormResponse,
  type FormResponseTriggerRecord,
  type RecipeEventTrigger,
  type ServerRecipeListEntry,
} from '@recued/contracts';

export type AcceptedFormResponseRouting = Pick<
  FormResponse,
  | 'submission_id'
  | 'endpoint_id'
  | 'form_definition_id'
  | 'submitted_at'
  | 'accepted_at'
>;

export type FormResponseAutomationRunScope =
  | 'current_response'
  | 'this_form'
  | 'all_forms';

export interface FormResponseAutomationRunMatch {
  entry: ServerRecipeListEntry;
  scope: FormResponseAutomationRunScope;
}

const routingPayloadForResponse = (
  response: AcceptedFormResponseRouting,
): Record<string, unknown> => {
  const record: FormResponseTriggerRecord = {
    _id: response.submission_id,
    _collection: 'form_response',
    submission_id: response.submission_id,
    endpoint_id: response.endpoint_id,
    form_definition_id: response.form_definition_id,
    submitted_at: response.submitted_at,
    accepted_at: response.accepted_at,
  };
  return {
    record_id: response.submission_id,
    at: response.accepted_at,
    platform: FORM_RESPONSE_EVENT_PLATFORM,
    slug: FORM_RESPONSE_EVENT_SLUG,
    entity_type: FORM_RESPONSE_EVENT_ENTITY_TYPE,
    record,
  };
};

const triggerScopeForResponse = (
  trigger: unknown,
  response: AcceptedFormResponseRouting,
): FormResponseAutomationRunScope | null => {
  if (
    trigger === null
    || typeof trigger !== 'object'
    || Array.isArray(trigger)
  ) {
    return null;
  }
  const candidate = trigger as RecipeEventTrigger;
  if (
    candidate.on !== FORM_RESPONSE_ON_SHORTHAND
    || validateRecipeEventTriggerEntry(candidate).length > 0
  ) {
    return null;
  }
  const compiled = compileTriggerSugarEntry(candidate, []);
  if (
    compiled === null
    || !compiled.some((subscription) =>
      subscription.pattern === FORM_RESPONSE_CREATED_EVENT_PATTERN
      && matchesTriggerDispatchFilter(
        subscription,
        routingPayloadForResponse(response),
      ))
  ) {
    return null;
  }
  const where: unknown = candidate.where;
  if (where === undefined) return 'all_forms';
  if (where === null || typeof where !== 'object' || Array.isArray(where)) {
    return null;
  }
  const conditions = where as Record<string, unknown>;
  if (Object.keys(conditions).length === 0) return 'all_forms';

  for (const [key, expected] of Object.entries(conditions)) {
    const actual = key === 'id'
      ? response.submission_id
      : key === 'endpoint_id'
        ? response.endpoint_id
        : key === 'form_definition_id'
          ? response.form_definition_id
          : undefined;
    // The canonical trigger grammar admits only these three string fields.
    // Stay closed over malformed legacy rows instead of treating an absent
    // path as a match in this owner-facing manual-run picker.
    if (typeof expected !== 'string' || actual === undefined || actual !== expected) {
      return null;
    }
  }

  return Object.keys(conditions).length === 1
    && conditions.form_definition_id === response.form_definition_id
    ? 'this_form'
    : 'current_response';
};

/** Find canonical accepted-response recipes whose authored filter matches this
 * exact routing record. Manual execution bypasses the trigger dispatcher, so
 * the picker reuses the trigger validator, compiler, and dispatch matcher and
 * never offers a recipe whose form / endpoint / response restriction
 * disagrees with the record. */
export const findFormResponseAutomationsForResponse = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
  response: AcceptedFormResponseRouting,
): FormResponseAutomationRunMatch[] => {
  const matches: FormResponseAutomationRunMatch[] = [];
  const rank: Readonly<Record<FormResponseAutomationRunScope, number>> = {
    current_response: 1,
    all_forms: 2,
    this_form: 3,
  };

  for (const entry of recipes) {
    const triggers = Array.isArray(entry.recipe?.event_triggers)
      ? entry.recipe.event_triggers
      : [];
    let scope: FormResponseAutomationRunScope | null = null;
    for (const trigger of triggers) {
      const candidate = triggerScopeForResponse(trigger, response);
      if (
        candidate !== null
        && (scope === null || rank[candidate] > rank[scope])
      ) {
        scope = candidate;
      }
      if (scope === 'this_form') break;
    }
    if (scope !== null) matches.push({ entry, scope });
  }

  return matches;
};

/** Reconstruct the exact privacy-minimized event context a declarative trigger
 * would have received. The run itself remains manual: this does not emit onto
 * the warehouse bus or fabricate a trigger id. */
export const buildFormResponseManualRunContext = (
  response: AcceptedFormResponseRouting,
): Record<string, unknown> => {
  return {
    event: {
      topic: FORM_RESPONSE_CREATED_EVENT_PATTERN.split('.'),
      kind: 'created',
      payload: routingPayloadForResponse(response),
    },
  };
};
