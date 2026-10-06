import { describe, it, expect } from 'vitest';
import { qualityPrecheck, type QualityFinding } from '../quality-precheck.js';

const codes = (f: QualityFinding[]) => f.map((x) => x.check);
const critical = (f: QualityFinding[]) => f.filter((x) => x.severity === 'critical');
const reviews = (f: QualityFinding[]) => f.filter((x) => x.severity === 'review');

const mkRecipe = (overrides: Record<string, unknown> = {}) => ({
  recipe_id: 'test-recipe-hubspot',
  version: 1,
  ttl: 300,
  metadata: { name: 'Test', author: 'test-pub', supported_platforms: ['hubspot'], tags: ['deal', 'risk', 'crm'] },
  variables: { threshold: 14 },
  prefetch_steps: [{ id: 'deal', ingredient: 'deal-reader-hubspot', input: { deal_id: '{{context.entity_id}}' } }],
  steps: [
    { id: 'check', transform: 'compare', field: '{{step.deal.days}}', operator: 'greater', value: '{{config.threshold}}' },
  ],
  output: { sidebar: [{ type: 'checklist', source: 'step.check' }] },
  ...overrides,
});

describe('qualityPrecheck — clean recipe', () => {
  it('no critical findings on a well-formed recipe', () => {
    expect(critical(qualityPrecheck(mkRecipe()))).toHaveLength(0);
  });
});

describe('qualityPrecheck — orphans', () => {
  it('detects orphan prefetch', () => {
    const r = mkRecipe({
      prefetch_steps: [
        { id: 'deal', ingredient: 'deal-reader', input: {} },
        { id: 'unused', ingredient: 'unused-reader', input: {} },
      ],
    });
    expect(codes(qualityPrecheck(r))).toContain('orphan_prefetch');
  });

  it('detects orphan step', () => {
    const r = mkRecipe({
      steps: [
        { id: 'check', transform: 'compare', field: '{{step.deal.x}}', operator: 'equal', value: 'y' },
        { id: 'dead', transform: 'template', text: 'nobody uses me' },
      ],
    });
    expect(codes(qualityPrecheck(r))).toContain('orphan_step');
  });
});

describe('qualityPrecheck — vault leak', () => {
  it('critical on vault ref in transform step', () => {
    const r = mkRecipe({
      steps: [{ id: 'bad', transform: 'template', text: '{{vault.hubspot.token}}' }],
    });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('vault_leak');
    expect(critical(f).length).toBeGreaterThan(0);
  });
});

describe('qualityPrecheck — variable hygiene', () => {
  it('critical on undeclared variable ref', () => {
    const r = mkRecipe({
      variables: {},
      steps: [{ id: 'x', transform: 'compare', field: '{{config.missing_var}}', operator: 'equal', value: '1' }],
    });
    expect(codes(qualityPrecheck(r))).toContain('undeclared_variable_ref');
  });

  it('review on unused variable', () => {
    const r = mkRecipe({
      variables: { threshold: 14, unused_var: 'hello' },
    });
    expect(codes(qualityPrecheck(r))).toContain('unused_variable');
  });
});

describe('qualityPrecheck — step ref hygiene', () => {
  it('critical on undeclared step ref', () => {
    const r = mkRecipe({
      steps: [{ id: 'x', transform: 'template', text: '{{step.nonexistent.field}}' }],
    });
    expect(codes(qualityPrecheck(r))).toContain('undeclared_step_ref');
  });
});

describe('qualityPrecheck — AI checks', () => {
  it('info on no guard before AI', () => {
    const r = mkRecipe({
      steps: [{ id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['a'] } }],
    });
    expect(codes(qualityPrecheck(r))).toContain('no_guard_before_ai');
  });

  it('critical on invalid model_hint', () => {
    const r = mkRecipe({
      steps: [{ id: 'ai', ingredient: 'ai-classify', input: { 'llm.model_hint': 'turbo' } }],
    });
    expect(codes(qualityPrecheck(r))).toContain('invalid_model_hint');
  });
});

