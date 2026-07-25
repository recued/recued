/** D-139 Phase 7 — Cross-vendor topic widening (substrate completeness).
 *
 *  P7 is the optional substrate-completeness validation step per
 *  spec § P7. The widening was performed across multiple prior phases
 *  (P1a.1 added the canary single-source `aggregates_from`; P3's
 *  Codex P2 #1 fanned out to all per-type engagement scopes; P1b
 *  added Salesforce reconcilers + entities). P7 explicitly asserts
 *  the cross-vendor union round-trip holds end-to-end at the topic
 *  layer (NOT the entity layer per the Deal Identity Asymmetry
 *  Invariant § A.5.5).
 *
 *  Pinned contracts (failing any indicates substrate regression on
 *  cross-vendor union):
 *    - `valid_scopes` enumerates BOTH vendors' deal scopes for every
 *      deal-level deterministic topic — recipes can attach the topic
 *      to a HubSpot deal OR a Salesforce opportunity.
 *    - `aggregates_from` enumerates all per-type engagement scopes
 *      across both vendors (10 closed-list scopes per Pass-5 R5.11
 *      dual-schema for Salesforce voice_call / call_history).
 *    - The `data.crm.deal.<full_target_id>.enrichments.<topic>`
 *      cross-vendor lens (D-130 P7) rewrites onto canonical paths
 *      for every deal-level topic across both vendors via the
 *      `crm_alias` registry annotation.
 *    - The `crm_alias` enum stays at `'deal' | 'contact' | 'account'`
 *      — engagement scopes (the per-type entities) are NOT in the
 *      alias enum (§ A.5.5 + § Non-goals: no `data.crm.engagement.*`
 *      lens; engagements stay vendor-scoped).
 *    - No engagement entity registers a `crm_alias` — explicit
 *      rejection of entity-layer engagement union per § A.5.5.
 *    - The unified-vendor shorthand `connection.api.<vendor>.engagement`
 *      never appears in any topic's `aggregates_from` — per-type
 *      enumeration is the contract.
 *
 *  Spec: D-139 § P7 (cross-vendor topic widening) +
 *  § P7 acceptance + § A.5.5 (Deal Identity Asymmetry Invariant) +
 *  § A.10 (cascade behaviors — topic-layer iteration). */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  ENRICHMENT_REGISTRY,
  ENGAGEMENT_VENDOR_VALUES,
  matchCrmAlias,
} from '../index.js';

const HUBSPOT_DEAL = 'connection.api.hubspot.deal' as const;
const SALESFORCE_OPPORTUNITY = 'connection.api.salesforce.opportunity' as const;

/** Closed list of per-type engagement scopes across both vendors per
 *  § A.1 + § A.2 + Pass-5 R5.11 (Salesforce dual-schema for voice
 *  call). Salesforce voice_call OR call_history register at probe
 *  time depending on org config; the registry includes BOTH so
 *  topic-load is probe-independent. */
const PER_TYPE_ENGAGEMENT_SCOPES = [
  'connection.api.hubspot.email',
  'connection.api.hubspot.meeting',
  'connection.api.hubspot.note',
  'connection.api.hubspot.call',
  'connection.api.hubspot.task',
  'connection.api.salesforce.task',
  'connection.api.salesforce.event',
  'connection.api.salesforce.email_message',
  'connection.api.salesforce.voice_call',
  'connection.api.salesforce.call_history',
] as const;

/** Deal-level deterministic engagement topics (§ A.9.1) — the closed
 *  list of topics the cross-vendor widening contract applies to.
 *  AI-surface canaries (P5: engagement_sentiment_trend +
 *  next_best_action) inherit the same `valid_scopes` shape but their
 *  trust default differs (manual per D-132). P4 cross-entity topics
 *  attach to different scopes (account / contact) and are validated
 *  separately. */
const DEAL_LEVEL_DETERMINISTIC_TOPICS = [
  'engagement_silence_duration',
  'engagement_velocity_signal',
  'inbound_outbound_ratio',
  'last_meaningful_touch',
] as const;

