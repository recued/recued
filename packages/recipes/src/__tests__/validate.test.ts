import { describe, it, expect } from 'vitest';
import { validateRecipe, isValidRecipe, assertValidRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Known-good sample — a realistic deal risk recipe
// ────────────────────────────────────────────────────────────────

const goodRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 300,
  trigger: ['app.hubspot.com/contacts/*/deal/*'],
  metadata: {
    name: 'Deal Risk Detector',
    description: 'Surfaces three risk indicators on a HubSpot deal: stale activity, expired close date, and disengaged contacts.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    variant_group: 'detect-deal-risk',
    tags: ['deal', 'risk', 'hubspot'],
  },
  variables: {
    max_days_since_activity: 7,
    stale_contact_window_days: 30,
    verbose: false,
  },
  prefetch_steps: [
    { id: 'deal', ingredient: 'deal-reader-hubspot', input: { deal_id: '{{context.entity_id}}' } },
    { id: 'contacts', ingredient: 'deal-contacts-hubspot', input: { deal_id: '{{context.entity_id}}' } },
  ],
  steps: [
    { id: 'days_since', transform: 'date_diff', from: '{{step.deal.last_activity_date}}', to: 'now', unit: 'days',
      skip_when: '{{step.deal.last_activity_date}} is_null' },
    { id: 'activity_risk', transform: 'compare', left: '{{step.days_since}}', operator: 'greater', value: '{{config.max_days_since_activity}}' },
    { id: 'stale_contacts', transform: 'filter', array: '{{step.contacts}}', field: 'last_email_date', operator: 'less', value: '{{config.stale_contact_window_days}}' },
    { id: 'should_ai', transform: 'all', values: ['{{step.activity_risk}}', '{{config.verbose}}'] },
    { id: 'ai_analysis', ingredient: 'ai-prompt',
      input: { 'llm.system_prompt': 'You analyze CRM deal risk.', 'llm.prompt': '{{step.activity_risk}}' },
      skip_when: '{{step.should_ai}} equal false' },
  ],
  output: {
    sidebar: [
      { type: 'summary', source: 'step.days_since' },
      { type: 'ai_analysis', source: 'step.ai_analysis' },
    ],
  },
};

// ────────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────────

const codesOf = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

// ────────────────────────────────────────────────────────────────
// Known-good
// ────────────────────────────────────────────────────────────────

describe('validateRecipe — known-good sample', () => {
  it('the deal risk sample passes with zero errors', () => {
    const result = validateRecipe(goodRecipe);
    const errors = result.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new Error('Sample should have zero errors:\n' +
        errors.map(e => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'));
    }
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Top-level shape
// ────────────────────────────────────────────────────────────────

describe('top-level shape', () => {
  it('null → recipe_not_object', () => {
    expect(codesOf(validateRecipe(null))).toContain('recipe_not_object');
  });
  it('array → recipe_not_object', () => {
    expect(codesOf(validateRecipe([]))).toContain('recipe_not_object');
  });
  it('empty object → multiple required_* errors', () => {
    const codes = codesOf(validateRecipe({}));
    expect(codes).toEqual(expect.arrayContaining([
      'recipe_id_required', 'version_invalid', 'ttl_invalid',
      'metadata_required', 'output_required',
    ]));
  });
});

describe('unsupported approval fields', () => {
  it.each(['prefetch_steps', 'steps', 'trigger_steps'] as const)(
    'rejects ignored requires_approval in %s',
    (field) => {
      const step = field === 'trigger_steps'
        ? { id: 'watch', ingredient: 'time-watcher', requires_approval: true }
        : { id: 'read', ingredient: 'deal-reader-hubspot', input: {}, requires_approval: true };
      const candidate = {
        ...goodRecipe,
        ...(field === 'trigger_steps' ? { auto_run: { interval_seconds: 300 } } : {}),
        [field]: [step],
      };
      const issue = validateRecipe(candidate).issues.find(
        ({ code }) => code === 'step_requires_approval_unsupported',
      );
      expect(issue).toMatchObject({
        severity: 'error',
        path: `${field}[0].requires_approval`,
      });
    },
  );
});

// ────────────────────────────────────────────────────────────────
// recipe_id convention
// ────────────────────────────────────────────────────────────────

describe('recipe_id convention', () => {
  it('uppercase → recipe_id_not_lowercase', () => {
    const m = { ...goodRecipe, recipe_id: 'Detect-Deal-Risk-Hubspot' };
    expect(codesOf(validateRecipe(m))).toContain('recipe_id_not_lowercase');
  });
  it('whitespace → recipe_id_has_whitespace', () => {
    const m = { ...goodRecipe, recipe_id: 'detect deal risk' };
    expect(codesOf(validateRecipe(m))).toContain('recipe_id_has_whitespace');
  });
  it('underscores/invalid chars → recipe_id_invalid_chars', () => {
    const m = { ...goodRecipe, recipe_id: 'detect_deal_risk' };
    expect(codesOf(validateRecipe(m))).toContain('recipe_id_invalid_chars');
  });
  it('leading hyphen → recipe_id_edge_hyphen', () => {
    const m = { ...goodRecipe, recipe_id: '-detect-deal-risk' };
    expect(codesOf(validateRecipe(m))).toContain('recipe_id_edge_hyphen');
  });
  it('trailing hyphen → recipe_id_edge_hyphen', () => {
    const m = { ...goodRecipe, recipe_id: 'detect-deal-risk-' };
    expect(codesOf(validateRecipe(m))).toContain('recipe_id_edge_hyphen');
  });
});

// ────────────────────────────────────────────────────────────────
// Versions + TTL
// ────────────────────────────────────────────────────────────────

describe('version and ttl', () => {
  it('version 0 → version_invalid', () => {
    const m = { ...goodRecipe, version: 0 };
    expect(codesOf(validateRecipe(m))).toContain('version_invalid');
  });
  it('version as string → version_invalid', () => {
    const m = { ...goodRecipe, version: '1' as unknown as number };
    expect(codesOf(validateRecipe(m))).toContain('version_invalid');
  });
  it('ttl negative → ttl_invalid', () => {
    const m = { ...goodRecipe, ttl: -10 };
    expect(codesOf(validateRecipe(m))).toContain('ttl_invalid');
  });
  it('ttl 0 is allowed (no caching)', () => {
    const m = { ...goodRecipe, ttl: 0 };
    expect(codesOf(validateRecipe(m))).not.toContain('ttl_invalid');
  });
});

// ────────────────────────────────────────────────────────────────
// Trigger patterns
// ────────────────────────────────────────────────────────────────

describe('trigger', () => {
  it('not an array → trigger_shape', () => {
    const m = { ...goodRecipe, trigger: 'app.hubspot.com/*' as unknown as string[] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_shape');
  });
  it('empty array → warn trigger_empty', () => {
    const m = { ...goodRecipe, trigger: [] };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('trigger_empty');
    expect(result.valid).toBe(true);
  });
  it('pattern with no dot → warn trigger_pattern_no_domain', () => {
    const m = { ...goodRecipe, trigger: ['somepage/*'] };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('trigger_pattern_no_domain');
    expect(result.valid).toBe(true);
  });
  it('omitting trigger entirely is fine', () => {
    const { trigger, ...rest } = goodRecipe;
    void trigger;
    const codes = codesOf(validateRecipe(rest));
    expect(codes).not.toContain('trigger_shape');
  });
});

// ────────────────────────────────────────────────────────────────
// Metadata
// ────────────────────────────────────────────────────────────────

describe('metadata', () => {
  it('missing name → name_required', () => {
    const m = { ...goodRecipe, metadata: { ...goodRecipe.metadata, name: '' } };
    expect(codesOf(validateRecipe(m))).toContain('name_required');
  });
  it('missing description → description_required', () => {
    const m = { ...goodRecipe, metadata: { ...goodRecipe.metadata, description: '' } };
    expect(codesOf(validateRecipe(m))).toContain('description_required');
  });
  it('short description → info description_thin', () => {
    const m = { ...goodRecipe, metadata: { ...goodRecipe.metadata, description: 'Too short.' } };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('description_thin');
    expect(result.valid).toBe(true);
  });
  it('placeholder author → warn author_placeholder', () => {
    const m = { ...goodRecipe, metadata: { ...goodRecipe.metadata, author: 'TODO' } };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('author_placeholder');
    expect(result.valid).toBe(true);
  });
  it('missing supported_platforms → platforms_required', () => {
    const { supported_platforms, ...restMeta } = goodRecipe.metadata;
    void supported_platforms;
    const m = { ...goodRecipe, metadata: restMeta };
    expect(codesOf(validateRecipe(m))).toContain('platforms_required');
  });
  it('tags missing → warn', () => {
    const { tags, ...restMeta } = goodRecipe.metadata;
    void tags;
    const m = { ...goodRecipe, metadata: restMeta };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('tags_missing');
    expect(result.valid).toBe(true);
  });
  it('thin tags (< 3) → info tags_thin', () => {
    const m = { ...goodRecipe, metadata: { ...goodRecipe.metadata, tags: ['deal'] } };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('tags_thin');
    expect(result.valid).toBe(true);
  });
  it('variant_group missing for platform-suffixed recipe_id → info', () => {
    const { variant_group, ...restMeta } = goodRecipe.metadata;
    void variant_group;
    const m = { ...goodRecipe, metadata: restMeta };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('variant_group_missing');
    expect(result.valid).toBe(true);
  });
  it('fork_of missing version → fork_of_version', () => {
    const m = {
      ...goodRecipe,
      metadata: {
        ...goodRecipe.metadata,
        fork_of: { recipe_id: 'original', author: 'someone' } as unknown as {
          recipe_id: string; author: string; version: number;
        },
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('fork_of_version');
  });
});

// ────────────────────────────────────────────────────────────────
// Step IDs
// ────────────────────────────────────────────────────────────────

describe('step IDs', () => {
  it('reserved name "step" → step_id_reserved', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [{ id: 'step', ingredient: 'deal-reader-hubspot' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_reserved');
  });
  it('reserved name "config" → step_id_reserved', () => {
    const m = {
      ...goodRecipe,
      steps: [{ id: 'config', transform: 'count', input: '{{step.deal}}' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_reserved');
  });
  it('prototype-sensitive names → step_id_reserved', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const m = {
        ...goodRecipe,
        steps: [{ id, transform: 'count', input: '{{step.deal}}' }],
      };
      expect(codesOf(validateRecipe(m))).toContain('step_id_reserved');
    }
  });
  it('invalid characters → step_id_invalid', () => {
    const m = {
      ...goodRecipe,
      steps: [{ id: 'has-hyphen', transform: 'count', input: '{{step.deal}}' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_invalid');
  });
  it('duplicate ids → step_id_duplicate', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [
        { id: 'deal', ingredient: 'deal-reader-hubspot' },
        { id: 'deal', ingredient: 'deal-contacts-hubspot' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_duplicate');
  });
  it('prefetch id duplicated in sequential steps → step_id_duplicate', () => {
    const m = {
      ...goodRecipe,
      steps: [
        ...goodRecipe.steps,
        { id: 'deal', transform: 'count', input: '{{step.contacts}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_duplicate');
  });
});

describe('step discriminators', () => {
  it('no discriminator → step_no_discriminator', () => {
    const m = {
      ...goodRecipe,
      steps: [{ id: 'empty_step' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_no_discriminator');
  });
  it('multiple discriminators → step_multi_discriminator', () => {
    const m = {
      ...goodRecipe,
      steps: [{ id: 'hybrid', transform: 'count', ingredient: 'something', input: '{{step.deal}}' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('step_multi_discriminator');
  });
  it('prefetch step with transform → prefetch_has_transform', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [{ id: 'bad', ingredient: 'deal-reader-hubspot', transform: 'count' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('prefetch_has_transform');
  });
  it('prefetch step with guard → prefetch_has_guard', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [{ id: 'bad', ingredient: 'deal-reader-hubspot', guard: 'something is_null' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('prefetch_has_guard');
  });
});

// ────────────────────────────────────────────────────────────────
// Conditions
// ────────────────────────────────────────────────────────────────

describe('condition syntax', () => {
  it('"or" in condition → condition_compound', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.a}} equal true or {{step.b}} equal true' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_compound');
  });
  it('"and" in condition → condition_compound', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.a}} is_null and {{step.b}} is_null' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_compound');
  });
  it('invalid operator → condition_operator_invalid', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.days}} == 7' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_operator_invalid');
  });
  it('unary operator with value → condition_unary_has_value', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.deal}} is_null something' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_unary_has_value');
  });
  it('binary operator missing value → condition_binary_missing_value', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.days}} greater' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_binary_missing_value');
  });
  it('object-form condition with bad operator → condition_object_operator', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: { field: '{{step.x}}', operator: 'matches', value: 'foo' },
        } as unknown as RecipeDefinition['steps'][0],
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('condition_object_operator');
  });
  it('valid unary "is_null" passes', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{step.deal}} is_null' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes.filter(c => c.startsWith('condition_'))).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Model hint
// ────────────────────────────────────────────────────────────────

describe('llm.model_hint', () => {
  it('invalid hint → invalid_model_hint', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'ai', ingredient: 'ai-prompt',
          input: { 'llm.prompt': 'hi', 'llm.model_hint': 'gpt-4o' } },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('invalid_model_hint');
  });
  it('valid hints (fast/quality/thinking) pass', () => {
    for (const hint of ['fast', 'quality', 'thinking']) {
      const m = {
        ...goodRecipe,
        steps: [
          { id: 'ai', ingredient: 'ai-prompt',
            input: { 'llm.prompt': 'hi', 'llm.model_hint': hint } },
        ],
      };
      expect(codesOf(validateRecipe(m))).not.toContain('invalid_model_hint');
    }
  });
  it('null hint (recipe-supplied, executor defaults to quality) passes', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'ai', ingredient: 'ai-prompt',
          input: { 'llm.prompt': 'hi', 'llm.model_hint': null } },
      ],
    };
    expect(codesOf(validateRecipe(m))).not.toContain('invalid_model_hint');
  });
});