/** Every shipped AI step is `op: "core.ai.*"` with its payload in `args`; the AI
 *  checks found AI steps by `ingredient` alone and ran on none of them. */
describe('qualityPrecheck — the AI checks see an op step', () => {
  const summarize = (args: Record<string, unknown> = {}) => ({
    id: 'brief', op: 'core.ai.summarize', args: { 'llm.data': '{{step.deal}}', ...args },
  });

  it('guard before AI, no PII declaration, the AI TTL floor', () => {
    const f = qualityPrecheck(mkRecipe({ ttl: 120, steps: [summarize()] }));
    expect(codes(f)).toEqual(expect.arrayContaining(['no_guard_before_ai', 'no_hash_before_ai', 'ttl_below_floor']));
    expect(f.find((x) => x.check === 'ttl_below_floor')?.detail).toBe('TTL 120s below floor 300s for AI recipes');
    const tagged = qualityPrecheck(mkRecipe({ steps: [summarize({ 'llm.pii_fields': { owner_email: 'email' } })] }));
    expect(codes(tagged)).not.toContain('no_hash_before_ai');
  });

  it('the ai-prompt system prompt', () => {
    const f = qualityPrecheck(mkRecipe({ steps: [{ id: 'ask', op: 'core.ai.prompt', args: { 'llm.prompt': '{{step.deal}}' } }] }));
    expect(f.filter((x) => x.check === 'ai_prompt_missing_system')).toEqual([{
      severity: 'review', check: 'ai_prompt_missing_system', detail: "step 'ask' core.ai.prompt has no llm.system_prompt",
    }]);
  });

  it('an unknown model hint is a review on an op step, critical on an ingredient step', () => {
    const hintSeverities = (step: Record<string, unknown>) => qualityPrecheck(mkRecipe({ steps: [step] }))
      .filter((x) => x.check === 'invalid_model_hint').map((x) => x.severity);
    expect(hintSeverities(summarize({ 'llm.model_hint': 'turbo' }))).toEqual(['review']);
    expect(hintSeverities({ id: 'ai', ingredient: 'ai-classify', input: { 'llm.model_hint': 'turbo' } })).toEqual(['critical']);
  });

  it('a non-AI op is not an AI step', () => {
    const f = qualityPrecheck(mkRecipe({ ttl: 120, steps: [{ id: 'ping', op: 'core.notification.send', args: { text: 'hi' } }] }));
    expect(codes(f).filter((c) => ['no_guard_before_ai', 'no_hash_before_ai', 'ttl_below_floor'].includes(c))).toEqual([]);
  });
});

describe('qualityPrecheck — nested templates', () => {
  it('critical on nested template', () => {
    const r = mkRecipe({
      steps: [{ id: 'x', transform: 'template', text: '{{step.{{config.key}}}}' }],
    });
    expect(codes(qualityPrecheck(r))).toContain('nested_template');
  });
});

describe('qualityPrecheck — metadata', () => {
  it('review on placeholder author', () => {
    const r = mkRecipe({ metadata: { name: 'X', author: 'TODO', supported_platforms: [], tags: ['a', 'b', 'c'] } });
    expect(codes(qualityPrecheck(r))).toContain('author_placeholder');
  });

  it('review on missing tags', () => {
    const r = mkRecipe({ metadata: { name: 'X', author: 'pub', supported_platforms: [], tags: [] } });
    expect(codes(qualityPrecheck(r))).toContain('tags_missing');
  });

  it('info on variant_group missing for platform recipe', () => {
    const r = mkRecipe({ metadata: { name: 'X', author: 'pub', supported_platforms: ['hubspot'], tags: ['a', 'b', 'c'] } });
    expect(codes(qualityPrecheck(r))).toContain('variant_group_missing');
  });
});

describe('qualityPrecheck — hash pairing', () => {
  it('review on hash_replace without restore', () => {
    const r = mkRecipe({
      steps: [
        { id: 'hash', transform: 'hash_replace', fields: ['name'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.hash}}' } },
      ],
    });
    expect(codes(qualityPrecheck(r))).toContain('missing_hash_restore');
  });
});