describe('D-139 P7 — valid_scopes covers both vendors at the deal level', () => {
  for (const topic of DEAL_LEVEL_DETERMINISTIC_TOPICS) {
    it(`${topic}.valid_scopes contains HubSpot deal + Salesforce opportunity`, () => {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.valid_scopes).toBeDefined();
      const scopes = [...(def.valid_scopes ?? [])].sort();
      expect(scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPPORTUNITY].sort());
    });
  }
});

describe('D-139 P7 — aggregates_from covers all per-type engagement scopes', () => {
  for (const topic of DEAL_LEVEL_DETERMINISTIC_TOPICS) {
    it(`${topic}.aggregates_from enumerates all ${PER_TYPE_ENGAGEMENT_SCOPES.length} per-type engagement scopes`, () => {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.aggregates_from).toBeDefined();
      const sources = [...(def.aggregates_from ?? [])].sort();
      expect(sources).toEqual([...PER_TYPE_ENGAGEMENT_SCOPES].sort());
    });
    it(`${topic}.aggregates_from never contains the unified-vendor engagement shorthand`, () => {
      const def = ENRICHMENT_REGISTRY[topic];
      const sources = def.aggregates_from ?? [];
      // Per § A.10 + § A.1: producers iterate per-type scopes, NEVER
      // a unified `connection.api.<vendor>.engagement` shorthand.
      // Existence of the shorthand in any topic's source list would
      // indicate the substrate started accepting an entity-layer
      // engagement abstraction the spec explicitly rejects.
      for (const vendor of ENGAGEMENT_VENDOR_VALUES) {
        expect(sources, `${topic} sourced from ${vendor} unified shorthand`).not.toContain(
          `connection.api.${vendor}.engagement`,
        );
      }
    });
  }
});

describe('D-139 P7 — cross-vendor data.crm.deal.* lens rewrites for every deal-level topic', () => {
  for (const topic of DEAL_LEVEL_DETERMINISTIC_TOPICS) {
    it(`${topic} resolves through the data.crm.deal.<hubspot_deal_*>.enrichments.* lens`, () => {
      const m = matchCrmAlias(`crm.deal.hubspot_deal_47291.enrichments.${topic}`);
      expect(m).not.toBeNull();
      expect(m!.vendor).toBe('hubspot');
      expect(m!.entity).toBe('deal');
      expect(m!.targetId).toBe('hubspot_deal_47291');
      expect(m!.canonicalPostData).toBe(
        `enrichment.connection.api.hubspot.deal.hubspot_deal_47291.${topic}`,
      );
    });
    it(`${topic} resolves through the data.crm.deal.<salesforce_opportunity_*>.enrichments.* lens`, () => {
      const m = matchCrmAlias(
        `crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.${topic}`,
      );
      expect(m).not.toBeNull();
      expect(m!.vendor).toBe('salesforce');
      expect(m!.entity).toBe('opportunity');
      expect(m!.targetId).toBe('salesforce_opportunity_006A0000005XYZAB');
      expect(m!.canonicalPostData).toBe(
        `enrichment.connection.api.salesforce.opportunity.salesforce_opportunity_006A0000005XYZAB.${topic}`,
      );
    });
    it(`${topic} drill-into-value-field via crm.deal lens preserves the suffix`, () => {
      const m = matchCrmAlias(
        `crm.deal.hubspot_deal_47291.enrichments.${topic}.cursor_at`,
      );
      expect(m).not.toBeNull();
      expect(m!.rest).toBe(`${topic}.cursor_at`);
      expect(m!.canonicalPostData).toBe(
        `enrichment.connection.api.hubspot.deal.hubspot_deal_47291.${topic}.cursor_at`,
      );
    });
  }
});

