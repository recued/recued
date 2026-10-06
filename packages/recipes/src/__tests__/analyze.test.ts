import { describe, it, expect } from 'vitest';
import { analyzeRecipe } from '../analyze.js';

// ────────────────────────────────────────────────────────────────
// Known-good sample — same shape as the validator test fixture so
// the analysis output is easy to reason about.
// ────────────────────────────────────────────────────────────────

const sampleRecipe = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 300,
  trigger: [
    'app.hubspot.com/contacts/*/deal/*',
    'https://app.hubspot.com/deals/*',
  ],
  metadata: {
    name: 'Deal Risk Detector',
    description: 'Three risk indicators on a HubSpot deal.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['deal', 'risk'],
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
    { id: 'days_since', transform: 'date_diff',
      from: '{{step.deal.last_activity_date}}', to: 'now', unit: 'days' },
    { id: 'activity_risk', transform: 'compare',
      left: '{{step.days_since}}', operator: 'greater',
      value: '{{config.max_days_since_activity}}' },
    { id: 'filtered', transform: 'filter',
      array: '{{step.contacts}}', field: 'last_email_date',
      operator: 'less', value: '{{config.stale_contact_window_days}}' },
    { id: 'should_ai', transform: 'all',
      values: ['{{step.activity_risk}}', '{{config.verbose}}'] },
    { id: 'summary', ingredient: 'ai-summarize',
      input: { 'llm.data': '{{step.filtered}}' },
      skip_when: '{{step.should_ai}} equal false' },
    { id: 'classify', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.activity_risk}}', 'llm.categories': ['low', 'high'] },
      skip_when: '{{step.should_ai}} equal false' },
  ],
  output: {
    sidebar: [
      { type: 'summary', source: 'step.days_since' },
      { type: 'ai_analysis', source: 'step.summary' },
    ],
  },
};

// ────────────────────────────────────────────────────────────────

describe('analyzeRecipe — known-good sample', () => {
  const result = analyzeRecipe(sampleRecipe);

  it('extracts unique ingredient slugs sorted', () => {
    expect(result.ingredient_slugs).toEqual([
      'ai-classify',
      'ai-summarize',
      'deal-contacts-hubspot',
      'deal-reader-hubspot',
    ]);
  });

  it('subsets ai function slugs', () => {
    expect(result.ai_function_slugs).toEqual(['ai-classify', 'ai-summarize']);
  });

  it('extracts config variables referenced', () => {
    expect(result.config_variables).toEqual([
      'max_days_since_activity',
      'stale_contact_window_days',
      'verbose',
    ]);
  });

  it('extracts context refs', () => {
    expect(result.context_refs).toEqual(['entity_id']);
  });

  it('extracts platforms', () => {
    expect(result.platforms).toEqual(['hubspot']);
  });

  it('extracts trigger domains (dedupe + strip scheme)', () => {
    expect(result.trigger_domains).toEqual(['app.hubspot.com']);
  });

  it('counts steps by phase', () => {
    expect(result.prefetch_step_count).toBe(2);
    expect(result.sequential_step_count).toBe(6);
  });

  it('counts AI calls', () => {
    expect(result.ai_call_count).toBe(2);
    expect(result.has_ai).toBe(true);
  });

  it('surfaces ttl', () => {
    expect(result.ttl).toBe(300);
  });
});

// ────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────

