/** D-139 Phase 1a.1 — contracts smoke tests.
 *
 *  Covers:
 *    - Closed-list enum membership for the Pass-4 evidence-quality
 *      contracts.
 *    - `hubspot.email` entity registration in
 *      `CONNECTION_VENDOR_ENTITIES` + `HUBSPOT_EMAIL_PROPERTIES`.
 *    - `engagement_silence_duration` enrichment topic registration.
 *    - MCP projection rule (`projectEngagementRowForMCP` strips
 *      `body_inline` + `vendor_raw_timestamp` by default).
 *    - Cursor encoding round-trip.
 *    - MCP-catalog ratchet: `data.contact.engagements.list` is NOT in
 *      the published catalog at v1; per-topic visibility opt-in is the
 *      only path to expose.
 *
 *  Spec: D-139 § A.3, § A.3.2, § A.3.3, § A.3.6, § A.5.1,
 *  § A.9.5, § P1a.1 acceptance. */

import { describe, expect, it } from 'vitest';

import {
  AUTHORSHIP_VALUES,
  DIRECTION_VALUES,
  DEDUPE_CONFIDENCE_VALUES,
  DEDUPE_ACCEPTANCE_VALUES,
  DEDUPE_MATCH_KEY_VALUES,
  ENGAGEMENT_LIFECYCLE_STATE_VALUES,
  BODY_STATE_VALUES,
  ENGAGEMENT_EDGE_TYPE_VALUES,
  SOURCE_DEGRADATION_REASON_VALUES,
  ENGAGEMENT_VENDOR_VALUES,
  ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES,
  DEDUPE_RESOLUTION_STATE_VALUES,
  ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP,
  ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS,
  ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE,
  ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE,
  ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  ENGAGEMENT_LIST_REGISTRY_KEY,
  isAuthorship,
  isDirection,
  isDedupeConfidence,
  isEngagementLifecycleState,
  isBodyState,
  isEngagementEdgeType,
  isEngagementEdgeTargetKind,
  isSourceDegradationReason,
  isEngagementInboundDeliveryPath,
  projectEngagementRowForMCP,
  encodeEngagementsCursor,
  decodeEngagementsCursor,
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_EMAIL_PROPERTIES,
  getVendorEntityByVendorEntity,
  ENRICHMENT_REGISTRY,
  isEnrichmentTopic,
  MCP_TOOL_CATALOG,
  isMcpToolName,
  type EngagementRow,
} from '../index.js';