describe('qualityPrecheck — division guard', () => {
  it('review on unguarded division', () => {
    const r = mkRecipe({
      steps: [{ id: 'calc', transform: 'math', operator: 'divide', a: '{{step.deal.x}}', b: '{{step.deal.y}}' }],
    });
    expect(codes(qualityPrecheck(r))).toContain('unguarded_division');
  });

  it('no finding when division has a skip_when guard', () => {
    const r = mkRecipe({
      steps: [{
        id: 'calc', transform: 'math', operator: 'divide',
        a: '{{step.deal.x}}', b: '{{step.deal.y}}',
        skip_when: '{{step.deal.y}} equal 0',
      }],
    });
    expect(codes(qualityPrecheck(r))).not.toContain('unguarded_division');
  });
});

// ────────────────────────────────────────────────────────────────
// TTL floor
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — TTL floor', () => {
  it('info when TTL is below the data-recipe floor (60)', () => {
    const r = mkRecipe({ ttl: 30 });
    expect(codes(qualityPrecheck(r))).toContain('ttl_below_floor');
  });

  it('info when TTL is below the AI floor (300)', () => {
    const r = mkRecipe({
      ttl: 60,
      steps: [{
        id: 'ai', ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['a'] },
        skip_when: '{{step.deal}} is_null',
      }],
    });
    expect(codes(qualityPrecheck(r))).toContain('ttl_below_floor');
  });

  it('treats missing/non-numeric ttl as 0 (always below floor)', () => {
    const r = mkRecipe({ ttl: 'not a number' });
    expect(codes(qualityPrecheck(r))).toContain('ttl_below_floor');
  });
});

// ────────────────────────────────────────────────────────────────
// Placeholder IDs
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — placeholder IDs', () => {
  it('info on common placeholder step ids', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'foo', ingredient: 'x', input: {} }],
      steps: [{ id: 'bar', transform: 'template', text: '{{step.foo}}' }],
    });
    const c = codes(qualityPrecheck(r));
    expect(c.filter(x => x === 'placeholder_id').length).toBeGreaterThanOrEqual(2);
  });

  it('is case-insensitive (STEP_1 matches step_1)', () => {
    const r = mkRecipe({
      steps: [
        { id: 'Step_1', transform: 'template', text: '{{step.Step_2}}' },
        { id: 'Step_2', transform: 'template', text: 'ok' },
      ],
    });
    expect(codes(qualityPrecheck(r))).toContain('placeholder_id');
  });
});