// ────────────────────────────────────────────────────────────────
// References
// ────────────────────────────────────────────────────────────────

describe('references', () => {
  it('{{config.undefined_var}} → undeclared_variable_ref', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.deal}}',
          skip_when: '{{config.nonexistent}} is_null' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('undeclared_variable_ref');
  });
  it('{{step.undefined}} → undeclared_step_ref', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{step.never_existed}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('undeclared_step_ref');
  });
  it('{{vault.X}} → vault_ref_in_recipe', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{vault.hubspot.token}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('vault_ref_in_recipe');
  });
  it('{{account.X}} → unknown_namespace (D-125 P5.2 retired account.*)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{account.slack.token}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('unknown_namespace');
  });
  it('{{unknown_ns.X}} → unknown_namespace', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{made_up.thing}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('unknown_namespace');
  });
  it('nested template → nested_template', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'template', template: 'days: {{step.deal.{{config.max_days_since_activity}}}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('nested_template');
  });
  it('unused variable → warn unused_variable', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, never_used: 42 },
    };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('unused_variable');
    expect(result.valid).toBe(true);
  });
  it('valid {{context.X}} passes (free-form namespace)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'count', input: '{{context.entity_id}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).not.toContain('unknown_namespace');
  });
  it('valid {{meta.X}} passes', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 's', transform: 'template', template: 'recipe: {{meta.name}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).not.toContain('unknown_namespace');
  });
});

// ────────────────────────────────────────────────────────────────
// Output section
// ────────────────────────────────────────────────────────────────

