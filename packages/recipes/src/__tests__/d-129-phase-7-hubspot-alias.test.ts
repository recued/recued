/** D-129 Phase 7 — Read-side alias resolver (recipe-validator surface).
 *
 *  Validator-level assertions for the cosmetic alias form
 *  `{{data.<vendor>.<entity>.<id>.enrichments.<topic>}}`. The contracts
 *  substrate (`matchVendorEnrichmentAlias` + runtime resolver collapse)
 *  is covered separately by
 *  `packages/contracts/src/__tests__/d-129-phase-7-vendor-aliases.test.ts`.
 *
 *  Coverage:
 *    - Alias passes for known platform-reference topics on each of
 *      D-129's three entities (deal / contact / company).
 *    - Unknown topic on an alias surfaces `enrichment_topic_unknown`
 *      with the ORIGINAL alias ref (not the rewritten canonical) in
 *      the error message.
 *    - Topic that is per-record but not valid on the platform-reference
 *      scope surfaces `enrichment_scope_unsupported`.
 *    - `read_connection_*` permission hint fires on alias-form reads
 *      and lists the canonical platform-reference scope.
 *    - `meta.<field>` drill on alias form passes (sibling traversal).
 *    - Bag form (`<id>.enrichments` with no topic) passes silently —
 *      same contract as the canonical bag.
 *    - Bare entity (no `.enrichments` suffix) is ignored by the
 *      validator (no false positives on unrelated `data.hubspot.*`
 *      shapes).
 *    - Unregistered vendor / entity is ignored by the validator
 *      (silently passes — same as any unrecognised data sub-namespace).
 */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'd-129-p7-validate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-129 P7 validate',
    description: 'Recipe under test for the D-129 P7 alias-form validator surface.',
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

const messagesFor = (
  result: { issues: Array<{ code: string; message: string }> },
  code: string,
): string[] => result.issues.filter((i) => i.code === code).map((i) => i.message);

const recipeWithRef = (ref: string, requires?: string[]): RecipeDefinition => ({
  ...base,
  ...(requires === undefined ? {} : { requires }),
  steps: [{ id: 's', transform: 'concat', values: [`prefix-${ref}`] }],
});

// ────────────────────────────────────────────────────────────────
// Alias passes for registered (vendor, entity) + valid topic
// ────────────────────────────────────────────────────────────────

describe('D-129 P7 — alias form passes the topic + scope walk', () => {
  it('accepts an alias to deal_health_score on hubspot.deal', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a drill through the topic value', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score.score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a drill into the meta sibling on alias form', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score.meta.name}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a contact alias keyed on a canonical email', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.contact.bob@x.com.enrichments.engagement_score_per_contact}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts a contact-alias drill through engagement_score_per_contact.score', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.contact.bob@x.com.enrichments.engagement_score_per_contact.score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts the bag form on a company alias (no topics on company yet)', () => {
    // No D-129 P6 topic registers `connection.api.hubspot.company` in
    // its `valid_scopes` — but the alias still parses to the canonical
    // bag form, which the validator accepts silently (no topic → no
    // topic-vs-scope check). Future post-P7 topics on company will
    // exercise the topic-bound walk identically to deal / contact.
    const recipe = recipeWithRef(
      '{{data.hubspot.company.99001.enrichments}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts the bag form (no topic) on alias', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });
});

// ────────────────────────────────────────────────────────────────
// Validator surfaces user's original syntax in error messages
// ────────────────────────────────────────────────────────────────

describe('D-129 P7 — error messages preserve the alias ref shape', () => {
  it('flags an unknown topic on an alias and quotes the ORIGINAL alias ref', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = messagesFor(result, 'enrichment_topic_unknown');
    // Original alias ref appears verbatim in the error.
    expect(messages.some(
      (m) => m.includes('{{data.hubspot.deal.47291.enrichments.not_a_topic}}'),
    )).toBe(true);
    // The canonical scope is mentioned in the valid-topics hint.
    expect(messages.some(
      (m) => m.includes("valid topics on 'connection.api.hubspot.deal'"),
    )).toBe(true);
  });

  it('flags scope_unsupported when the topic is per-record but not valid on the platform-reference scope', () => {
    // `summary` is mail-only; addressing it through a deal alias must
    // surface scope_unsupported with the canonical scope mentioned in
    // the message.
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.summary}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
    const messages = messagesFor(result, 'enrichment_scope_unsupported');
    expect(messages.some((m) => m.includes('connection.api.hubspot.deal'))).toBe(true);
    // Original alias ref preserved for the author.
    expect(messages.some(
      (m) => m.includes('{{data.hubspot.deal.47291.enrichments.summary}}'),
    )).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// `read_connection_*` permission hint
// ────────────────────────────────────────────────────────────────

describe('D-129 P7 — read_connection_* hint on alias-form reads', () => {
  it('fires the hint when the recipe reads an alias without declaring read_connection_*', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('read_connection_permission_missing');
    const messages = messagesFor(result, 'read_connection_permission_missing');
    expect(messages.some((m) => m.includes("'connection.api.hubspot.deal'"))).toBe(true);
    expect(messages.some((m) => m.includes('hubspot'))).toBe(true);
  });

  it('suppresses the hint when the recipe declares any read_connection_* slug', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score}}',
      ['read_connection_my_hubspot'],
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });
});

// ────────────────────────────────────────────────────────────────
// Negative space: alias matcher silently ignores unrelated shapes
// ────────────────────────────────────────────────────────────────

describe('D-129 P7 — alias matcher ignores unrelated data.* refs', () => {
  it('does not enforce topic validation on a bare-entity ref (no `.enrichments` suffix)', () => {
    // `data.hubspot.deal.47291` is the bare-entity shape. Spec §A.7
    // decision §5: bare-entity reads go through the connection adapter
    // wrapper, not through this rewrite. The validator silently passes.
    const recipe = recipeWithRef('{{data.hubspot.deal.47291}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('does not enforce topic validation on an unregistered vendor', () => {
    const recipe = recipeWithRef(
      '{{data.unknownvendor.deal.47291.enrichments.foo}}',
    );
    const result = validateRecipe(recipe);
    // Validator does not recognise the alias because the vendor is
    // unregistered — falls through silently like any other unknown
    // data sub-namespace. The runtime resolver returns undefined.
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });

  it('does not enforce topic validation on a registered vendor with an unregistered entity', () => {
    const recipe = recipeWithRef(
      '{{data.hubspot.foobar.42.enrichments.foo}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('does not double-process the canonical enrichment ref through the alias scanner', () => {
    // Canonical refs are handled by the existing enrichment scanner;
    // the alias scanner short-circuits on `enrichment.*` paths so the
    // canonical form does not surface duplicate errors.
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.47291.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    const topicErrs = messagesFor(result, 'enrichment_topic_unknown');
    const scopeErrs = messagesFor(result, 'enrichment_scope_unsupported');
    expect(topicErrs).toHaveLength(0);
    expect(scopeErrs).toHaveLength(0);
  });
});