// ────────────────────────────────────────────────────────────────
// AI hygiene — hash pairing + system_prompt
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — AI hash + prompt hygiene', () => {
  it('info when AI is present without hash_replace or pii_fields', () => {
    const r = mkRecipe({
      steps: [{
        id: 'ai', ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['x'] },
        skip_when: '{{step.deal}} is_null',
      }],
    });
    expect(codes(qualityPrecheck(r))).toContain('no_hash_before_ai');
  });

  // ⛔ It counted only hash_replace and the step-level pii_fields list, and told
  // authors (models too, through recued_saveRecipe) to add one: both turn free text
  // into tokens, and a recipe protected another way was told it had nothing.
  it('the notice points to llm.pii_fields and pii-protect, never to hash_replace or a pii_fields list', () => {
    const r = mkRecipe({
      steps: [{
        id: 'ai', ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['x'] },
        skip_when: '{{step.deal}} is_null',
      }],
    });
    const detail = qualityPrecheck(r).find((f) => f.check === 'no_hash_before_ai')?.detail ?? '';
    expect(detail).toContain("AI step's llm.pii_fields");
    expect(detail).toContain('pii-protect / pii-restore');
    expect(detail).not.toContain('hash_replace');
    expect(detail).not.toMatch(/(?<!llm\.)pii_fields/); // only ever llm.pii_fields
  });

  it('llm.pii_fields, in an input or an op-step\'s args, or a pii-protect bracket suppresses no_hash_before_ai', () => {
    const ai = {
      id: 'ai', ingredient: 'ai-classify',
      input: { 'llm.data': '{{step.deal}}', 'llm.categories': ['x'] },
      skip_when: '{{step.deal}} is_null',
    };
    const tagged = mkRecipe({ steps: [{ ...ai, input: { ...ai.input, 'llm.pii_fields': { email: 'email' } } }] });
    const viaOp = mkRecipe({ steps: [
      ai,
      { id: 'brief', op: 'core.ai.summarize', args: { 'llm.data': '{{step.deal}}', 'llm.pii_fields': { notes: 'content' } } },
    ] });
    const bracketed = mkRecipe({ steps: [
      { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
      ai,
    ] });
    for (const r of [tagged, viaOp, bracketed]) expect(codes(qualityPrecheck(r))).not.toContain('no_hash_before_ai');
  });

  it('pii_fields on any step suppresses no_hash_before_ai', () => {
    const r = mkRecipe({
      steps: [
        { id: 'redact', transform: 'redact', pii_fields: ['email'] },
        {
          id: 'ai', ingredient: 'ai-classify',
          input: { 'llm.data': '{{step.redact}}', 'llm.categories': ['x'] },
          skip_when: '{{step.redact}} is_null',
        },
      ],
    });
    expect(codes(qualityPrecheck(r))).not.toContain('no_hash_before_ai');
  });

  it('review on ai-prompt missing llm.system_prompt', () => {
    const r = mkRecipe({
      steps: [{
        id: 'ai', ingredient: 'ai-prompt',
        input: { 'llm.prompt': 'do a thing' },
        skip_when: '{{step.deal}} is_null',
      }],
    });
    expect(codes(qualityPrecheck(r))).toContain('ai_prompt_missing_system');
  });
});

// ────────────────────────────────────────────────────────────────
// Tags thinness
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — tags thinness', () => {
  it('info (tags_thin) when tags has 1-2 items', () => {
    const r = mkRecipe({
      metadata: { name: 'X', author: 'pub', supported_platforms: [], tags: ['deal'] },
    });
    expect(codes(qualityPrecheck(r))).toContain('tags_thin');
  });
});

// ────────────────────────────────────────────────────────────────
// No-op transforms
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — no-op transforms', () => {
  it('review on hash_replace with empty fields', () => {
    const r = mkRecipe({
      steps: [{ id: 'h', transform: 'hash_replace', fields: [] }],
    });
    expect(codes(qualityPrecheck(r))).toContain('empty_hash_replace');
  });

  it('review on pick with no source and no keys', () => {
    const r = mkRecipe({
      steps: [{ id: 'p', transform: 'pick' }],
    });
    expect(codes(qualityPrecheck(r))).toContain('empty_pick');
  });

  it('no empty_pick when pick has a source', () => {
    const r = mkRecipe({
      steps: [{ id: 'p', transform: 'pick', source: '{{step.deal}}' }],
    });
    expect(codes(qualityPrecheck(r))).not.toContain('empty_pick');
  });
});

