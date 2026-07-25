/** D-130 Phase 7 — Cross-vendor `data.crm.*` alias resolver (contracts
 *  substrate).
 *
 *  Substrate-level assertions:
 *    - `matchCrmAlias` rewrites `crm.<crm_alias>.<full_target_id>[.<rest>]`
 *      onto canonical `enrichment.connection.api.<vendor>.<entity>.<full_target_id>[.<rest>]`
 *      via vendor-prefix dispatch on the target_id.
 *    - Both HubSpot + Salesforce target_id prefixes dispatch correctly.
 *    - Cross-vendor `crm_alias` collision is the desired shape — both
 *      vendors carry `'deal'` / `'contact'` / `'account'` and the
 *      target_id picks which.
 *    - Within-vendor `crm_alias` collision is rejected by
 *      `assertConnectionVendorRegistry`.
 *    - Unknown crm_alias / unknown target_id prefix returns null.
 *    - `tryRewriteCrmAlias` returns null on non-aliases.
 *    - The runtime resolver collapses `data.crm.*` refs onto the
 *      canonical store at `parseRef` boundary.
 *    - The `crm` reserved sub-namespace would clash if a vendor
 *      registered itself as `'crm'`.
 *    - Existing D-129 vendor-alias rewrites still work (the new
 *      crm-alias dispatch is additive, doesn't shadow).
 */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  RESERVED_DATA_SUBNAMESPACES,
  assertConnectionVendorRegistry,
  assertNoVendorPrefixClash,
  buildConnectionVendorEntity,
  collectRefs,
  getVendorEntityByCrmAlias,
  matchCrmAlias,
  resolveRef,
  tryRewriteCrmAlias,
  tryRewriteVendorEnrichmentAlias,
  type ConnectionVendorEntity,
  type NamespaceStores,
} from '../index.js';

describe('D-130 Phase 7 — crm alias values + registry annotations', () => {
  it('exposes the closed `CRM_ALIAS_VALUES` list', () => {
    expect([...CRM_ALIAS_VALUES]).toEqual(['deal', 'contact', 'account']);
  });

  it('annotates the three HubSpot D-129 entries retroactively', () => {
    const deal = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'hubspot' && e.entity === 'deal',
    );
    const contact = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'hubspot' && e.entity === 'contact',
    );
    const company = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'hubspot' && e.entity === 'company',
    );
    expect(deal?.crm_alias).toBe('deal');
    expect(contact?.crm_alias).toBe('contact');
    // HubSpot's `company` maps to the cross-vendor `account` lexicon
    // — the vendor-specific alias preserves "company", the cross-
    // vendor lens uses "account" (Salesforce-flavored term).
    expect(company?.crm_alias).toBe('account');
  });

  it('annotates the three Salesforce D-130 entries', () => {
    const opportunity = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'salesforce' && e.entity === 'opportunity',
    );
    const contact = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'salesforce' && e.entity === 'contact',
    );
    const account = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'salesforce' && e.entity === 'account',
    );
    expect(opportunity?.crm_alias).toBe('deal');
    expect(contact?.crm_alias).toBe('contact');
    expect(account?.crm_alias).toBe('account');
  });

  it('annotates the three Pipedrive CRM entries', () => {
    const deal = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'pipedrive' && e.entity === 'deal',
    );
    const person = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'pipedrive' && e.entity === 'person',
    );
    const organization = CONNECTION_VENDOR_ENTITIES.find(
      (e) => e.vendor === 'pipedrive' && e.entity === 'organization',
    );
    expect(deal?.crm_alias).toBe('deal');
    expect(person?.crm_alias).toBe('contact');
    expect(organization?.crm_alias).toBe('account');
  });

  it('exposes a getVendorEntityByCrmAlias lookup', () => {
    expect(getVendorEntityByCrmAlias('hubspot', 'deal')?.entity).toBe('deal');
    expect(getVendorEntityByCrmAlias('hubspot', 'account')?.entity).toBe('company');
    expect(getVendorEntityByCrmAlias('salesforce', 'deal')?.entity).toBe('opportunity');
    expect(getVendorEntityByCrmAlias('salesforce', 'account')?.entity).toBe('account');
    expect(getVendorEntityByCrmAlias('pipedrive', 'deal')?.entity).toBe('deal');
    expect(getVendorEntityByCrmAlias('pipedrive', 'contact')?.entity).toBe('person');
    expect(getVendorEntityByCrmAlias('pipedrive', 'account')?.entity).toBe('organization');
    expect(getVendorEntityByCrmAlias('hubspot', 'contact')?.entity).toBe('contact');
    expect(getVendorEntityByCrmAlias('unknownvendor', 'deal')).toBeNull();
  });
});

