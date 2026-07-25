/** D-130 Phase 7 — Cross-vendor `data.crm.*` alias (recipe-validator
 *  surface).
 *
 *  Validator-level assertions for the cross-vendor alias form
 *  `{{data.crm.<crm_alias>.<full_target_id>.enrichments.<topic>}}`.
 *  The contracts substrate (`matchCrmAlias` + runtime resolver
 *  collapse) is covered separately by
 *  `packages/contracts/src/__tests__/d-130-phase-7-crm-aliases.test.ts`.
 *
 *  Coverage:
 *    - Cross-vendor alias passes for known platform-reference topics
 *      against both HubSpot + Salesforce vendors via target_id
 *      prefix dispatch.
 *    - Unknown topic on the cross-vendor alias surfaces
 *      `enrichment_topic_unknown` with the ORIGINAL alias ref
 *      preserved in the message.
 *    - Topic that is per-record but not valid on the dispatched
 *      scope surfaces `enrichment_scope_unsupported`.
 *    - `read_connection_*` permission hint fires on cross-vendor
 *      alias reads and lists the dispatched canonical scope.
 *    - Unknown `crm_alias` segment hard-errors `crm_alias_unknown`.
 *    - Unresolved target_id prefix hard-errors `crm_alias_unresolved`.
 *    - Bare `data.crm` / `data.crm.<alias>` / bare-entity refs are
 *      ignored (no false positives).
 *    - Dynamic id inside `data.crm.*` is caught by the global
 *      nested-template detector.
 */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'd-130-p7-validate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-130 P7 validate',
    description: 'Recipe under test for the D-130 P7 cross-vendor alias validator surface.',
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
// Cross-vendor alias passes for known topics + valid target_id
// ────────────────────────────────────────────────────────────────

describe('D-130 P7 — cross-vendor alias passes the topic + scope walk', () => {
  it('accepts a deal alias dispatching to hubspot.deal', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
  });

  it('accepts a deal alias dispatching to salesforce.opportunity', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
  });

  it('accepts a contact alias drill across either vendor', () => {
    const hubspot = recipeWithRef(
      '{{data.crm.contact.hubspot_contact_42.enrichments.engagement_score_per_contact.score}}',
    );
    const salesforce = recipeWithRef(
      '{{data.crm.contact.salesforce_contact_003A0000005XYZAB.enrichments.engagement_score_per_contact.score}}',
    );
    expect(codes(validateRecipe(hubspot))).not.toContain('enrichment_topic_unknown');
    expect(codes(validateRecipe(hubspot))).not.toContain('enrichment_scope_unsupported');
    expect(codes(validateRecipe(salesforce))).not.toContain('enrichment_topic_unknown');
    expect(codes(validateRecipe(salesforce))).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts the account alias dispatching to hubspot.company (lexicon mapping) on the bag form', () => {
    // `crm.account` rewrites onto `hubspot.company`; no per-record
    // topic is registered against `connection.api.hubspot.company` at
    // D-130, so the bag form is the only shape that exercises the
    // dispatch path without surfacing scope-unsupported.
    const recipe = recipeWithRef(
      '{{data.crm.account.hubspot_company_55555.enrichments}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('accepts the bag form (no topic) on the cross-vendor alias', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });
});

// ────────────────────────────────────────────────────────────────
// Validator surfaces user's original syntax in error messages
// ────────────────────────────────────────────────────────────────

describe('D-130 P7 — error messages preserve the cross-vendor alias ref shape', () => {
  it('flags an unknown topic on a cross-vendor alias and quotes the ORIGINAL ref', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.not_a_topic}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_topic_unknown');
    const messages = messagesFor(result, 'enrichment_topic_unknown');
    expect(
      messages.some((m) =>
        m.includes('{{data.crm.deal.hubspot_deal_47291.enrichments.not_a_topic}}'),
      ),
    ).toBe(true);
    // The dispatched canonical scope appears in the valid-topics hint.
    expect(
      messages.some((m) => m.includes("valid topics on 'connection.api.hubspot.deal'")),
    ).toBe(true);
  });

  it('flags scope_unsupported when the topic is per-record but not valid on the dispatched scope', () => {
    // `summary` is mail-only; addressing it through a CRM alias must
    // surface scope_unsupported with the dispatched canonical scope
    // mentioned in the message.
    const recipe = recipeWithRef(
      '{{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.summary}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('enrichment_scope_unsupported');
    const messages = messagesFor(result, 'enrichment_scope_unsupported');
    expect(
      messages.some((m) => m.includes('connection.api.salesforce.opportunity')),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('{{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.summary}}'),
      ),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// `read_connection_*` permission hint
// ────────────────────────────────────────────────────────────────

describe('D-130 P7 — read_connection_* hint on cross-vendor alias reads', () => {
  it('fires the hint with the dispatched canonical scope', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('read_connection_permission_missing');
    const messages = messagesFor(result, 'read_connection_permission_missing');
    expect(messages.some((m) => m.includes("'connection.api.hubspot.deal'"))).toBe(true);
  });

  it('reports both vendor scopes when the recipe touches both via crm.*', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score}} {{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    const messages = messagesFor(result, 'read_connection_permission_missing');
    expect(messages.some((m) => m.includes("'connection.api.hubspot.deal'"))).toBe(true);
    expect(messages.some((m) => m.includes("'connection.api.salesforce.opportunity'"))).toBe(true);
  });

  it('suppresses the hint when the recipe declares any read_connection_* slug', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score}}',
      ['read_connection_my_hubspot'],
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });
});