describe('analyzeRecipe — edge cases', () => {
  it('null input → empty summary', () => {
    const r = analyzeRecipe(null);
    expect(r.ingredient_slugs).toEqual([]);
    expect(r.has_ai).toBe(false);
    expect(r.ttl).toBe(0);
  });

  it('undefined input → empty summary', () => {
    const r = analyzeRecipe(undefined);
    expect(r.sequential_step_count).toBe(0);
  });

  it('array input → empty summary', () => {
    const r = analyzeRecipe([1, 2, 3]);
    expect(r.ingredient_slugs).toEqual([]);
  });

  it('empty object → empty summary with zero counts', () => {
    const r = analyzeRecipe({});
    expect(r).toMatchObject({
      ingredient_slugs: [],
      config_variables: [],
      platforms: [],
      prefetch_step_count: 0,
      sequential_step_count: 0,
      ai_call_count: 0,
      has_ai: false,
      ttl: 0,
    });
  });

  it('malformed steps (not array) → treated as empty', () => {
    const r = analyzeRecipe({ steps: 'not-an-array' });
    expect(r.sequential_step_count).toBe(0);
  });

  it('invalid ttl → 0', () => {
    expect(analyzeRecipe({ ttl: 'bad' }).ttl).toBe(0);
    expect(analyzeRecipe({ ttl: NaN }).ttl).toBe(0);
    expect(analyzeRecipe({ ttl: -1 }).ttl).toBe(-1); // analyzer doesn't validate ranges
  });

  it('metadata.supported_platforms non-array → empty', () => {
    const r = analyzeRecipe({ metadata: { supported_platforms: 'hubspot' } });
    expect(r.platforms).toEqual([]);
  });

  it('dedupes duplicate ingredient slugs across prefetch + steps', () => {
    const r = analyzeRecipe({
      prefetch_steps: [{ id: 'a', ingredient: 'deal-reader-hubspot' }],
      steps: [{ id: 'b', ingredient: 'deal-reader-hubspot' }],
    });
    expect(r.ingredient_slugs).toEqual(['deal-reader-hubspot']);
  });
});

// ────────────────────────────────────────────────────────────────
// Reference extraction
// ────────────────────────────────────────────────────────────────

describe('analyzeRecipe — reference extraction', () => {
  it('deep-nested refs are found', () => {
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'template',
          template: 'user {{config.user_name}} on {{context.page_url}}' },
      ],
    });
    expect(r.config_variables).toEqual(['user_name']);
    expect(r.context_refs).toEqual(['page_url']);
  });

  it('path refs collapse to root field', () => {
    // {{config.thresholds.max}} → "thresholds"
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'compare',
          left: '{{config.thresholds.max}}',
          operator: 'greater',
          value: '{{config.thresholds.min}}' },
      ],
    });
    expect(r.config_variables).toEqual(['thresholds']);
  });

  it('format hints are stripped', () => {
    // {{config.amount:currency}} → "amount"
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'template',
          template: '{{config.amount:currency}} at {{context.now:date}}' },
      ],
    });
    expect(r.config_variables).toEqual(['amount']);
    expect(r.context_refs).toEqual(['now']);
  });

  it('meta refs are extracted separately', () => {
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'template',
          template: 'Recipe: {{meta.name}} v{{meta.version}}' },
      ],
    });
    expect(r.meta_refs).toEqual(['name', 'version']);
  });

  it('vault refs are NOT extracted (not in recipe namespace)', () => {
    // Even if the recipe tries to leak one, analyzer doesn't care — that's
    // validation's job. Analyzer simply doesn't track it.
    const r = analyzeRecipe({
      steps: [{ id: 'a', transform: 'template', template: '{{vault.api_key}}' }],
    });
    expect(r.config_variables).toEqual([]);
    expect(r.context_refs).toEqual([]);
    expect(r.meta_refs).toEqual([]);
  });

  it('duplicate refs are deduped', () => {
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'template', template: '{{config.x}}' },
        { id: 'b', transform: 'template', template: '{{config.x}} {{config.x}}' },
      ],
    });
    expect(r.config_variables).toEqual(['x']);
  });
});

// ────────────────────────────────────────────────────────────────
// Trigger domain extraction
// ────────────────────────────────────────────────────────────────

