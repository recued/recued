/** D-122 Phase 4.5 — enrichment validator codes.
 *  Three new codes: enrichment_topic_unknown,
 *  enrichment_scope_unsupported, enrichment_value_schema_mismatch. */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'enrichment-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Enrichment Test',
    description: 'A recipe under test for the enrichment validator.',
    author: 'recued',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

const codes = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

describe('D-122 Phase 4.5 — enrichment ref validators', () => {
  it('flags an unknown topic on a per-record ref', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['prefix-{{data.enrichment.contact.bob@x.com.not_a_topic}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
  });

  it('flags an unknown topic on a derived-entity ref', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['{{data.enrichment.not_a_topic.foo}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
  });

  it('flags scope_unsupported when topic does not allow the scope', () => {
    // contact_timeline_rollup is contact-only; mail is not allowed.
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['{{data.enrichment.mail.msg-1.contact_timeline_rollup}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
  });

  it('passes a valid Shape A ref', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['{{data.enrichment.contact.bob@x.com.contact_timeline_rollup}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result).filter((c) => c.startsWith('enrichment_'))).toEqual([]);
  });

  it('passes a valid Shape B ref', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['{{data.enrichment.topic_cluster.cluster_xyz}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result).filter((c) => c.startsWith('enrichment_'))).toEqual([]);
  });

  it('flags trying to address a per-record topic at the top level', () => {
    // contact_timeline_rollup is per_record; addressing it as a Shape B
    // entity is the wrong path shape.
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          transform: 'concat',
          values: ['{{data.enrichment.contact_timeline_rollup.foo}}'],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
  });
});

describe('D-122 Phase 4.5 — enrichment-upsert step value-schema mismatch', () => {
  it('warns when literal value fails the schema', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          // Cast through `any` because the schema validator only inspects
          // the shape at runtime.
          ingredient: 'enrichment-upsert',
          input: {
            topic: 'contact_timeline_rollup',
            scope: 'contact',
            id: 'bob@x.com',
            value: { interaction_count: 'four' }, // wrong type
            authored_by_recipe_id: 'r',
          },
          // Engine signature for the validator: it inspects step.topic
          // / step.value when present at the top level. We surface those
          // here for the static check.
          topic: 'contact_timeline_rollup',
          value: { interaction_count: 'four' },
        } as unknown as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_value_schema_mismatch');
  });

  it('does not warn when value contains a {{ref}}', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          ingredient: 'enrichment-upsert',
          input: {
            topic: 'contact_timeline_rollup',
            scope: 'contact',
            id: 'bob@x.com',
            value: '{{step.noop}}',
            authored_by_recipe_id: 'r',
          },
          topic: 'contact_timeline_rollup',
          value: '{{step.noop}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_value_schema_mismatch');
  });

  it('passes when literal value matches the schema', () => {
    const recipe: RecipeDefinition = {
      ...base,
      // D-128 P6 — `enrichment-upsert` requires the `write_enrichment`
      // staged-trust permission. Declare it so the schema-shape branch
      // exercised here doesn't flag the permission gate as a side
      // effect.
      requires: ['write_enrichment'],
      steps: [
        {
          id: 's',
          ingredient: 'enrichment-upsert',
          input: {
            topic: 'contact_timeline_rollup',
            scope: 'contact',
            id: 'bob@x.com',
            value: {
              interaction_count: 4,
              last_interaction: 1_700_000_000_000,
              recent_subjects: [],
              cursor_at: 1_700_000_000_000,
              window_ms: 30 * 24 * 60 * 60 * 1000,
            },
            authored_by_recipe_id: 'r',
          },
          topic: 'contact_timeline_rollup',
          value: {
            interaction_count: 4,
            last_interaction: 1_700_000_000_000,
            recent_subjects: [],
            cursor_at: 1_700_000_000_000,
            window_ms: 30 * 24 * 60 * 60 * 1000,
          },
        } as unknown as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result).filter((c) => c.startsWith('enrichment_'))).toEqual([]);
  });

  it('flags an unknown topic on the step', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 's',
          ingredient: 'enrichment-upsert',
          input: {
            topic: 'no_such_topic',
            scope: 'contact',
            id: 'bob@x.com',
            value: {},
            authored_by_recipe_id: 'r',
          },
          topic: 'no_such_topic',
          value: {},
        } as unknown as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
  });
});