describe('output', () => {
  it('output.sidebar not an array → output_sidebar_shape', () => {
    const m = { ...goodRecipe, output: { sidebar: 'x' as unknown as [] } };
    expect(codesOf(validateRecipe(m))).toContain('output_sidebar_shape');
    expect(codesOf(validateRecipe(m))).not.toContain('output_render_shape');
  });
  it('missing render and sidebar points authors to output.render', () => {
    const m = { ...goodRecipe, output: {} };
    expect(codesOf(validateRecipe(m))).toContain('output_render_shape');
    expect(codesOf(validateRecipe(m))).not.toContain('output_sidebar_shape');
  });
  it('output.render is accepted as the canonical output field', () => {
    const m = {
      ...goodRecipe,
      output: {
        render: [
          { type: 'summary' as const, source: 'step.days_since' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).not.toContain('output_sidebar_shape');
    expect(codesOf(validateRecipe(m))).not.toContain('output_render_shape');
  });
  it('file_artifact is accepted as a closed output.render section type', () => {
    const m = {
      ...goodRecipe,
      output: {
        render: [
          { type: 'file_artifact' as const, source: 'step.days_since' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).not.toContain('output_section_type_invalid');
  });
  it('output.render shape errors use output_render_shape', () => {
    const m = { ...goodRecipe, output: { render: 'x' as unknown as [] } };
    expect(codesOf(validateRecipe(m))).toContain('output_render_shape');
  });
  it('render wins over sidebar and emits a migration warning', () => {
    const m = {
      ...goodRecipe,
      output: {
        render: [
          { type: 'summary' as const, source: 'step.days_since' },
        ],
        sidebar: [
          { type: 'custom' as unknown as 'summary', source: 'step.nonexistent' },
        ],
      },
    };
    const result = validateRecipe(m);
    expect(result.issues.some((i) => i.code === 'output_sidebar_ignored' && i.severity === 'warn')).toBe(true);
    expect(codesOf(result)).not.toContain('output_section_type_invalid');
    expect(codesOf(result)).not.toContain('output_source_not_a_step');
  });
  it('button is an accepted output section type', () => {
    const m = {
      ...goodRecipe,
      output: {
        render: [
          { type: 'button' as const, source: 'step.days_since' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).not.toContain('output_section_type_invalid');
  });
  it('section with invalid type → output_section_type_invalid', () => {
    const m = {
      ...goodRecipe,
      output: {
        sidebar: [
          { type: 'custom' as unknown as 'summary', source: 'step.days_since' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('output_section_type_invalid');
  });
  it('section source not starting with "step." → output_source_format', () => {
    const m = {
      ...goodRecipe,
      output: {
        sidebar: [
          { type: 'summary' as const, source: 'days_since' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('output_source_format');
  });
  it('section source references nonexistent step → output_source_not_a_step', () => {
    const m = {
      ...goodRecipe,
      output: {
        sidebar: [
          { type: 'summary' as const, source: 'step.nonexistent' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('output_source_not_a_step');
  });
  it('valid output with step.X.path form', () => {
    const m = {
      ...goodRecipe,
      output: {
        sidebar: [
          { type: 'summary' as const, source: 'step.days_since.raw_value' },
        ],
      },
    };
    expect(codesOf(validateRecipe(m))).not.toContain('output_source_not_a_step');
  });
});

describe('metadata.recipe_bundle', () => {
  it('accepts a well-formed standalone bundle key', () => {
    const result = validateRecipe({
      ...goodRecipe,
      metadata: {
        ...goodRecipe.metadata,
        recipe_bundle: 'recued-core/outbound-follow-up-response',
      },
    });
    expect(codesOf(result)).not.toContain('recipe_bundle_format');
    expect(codesOf(result)).not.toContain('handle_format');
    expect(codesOf(result)).not.toContain('slug_format');
  });

  it('rejects malformed bundle keys during standalone recipe validation', () => {
    const result = validateRecipe({
      ...goodRecipe,
      metadata: {
        ...goodRecipe.metadata,
        recipe_bundle: 'recued-core/outbound_follow-up',
      },
    });
    expect(codesOf(result)).toContain('slug_format');
  });
});

// ────────────────────────────────────────────────────────────────
// Variables
// ────────────────────────────────────────────────────────────────

describe('variables', () => {
  it('reserved name → variable_name_reserved', () => {
    const m = { ...goodRecipe, variables: { ...goodRecipe.variables, config: 10 } };
    expect(codesOf(validateRecipe(m))).toContain('variable_name_reserved');
  });
  it('invalid identifier → variable_name_invalid', () => {
    const m = { ...goodRecipe, variables: { ...goodRecipe.variables, 'bad-name': 10 } };
    expect(codesOf(validateRecipe(m))).toContain('variable_name_invalid');
  });
  it('variable shadowing a step id → warn variable_shadows_step', () => {
    const m = { ...goodRecipe, variables: { ...goodRecipe.variables, deal: 'shadow' } };
    const result = validateRecipe(m);
    expect(codesOf(result)).toContain('variable_shadows_step');
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Convenience wrappers
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Transform param schemas (required params + literal type checks)
// ────────────────────────────────────────────────────────────────

describe('transform param schemas', () => {
  it('unknown transform name → unknown_transform', () => {
    const m = {
      ...goodRecipe,
      steps: [{ id: 'bad', transform: 'not_a_transform', input: '{{step.deal}}' }],
    };
    expect(codesOf(validateRecipe(m))).toContain('unknown_transform');
  });

  it('filter missing array → transform_missing_param', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_filter', transform: 'filter', field: 'stage', operator: 'equal', value: 'won' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_missing_param');
  });

  it('filter missing the single required param (array) → one transform_missing_param', () => {
    // field/operator are optional since filter also accepts a `conditions`
    // array mode (each entry there carries its own field/operator).
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'empty_filter', transform: 'filter' },
      ],
    };
    const result = validateRecipe(m);
    const missing = result.issues.filter(i => i.code === 'transform_missing_param');
    expect(missing.length).toBe(1); // array
  });

  it('reduce missing operator → transform_missing_param', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_reduce', transform: 'reduce', array: '{{step.contacts}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_missing_param');
  });

  it('group_by missing field → transform_missing_param', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_group', transform: 'group_by', array: '{{step.contacts}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_missing_param');
  });

  it('date_diff missing unit → transform_missing_param', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_date', transform: 'date_diff', from: '{{step.deal.created_at}}', to: 'now' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_missing_param');
  });

  it('math with unary operator and no right → no error (unary ops ignore right)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'abs_value', transform: 'math', left: -5, operator: 'abs' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.abs_value' }] },
    };
    const result = validateRecipe(m);
    const errors = result.issues.filter((i) => i.severity === 'error' && i.code.startsWith('transform_'));
    expect(errors).toEqual([]);
  });

  it('literal wrong-type param → transform_param_wrong_type', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_type', transform: 'filter', array: 42, field: 'stage', operator: 'equal' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_param_wrong_type');
  });

  it('literal wrong-type number → transform_param_wrong_type', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_clamp', transform: 'clamp', input: 10, min: 'low', max: 100 },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_param_wrong_type');
  });

  it('literal wrong-type array → transform_param_wrong_type', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_concat', transform: 'concat', values: 'not an array' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('transform_param_wrong_type');
  });

  it('reference value skipped for type check (cannot resolve at validate time)', () => {
    // array must be an array — but the value is a reference. The validator
    // cannot know what it resolves to, so type-checking is skipped.
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'ref_array', transform: 'filter', array: '{{step.deal}}', field: 'stage', operator: 'equal', value: 'won' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_wrong_type');
  });

  it('literal number param accepted as number type', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, lookback: 30 },
      steps: [
        { id: 'good_slice', transform: 'slice', array: '{{step.contacts}}', start: 0, end: 10 },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_wrong_type');
  });

  it('null param values skipped (treated as recipe-supplied / optional)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'null_val', transform: 'filter', array: '{{step.contacts}}', field: 'stage', operator: 'is_null', value: null },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_wrong_type');
  });

  it('all/any with values param passes (exception list)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'any_check', transform: 'any', values: ['{{step.activity_risk}}', true] },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes.filter(c => c.startsWith('transform_'))).toEqual([]);
  });

  // ── Enum validation on operator-family params ────────────
  it('filter with invalid operator → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_filter', transform: 'filter',
          array: '{{step.contacts}}', field: 'stage', operator: 'bogus' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('filter with valid operator → no enum error', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'good_filter', transform: 'filter',
          array: '{{step.contacts}}', field: 'stage', operator: 'equal', value: 'won' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('sort with invalid direction → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_sort', transform: 'sort',
          array: '{{step.contacts}}', field: 'name', direction: 'ascending' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('sort with asc/desc → no enum error', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'good_sort', transform: 'sort',
          array: '{{step.contacts}}', field: 'name', direction: 'desc' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('math with invalid operator → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_math', transform: 'math', left: 10, operator: 'power', right: 2 },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('math with "mod" is invalid — canonical name is "modulo"', () => {
    // Common mistake: `mod` vs `modulo`. The runtime only accepts `modulo`.
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_mod', transform: 'math', left: 10, operator: 'mod', right: 3 },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('math with valid operator → no enum error', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'good_math', transform: 'math', left: 10, operator: 'modulo', right: 3 },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('reduce with invalid operator → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_reduce', transform: 'reduce',
          array: '{{step.contacts}}', operator: 'median' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('reduce with sum/count/avg/min/max → no enum error', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'good_reduce', transform: 'reduce',
          array: '{{step.contacts}}', operator: 'avg', field: 'score' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('date_diff with invalid unit → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_dd', transform: 'date_diff',
          from: '{{step.deal.created_at}}', to: 'now', unit: 'weeks' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('date_diff with canonical unit → no enum error', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'good_dd', transform: 'date_diff',
          from: '{{step.deal.created_at}}', to: 'now', unit: 'days' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('date_add with invalid unit → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_da', transform: 'date_add',
          date: '{{step.deal.close_date}}', amount: 5, unit: 'years' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('compare with invalid operator → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_cmp', transform: 'compare',
          left: '{{step.days_since}}', operator: 'greaterThan', value: 10 },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('find with invalid operator → transform_param_invalid_enum', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'bad_find', transform: 'find',
          array: '{{step.contacts}}', field: 'email', operator: 'matches', value: '@example' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('transform_param_invalid_enum');
  });

  it('enum check is skipped for reference values', () => {
    // A recipe might legitimately parameterize the operator via a variable.
    // The validator can't know the runtime value, so skip the enum check.
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, op: 'equal' },
      steps: [
        { id: 'dyn_op', transform: 'filter',
          array: '{{step.contacts}}', field: 'stage',
          operator: '{{config.op}}', value: 'won' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('transform_param_invalid_enum');
  });

  it('wrong type takes precedence over enum — only type error reported', () => {
    // If operator is a number instead of a string, validator reports the
    // type error and skips the enum check (avoids double-reporting).
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'wrong_type', transform: 'filter',
          array: '{{step.contacts}}', field: 'stage', operator: 42 },
      ],
    };
    const result = validateRecipe(m);
    const typeErrors = result.issues.filter((i) => i.code === 'transform_param_wrong_type');
    const enumErrors = result.issues.filter((i) => i.code === 'transform_param_invalid_enum');
    expect(typeErrors.length).toBe(1);
    expect(enumErrors.length).toBe(0);
  });

  it('complete good transform step passes with zero schema errors', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'clean_filter', transform: 'filter',
          array: '{{step.contacts}}', field: 'last_email_date', operator: 'less', value: '{{config.stale_contact_window_days}}' },
      ],
    };
    const result = validateRecipe(m);
    const schemaErrors = result.issues.filter(i =>
      i.code === 'unknown_transform' ||
      i.code === 'transform_missing_param' ||
      i.code === 'transform_param_wrong_type',
    );
    expect(schemaErrors).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 2: Quality checks
// ────────────────────────────────────────────────────────────────

/** Helper to extract issues with a given code at any severity. */
const issuesOf = (
  result: ReturnType<typeof validateRecipe>,
  code: string,
) => result.issues.filter((i) => i.code === code);

describe('phase 2: orphan prefetch', () => {
  it('prefetch step output unused downstream → orphan_prefetch info', () => {
    const recipe = {
      ...goodRecipe,
      prefetch_steps: [
        { id: 'deal', ingredient: 'deal-reader-hubspot', input: { deal_id: '{{context.entity_id}}' } },
        { id: 'unused_fetch', ingredient: 'x-reader', input: {} },
      ],
    };
    const result = validateRecipe(recipe);
    const orphans = issuesOf(result, 'orphan_prefetch');
    expect(orphans.length).toBe(1);
    expect(orphans[0].severity).toBe('info');
    expect(orphans[0]).toMatchObject({ code: 'orphan_prefetch' });
  });
  it('used prefetch step → no orphan_prefetch', () => {
    const result = validateRecipe(goodRecipe);
    expect(issuesOf(result, 'orphan_prefetch').length).toBe(0);
  });
});

describe('phase 2: orphan sequential step', () => {
  it('step with unused output → orphan_step info', () => {
    // goodRecipe's stale_contacts is never referenced — that's our fixture
    const result = validateRecipe(goodRecipe);
    const orphans = issuesOf(result, 'orphan_step');
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans.some((o) => o.severity === 'info')).toBe(true);
  });
  it('guard steps are not flagged as orphan even if result unused', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'empty_check', guard: '{{step.deal}} is_not_null' },
        { id: 'followup', transform: 'template', template: 'ok' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.followup' }] },
    };
    const result = validateRecipe(recipe);
    const orphans = issuesOf(result, 'orphan_step');
    expect(orphans.some((o) => o.path.includes('[0]'))).toBe(false);
  });
});

describe('phase 2: guard before AI', () => {
  it('AI step with no skip_when and no prior guard → no_guard_before_ai info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ai_cold', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': 'x' } },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_cold' }] },
    };
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'no_guard_before_ai');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });
  it('AI step with skip_when → no finding', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ai_gated', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': 'x' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_gated' }] },
    };
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'no_guard_before_ai').length).toBe(0);
  });
});