describe('D-130 Phase 7 — crm alias rewrite (HubSpot dispatch)', () => {
  it('rewrites a deal alias onto the canonical hubspot.deal store', () => {
    const m = matchCrmAlias('crm.deal.hubspot_deal_47291.enrichments.deal_health_score');
    expect(m).not.toBeNull();
    expect(m!.crmAlias).toBe('deal');
    expect(m!.vendor).toBe('hubspot');
    expect(m!.entity).toBe('deal');
    expect(m!.targetId).toBe('hubspot_deal_47291');
    expect(m!.rest).toBe('deal_health_score');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score',
    );
  });

  it('rewrites a deal-topic drill', () => {
    const m = matchCrmAlias(
      'crm.deal.hubspot_deal_47291.enrichments.attribution_signal.first_touch_source',
    );
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.hubspot_deal_47291.attribution_signal.first_touch_source',
    );
    expect(m!.rest).toBe('attribution_signal.first_touch_source');
  });

  it('rewrites a meta-sibling drill', () => {
    const m = matchCrmAlias(
      'crm.deal.hubspot_deal_47291.enrichments.deal_health_score.meta.amount',
    );
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.meta.amount',
    );
  });

  it("rewrites the bag form (no topic) onto the canonical bag", () => {
    const m = matchCrmAlias('crm.deal.hubspot_deal_47291.enrichments');
    expect(m!.targetId).toBe('hubspot_deal_47291');
    expect(m!.rest).toBe('');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.hubspot_deal_47291',
    );
  });

  it('dispatches the contact alias onto hubspot.contact', () => {
    const m = matchCrmAlias(
      'crm.contact.hubspot_contact_99001.enrichments.engagement_score_per_contact.score',
    );
    expect(m!.vendor).toBe('hubspot');
    expect(m!.entity).toBe('contact');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.contact.hubspot_contact_99001.engagement_score_per_contact.score',
    );
  });

  it('dispatches the account alias onto hubspot.company (cross-vendor lexicon)', () => {
    // HubSpot's "company" is the cross-vendor "account". The user
    // writes `data.crm.account.hubspot_company_<id>...` and the
    // resolver rewrites onto the company store.
    const m = matchCrmAlias(
      'crm.account.hubspot_company_55555.enrichments.lifecycle_stage_inferred',
    );
    expect(m!.vendor).toBe('hubspot');
    expect(m!.entity).toBe('company');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.company.hubspot_company_55555.lifecycle_stage_inferred',
    );
  });
});

describe('D-130 Phase 7 — crm alias rewrite (Salesforce dispatch)', () => {
  it('rewrites a deal alias onto the canonical salesforce.opportunity store', () => {
    const m = matchCrmAlias(
      'crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.deal_health_score',
    );
    expect(m).not.toBeNull();
    expect(m!.crmAlias).toBe('deal');
    expect(m!.vendor).toBe('salesforce');
    expect(m!.entity).toBe('opportunity');
    expect(m!.targetId).toBe('salesforce_opportunity_006A0000005XYZAB');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.salesforce.opportunity.salesforce_opportunity_006A0000005XYZAB.deal_health_score',
    );
  });

  it('dispatches the contact alias onto salesforce.contact', () => {
    const m = matchCrmAlias(
      'crm.contact.salesforce_contact_003A0000005XYZAB.enrichments.engagement_score_per_contact',
    );
    expect(m!.vendor).toBe('salesforce');
    expect(m!.entity).toBe('contact');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.salesforce.contact.salesforce_contact_003A0000005XYZAB.engagement_score_per_contact',
    );
  });

  it('dispatches the account alias onto salesforce.account', () => {
    const m = matchCrmAlias(
      'crm.account.salesforce_account_001A0000005XYZAB.enrichments.lifecycle_stage_inferred',
    );
    expect(m!.vendor).toBe('salesforce');
    expect(m!.entity).toBe('account');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.salesforce.account.salesforce_account_001A0000005XYZAB.lifecycle_stage_inferred',
    );
  });
});