describe('D-139 P1a.1 — evidence-quality enum closed lists', () => {
  it('Authorship enumerates the 7 documented values', () => {
    expect([...AUTHORSHIP_VALUES].sort()).toEqual([
      'crm_automation',
      'crm_user',
      'import',
      'integration',
      'system_process',
      'unknown',
      'user',
    ]);
    expect(isAuthorship('user')).toBe(true);
    expect(isAuthorship('system_process')).toBe(true);
    expect(isAuthorship('engineer')).toBe(false);
  });
  it('Direction enumerates inbound/outbound/internal/unknown', () => {
    expect([...DIRECTION_VALUES].sort()).toEqual([
      'inbound',
      'internal',
      'outbound',
      'unknown',
    ]);
    expect(isDirection('inbound')).toBe(true);
    expect(isDirection('lateral')).toBe(false);
  });
  it('DedupeConfidence enumerates exact/probable/none', () => {
    expect([...DEDUPE_CONFIDENCE_VALUES].sort()).toEqual([
      'exact',
      'none',
      'probable',
    ]);
    expect(isDedupeConfidence('exact')).toBe(true);
    expect(isDedupeConfidence('strong')).toBe(false);
  });
  it('DedupeAcceptance enumerates exact_only/probable/all', () => {
    expect([...DEDUPE_ACCEPTANCE_VALUES].sort()).toEqual([
      'all',
      'exact_only',
      'probable',
    ]);
  });
  it('DedupeMatchKey vocabulary covers Pass-5 R5.6 closed list', () => {
    expect(DEDUPE_MATCH_KEY_VALUES).toContain('message_id');
    expect(DEDUPE_MATCH_KEY_VALUES).toContain('from_to_sent_at_triple');
    expect(DEDUPE_MATCH_KEY_VALUES).toContain(
      'from_to_sent_at_subject_hash_quadruple',
    );
    expect(DEDUPE_MATCH_KEY_VALUES).toContain('vendor_native_id');
  });
  it('LifecycleState includes Pass-5 failed + no_answer additions', () => {
    expect([...ENGAGEMENT_LIFECYCLE_STATE_VALUES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'no_answer',
      'pending',
      'point_in_time',
      'rescheduled',
      'scheduled',
    ]);
    expect(isEngagementLifecycleState('point_in_time')).toBe(true);
    expect(isEngagementLifecycleState('failed')).toBe(true);
    expect(isEngagementLifecycleState('done')).toBe(false);
  });
  it('BodyState covers the 7-state machine', () => {
    expect([...BODY_STATE_VALUES].sort()).toEqual([
      'calendar_link',
      'inline_body',
      'mail_link',
      'mirror_blob',
      'mirror_blob_pending',
      'none',
      'truncated_inline',
    ]);
    expect(isBodyState('mail_link')).toBe(true);
    expect(isBodyState('html_body')).toBe(false);
  });
  it('EngagementEdgeType closed-list at 6 values for v1', () => {
    expect([...ENGAGEMENT_EDGE_TYPE_VALUES].sort()).toEqual([
      'account',
      'calendar_twin',
      'contact',
      'deal',
      'mail_twin',
      'owner',
    ]);
    expect(isEngagementEdgeType('contact')).toBe(true);
    expect(isEngagementEdgeType('campaign')).toBe(false);
  });
  it('EngagementEdgeTargetKind covers data.contact / connection.api / data.mail / data.calendar / user', () => {
    expect(isEngagementEdgeTargetKind('data.contact')).toBe(true);
    expect(isEngagementEdgeTargetKind('connection.api')).toBe(true);
    expect(isEngagementEdgeTargetKind('data.mail')).toBe(true);
    expect(isEngagementEdgeTargetKind('data.calendar')).toBe(true);
    expect(isEngagementEdgeTargetKind('user')).toBe(true);
    expect(isEngagementEdgeTargetKind('data.shared')).toBe(false);
  });
  it('SourceDegradationReason enumerates 11 closed-list reasons (D-145 PA9 widened with sample_floor_unmet)', () => {
    expect(SOURCE_DEGRADATION_REASON_VALUES).toHaveLength(11);
    expect(isSourceDegradationReason('quota_suspended')).toBe(true);
    expect(isSourceDegradationReason('body_redacted')).toBe(true);
    expect(isSourceDegradationReason('association_rescan_pending')).toBe(true);
    expect(isSourceDegradationReason('sample_floor_unmet')).toBe(true);
    expect(isSourceDegradationReason('weekend_mode')).toBe(false);
  });
  it('ENGAGEMENT_VENDOR_VALUES is the shipped built-in engagement-vendor set', () => {
    // D-192 — the closed `EngagementVendor` union + `isEngagementVendor` guard
    // were retired: the plane is open to pack-declared vendors via the registry
    // `engagement` facet, and membership is now `vendorHasEngagement(vendor,
    // registry)` (covered in d-192-engagement-facet.test.ts). This list survives
    // only as the built-in set the MCP schema enumerates.
    expect([...ENGAGEMENT_VENDOR_VALUES].sort()).toEqual([
      'hubspot',
      'salesforce',
    ]);
  });
  it('EngagementInboundDeliveryPath covers webhook/cometd/reconciler (D-184 retired runonce)', () => {
    expect([...ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES].sort()).toEqual([
      'cometd',
      'reconciler',
      'webhook',
    ]);
    expect(isEngagementInboundDeliveryPath('webhook')).toBe(true);
    expect(isEngagementInboundDeliveryPath('runonce')).toBe(false);
    expect(isEngagementInboundDeliveryPath('graph')).toBe(false);
  });
  it('DedupeResolutionState covers pending/confirmed_merge/marked_distinct', () => {
    expect([...DEDUPE_RESOLUTION_STATE_VALUES].sort()).toEqual([
      'confirmed_merge',
      'marked_distinct',
      'pending',
    ]);
  });
  it('Substrate constants surface at expected values', () => {
    expect(ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP).toBe(8);
    expect(ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE).toBe(50);
    expect(ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE).toBe(200);
    expect(ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS).toBe(
      90 * 24 * 60 * 60 * 1000,
    );
    expect(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY).toBe(
      'data.contact.engagements.body_content',
    );
    expect(ENGAGEMENT_LIST_REGISTRY_KEY).toBe('data.contact.engagements');
  });
});