describe('phase 2: hash_replace / hash_restore pairing', () => {
  it('AI without any PII declaration → no_hash_before_ai info, pointing to llm.pii_fields', () => {
    const result = validateRecipe(goodRecipe);
    const issues = issuesOf(result, 'no_hash_before_ai');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("AI step's llm.pii_fields");
    expect(issues[0].message).not.toContain('hash_replace');
  });
  it('llm.pii_fields or a pii-protect bracket counts as a declaration', () => {
    const classify = {
      id: 'ai_classify', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['at_risk', 'healthy'] },
      skip_when: '{{config.verbose}} equal false',
    };
    const withSteps = (steps: unknown[]) => ({
      ...goodRecipe, steps, output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_classify' }] },
    }) as unknown as RecipeDefinition;
    const tagged = withSteps([{ ...classify, input: { ...classify.input, 'llm.pii_fields': { owner_email: 'email' } } }]);
    const bracketed = withSteps([
      { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'owner_email', kind: 'email' }] },
      { ...classify, input: { ...classify.input, 'llm.data': '{{step.protect.aliased}}' } },
    ]);
    expect(issuesOf(validateRecipe(withSteps([classify])), 'no_hash_before_ai').length).toBe(1);
    expect(issuesOf(validateRecipe(tagged), 'no_hash_before_ai').length).toBe(0);
    expect(issuesOf(validateRecipe(bracketed), 'no_hash_before_ai').length).toBe(0);
  });
  it('hash_replace without hash_restore → missing_hash_restore warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', source: '{{step.deal}}', fields: ['email'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'missing_hash_restore');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
    // no_hash_before_ai should NOT fire when hash_replace is present
    expect(issuesOf(result, 'no_hash_before_ai').length).toBe(0);
  });
  it('hash_replace + hash_restore → no finding', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', source: '{{step.deal}}', fields: ['email'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed}}' },
          skip_when: '{{config.verbose}} equal false' },
        { id: 'restored', transform: 'hash_restore', source: '{{step.ai_x}}' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.restored' }] },
    };
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'missing_hash_restore').length).toBe(0);
    expect(issuesOf(result, 'no_hash_before_ai').length).toBe(0);
  });
});

describe('phase 2: pii-protect / pii-restore guidance', () => {
  it('AI recipe + hash_replace on snake_case PII field → prefer_pii_protect info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', data: '{{step.deal}}', fields: ['contact.email'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'prefer_pii_protect');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });
  it('AI recipe + hash_replace on camelCase PII field → prefer_pii_protect info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', data: '{{step.deal}}', fields: ['ownerName'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'prefer_pii_protect');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });
  it('AI recipe + hash_replace on non-PII boundary fields → no prefer_pii_protect', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed_user', transform: 'hash_replace', data: '{{step.deal}}', fields: ['username'] },
        { id: 'hashed_file', transform: 'hash_replace', data: '{{step.hashed_user}}', fields: ['filename'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed_file}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'prefer_pii_protect').length).toBe(0);
  });
  it('data-only recipe + hash_replace on PII field → no prefer_pii_protect', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', data: '{{step.deal}}', fields: ['email'] },
        { id: 'use', transform: 'template', template: '{{step.hashed}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.use' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'prefer_pii_protect').length).toBe(0);
  });
  it('hash_replace + hash_restore still nudges toward pii-protect for AI', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', data: '{{step.deal}}', fields: ['email'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed}}' },
          skip_when: '{{config.verbose}} equal false' },
        { id: 'restored', transform: 'hash_restore', data: '{{step.ai_x}}', mapping: '{{step.hashed.mapping}}' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.restored' }] },
    };
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'prefer_pii_protect');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
    expect(issuesOf(result, 'missing_hash_restore').length).toBe(0);
  });
  it('pii-protect without pii-restore → missing_pii_restore warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.protect.aliased}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'missing_pii_restore');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('pii-protect + pii-restore → no missing_pii_restore', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.protect.aliased}}' },
          skip_when: '{{config.verbose}} equal false' },
        { id: 'restore', transform: 'pii-restore', data: '{{step.ai_x}}', ledger_handle: '{{step.protect.ledger_handle}}' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.restore' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'missing_pii_restore').length).toBe(0);
  });
  it('multiple hash_replace steps on PII fields → one prefer_pii_protect per step', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed_email', transform: 'hash_replace', data: '{{step.deal}}', fields: ['email'] },
        { id: 'hashed_phone', transform: 'hash_replace', data: '{{step.hashed_email}}', fields: ['phone'] },
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Analyze this data carefully and produce a detailed report with specific action items.', 'llm.prompt': '{{step.hashed_phone}}' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'prefer_pii_protect');
    expect(issues.length).toBe(2);
    expect(issues[0].severity).toBe('info');
    expect(issues[1].severity).toBe('info');
  });
});

describe('phase 2: pii_protect_bad_field_tag', () => {
  it('typoed kind -> pii_protect_bad_field_tag error', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'emial' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('error');
  });

  it('missing path -> pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ kind: 'email' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(1);
  });

  it('non-object entry -> pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: ['email'] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(1);
  });

  it('valid tag -> no pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(0);
  });

  it('kind content is valid -> no pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'body', kind: 'content' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(0);
  });

  it('empty fields -> no pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(0);
  });

  it('absent fields -> no pii_protect_bad_field_tag', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(0);
  });

  it('two malformed entries -> two pii_protect_bad_field_tag findings', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'emial' }, { kind: 'name' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(2);
  });

  it('null fields -> no pii_protect_bad_field_tag (no-op)', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: null },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'pii_protect_bad_field_tag').length).toBe(0);
  });
});

describe('phase 2: unguarded division', () => {
  it('math divide without skip_when → unguarded_division warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ratio', transform: 'math', operator: 'divide', left: 10, right: '{{step.deal.count}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ratio' }] },
    };
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'unguarded_division');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('math divide with skip_when → no finding', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ratio', transform: 'math', operator: 'divide', left: 10, right: '{{step.deal.count}}',
          skip_when: '{{step.deal.count}} equal 0' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ratio' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'unguarded_division').length).toBe(0);
  });
  it('math multiply is not flagged', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'product', transform: 'math', operator: 'multiply', left: 10, right: 3 },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.product' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'unguarded_division').length).toBe(0);
  });
});