describe('D-130 Phase 7 — crm alias rewrite (Pipedrive dispatch)', () => {
  it('rewrites a deal alias onto the canonical pipedrive.deal store', () => {
    const m = matchCrmAlias(
      'crm.deal.pipedrive_deal_123.enrichments.deal_health_score',
    );
    expect(m).not.toBeNull();
    expect(m!.vendor).toBe('pipedrive');
    expect(m!.entity).toBe('deal');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.pipedrive.deal.pipedrive_deal_123.deal_health_score',
    );
  });

  it('dispatches the contact alias onto pipedrive.person', () => {
    const m = matchCrmAlias(
      'crm.contact.pipedrive_person_456.enrichments.engagement_score_per_contact',
    );
    expect(m!.vendor).toBe('pipedrive');
    expect(m!.entity).toBe('person');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.pipedrive.person.pipedrive_person_456.engagement_score_per_contact',
    );
  });

  it('dispatches the account alias onto pipedrive.organization', () => {
    const m = matchCrmAlias(
      'crm.account.pipedrive_organization_789.enrichments.lifecycle_stage_inferred',
    );
    expect(m!.vendor).toBe('pipedrive');
    expect(m!.entity).toBe('organization');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.pipedrive.organization.pipedrive_organization_789.lifecycle_stage_inferred',
    );
  });
});

describe('D-130 Phase 7 — crm alias non-matches', () => {
  it('returns null when the path is not under `crm.*`', () => {
    expect(matchCrmAlias('hubspot.deal.47291.enrichments.foo')).toBeNull();
    expect(matchCrmAlias('memory.run-1.commit_status')).toBeNull();
    expect(matchCrmAlias('mail.msg-1.subject')).toBeNull();
  });

  it('returns null for an unknown crm_alias segment', () => {
    expect(
      matchCrmAlias('crm.bogus.hubspot_deal_47291.enrichments.deal_health_score'),
    ).toBeNull();
  });

  it('returns null when the target_id prefix matches no registered vendor', () => {
    // No `(vendor, entity)` in the registry has `_deal_` as `<vendor>_<entity>_`
    // prefix when the vendor token is `unknownvendor`.
    expect(
      matchCrmAlias('crm.deal.unknownvendor_deal_42.enrichments.deal_health_score'),
    ).toBeNull();
  });

  it('returns null when the alias is missing the `.enrichments` marker', () => {
    expect(matchCrmAlias('crm.deal.hubspot_deal_47291')).toBeNull();
    expect(matchCrmAlias('crm.deal.hubspot_deal_47291.deal_health_score')).toBeNull();
  });

  it('returns null for canonical paths (handled by the enrichment scanner)', () => {
    expect(
      matchCrmAlias('enrichment.connection.api.hubspot.deal.47291.attribution_signal'),
    ).toBeNull();
  });

  it('returns null for the bare crm namespace + crm.<alias> shapes', () => {
    expect(matchCrmAlias('crm')).toBeNull();
    expect(matchCrmAlias('crm.deal')).toBeNull();
  });

  it('tryRewriteCrmAlias returns null on non-matches', () => {
    expect(tryRewriteCrmAlias('hubspot.deal.47291.enrichments.foo')).toBeNull();
    expect(tryRewriteCrmAlias('crm.bogus.hubspot_deal_47291.enrichments.foo')).toBeNull();
    expect(tryRewriteCrmAlias('crm')).toBeNull();
  });

  it('does not dispatch when the cross-vendor target_id prefix collides on a vendor that does not register the crm_alias', () => {
    // `linear_issue_42` would not match any registered crm_alias for
    // `linear` (Linear is not in the registry at D-130). Returns null
    // — recipe gets a graceful "no match" rather than a wild dispatch.
    expect(
      matchCrmAlias('crm.deal.linear_issue_42.enrichments.deal_health_score'),
    ).toBeNull();
  });
});

