import { describe, expect, it } from 'vitest';
import type {
  FormResponse,
  RecipeDefinition,
  RecipeEventTrigger,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  buildFormResponseManualRunContext,
  findFormResponseAutomationsForResponse,
} from '../form-response-automation-run.js';

const entry = (
  recipe_id: string,
  event_triggers: RecipeEventTrigger[],
): ServerRecipeListEntry => {
  const recipe: RecipeDefinition = {
    recipe_id,
    version: 1,
    ttl: 300,
    metadata: {
      name: recipe_id,
      description: '',
      author: 'local',
      supported_platforms: [],
    },
    variables: {},
    event_triggers,
    prefetch_steps: [],
    steps: [],
    output: { render: [] },
  };
  return {
    recipe_id,
    publisher_id: 'kitchen',
    version: 1,
    recipe_hash: `hash-${recipe_id}`,
    recipe,
    source: 'pair-sync',
    installed_at: 1,
  };
};

const response: FormResponse = {
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'project-intake',
  definition_snapshot: {
    form_definition_id: 'project-intake',
    fields: [{ name: 'secret', label: 'Secret', type: 'text' }],
  },
  values: { secret: 'visitor answer' },
  visitor: { email: 'visitor@example.test' },
  submitted_at: 1_000,
  accepted_at: 2_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: { private_plan: 'owner-only plan' },
};

describe('accepted response manual automation run', () => {
  it('offers only canonical triggers whose entire routing filter matches', () => {
    const exactForm = entry('form', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake' },
    }]);
    const allForms = entry('all', [{ on: 'form_response.accepted' }]);
    const endpoint = entry('endpoint', [{
      on: 'form_response.accepted',
      where: { endpoint_id: 'endpoint-1' },
    }]);
    const oneResponse = entry('one', [{
      on: 'form_response.accepted',
      where: { id: 'submission-1' },
    }]);
    const wrongEndpoint = entry('wrong-endpoint', [{
      on: 'form_response.accepted',
      where: {
        form_definition_id: 'project-intake',
        endpoint_id: 'endpoint-2',
      },
    }]);
    const wrongResponse = entry('wrong-response', [{
      on: 'form_response.accepted',
      where: { id: 'submission-2' },
    }]);
    const raw = entry('raw', [{
      event: 'data.form_response.accepted.response.created',
    }]);
    const malformed = entry('malformed', [{
      on: 'form_response.accepted',
      where: null,
    } as never]);
    const templated = entry('templated', [{
      on: 'form_response.accepted',
      where: { form_definition_id: '{{config.form_definition_id}}' },
    }]);
    const mixedForms = entry('mixed-forms', [{
      on: 'form_response.accepted',
      event: 'data.form_response.accepted.response.created',
    }]);
    const malformedElement = entry('malformed-element', [null as never]);

    expect(findFormResponseAutomationsForResponse([
      exactForm,
      allForms,
      endpoint,
      oneResponse,
      wrongEndpoint,
      wrongResponse,
      raw,
      malformed,
      templated,
      mixedForms,
      malformedElement,
    ], response)).toEqual([
      { entry: exactForm, scope: 'this_form' },
      { entry: allForms, scope: 'all_forms' },
      { entry: endpoint, scope: 'current_response' },
      { entry: oneResponse, scope: 'current_response' },
    ]);
  });

  it('rebuilds the watcher event context without answer or visitor content', () => {
    const context = buildFormResponseManualRunContext(response);
    expect(context).toEqual({
      event: {
        topic: ['data', 'form_response', 'accepted', 'response', 'created'],
        kind: 'created',
        payload: {
          record_id: 'submission-1',
          at: 2_000,
          platform: 'form_response',
          slug: 'accepted',
          entity_type: 'response',
          record: {
            _id: 'submission-1',
            _collection: 'form_response',
            submission_id: 'submission-1',
            endpoint_id: 'endpoint-1',
            form_definition_id: 'project-intake',
            submitted_at: 1_000,
            accepted_at: 2_000,
          },
        },
      },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('visitor answer');
    expect(serialized).not.toContain('visitor@example.test');
    expect(serialized).not.toContain('owner-only plan');
    expect(serialized).not.toContain('definition_snapshot');
  });
});