describe('D-139 P7 — Deal Identity Asymmetry Invariant — engagements stay vendor-scoped', () => {
  it('CRM_ALIAS_VALUES enum stays closed at deal / contact / account (no engagement)', () => {
    // § Non-goals + § A.5.5: cross-vendor engagement union happens at
    // the topic layer (`engagement_velocity_signal.valid_scopes` per
    // P3 + P7 widening), NEVER the entity layer. Adding `'engagement'`
    // to `CRM_ALIAS_VALUES` would unlock a `data.crm.engagement.*`
    // lens that the spec explicitly refuses.
    expect([...CRM_ALIAS_VALUES].sort()).toEqual(['account', 'contact', 'deal']);
  });

  it('no engagement entity registers a crm_alias (entity-layer rejection)', () => {
    // Every per-type engagement entity in the registry must omit
    // crm_alias. Setting one would lift engagements into the
    // cross-vendor `data.crm.*` lens at the entity layer — the
    // exact substrate-asymmetry the invariant forbids.
    //
    // Codex P2 #2 fold — assert PRESENCE first, then assert
    // crm_alias is undefined. Pre-fold the test allowed entries to
    // be absent (`if (entry !== undefined)`) — but every per-type
    // engagement entity is statically registered in
    // `connection-vendors.ts` (HubSpot 5 at P1a.1+P1a.2, Salesforce
    // 5 at P1b — including dual-schema voice_call + call_history).
    // The static registry is the contract; the test must ratchet
    // against the full set, not silently allow drift.
    const engagementEntities = [
      // HubSpot — § A.1
      ['hubspot', 'email'],
      ['hubspot', 'meeting'],
      ['hubspot', 'note'],
      ['hubspot', 'call'],
      ['hubspot', 'task'],
      // Salesforce — § A.2 (dual-schema VoiceCall + CallHistory per Pass-5 R5.11)
      ['salesforce', 'task'],
      ['salesforce', 'event'],
      ['salesforce', 'email_message'],
      ['salesforce', 'voice_call'],
      ['salesforce', 'call_history'],
    ] as const;
    for (const [vendor, entity] of engagementEntities) {
      const entry = CONNECTION_VENDOR_ENTITIES.find(
        (e) => e.vendor === vendor && e.entity === entity,
      );
      expect(
        entry,
        `${vendor}.${entity} must be statically registered in CONNECTION_VENDOR_ENTITIES`,
      ).toBeDefined();
      expect(
        entry!.crm_alias,
        `${vendor}.${entity} must NOT declare crm_alias (engagements stay vendor-scoped per § A.5.5)`,
      ).toBeUndefined();
    }
  });

  it('crm_alias engagement-shorthand path returns null (no engagement lens at entity layer)', () => {
    // Even if a recipe author tried to write `data.crm.engagement.*`
    // (the enum-rejected path), `matchCrmAlias` must surface null
    // rather than dispatch to any engagement entity.
    expect(
      matchCrmAlias('crm.engagement.hubspot_email_47291.enrichments.engagement_silence_duration'),
    ).toBeNull();
  });
});

describe('D-139 P7 — recipe-layer cross-vendor union pattern', () => {
  it('crm.deal lens dispatches the same topic across both vendors via target_id prefix', () => {
    // Topic-layer union demonstration: one topic, two vendors, one
    // recipe path shape — the path's `<full_target_id>` segment
    // alone discriminates HubSpot vs Salesforce. Recipes addressing
    // `data.crm.deal.<id>.enrichments.engagement_velocity_signal`
    // operate at the topic layer (NOT the entity layer per § A.5.5).
    const hub = matchCrmAlias(
      'crm.deal.hubspot_deal_47291.enrichments.engagement_velocity_signal',
    );
    const sf = matchCrmAlias(
      'crm.deal.salesforce_opportunity_006A0000005XYZAB.enrichments.engagement_velocity_signal',
    );
    expect(hub).not.toBeNull();
    expect(sf).not.toBeNull();
    // Both rewrites land on the same topic name in the canonical path
    // — that's the topic-layer union: one topic, two storage scopes.
    expect(hub!.canonicalPostData.endsWith('.engagement_velocity_signal')).toBe(true);
    expect(sf!.canonicalPostData.endsWith('.engagement_velocity_signal')).toBe(true);
    // Different vendors / entities though.
    expect(hub!.vendor).toBe('hubspot');
    expect(sf!.vendor).toBe('salesforce');
  });
});