// ────────────────────────────────────────────────────────────────
// to_table format-hint suggestions
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — to_table format hints', () => {
  it('info on currency-like column without format hint', () => {
    const r = mkRecipe({
      steps: [{
        id: 't', transform: 'to_table', rows: '{{step.deal}}',
        columns: [{ field: 'amount', label: 'Amount' }],
      }],
    });
    expect(codes(qualityPrecheck(r))).toContain('format_hint_missing_currency');
  });

  it('info on date-like column without format hint', () => {
    const r = mkRecipe({
      steps: [{
        id: 't', transform: 'to_table', rows: '{{step.deal}}',
        columns: [{ field: 'close_date', label: 'Close' }],
      }],
    });
    expect(codes(qualityPrecheck(r))).toContain('format_hint_missing_date');
  });

  it('no finding when the column already specifies format', () => {
    const r = mkRecipe({
      steps: [{
        id: 't', transform: 'to_table', rows: '{{step.deal}}',
        columns: [
          { field: 'amount', label: 'Amount', format: 'currency' },
          { field: 'close_date', label: 'Close', format: 'date' },
        ],
      }],
    });
    const c = codes(qualityPrecheck(r));
    expect(c).not.toContain('format_hint_missing_currency');
    expect(c).not.toContain('format_hint_missing_date');
  });

  it('no format hint finding for action columns', () => {
    const r = mkRecipe({
      steps: [{
        id: 't', transform: 'to_table', rows: '{{step.deal}}',
        columns: [{ field: 'close_date', label: 'Action', type: 'action' }],
      }],
    });
    expect(codes(qualityPrecheck(r))).not.toContain('format_hint_missing_date');
  });
});

// ────────────────────────────────────────────────────────────────
// Negative: hash_restore-without-replace produces no finding
// ────────────────────────────────────────────────────────────────

describe('qualityPrecheck — missing_hash_restore negatives', () => {
  it('no finding when both hash_replace and hash_restore are present', () => {
    const r = mkRecipe({
      steps: [
        { id: 'hr', transform: 'hash_replace', fields: ['email'] },
        {
          id: 'ai', ingredient: 'ai-classify',
          input: { 'llm.data': '{{step.hr}}', 'llm.categories': ['x'] },
          skip_when: '{{step.hr}} is_null',
        },
        { id: 'restore', transform: 'hash_restore', source: '{{step.ai}}' },
      ],
    });
    expect(codes(qualityPrecheck(r))).not.toContain('missing_hash_restore');
  });
});