describe('analyzeRecipe — trigger domain extraction', () => {
  it('extracts domain from pattern without scheme', () => {
    const r = analyzeRecipe({ trigger: ['app.hubspot.com/contacts/*'] });
    expect(r.trigger_domains).toEqual(['app.hubspot.com']);
  });

  it('strips https scheme', () => {
    const r = analyzeRecipe({ trigger: ['https://app.hubspot.com/deals/*'] });
    expect(r.trigger_domains).toEqual(['app.hubspot.com']);
  });

  it('handles wildcard hosts', () => {
    const r = analyzeRecipe({ trigger: ['*.lightning.force.com/*'] });
    expect(r.trigger_domains).toEqual(['*.lightning.force.com']);
  });

  it('skips patterns with no recognizable domain', () => {
    const r = analyzeRecipe({ trigger: ['localhost/', 'invalidpattern'] });
    expect(r.trigger_domains).toEqual([]);
  });

  it('dedupes same domain across patterns', () => {
    const r = analyzeRecipe({
      trigger: [
        'app.hubspot.com/contacts/*',
        'app.hubspot.com/deals/*',
        'https://app.hubspot.com/other',
      ],
    });
    expect(r.trigger_domains).toEqual(['app.hubspot.com']);
  });

  it('multiple distinct domains are sorted', () => {
    const r = analyzeRecipe({
      trigger: [
        '*.lightning.force.com/*',
        'app.hubspot.com/*',
        'app.pipedrive.com/*',
      ],
    });
    expect(r.trigger_domains).toEqual([
      '*.lightning.force.com',
      'app.hubspot.com',
      'app.pipedrive.com',
    ]);
  });

  it('missing trigger field → empty', () => {
    const r = analyzeRecipe({});
    expect(r.trigger_domains).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// AI call counting
// ────────────────────────────────────────────────────────────────

describe('analyzeRecipe — AI call counting', () => {
  it('only counts sequential AI steps (prefetch ignored)', () => {
    const r = analyzeRecipe({
      prefetch_steps: [
        { id: 'a', ingredient: 'ai-extract', input: {} }, // rare but possible — still a cost
      ],
      steps: [
        { id: 'b', ingredient: 'ai-classify', input: {} },
        { id: 'c', ingredient: 'ai-score', input: {} },
      ],
    });
    // ingredient_slugs includes all three; ai_call_count counts sequential AI
    expect(r.ingredient_slugs).toEqual(['ai-classify', 'ai-extract', 'ai-score']);
    expect(r.ai_function_slugs).toEqual(['ai-classify', 'ai-extract', 'ai-score']);
    expect(r.ai_call_count).toBe(2);
  });

  it('zero AI calls → has_ai false', () => {
    const r = analyzeRecipe({
      steps: [
        { id: 'a', transform: 'filter', array: '[]', field: 'x', operator: 'equal' },
      ],
    });
    expect(r.ai_call_count).toBe(0);
    expect(r.has_ai).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Op steps
// ────────────────────────────────────────────────────────────────

/** Every shipped recipe writes its calls as `op:` steps. ⛔ The analyzer read
 *  `ingredient` alone, so a shipped recipe analysed as calling nothing, with no AI. */
describe('analyzeRecipe — op steps', () => {
  it('a kernel op counts as the ingredient it runs as, every op is listed, and an AI op is an AI call', () => {
    const r = analyzeRecipe({
      prefetch_steps: [{ id: 'account', op: 'recued-core.recurly.account.read', args: {} }],
      steps: [
        { id: 'brief', op: 'core.ai.summarize', args: { 'llm.data': '{{step.account}}' } },
        { id: 'tell', op: 'core.notification.send', args: { text: '{{step.brief.summary}}' } },
        { id: 'label', ingredient: 'ai-classify', input: {} },
      ],
    });
    expect(r.ingredient_slugs).toEqual(['ai-classify', 'core-ai-summarize', 'core-notification-send']);
    expect(r.op_ids).toEqual(['core.ai.summarize', 'core.notification.send', 'recued-core.recurly.account.read']);
    expect(r.ai_function_slugs).toEqual(['ai-classify', 'core-ai-summarize']);
    expect(r.ai_call_count).toBe(2);
    expect(r.has_ai).toBe(true);
  });

});