describe('D-139 P1a.1 — hubspot.email entity registration', () => {
  it('CONNECTION_VENDOR_ENTITIES includes hubspot.email at scope connection.api.hubspot.email', () => {
    const entry = getVendorEntityByVendorEntity('hubspot', 'email');
    expect(entry).not.toBeNull();
    expect(entry!.scope).toBe('connection.api.hubspot.email');
    expect(entry!.display_name).toBe('HubSpot Email Engagement');
  });
  it('hubspot.email carries no crm_alias (engagements stay vendor-specific per § A.5.5 invariant)', () => {
    const entry = getVendorEntityByVendorEntity('hubspot', 'email');
    expect(entry!.crm_alias).toBeUndefined();
  });
  it('hubspot.email meta_fields cover the 11 canonical fields per § A.1', () => {
    const entry = getVendorEntityByVendorEntity('hubspot', 'email');
    const keys = entry!.meta_fields.map((f) => f.key).sort();
    expect(keys).toEqual([
      'body_preview',
      'cc_emails',
      'direction',
      'from_email',
      'message_id',
      'owner',
      'status',
      'subject',
      'thread_id',
      'timestamp',
      'to_emails',
    ]);
  });
  it('HUBSPOT_EMAIL_PROPERTIES carries the cursor field + lifecycle drivers', () => {
    const props = HUBSPOT_EMAIL_PROPERTIES as ReadonlyArray<string>;
    expect(props).toContain('hs_lastmodifieddate');
    expect(props).toContain('hs_email_status');
    expect(props).toContain('hs_email_direction');
    expect(props).toContain('hs_email_internet_message_id');
    expect(props).toContain('hubspot_owner_id');
  });
  it('CONNECTION_VENDOR_ENTITIES boot-validates clean (smoke for the new entry)', () => {
    // Module-level validation runs at import; if the new entry was
    // malformed the module would throw on load. Sanity-check the
    // shape is at least 7 entries long now (3 D-129 HubSpot trio +
    // 3 D-130 Salesforce trio + new hubspot.email).
    expect(CONNECTION_VENDOR_ENTITIES.length).toBeGreaterThanOrEqual(7);
  });
});

describe('D-139 P1a.1 — engagement_silence_duration topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('engagement_silence_duration')).toBe(true);
  });
  it('topic carries time_bound × scenario × historical lifecycle per § A.9.1', () => {
    const def = ENRICHMENT_REGISTRY.engagement_silence_duration;
    expect(def).toBeDefined();
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot + Salesforce deal scopes', () => {
    const def = ENRICHMENT_REGISTRY.engagement_silence_duration;
    expect(def.valid_scopes).toEqual([
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ]);
  });
  it('default_trust_state = auto (deterministic — no AI)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_silence_duration;
    expect(def.default_trust_state).toBe('auto');
  });
  it('value_schema validates a well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.engagement_silence_duration;
    const result = def.value_schema!({
      days: 5,
      last_inbound_event_at: 1714780800000,
      cursor_at: 1714867200000,
    });
    expect(result.ok).toBe(true);
  });
  it('value_schema rejects non-numeric fields + negative days', () => {
    const def = ENRICHMENT_REGISTRY.engagement_silence_duration;
    const r1 = def.value_schema!({
      days: -1,
      last_inbound_event_at: 0,
      cursor_at: 0,
    });
    expect(r1.ok).toBe(false);
    const r2 = def.value_schema!({
      days: 'forever',
      last_inbound_event_at: 0,
      cursor_at: 0,
    });
    expect(r2.ok).toBe(false);
  });
});