describe('D-130 Phase 7 — within-vendor crm_alias collision rejection', () => {
  it('passes the live registry (no within-vendor collisions)', () => {
    expect(assertConnectionVendorRegistry(CONNECTION_VENDOR_ENTITIES)).toEqual([]);
  });

  it('rejects two entries on the same vendor sharing a crm_alias', () => {
    const deal: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'deal',
      display_name: 'HubSpot Deal',
      crm_alias: 'deal',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const opportunity: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'opportunity',
      display_name: 'HubSpot Opportunity (BOGUS)',
      crm_alias: 'deal',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const issues = assertConnectionVendorRegistry([deal, opportunity]);
    const collisionIssue = issues.find((i) =>
      /already declares crm_alias 'deal' at entry \[0\]/.test(i),
    );
    expect(collisionIssue).toBeDefined();
  });

  it('allows cross-vendor crm_alias collision (the intended shape)', () => {
    const hubspotDeal: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'deal',
      display_name: 'HubSpot Deal',
      crm_alias: 'deal',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const salesforceOpportunity: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'salesforce',
      entity: 'opportunity',
      display_name: 'Salesforce Opportunity',
      crm_alias: 'deal',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const issues = assertConnectionVendorRegistry([hubspotDeal, salesforceOpportunity]);
    const collisionIssues = issues.filter((i) => /crm_alias/.test(i));
    expect(collisionIssues).toEqual([]);
  });

  it('rejects an entry whose crm_alias is not in the closed list', () => {
    expect(() =>
      buildConnectionVendorEntity({
        vendor: 'hubspot',
        entity: 'lead',
        display_name: 'HubSpot Lead (BOGUS)',
        // @ts-expect-error — invalid crm_alias enum value.
        crm_alias: 'lead',
        meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
      }),
    ).toThrow(/crm_alias' must be one of deal \/ contact \/ account/);
  });
});

describe('D-130 Phase 7 — `crm` is a reserved data sub-namespace', () => {
  it('lists `crm` in RESERVED_DATA_SUBNAMESPACES', () => {
    expect(RESERVED_DATA_SUBNAMESPACES.has('crm')).toBe(true);
  });

  it('flags a vendor entry that names itself `crm`', () => {
    const bogus: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'crm',
      entity: 'deal',
      display_name: 'Bogus crm vendor',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const issues = assertNoVendorPrefixClash([bogus]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/vendor 'crm' shadows a reserved data\.\* sub-namespace/);
  });
});

describe('D-130 Phase 7 — runtime resolver collapse', () => {
  // Canonical store shape — both HubSpot + Salesforce rows live under
  // the same `connection.api.<vendor>.<entity>.<full_target_id>` path.
  // The cross-vendor alias must walk into either tree by inspecting
  // the target_id's vendor prefix.
  const stores: NamespaceStores = {
    vault: {},
    config: {},
    context: {},
    meta: {},
    step: {},
    data: {
      enrichment: {
        connection: {
          api: {
            hubspot: {
              deal: {
                hubspot_deal_47291: {
                  deal_health_score: {
                    score: 78,
                    breakdown: ['recent_engagement', 'multi_thread'],
                  },
                  meta: { name: 'Acme Q3 expansion', amount: 50_000 },
                },
              },
              company: {
                hubspot_company_55555: {
                  lifecycle_stage_inferred: { stage: 'customer', confidence: 0.81 },
                },
              },
            },
            salesforce: {
              opportunity: {
                salesforce_opportunity_006A0000005XYZAB: {
                  deal_health_score: { score: 65 },
                  meta: { name: 'Globex renewal', amount: 120_000 },
                },
              },
              account: {
                salesforce_account_001A0000005XYZAB: {
                  lifecycle_stage_inferred: { stage: 'partner', confidence: 0.92 },
                },
              },
            },
          },
        },
      },
    },
  };

  it('cross-vendor deal ref dispatches to the HubSpot canonical record', () => {
    expect(
      resolveRef(
        '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score}}',
        stores,
      ),
    ).toEqual({ score: 78, breakdown: ['recent_engagement', 'multi_thread'] });
  });

  it('cross-vendor deal ref dispatches to the Salesforce canonical record', () => {
    expect(
      resolveRef(
        '{{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.deal_health_score.score}}',
        stores,
      ),
    ).toBe(65);
  });

  it('cross-vendor account ref dispatches to hubspot.company (lexicon mapping)', () => {
    expect(
      resolveRef(
        '{{data.crm.account.hubspot_company_55555.enrichments.lifecycle_stage_inferred.stage}}',
        stores,
      ),
    ).toBe('customer');
  });

  it('cross-vendor account ref dispatches to salesforce.account', () => {
    expect(
      resolveRef(
        '{{data.crm.account.salesforce_account_001A0000005XYZAB.enrichments.lifecycle_stage_inferred.stage}}',
        stores,
      ),
    ).toBe('partner');
  });

  it('alias and canonical resolve to the same record', () => {
    const aliasResult = resolveRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score.score}}',
      stores,
    );
    const canonicalResult = resolveRef(
      '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score}}',
      stores,
    );
    expect(aliasResult).toBe(78);
    expect(aliasResult).toBe(canonicalResult);
  });

  it('cross-vendor and per-vendor aliases resolve to the same record', () => {
    const crossVendor = resolveRef(
      '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score.score}}',
      stores,
    );
    const perVendor = resolveRef(
      '{{data.hubspot.deal.hubspot_deal_47291.enrichments.deal_health_score.score}}',
      stores,
    );
    expect(crossVendor).toBe(78);
    expect(crossVendor).toBe(perVendor);
  });

  it('alias `meta.<field>` drill resolves to the canonical meta snapshot', () => {
    // `meta` is a sibling of topics under the entity-id record (D-128
    // store layout), addressed via `<id>.meta.<field>` — i.e. the
    // alias path is `<vendor>.<entity>.<id>.enrichments.meta.<field>`,
    // which rewrites onto `enrichment.connection.api.<vendor>.<entity>.<id>.meta.<field>`.
    expect(
      resolveRef(
        '{{data.crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.meta.name}}',
        stores,
      ),
    ).toBe('Globex renewal');
  });

  it('returns undefined for a missing record', () => {
    expect(
      resolveRef(
        '{{data.crm.deal.hubspot_deal_99999.enrichments.deal_health_score}}',
        stores,
      ),
    ).toBeUndefined();
  });

  it('does not rewrite a bare entity (alias is enrichment-only)', () => {
    // `data.crm.deal.<id>` (no `.enrichments` suffix) walks the
    // (empty) `data.crm` store and resolves to undefined.
    expect(
      resolveRef('{{data.crm.deal.hubspot_deal_47291}}', stores),
    ).toBeUndefined();
  });

  it('collectRefs collapses cross-vendor + per-vendor + canonical onto one ref', () => {
    const refs = collectRefs({
      a: '{{data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score.score}}',
      b: '{{data.hubspot.deal.hubspot_deal_47291.enrichments.deal_health_score.score}}',
      c: '{{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score}}',
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      ns: 'data',
      path: 'enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score',
    });
  });

  it('does not regress D-129 vendor alias rewrites', () => {
    // Adding the cross-vendor scanner must not shadow the per-vendor
    // alias. `data.hubspot.*` paths still rewrite as before.
    expect(
      tryRewriteVendorEnrichmentAlias('hubspot.deal.47291.enrichments.deal_health_score'),
    ).toBe('enrichment.connection.api.hubspot.deal.47291.deal_health_score');
  });
});