describe('phase 2: TTL floor', () => {
  it('AI recipe with ttl < 300 → ttl_below_floor info', () => {
    const recipe = { ...goodRecipe, ttl: 60 };
    const issues = issuesOf(validateRecipe(recipe), 'ttl_below_floor');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toMatch(/300s/);
  });
  it('data-only recipe with ttl < 60 → ttl_below_floor info', () => {
    const recipe = {
      ...goodRecipe,
      ttl: 30,
      steps: [
        { id: 'noop', transform: 'template', template: 'hello' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'ttl_below_floor');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toMatch(/60s/);
  });
  it('AI recipe with ttl >= 300 → no finding', () => {
    expect(issuesOf(validateRecipe(goodRecipe), 'ttl_below_floor').length).toBe(0);
  });
});

describe('phase 2: placeholder step IDs', () => {
  it('placeholder id like "foo" or "test" → placeholder_id info', () => {
    const recipe = {
      ...goodRecipe,
      prefetch_steps: [
        { id: 'foo', ingredient: 'deal-reader-hubspot', input: {} },
      ],
      steps: [
        { id: 'test', transform: 'template', template: '{{step.foo}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.test' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'placeholder_id');
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.severity === 'info')).toBe(true);
  });
});

describe('phase 2: output determinism', () => {
  it('all sidebar sections ai_analysis → no_deterministic_output warn', () => {
    const recipe = {
      ...goodRecipe,
      output: {
        sidebar: [
          { type: 'ai_analysis', source: 'step.ai_analysis' },
        ],
      },
    };
    const issues = issuesOf(validateRecipe(recipe), 'no_deterministic_output');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('all render sections ai_analysis → no_deterministic_output warn', () => {
    const recipe = {
      ...goodRecipe,
      output: {
        render: [
          { type: 'ai_analysis', source: 'step.ai_analysis' },
        ],
      },
    };
    const issues = issuesOf(validateRecipe(recipe), 'no_deterministic_output');
    expect(issues.length).toBe(1);
    expect(issues[0].path).toBe('output.render');
    expect(issues[0].severity).toBe('warn');
  });
  it('mixed sidebar → no finding', () => {
    expect(issuesOf(validateRecipe(goodRecipe), 'no_deterministic_output').length).toBe(0);
  });
});

describe('phase 2: empty no-op transforms', () => {
  it('hash_replace with empty fields → empty_hash_replace warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'empty_hash', transform: 'hash_replace', source: '{{step.deal}}', fields: [] },
        { id: 'use', transform: 'template', template: '{{step.empty_hash}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.use' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'empty_hash_replace');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('pick with no source and no keys → empty_pick warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'empty_pick', transform: 'pick' },
        { id: 'use', transform: 'template', template: '{{step.empty_pick}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.use' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'empty_pick');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('hash_replace with fields → no finding', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'hashed', transform: 'hash_replace', source: '{{step.deal}}', fields: ['email'] },
        { id: 'use', transform: 'template', template: '{{step.hashed}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.use' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'empty_hash_replace').length).toBe(0);
  });
});

describe('phase 2: ai-prompt system_prompt length', () => {
  it('missing system_prompt → ai_prompt_missing_system warn', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ai_x', ingredient: 'ai-prompt', input: { 'llm.prompt': 'x' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'ai_prompt_missing_system');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('short system_prompt (< 80 chars) → ai_prompt_vague info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': 'Short prompt.', 'llm.prompt': 'x' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'ai_prompt_vague');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });
  it('long system_prompt → no finding', () => {
    const longPrompt = 'You are a careful CRM analyst. Identify each risk dimension, cite specific step outputs, and format the response as a bulleted list with one line per finding.';
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'ai_x', ingredient: 'ai-prompt',
          input: { 'llm.system_prompt': longPrompt, 'llm.prompt': 'x' },
          skip_when: '{{config.verbose}} equal false' },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai_x' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'ai_prompt_vague').length).toBe(0);
    expect(issuesOf(validateRecipe(recipe), 'ai_prompt_missing_system').length).toBe(0);
  });
});

/** Every shipped AI step is written `op: "core.ai.*"`, its payload in `args` (371
 *  steps in 328 recipes on 2026-10-06, none in ingredient form). The AI checks found
 *  AI steps by `ingredient` alone, so they ran on none of them. */
describe('phase 2: the AI checks see an op step', () => {
  const GATED = '{{config.verbose}} equal false';
  const withStep = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...goodRecipe,
    steps: [step],
    output: { sidebar: [{ type: 'ai_analysis', source: `step.${String(step.id)}` }] },
    ...extra,
  }) as unknown as RecipeDefinition;
  const summarize = (args: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
    id: 'brief', op: 'core.ai.summarize', args: { 'llm.data': '{{step.deal}}', ...args }, ...more,
  });

  it('guard before AI', () => {
    expect(issuesOf(validateRecipe(withStep(summarize())), 'no_guard_before_ai')).toEqual([
      expect.objectContaining({ severity: 'info', path: 'steps[0]' }),
    ]);
    expect(issuesOf(validateRecipe(withStep(summarize({}, { skip_when: GATED }))), 'no_guard_before_ai')).toEqual([]);
  });

  it('no PII declaration — and llm.pii_fields in args is one', () => {
    expect(issuesOf(validateRecipe(withStep(summarize())), 'no_hash_before_ai')).toHaveLength(1);
    const tagged = withStep(summarize({ 'llm.pii_fields': { owner_email: 'email' } }));
    expect(issuesOf(validateRecipe(tagged), 'no_hash_before_ai')).toEqual([]);
  });

  it('pii-protect over a hash_replace of an identifier', () => {
    const recipe = {
      ...withStep(summarize()),
      steps: [
        { id: 'hashed', transform: 'hash_replace', source: '{{step.deal}}', fields: ['owner_email'] },
        summarize({ 'llm.data': '{{step.hashed}}' }, { skip_when: GATED }),
        { id: 'restored', transform: 'hash_restore', source: '{{step.brief}}' },
      ],
    };
    expect(issuesOf(validateRecipe(recipe), 'prefer_pii_protect')).toHaveLength(1);
  });

  it('the AI TTL floor', () => {
    // 120 s clears the data floor (60 s), not the AI one (300 s).
    expect(issuesOf(validateRecipe(withStep(summarize(), { ttl: 120 })), 'ttl_below_floor')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('below the AI recipe floor of 300s') }),
    ]);
  });

  it('the ai-prompt system prompt, at the args path, named as the step spells it', () => {
    const prompt = (args: Record<string, unknown>) => withStep({
      id: 'ask', op: 'core.ai.prompt', args: { 'llm.prompt': '{{step.deal}}', ...args }, skip_when: GATED,
    });
    expect(issuesOf(validateRecipe(prompt({})), 'ai_prompt_missing_system')).toEqual([{
      severity: 'warn',
      code: 'ai_prompt_missing_system',
      path: "steps[0].args['llm.system_prompt']",
      message: "step 'ask' is core.ai.prompt but has no llm.system_prompt",
    }]);
    expect(issuesOf(validateRecipe(prompt({ 'llm.system_prompt': 'Be brief.' })), 'ai_prompt_vague')).toHaveLength(1);
    const long = 'You are a careful CRM analyst. Name each risk, cite the step output it comes from, one line per finding.';
    expect(issuesOf(validateRecipe(prompt({ 'llm.system_prompt': long })), 'ai_prompt_vague')).toEqual([]);
  });

  it('an unknown model hint WARNS on an op step, where the ingredient form is an error', () => {
    const result = validateRecipe(withStep(summarize({ 'llm.model_hint': 'gpt-4o' }, { skip_when: GATED })));
    expect(issuesOf(result, 'invalid_model_hint')).toEqual([
      expect.objectContaining({ severity: 'warn', path: "steps[0].args['llm.model_hint']" }),
    ]);
    // ⛔ An error would stop an installed recipe that runs today: strict parsing
    // refuses the whole run, and the runtime runs the hint as the default tier.
    expect(result.valid).toBe(true);
    for (const hint of ['fast', 'quality', 'thinking', null]) {
      const ok = validateRecipe(withStep(summarize({ 'llm.model_hint': hint }, { skip_when: GATED })));
      expect(issuesOf(ok, 'invalid_model_hint'), String(hint)).toEqual([]);
    }
    const ingredientForm = validateRecipe(withStep({
      id: 'brief', ingredient: 'ai-summarize', input: { 'llm.data': '{{step.deal}}', 'llm.model_hint': 'gpt-4o' },
      skip_when: GATED,
    }));
    expect(issuesOf(ingredientForm, 'invalid_model_hint').map((i) => i.severity)).toEqual(['error']);
  });

  it('a non-AI op is not an AI step', () => {
    const notify = { id: 'ping', op: 'core.notification.send', args: { text: 'hi' } };
    const result = validateRecipe(withStep(notify, { ttl: 120 }));
    for (const code of ['no_guard_before_ai', 'no_hash_before_ai', 'ttl_below_floor']) {
      expect(issuesOf(result, code), code).toEqual([]);
    }
  });
});