describe('qualityPrecheck — pii-protect / pii-restore guidance', () => {
  it('info on AI recipe with hash_replace on snake PII', () => {
    const r = mkRecipe({
      steps: [
        { id: 'h', transform: 'hash_replace', fields: ['contact.email'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.h}}', 'llm.categories': ['a'] } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
    });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('prefer_pii_protect');
    expect(f.find(x => x.check === 'prefer_pii_protect')?.severity).toBe('info');
  });

  it('info on AI recipe with hash_replace on camelCase PII', () => {
    const r = mkRecipe({
      steps: [
        { id: 'h', transform: 'hash_replace', fields: ['ownerName'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.h}}', 'llm.categories': ['a'] } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
    });
    expect(codes(qualityPrecheck(r))).toContain('prefer_pii_protect');
  });

  it('does not suggest pii-protect for non-PII hash_replace fields', () => {
    const r = mkRecipe({
      steps: [
        { id: 'h1', transform: 'hash_replace', fields: ['username'] },
        { id: 'h2', transform: 'hash_replace', fields: ['filename'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.h1}} {{step.h2}}', 'llm.categories': ['a'] } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('prefer_pii_protect');
  });

  it('does not suggest pii-protect for data-only recipes', () => {
    const r = mkRecipe({
      steps: [{ id: 'h', transform: 'hash_replace', fields: ['email'] }],
      output: { sidebar: [{ type: 'summary', source: 'step.h' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('prefer_pii_protect');
  });

  it('still suggests pii-protect when hash_restore is present without missing_hash_restore', () => {
    const r = mkRecipe({
      steps: [
        { id: 'h', transform: 'hash_replace', fields: ['email'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.h}}', 'llm.categories': ['a'] } },
        { id: 'r', transform: 'hash_restore', data: '{{step.ai}}', mapping: '{{step.h.mapping}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.r' }] },
    });
    const c = codes(qualityPrecheck(r));
    expect(c).toContain('prefer_pii_protect');
    expect(c).not.toContain('missing_hash_restore');
  });

  it('review on pii-protect without pii-restore', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.protect}}', 'llm.categories': ['a'] } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
    });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('missing_pii_restore');
    expect(f.find(x => x.check === 'missing_pii_restore')?.severity).toBe('review');
  });

  it('does not flag missing_pii_restore when pii-restore is present', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.protect}}', 'llm.categories': ['a'] } },
        { id: 'restore', transform: 'pii-restore', data: '{{step.ai}}', ledger_handle: '{{step.protect.ledger_handle}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.restore' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('missing_pii_restore');
  });

  it('emits one prefer_pii_protect finding per PII hash_replace step', () => {
    const r = mkRecipe({
      steps: [
        { id: 'h1', transform: 'hash_replace', fields: ['email'] },
        { id: 'h2', transform: 'hash_replace', fields: ['phone'] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.h1}} {{step.h2}}', 'llm.categories': ['a'] } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
    });
    expect(codes(qualityPrecheck(r)).filter(c => c === 'prefer_pii_protect').length).toBe(2);
  });
});

describe('qualityPrecheck — pii_protect_bad_field_tag', () => {
  it('typoed kind -> pii_protect_bad_field_tag critical', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'emial' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('pii_protect_bad_field_tag');
    expect(f.find(x => x.check === 'pii_protect_bad_field_tag')?.severity).toBe('critical');
  });

  it('missing path -> pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ kind: 'email' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).toContain('pii_protect_bad_field_tag');
  });

  it('non-object entry -> pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: ['email'] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).toContain('pii_protect_bad_field_tag');
  });

  it('valid tag -> no pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'email' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('pii_protect_bad_field_tag');
  });

  it('kind content is valid -> no pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'body', kind: 'content' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('pii_protect_bad_field_tag');
  });

  it('empty fields -> no pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('pii_protect_bad_field_tag');
  });

  it('absent fields -> no pii_protect_bad_field_tag', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('pii_protect_bad_field_tag');
  });

  it('two malformed entries -> two pii_protect_bad_field_tag findings', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: [{ path: 'email', kind: 'emial' }, { kind: 'name' }] },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r)).filter(c => c === 'pii_protect_bad_field_tag').length).toBe(2);
  });

  it('non-array fields -> pii_protect_bad_field_tag critical', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: { nope: true } },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('pii_protect_bad_field_tag');
    expect(f.find(x => x.check === 'pii_protect_bad_field_tag')?.severity).toBe('critical');
  });

  it('null fields -> no pii_protect_bad_field_tag (no-op)', () => {
    const r = mkRecipe({
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{step.deal}}', fields: null },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.protect' }] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('pii_protect_bad_field_tag');
  });
});

describe('qualityPrecheck — empty / degenerate recipe (slice 3)', () => {
  it('flags a recipe with no prefetch_steps and no steps as critical', () => {
    const r = mkRecipe({ prefetch_steps: [], steps: [], output: { sidebar: [] } });
    const f = qualityPrecheck(r);
    expect(codes(f)).toContain('empty_recipe');
    expect(f.find((x) => x.check === 'empty_recipe')?.severity).toBe('critical');
  });

  it('a recipe with steps is not flagged', () => {
    expect(codes(qualityPrecheck(mkRecipe()))).not.toContain('empty_recipe');
  });

  it('a prefetch-only recipe is NOT empty (prefetch performs work)', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'deal', ingredient: 'deal-reader-hubspot', input: {} }],
      steps: [],
      output: { sidebar: [] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('empty_recipe');
  });

  it('a trigger_steps-only reactive recipe is NOT flagged empty', () => {
    const r = mkRecipe({
      auto_run: { interval_ms: 3_600_000 },
      prefetch_steps: [],
      steps: [],
      trigger_steps: [{ id: 'gate', guard: '{{context.event}} is_null' }],
      output: { sidebar: [] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('empty_recipe');
  });

  it('a canonical op-step recipe is not flagged empty (the op-step is a step)', () => {
    const r = mkRecipe({
      prefetch_steps: [],
      steps: [{ id: 'deals', op: 'deal.search', args: { limit: 50 } }],
      output: { sidebar: [] },
    });
    expect(codes(qualityPrecheck(r))).not.toContain('empty_recipe');
  });
});