describe('D-139 P1a.1 — projectEngagementRowForMCP', () => {
  const baseRow: EngagementRow = {
    connection_id: 'acme-hubspot',
    target_id: 'hubspot_email_47291',
    vendor: 'hubspot',
    entity: 'email',
    meta: { subject: 'Quarterly review', from_email: 'bob@acme.com' },
    mirror_blob_hash: null,
    authorship: 'user',
    direction: 'outbound',
    dedupe_confidence: 'none',
    lifecycle_state: 'point_in_time',
    event_at: 1714867200000,
    vendor_created_at: 1714867200000,
    vendor_modified_at: 1714867200500,
    ingested_at: 1714867200600,
    body_state: 'inline_body',
    body_inline: 'Hi Bob — heads up: I have one more thing for the deal.',
    body_truncation_offset: 12_345,
    vendor_raw_timestamp: '1714867200000',
    event_at_tz_hint: 'America/New_York',
  };

  it('strips body_inline + vendor_raw_timestamp by default (Pass-3 R3.6 + Pass-5 R5.9)', () => {
    const projected = projectEngagementRowForMCP(baseRow);
    expect(projected.body_inline).toBeUndefined();
    expect(projected.vendor_raw_timestamp).toBeUndefined();
    expect(projected.body_truncation_offset).toBe(12_345);
    expect(projected.body_state).toBe('inline_body');
  });
  it('exposes body fields when body_content_granted is true', () => {
    const projected = projectEngagementRowForMCP(baseRow, {
      body_content_granted: true,
    });
    expect(projected.body_inline).toBe(baseRow.body_inline);
    expect(projected.vendor_raw_timestamp).toBe(baseRow.vendor_raw_timestamp);
  });
  it('preserves event_at + tz hint + dedupe_candidates surface', () => {
    const projected = projectEngagementRowForMCP({
      ...baseRow,
      dedupe_confidence: 'probable',
    });
    expect(projected.event_at).toBe(baseRow.event_at);
    expect(projected.event_at_tz_hint).toBe('America/New_York');
    expect(projected.dedupe_confidence).toBe('probable');
  });
});

describe('D-139 P1a.1 — engagements cursor encoding round-trip', () => {
  it('encodes + decodes a cursor losslessly', () => {
    const cursor = {
      event_at: 1714867200000,
      engagement_id: 'hubspot_email_47291',
      connection_id: 'acme-hubspot',
    };
    const encoded = encodeEngagementsCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    const decoded = decodeEngagementsCursor(encoded);
    expect(decoded).toEqual(cursor);
  });
  it('encodes a NULL event_at cursor (forward-compat for first-page-with-no-event_at)', () => {
    const cursor = {
      event_at: null,
      engagement_id: 'hubspot_email_47291',
      connection_id: 'acme-hubspot',
    };
    const encoded = encodeEngagementsCursor(cursor);
    const decoded = decodeEngagementsCursor(encoded);
    expect(decoded.event_at).toBeNull();
  });
  it('rejects malformed cursor blobs', () => {
    expect(() => decodeEngagementsCursor('not-a-cursor')).toThrow();
    // Encoded "{}" — base64 of '{}' is 'e30'.
    expect(() => decodeEngagementsCursor('e30')).toThrow(/cursor_invalid/);
  });
});

describe('D-139 P1a.1 — MCP-catalog ratchet (engagement resolver excluded)', () => {
  it('data.contact.engagements.list never appears in MCP_TOOL_CATALOG at v1', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      expect(tool).not.toContain('engagements');
      expect(tool).not.toContain('data.contact');
    }
  });
  it('isMcpToolName rejects the engagements rpc + the body-content registry key', () => {
    expect(isMcpToolName(ENGAGEMENT_LIST_REGISTRY_KEY)).toBe(false);
    expect(isMcpToolName(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY)).toBe(false);
    expect(isMcpToolName('data.contact.engagements.list')).toBe(false);
  });
});