describe('phase 2: to_table format hints', () => {
  it('currency-looking column without format → format_hint_missing_currency info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'table', transform: 'to_table', rows: '{{step.deal}}',
          columns: [
            { field: 'name', label: 'Name' },
            { field: 'amount', label: 'Amount' },
          ] },
      ],
      output: { sidebar: [{ type: 'table', source: 'step.table' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'format_hint_missing_currency');
    expect(issues.length).toBe(1);
  });
  it('date-looking column without format → format_hint_missing_date info', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'table', transform: 'to_table', rows: '{{step.deal}}',
          columns: [
            { field: 'name', label: 'Name' },
            { field: 'close_date', label: 'Close' },
          ] },
      ],
      output: { sidebar: [{ type: 'table', source: 'step.table' }] },
    };
    const issues = issuesOf(validateRecipe(recipe), 'format_hint_missing_date');
    expect(issues.length).toBe(1);
  });
  it('currency column with format hint → no finding', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'table', transform: 'to_table', rows: '{{step.deal}}',
          columns: [
            { field: 'amount', label: 'Amount', format: 'currency' },
          ] },
      ],
      output: { sidebar: [{ type: 'table', source: 'step.table' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'format_hint_missing_currency').length).toBe(0);
  });
  it('action columns do not request text format hints', () => {
    const recipe = {
      ...goodRecipe,
      steps: [
        { id: 'table', transform: 'to_table', array: '{{step.deal}}',
          columns: [
            { field: 'close_date', label: 'Action', type: 'action' },
          ] },
      ],
      output: { sidebar: [{ type: 'table', source: 'step.table' }] },
    };
    expect(issuesOf(validateRecipe(recipe), 'format_hint_missing_date').length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 3: Contracts (inner shapes + AI function inputs)
// ────────────────────────────────────────────────────────────────

/** Build a minimal valid recipe with exactly one sequential step so tests
 *  can focus on one transform at a time without bleeding from other checks. */
const singleStepRecipe = (step: Record<string, unknown>): Record<string, unknown> => ({
  recipe_id: 'test-recipe-hubspot',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Test Recipe',
    description: 'A minimal recipe for testing transform inner shapes.',
    author: 'test-suite',
    supported_platforms: ['hubspot'],
    variant_group: 'test-recipe',
    tags: ['test', 'fixture', 'shape'],
  },
  variables: {},
  prefetch_steps: [
    { id: 'data', ingredient: 'x-reader', input: {} },
  ],
  steps: [step],
  output: {
    sidebar: [{ type: 'summary', source: `step.${step.id}` }],
  },
});

describe('phase 3: to_checklist inner shape', () => {
  it('items missing → phase 1 transform_missing_param fires', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
    });
    const codes = codesOf(validateRecipe(recipe));
    expect(codes).toContain('transform_missing_param');
  });
  it('items empty array → checklist_items_empty warn', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks', items: [],
    });
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'checklist_items_empty');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('item missing label → checklist_item_label_required error', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { issue: '{{step.data}} is_null', detail_ok: 'fine', detail_issue: 'bad' },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'checklist_item_label_required').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('item missing issue condition → checklist_item_no_issue info', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'Deal is fresh', detail_ok: 'ok' },
      ],
    });
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'checklist_item_no_issue');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });
  it('item missing all detail_* → checklist_item_no_detail info', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'Deal is fresh', issue: '{{step.data}} is_null' },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'checklist_item_no_detail').length).toBe(1);
  });
  it('duplicate labels → checklist_item_duplicate_label warn', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'Stale', issue: '{{step.data}} is_null', detail_ok: 'ok' },
        { label: 'Stale', issue: '{{step.data}} is_null', detail_ok: 'ok' },
      ],
    });
    const result = validateRecipe(recipe);
    const issues = issuesOf(result, 'checklist_item_duplicate_label');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('detail_ok wrong type → checklist_item_detail_ok_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'Stale', issue: '{{step.data}} is_null', detail_ok: 42 },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'checklist_item_detail_ok_shape').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('well-formed checklist actions → no structural errors', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        {
          label: 'Stale',
          issue: '{{step.data}} is_null',
          detail_ok: 'fresh',
          detail_issue: 'stale',
          action: {
            kind: 'recipe.run',
            label: 'Review',
            recipe_id: 'review-stale-deal',
            variant: 'primary',
            config: { status: 'stale' },
            context: { deal_id: '{{context.entity_id}}' },
          },
          actions: [
            {
              kind: 'recipe.run',
              label: 'Close',
              recipe_id: 'close-stale-deal',
              variant: 'danger',
              confirm: 'Close this deal watcher?',
            },
          ],
        },
      ],
    });
    const errors = validateRecipe(recipe).issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(0);
  });
  it('malformed checklist actions fail validation', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        {
          label: 'Stale',
          issue: '{{step.data}} is_null',
          detail_ok: 'fresh',
          detail_issue: 'stale',
          action: {
            kind: 'recipe.run',
            label: '',
            recipe_id: '',
            variant: 'loud',
            context: {
              event: { forged: true },
              caller: { contract_id: 'ct_forged' },
            },
          },
          actions: [
            { kind: 'url.open', label: 'Open', recipe_id: 'x' },
          ],
        },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'recipe_output_action_label_required').length).toBe(1);
    expect(issuesOf(result, 'recipe_output_action_recipe_id_required').length).toBe(1);
    expect(issuesOf(result, 'recipe_output_action_variant').length).toBe(1);
    expect(issuesOf(result, 'recipe_output_action_context_reserved').length).toBe(2);
    expect(issuesOf(result, 'recipe_output_action_kind').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('non-JSON-compatible action config value → recipe_output_action_json_value', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        {
          label: 'Stale',
          issue: '{{step.data}} is_null',
          detail_ok: 'fresh',
          detail_issue: 'stale',
          action: {
            kind: 'recipe.run',
            label: 'Review',
            recipe_id: 'review',
            config: { amount: Number.POSITIVE_INFINITY },
          },
        },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'recipe_output_action_json_value').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('checklist actions must be an array when present', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        {
          label: 'Stale',
          issue: '{{step.data}} is_null',
          detail_ok: 'fresh',
          detail_issue: 'stale',
          actions: { kind: 'recipe.run', label: 'Review', recipe_id: 'review' },
        },
      ],
    });
    expect(issuesOf(validateRecipe(recipe), 'checklist_item_actions_shape').length).toBe(1);
  });
  it('well-formed checklist → no structural errors', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'Stale', issue: '{{step.data}} is_null', detail_ok: 'fresh', detail_issue: 'stale' },
        { label: 'Close date', issue: '{{step.data}} is_empty', detail_ok: 'future', detail_issue: 'past' },
      ],
    });
    const result = validateRecipe(recipe);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(0);
  });
});

describe('phase 3: to_summary inner shape', () => {
  it('field missing label → summary_field_label_required error', () => {
    const recipe = singleStepRecipe({
      id: 'sum', transform: 'to_summary',
      fields: [{ value: '{{step.data.x}}' }],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'summary_field_label_required').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('field missing value → summary_field_value_required error', () => {
    const recipe = singleStepRecipe({
      id: 'sum', transform: 'to_summary',
      fields: [{ label: 'Count' }],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'summary_field_value_required').length).toBe(1);
  });
  it('well-formed summary → no errors', () => {
    const recipe = singleStepRecipe({
      id: 'sum', transform: 'to_summary',
      fields: [
        { label: 'Count', value: '{{step.data.total}}' },
        { label: 'Amount', value: '{{step.data.amount}}' },
      ],
    });
    const errors = validateRecipe(recipe).issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(0);
  });
});

describe('phase 3: to_table inner shape', () => {
  it('column missing field → table_column_field_required error', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [{ label: 'Name' }],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'table_column_field_required').length).toBe(1);
  });
  it('column missing label → table_column_no_label info', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [{ field: 'name' }],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'table_column_no_label').length).toBe(1);
  });
  it('column label wrong type → table_column_label_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [{ field: 'name', label: 42 }],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'table_column_label_shape').length).toBe(1);
  });
  it('action column type is accepted', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [
        { field: 'name', label: 'Name', type: 'text' },
        { field: 'actions', label: 'Actions', type: 'action' },
      ],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'table_column_type_invalid').length).toBe(0);
    expect(issuesOf(result, 'table_column_action_format').length).toBe(0);
  });
  it('invalid table column type → table_column_type_invalid error', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [{ field: 'actions', label: 'Actions', type: 'button' }],
    });
    expect(issuesOf(validateRecipe(recipe), 'table_column_type_invalid').length).toBe(1);
  });
  it('action table column may not declare format', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [{ field: 'actions', label: 'Actions', type: 'action', format: 'currency' }],
    });
    expect(issuesOf(validateRecipe(recipe), 'table_column_action_format').length).toBe(1);
  });
  it('well-formed table → no errors', () => {
    const recipe = singleStepRecipe({
      id: 'tbl', transform: 'to_table', array: '{{step.data}}',
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'amount', label: 'Amount', format: 'currency' },
      ],
    });
    const errors = validateRecipe(recipe).issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(0);
  });
});

