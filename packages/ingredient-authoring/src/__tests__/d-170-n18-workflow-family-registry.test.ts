import { describe, expect, it } from 'vitest';
import type {
  ArgEditField,
  CanonicalWorkflowTemplate,
  CompositionIngredient,
  Recipe,
  RecipeTemplateRow,
} from '@recued/contracts';
import type { DecomposedArtifacts } from '../decomposer.js';
import { CANONICAL_WORKFLOW_TEMPLATE_REGISTRY } from '../schema.js';
import { validateComposition } from '../validators.js';

const canonicalTemplates = [
  'review-then-approve',
  'notify-on-event',
  'conditional-operate',
  'scheduled-operate',
  'escalate',
] as const satisfies readonly CanonicalWorkflowTemplate[];

const editableArgs = [
  {
    key: 'request.email',
    type: 'string',
    label: 'Requester email',
    required: true,
    privacy: 'email',
    options_source: 'reception_contact_options',
    affects_target: true,
    validation: { pattern: '@' },
  },
  {
    key: 'request.priority',
    type: 'number',
    validation: { min: 1, max: 5 },
  },
] satisfies ArgEditField[];

const recipeTemplateRow = {
  template: 'review-then-approve',
  trigger: {
    entity: 'reception_booking_request',
    field: 'status',
    value: 'pending',
  },
  operation: 'booking_request.materialize',
  sync_target: {
    source_id: 'google-calendar-primary',
    write_back_op: 'calendar.event.create',
  },
  notify_target: 'owner',
  escalate_after_ms: 30 * 60 * 1000,
} satisfies RecipeTemplateRow;

const compiledRecipe = {
  recipe_id: 'reception-booking-request-review',
  version: 1,
  ttl: 3600,
  metadata: {
    name: 'Reception booking request review',
    description: 'Review and materialize a booking request.',
    author: 'recued-core',
    supported_platforms: ['server'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
} satisfies Recipe;

const twoOperationCompositionWithWorkflow = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'reception-booking',
  ingredients: [
    {
      slug: 'reception-booking',
      kind: 'http',
      http: { base: 'https://api.example.test', connection: 'reception' },
    },
  ],
  operations: [
    {
      op: 'booking_request.materialize',
      ingredient: 'reception-booking',
      risk: 'write',
      approval: 'ask',
      bind: { kind: 'rest', method: 'POST', path_template: '/booking-requests' },
    },
    {
      op: 'calendar.event.create',
      ingredient: 'reception-booking',
      risk: 'write',
      approval: 'ask',
      bind: { kind: 'rest', method: 'POST', path_template: '/calendar/events' },
    },
  ],
  recipe_templates: [
    {
      template: 'review-then-approve',
      trigger: {
        entity: 'reception_booking_request',
        field: 'status',
        value: 'pending',
      },
      operation: 'booking_request.materialize',
      sync_target: {
        source_id: '{{vault.calendar}}',
        write_back_op: 'calendar.event.create',
      },
    },
  ],
});

describe('D-170 N.18 workflow-family type registry', () => {
  it('declares every closed canonical workflow template in the registry', () => {
    expect(Object.keys(CANONICAL_WORKFLOW_TEMPLATE_REGISTRY).sort()).toEqual(
      [...canonicalTemplates].sort(),
    );

    for (const template of canonicalTemplates) {
      const entry = CANONICAL_WORKFLOW_TEMPLATE_REGISTRY[template];
      expect(entry.description).toContain('->');
      expect(entry.structure.length).toBeGreaterThan(0);
    }
  });

  it('threads recipe templates and editable args through the composition types', () => {
    const composition = {
      schema_version: 1,
      slug: 'reception-booking',
      ingredients: [
        {
          slug: 'reception-booking',
          kind: 'http',
          http: { base: 'https://api.example.test', connection: 'reception' },
        },
      ],
      operations: [
        {
          op: 'booking_request.materialize',
          ingredient: 'reception-booking',
          risk: 'write',
          approval: 'ask',
          bind: { kind: 'rest', method: 'POST', path_template: '/booking-requests' },
          editable_args: editableArgs,
        },
      ],
      recipe_templates: [recipeTemplateRow],
    } satisfies CompositionIngredient;

    expect(composition.recipe_templates?.[0]?.template).toBe('review-then-approve');
    expect(composition.operations[0]?.editable_args?.[0]?.privacy).toBe('email');
    expect(composition.operations[0]?.editable_args?.[1]?.type).toBe('number');
  });

  it('admits compiled recipes on decomposed artifacts without requiring emit', () => {
    const artifacts = {
      recipes: [compiledRecipe],
    } satisfies DecomposedArtifacts;

    expect(artifacts.recipes).toHaveLength(1);
    expect(artifacts.recipes?.[0]?.recipe_id).toBe('reception-booking-request-review');
  });

  it('only validates compiled recipes when a recipeValidator is injected', () => {
    const composition = twoOperationCompositionWithWorkflow();

    const skipped = validateComposition(composition);
    expect(skipped.valid).toBe(true);
    expect(skipped.issues.map((issue) => issue.code)).not.toContain('recipe_invalid_from_test');

    const doubled = validateComposition(composition, {
      recipeValidator: () => ({
        issues: [{
          severity: 'error',
          code: 'recipe_invalid_from_test',
          path: 'steps[1].input.source_id',
          message: 'compiled recipe is invalid',
        }],
      }),
    });

    expect(doubled.valid).toBe(false);
    expect(doubled.issues).toContainEqual(
      expect.objectContaining({
        code: 'recipe_invalid_from_test',
        path: 'recipes[0].steps[1].input.source_id',
      }),
    );
  });
});
