/** D-128 Phase 4 — recipe-validator extension for platform-reference
 *  enrichment scope refs.
 *
 *  Covers the 4-segment scope walk
 *  (`data.enrichment.connection.api.<vendor>.<entity>.<id>.<topic>`),
 *  scope-vs-topic acceptance against the three reserved cross-vendor
 *  topics, and the helpful "valid topics on '<scope>' are: …" hint
 *  surfaced when an author writes an unknown topic on a recognised
 *  scope. */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'd-128-p4-validate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-128 P4 validate',
    description: 'Recipe under test for the D-128 P4 enrichment ref validator extension.',
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

const issuesOf = (
  result: { issues: Array<{ code: string; message: string }> },
  code: string,
): string[] => result.issues.filter((i) => i.code === code).map((i) => i.message);

const recipeWithRef = (ref: string): RecipeDefinition => ({
  ...base,
  steps: [{ id: 's', transform: 'concat', values: [`prefix-${ref}`] }],
});

// ────────────────────────────────────────────────────────────────
// 4-segment scope walk
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — platform-reference scope walk', () => {
  it('accepts a canonical platform-reference ref to deal_health_score', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a drill into the deal_health_score value', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a drill into the meta snapshot', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.meta.name}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('flags a topic that is not valid on the platform-reference scope', () => {
    // `summary` is mail-only.
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.summary}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
    const messages = issuesOf(result, 'enrichment_scope_unsupported');
    expect(messages.some((m) => m.includes('connection.api.hubspot.deal'))).toBe(true);
  });

  it('flags an unknown topic and includes the valid-topics hint for the scope', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = issuesOf(result, 'enrichment_topic_unknown');
    expect(messages.some((m) => m.includes("valid topics on 'connection.api.hubspot.deal'"))).toBe(true);
    expect(messages.some((m) => m.includes('deal_health_score'))).toBe(true);
  });

  it('emits the no-topics-yet hint for unknown vendor + entity combinations', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.unknownvendor.something.<id>.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    // The topic isn't recognised; the scope has no registered topics.
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = issuesOf(result, 'enrichment_topic_unknown');
    expect(messages.some((m) => m.includes('no per-record topics are registered'))).toBe(true);
  });

  it('bag-form ref (no topic) on a platform-reference scope passes', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('wildcard-list form on a platform-reference scope passes', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.*}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });
});

// ────────────────────────────────────────────────────────────────
// Coexistence with the existing 2-segment connection scope path
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — falls back to 2-segment scope for unconventional names', () => {
  it('connection.api.<connection_name>.<topic> still walks via connection.api', () => {
    // Connection name `MyConn` doesn't match the lowercase-identifier
    // regex used to discriminate vendor segments, so the validator
    // stays on the 2-segment path. `connection_health_trend` is valid
    // on `connection.api`.
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.MyConn.connection_health_trend}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
  });

  it('connection.api.<conn>.<unknown_topic> reports topic_unknown on the 2-segment scope', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.MyConn.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = issuesOf(result, 'enrichment_topic_unknown');
    expect(messages.some((m) => m.includes("valid topics on 'connection.api'"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-checks: closed-list scopes still work
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — closed-list scope refs continue to validate', () => {
  it('mail summary still passes', () => {
    const recipe = recipeWithRef('{{data.enrichment.mail.msg-1.summary}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('contact_timeline_rollup on mail still flags scope_unsupported with valid-topics hint', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.mail.msg-1.contact_timeline_rollup}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
  });

  it('unknown topic on mail surfaces the valid-topics hint', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.mail.msg-1.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = issuesOf(result, 'enrichment_topic_unknown');
    expect(messages.some((m) => m.includes("valid topics on 'mail'"))).toBe(true);
    expect(messages.some((m) => m.includes('summary'))).toBe(true);
  });
});