describe('phase 3: switch inner shape', () => {
  it('switch with empty cases → switch_cases_empty error', () => {
    const recipe = singleStepRecipe({
      id: 'sw', transform: 'switch', input: '{{step.data.stage}}', cases: {},
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'switch_cases_empty').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('switch without default → switch_no_default info', () => {
    const recipe = singleStepRecipe({
      id: 'sw', transform: 'switch', input: '{{step.data.stage}}',
      cases: { won: 'green', lost: 'red' },
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'switch_no_default').length).toBe(1);
  });
  it('switch with default → no info finding', () => {
    const recipe = singleStepRecipe({
      id: 'sw', transform: 'switch', input: '{{step.data.stage}}',
      cases: { won: 'green', lost: 'red' }, default: 'gray',
    });
    expect(issuesOf(validateRecipe(recipe), 'switch_no_default').length).toBe(0);
  });
});

describe('phase 3: any/all either-or', () => {
  it('any with neither values nor conditions → any_all_missing_operands error', () => {
    const recipe = singleStepRecipe({
      id: 'gate', transform: 'any',
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'any_all_missing_operands').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('all with values → no finding', () => {
    const recipe = singleStepRecipe({
      id: 'gate', transform: 'all', values: ['{{step.data.a}}', '{{step.data.b}}'],
    });
    expect(issuesOf(validateRecipe(recipe), 'any_all_missing_operands').length).toBe(0);
  });
  it('any with empty values array → any_all_empty_values warn', () => {
    const recipe = singleStepRecipe({
      id: 'gate', transform: 'any', values: [],
    });
    expect(issuesOf(validateRecipe(recipe), 'any_all_empty_values').length).toBe(1);
  });
  it('all with conditions → no finding', () => {
    const recipe = singleStepRecipe({
      id: 'gate', transform: 'all',
      conditions: ['{{step.data.x}} is_not_null'],
    });
    expect(issuesOf(validateRecipe(recipe), 'any_all_missing_operands').length).toBe(0);
  });
});

describe('phase 3: merge either-or', () => {
  it('merge with neither source nor sources → merge_missing_operands error', () => {
    const recipe = singleStepRecipe({
      id: 'm', transform: 'merge',
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'merge_missing_operands').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('merge.sources not array → merge_sources_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'm', transform: 'merge', sources: { a: 1 },
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'merge_sources_shape').length).toBe(1);
  });
  it('merge with source → no finding', () => {
    const recipe = singleStepRecipe({
      id: 'm', transform: 'merge', source: '{{step.data}}',
    });
    expect(issuesOf(validateRecipe(recipe), 'merge_missing_operands').length).toBe(0);
  });
});

describe('phase 3: AI function input contracts', () => {
  it('ai-classify without llm.categories → ai_function_input_missing_key error', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.data}}' },
      skip_when: '{{step.data}} is_null',
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'ai_function_input_missing_key').length).toBe(1);
    expect(result.valid).toBe(false);
  });
  it('ai-score without llm.criteria → error', () => {
    const recipe = singleStepRecipe({
      id: 'sc', ingredient: 'ai-score',
      input: { 'llm.data': '{{step.data}}' },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_missing_key').length).toBe(1);
  });
  it('ai-extract without llm.fields → error', () => {
    const recipe = singleStepRecipe({
      id: 'x', ingredient: 'ai-extract',
      input: { 'llm.data': '{{step.data}}' },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_missing_key').length).toBe(1);
  });
  it('ai-compare without llm.data_a → error', () => {
    const recipe = singleStepRecipe({
      id: 'cmp', ingredient: 'ai-compare',
      input: { 'llm.data_b': '{{step.data}}' },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_missing_key').length).toBe(1);
  });
  it('ai-classify with categories of wrong type → ai_function_input_wrong_type', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.data}}', 'llm.categories': 'won,lost' },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_wrong_type').length).toBe(1);
  });
  it('ai-classify with empty categories array → ai_function_input_empty_array warn', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.data}}', 'llm.categories': [] },
      skip_when: '{{step.data}} is_null',
    });
    const issues = issuesOf(validateRecipe(recipe), 'ai_function_input_empty_array');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
  });
  it('ai-classify with reference categories → no type error (runtime-resolved)', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.data}}', 'llm.categories': '{{config.categories}}' },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_wrong_type').length).toBe(0);
  });
  it('ai-classify without input object → ai_function_input_missing error', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_missing').length).toBe(1);
  });
  it('ai-classify with full valid input → no finding', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: {
        'llm.data': '{{step.data}}',
        'llm.categories': ['won', 'lost', 'pending'],
      },
      skip_when: '{{step.data}} is_null',
    });
    const result = validateRecipe(recipe);
    const aiErrors = result.issues.filter((i) =>
      i.code.startsWith('ai_function_input_') && i.severity === 'error',
    );
    expect(aiErrors.length).toBe(0);
  });
  it('ai-prompt requires llm.prompt', () => {
    const recipe = singleStepRecipe({
      id: 'p', ingredient: 'ai-prompt',
      input: { 'llm.system_prompt': 'You are a careful analyst. Produce a bullet list with one finding per line and cite specific steps.' },
      skip_when: '{{step.data}} is_null',
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'ai_function_input_missing_key').length).toBe(1);
  });
  it('non-AI ingredient is not subject to AI contracts', () => {
    const recipe = singleStepRecipe({
      id: 'read', ingredient: 'deal-reader-hubspot', input: { deal_id: 'x' },
    });
    const result = validateRecipe(recipe);
    const aiIssues = result.issues.filter((i) => i.code.startsWith('ai_function_input_'));
    expect(aiIssues.length).toBe(0);
  });

  it('ai-classify with string reference for categories skips wrong_type check (resolves at runtime)', () => {
    const recipe = singleStepRecipe({
      id: 'c', ingredient: 'ai-classify',
      input: {
        'llm.data': '{{step.data}}',
        'llm.categories': '{{config.tone_options}}',
      },
      skip_when: '{{step.data}} is_null',
    });
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_wrong_type').length).toBe(0);
    expect(issuesOf(validateRecipe(recipe), 'ai_function_input_missing_key').length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 3: shape-error gap coverage
// ────────────────────────────────────────────────────────────────

describe('phase 3 — top-level shape errors', () => {
  it('to_checklist.items that is not an array → checklist_items_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: 'not-an-array' as unknown,
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'checklist_items_shape').length).toBe(1);
  });

  it('to_checklist item that is not an object → checklist_item_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: ['raw string item'],
    });
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'checklist_item_shape').length).toBe(1);
  });

  it('to_checklist item with non-string detail_issue → shape error for that field', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'A', issue: '{{step.data}} is_null', detail_issue: 42 },
      ],
    });
    expect(issuesOf(validateRecipe(recipe), 'checklist_item_detail_issue_shape').length).toBe(1);
  });

  it('to_checklist item with non-string detail_null → shape error', () => {
    const recipe = singleStepRecipe({
      id: 'cl', transform: 'to_checklist', title: 'Risks',
      items: [
        { label: 'A', issue: '{{step.data}} is_null', detail_ok: 'ok', detail_null: true },
      ],
    });
    expect(issuesOf(validateRecipe(recipe), 'checklist_item_detail_null_shape').length).toBe(1);
  });

  it('to_summary.fields that is not an array → summary_fields_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'sm', transform: 'to_summary', fields: 'oops' as unknown,
    });
    expect(issuesOf(validateRecipe(recipe), 'summary_fields_shape').length).toBe(1);
  });

  it('to_summary empty fields array → summary_fields_empty warn', () => {
    const recipe = singleStepRecipe({
      id: 'sm', transform: 'to_summary', fields: [],
    });
    expect(issuesOf(validateRecipe(recipe), 'summary_fields_empty').length).toBe(1);
  });

  it('to_summary field that is not an object → summary_field_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'sm', transform: 'to_summary', fields: ['raw string'],
    });
    expect(issuesOf(validateRecipe(recipe), 'summary_field_shape').length).toBe(1);
  });

  it('to_table.columns that is not an array → table_columns_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'tb', transform: 'to_table', rows: '{{step.data}}',
      columns: 'not-an-array' as unknown,
    });
    expect(issuesOf(validateRecipe(recipe), 'table_columns_shape').length).toBe(1);
  });

  it('to_table empty columns array → table_columns_empty warn', () => {
    const recipe = singleStepRecipe({
      id: 'tb', transform: 'to_table', rows: '{{step.data}}', columns: [],
    });
    expect(issuesOf(validateRecipe(recipe), 'table_columns_empty').length).toBe(1);
  });

  it('to_table column that is not an object → table_column_shape error', () => {
    const recipe = singleStepRecipe({
      id: 'tb', transform: 'to_table', rows: '{{step.data}}',
      columns: ['raw string'],
    });
    expect(issuesOf(validateRecipe(recipe), 'table_column_shape').length).toBe(1);
  });

  it('switch with null cases → no shape error (phase 1 handles it, phase 3 early-returns)', () => {
    const recipe = singleStepRecipe({
      id: 'sw', transform: 'switch', input: '{{step.data}}', cases: null,
    });
    // Phase 3 early-returns silently on invalid shape; codes prefixed "switch_" should be absent.
    const result = validateRecipe(recipe);
    expect(issuesOf(result, 'switch_cases_empty').length).toBe(0);
    expect(issuesOf(result, 'switch_no_default').length).toBe(0);
  });

  it('any with empty conditions array → any_all_empty_conditions warn', () => {
    const recipe = singleStepRecipe({
      id: 'gate', transform: 'any', conditions: [],
    });
    expect(issuesOf(validateRecipe(recipe), 'any_all_empty_conditions').length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Tier 2: Enum variable validation
// ────────────────────────────────────────────────────────────────

describe('tier 2: enum variable validation', () => {
  it('array variable with consistent string type → no error', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, tone: ['formal', 'casual', 'friendly'] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_tone', transform: 'template', template: '{{config.tone}}' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('enum_variable_mixed_types');
    expect(codes).not.toContain('enum_variable_empty');
  });

  it('empty array variable → enum_variable_empty error', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, tone: [] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_tone', transform: 'template', template: '{{config.tone}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('enum_variable_empty');
  });

  it('single-element array → enum_variable_single warn', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, tone: ['formal'] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_tone', transform: 'template', template: '{{config.tone}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('enum_variable_single');
  });

  it('mixed-type array → enum_variable_mixed_types error', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, bad: ['formal', 42, true] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_bad', transform: 'template', template: '{{config.bad}}' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).toContain('enum_variable_mixed_types');
  });

  it('object-valued enum element → enum_variable_non_scalar error', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, bad: [{ a: 1 }, { a: 2 }] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_bad', transform: 'template', template: '{{config.bad}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('enum_variable_non_scalar');
  });

  it('duplicate enum values → enum_variable_duplicate warn', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, tone: ['formal', 'casual', 'formal'] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_tone', transform: 'template', template: '{{config.tone}}' },
      ],
    };
    expect(codesOf(validateRecipe(m))).toContain('enum_variable_duplicate');
  });

  it('number-valued enum is allowed', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, days: [7, 14, 30, 90] },
      steps: [
        ...goodRecipe.steps,
        { id: 'use_days', transform: 'template', template: '{{config.days}}' },
      ],
    };
    const codes = codesOf(validateRecipe(m));
    expect(codes).not.toContain('enum_variable_non_scalar');
    expect(codes).not.toContain('enum_variable_mixed_types');
  });

  it('scalar variable (not array) is not subject to enum checks', () => {
    const m = {
      ...goodRecipe,
      variables: { ...goodRecipe.variables, threshold: 7 },
    };
    const codes = codesOf(validateRecipe(m));
    const enumCodes = codes.filter((c) => c.startsWith('enum_variable_'));
    expect(enumCodes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Tier 2: Duplicate step content detection
// ────────────────────────────────────────────────────────────────

describe('tier 2: duplicate step content detection', () => {
  it('two sequential steps with identical body → duplicate_step_content warn', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'a', transform: 'template', template: 'hello {{step.deal}}' },
        { id: 'b', transform: 'template', template: 'hello {{step.deal}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.a' }, { type: 'summary', source: 'step.b' }] },
    };
    const issues = validateRecipe(m).issues.filter((i) => i.code === 'duplicate_step_content');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].message).toMatch(/'b'.*'a'/);
  });

  it('two prefetch steps with identical body → duplicate_step_content warn', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [
        { id: 'deal1', ingredient: 'deal-reader-hubspot', input: { deal_id: '{{context.entity_id}}' } },
        { id: 'deal2', ingredient: 'deal-reader-hubspot', input: { deal_id: '{{context.entity_id}}' } },
      ],
    };
    const issues = validateRecipe(m).issues.filter((i) => i.code === 'duplicate_step_content');
    expect(issues.length).toBe(1);
    expect(issues[0].path).toMatch(/prefetch_steps/);
  });

  it('different key ordering but same content → still flagged', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [
        { id: 'a', ingredient: 'x', input: { a: 1, b: 2 } },
        { id: 'b', input: { b: 2, a: 1 }, ingredient: 'x' },
      ],
    };
    const issues = validateRecipe(m).issues.filter((i) => i.code === 'duplicate_step_content');
    expect(issues.length).toBe(1);
  });

  it('two steps with different content → no finding', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'a', transform: 'template', template: 'hello' },
        { id: 'b', transform: 'template', template: 'goodbye' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.a' }, { type: 'summary', source: 'step.b' }] },
    };
    expect(validateRecipe(m).issues.filter((i) => i.code === 'duplicate_step_content')).toEqual([]);
  });

  it('three identical steps → two duplicate warnings (2nd and 3rd both flagged against 1st)', () => {
    const m = {
      ...goodRecipe,
      steps: [
        { id: 'a', transform: 'template', template: 'x' },
        { id: 'b', transform: 'template', template: 'x' },
        { id: 'c', transform: 'template', template: 'x' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.a' }] },
    };
    const issues = validateRecipe(m).issues.filter((i) => i.code === 'duplicate_step_content');
    expect(issues.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Tier 2: Trigger pattern validation
// ────────────────────────────────────────────────────────────────

describe('tier 2: trigger pattern validation', () => {
  it('simple host/path pattern → no error', () => {
    const m = { ...goodRecipe, trigger: ['app.hubspot.com/contacts/*'] };
    const codes = codesOf(validateRecipe(m));
    expect(codes.filter((c) => c.startsWith('trigger_'))).toEqual([]);
  });

  it('https scheme → no error', () => {
    const m = { ...goodRecipe, trigger: ['https://app.hubspot.com/deals/*'] };
    const codes = codesOf(validateRecipe(m));
    expect(codes.filter((c) => c.startsWith('trigger_'))).toEqual([]);
  });

  it('leading *.subdomain wildcard → no error', () => {
    const m = { ...goodRecipe, trigger: ['*.lightning.force.com/*'] };
    const codes = codesOf(validateRecipe(m));
    expect(codes.filter((c) => c.startsWith('trigger_'))).toEqual([]);
  });

  it('whitespace in pattern → trigger_pattern_whitespace error', () => {
    const m = { ...goodRecipe, trigger: ['app.hubspot.com /deals/*'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_whitespace');
  });

  it('partial-label wildcard → trigger_pattern_host_wildcard warn', () => {
    const m = { ...goodRecipe, trigger: ['app*.hubspot.com/*'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_host_wildcard');
  });

  it('middle-label wildcard → trigger_pattern_host_wildcard warn', () => {
    const m = { ...goodRecipe, trigger: ['app.*.hubspot.com/*'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_host_wildcard');
  });

  it('unsupported scheme → trigger_pattern_scheme warn', () => {
    const m = { ...goodRecipe, trigger: ['file://host.com/path'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_scheme');
  });

  it('host with no domain → trigger_pattern_no_domain warn', () => {
    const m = { ...goodRecipe, trigger: ['localhost/path'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_no_domain');
  });

  it('no host at all → trigger_pattern_no_host error', () => {
    const m = { ...goodRecipe, trigger: ['https:///path'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_no_host');
  });

  it('consecutive dots → trigger_pattern_empty_label error', () => {
    const m = { ...goodRecipe, trigger: ['app..com/*'] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_empty_label');
  });

  it('non-string trigger entry → trigger_pattern_shape error', () => {
    const m = { ...goodRecipe, trigger: [42] as unknown as string[] };
    expect(codesOf(validateRecipe(m))).toContain('trigger_pattern_shape');
  });
});

// ────────────────────────────────────────────────────────────────
// Gap-fill tests for structural validators
// ────────────────────────────────────────────────────────────────

describe('structural gap-fill — metadata shape errors', () => {
  it('non-array supported_platforms → platforms_shape error', () => {
    const m = {
      ...goodRecipe,
      metadata: { ...goodRecipe.metadata, supported_platforms: 'hubspot' as unknown as string[] },
    };
    expect(codesOf(validateRecipe(m))).toContain('platforms_shape');
  });

  it('non-array tags → tags_shape error', () => {
    const m = {
      ...goodRecipe,
      metadata: { ...goodRecipe.metadata, tags: 'not-an-array' as unknown as string[] },
    };
    expect(codesOf(validateRecipe(m))).toContain('tags_shape');
  });

  it('tags with non-string element → tags_shape error', () => {
    const m = {
      ...goodRecipe,
      metadata: { ...goodRecipe.metadata, tags: ['ok', 42 as unknown as string] },
    };
    expect(codesOf(validateRecipe(m))).toContain('tags_shape');
  });

  it('fork_of as non-object → fork_of_shape error', () => {
    const m = {
      ...goodRecipe,
      metadata: { ...goodRecipe.metadata, fork_of: 'string-not-object' as unknown },
    };
    expect(codesOf(validateRecipe(m))).toContain('fork_of_shape');
  });

  it('fork_of missing recipe_id → fork_of_recipe_id error', () => {
    const m = {
      ...goodRecipe,
      metadata: {
        ...goodRecipe.metadata,
        fork_of: { author: 'pub', version: 1 } as unknown,
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('fork_of_recipe_id');
  });

  it('fork_of missing author → fork_of_author error', () => {
    const m = {
      ...goodRecipe,
      metadata: {
        ...goodRecipe.metadata,
        fork_of: { recipe_id: 'original', version: 1 } as unknown,
      },
    };
    expect(codesOf(validateRecipe(m))).toContain('fork_of_author');
  });
});

describe('structural gap-fill — step shape errors', () => {
  it('prefetch step that is not an object → prefetch_step_shape error', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: ['not-an-object'] as unknown as typeof goodRecipe.prefetch_steps,
    };
    expect(codesOf(validateRecipe(m))).toContain('prefetch_step_shape');
  });

  it('prefetch step missing id → prefetch_step_id_required error', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [{ ingredient: 'x-reader', input: {} }] as unknown as typeof goodRecipe.prefetch_steps,
    };
    expect(codesOf(validateRecipe(m))).toContain('prefetch_step_id_required');
  });

  it('prefetch step missing ingredient → prefetch_ingredient_required error', () => {
    const m = {
      ...goodRecipe,
      prefetch_steps: [{ id: 'orphan', input: {} }] as unknown as typeof goodRecipe.prefetch_steps,
    };
    expect(codesOf(validateRecipe(m))).toContain('prefetch_ingredient_required');
  });

  it('sequential step that is not an object → step_shape error', () => {
    const m = {
      ...goodRecipe,
      steps: ['not-an-object'] as unknown as typeof goodRecipe.steps,
    };
    expect(codesOf(validateRecipe(m))).toContain('step_shape');
  });

  it('sequential step missing id → step_id_required error', () => {
    const m = {
      ...goodRecipe,
      steps: [{ transform: 'template', template: 'x' }] as unknown as typeof goodRecipe.steps,
    };
    expect(codesOf(validateRecipe(m))).toContain('step_id_required');
  });
});

describe('structural gap-fill — output section errors', () => {
  it('output section that is not an object → output_section_shape error', () => {
    const m = {
      ...goodRecipe,
      output: { sidebar: ['not-an-object'] as unknown as typeof goodRecipe.output.sidebar },
    };
    expect(codesOf(validateRecipe(m))).toContain('output_section_shape');
  });

  it('output section missing source → output_section_source_required error', () => {
    const m = {
      ...goodRecipe,
      output: { sidebar: [{ type: 'summary' }] as unknown as typeof goodRecipe.output.sidebar },
    };
    expect(codesOf(validateRecipe(m))).toContain('output_section_source_required');
  });
});

describe('isValidRecipe', () => {
  it('returns true for valid recipe', () => {
    expect(isValidRecipe(goodRecipe)).toBe(true);
  });
  it('returns false for invalid recipe', () => {
    expect(isValidRecipe({ recipe_id: 'x' })).toBe(false);
  });
});

describe('assertValidRecipe', () => {
  it('returns recipe on success', () => {
    expect(assertValidRecipe(goodRecipe)).toBe(goodRecipe);
  });
  it('throws on failure with code + path', () => {
    try {
      assertValidRecipe({ recipe_id: 'Bad-Name' });
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/validation failed/);
      expect((e as Error).message).toMatch(/\[[a-z_]+\]/);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Step count limit (MAX_STEPS = 500)
// ────────────────────────────────────────────────────────────────

describe('validateRecipe — step count limit', () => {
  it('rejects recipes with more than 500 total steps', () => {
    const bigRecipe = {
      ...goodRecipe,
      steps: Array.from({ length: 501 }, (_, i) => ({
        id: `s${i}`,
        transform: 'coalesce',
        values: ['a', 'b'],
      })),
    };
    const result = validateRecipe(bigRecipe);
    expect(result.issues.some((i) => i.code === 'recipe_too_many_steps')).toBe(true);
  });

  it('counts prefetch + sequential steps together', () => {
    const bigRecipe = {
      ...goodRecipe,
      prefetch_steps: Array.from({ length: 300 }, (_, i) => ({
        id: `p${i}`,
        ingredient: 'deal-reader-hubspot',
      })),
      steps: Array.from({ length: 201 }, (_, i) => ({
        id: `s${i}`,
        transform: 'coalesce',
        values: ['a'],
      })),
    };
    const result = validateRecipe(bigRecipe);
    expect(result.issues.some((i) => i.code === 'recipe_too_many_steps')).toBe(true);
  });

  it('accepts recipes with exactly 500 steps', () => {
    const okRecipe = {
      ...goodRecipe,
      prefetch_steps: [], // clear prefetch so only sequential counts
      steps: Array.from({ length: 500 }, (_, i) => ({
        id: `s${i}`,
        transform: 'coalesce',
        values: ['a'],
      })),
    };
    const result = validateRecipe(okRecipe);
    expect(result.issues.some((i) => i.code === 'recipe_too_many_steps')).toBe(false);
  });
});