// ────────────────────────────────────────────────────────────────
// Hard-error on unknown crm_alias / unresolved target_id
// ────────────────────────────────────────────────────────────────

describe('D-130 P7 — hard-errors on malformed `data.crm.*` shapes', () => {
  it('hard-errors on unknown crm_alias (not in CRM_ALIAS_VALUES)', () => {
    const recipe = recipeWithRef(
      '{{data.crm.lead.hubspot_deal_47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('crm_alias_unknown');
    const messages = messagesFor(result, 'crm_alias_unknown');
    expect(messages.some((m) => m.includes("unknown crm_alias 'lead'"))).toBe(true);
    expect(messages.some((m) => m.includes('valid: deal, contact, account'))).toBe(true);
  });

  it('hard-errors when the target_id prefix dispatches to no registered vendor', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.unknownvendor_deal_42.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('crm_alias_unresolved');
    const messages = messagesFor(result, 'crm_alias_unresolved');
    expect(messages.some((m) => m.includes("crm_alias 'deal'"))).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('hubspot_deal_<id>') || m.includes('salesforce_opportunity_<id>'),
      ),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Negative space: bare refs and unrelated shapes silently pass
// ────────────────────────────────────────────────────────────────

describe('D-130 P7 — bare cross-vendor refs ignored', () => {
  it('does not enforce topic validation on a bare `data.crm` ref', () => {
    const recipe = recipeWithRef('{{data.crm}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
  });

  it('does not enforce topic validation on a bare `data.crm.<alias>` ref', () => {
    const recipe = recipeWithRef('{{data.crm.deal}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
  });

  it('does not enforce topic validation on a `data.crm.<alias>.<id>` bare entity (no enrichments)', () => {
    const recipe = recipeWithRef('{{data.crm.deal.hubspot_deal_47291}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
  });

  it('catches dynamic id under `data.crm.*` via the global nested-template detector', () => {
    const recipe = recipeWithRef(
      '{{data.crm.deal.{{step.s}}.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('nested_template');
  });

  it('does not double-process an already-canonical ref through the cross-vendor scanner', () => {
    const recipe = recipeWithRef(
      '{{data.enrichment.connection.api.hubspot.deal.47291.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(messagesFor(result, 'enrichment_topic_unknown')).toHaveLength(0);
    expect(messagesFor(result, 'enrichment_scope_unsupported')).toHaveLength(0);
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
  });

  it('does not collide D-129 vendor alias with the cross-vendor scanner', () => {
    // `data.hubspot.deal.<id>.enrichments.<topic>` should still walk
    // through the D-129 vendor-alias path; the cross-vendor scanner
    // only fires on `data.crm.*`.
    const recipe = recipeWithRef(
      '{{data.hubspot.deal.47291.enrichments.deal_health_score}}',
    );
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_topic_unknown');
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
    expect(codes(result)).not.toContain('crm_alias_unknown');
    expect(codes(result)).not.toContain('crm_alias_unresolved');
  });
});
