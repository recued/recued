/** D-149 § A.20.2 follow-on — Reception → endpoint detail →
 *  "View as visitor" panel renderer.
 *
 *  Covers the projection layer over `buildViewAsVisitorPanel` + the
 *  `reception.endpoint.preview_draft` result: the token-mode / audit-
 *  mode / privacy-invariant copy registries (+ their ratchets against
 *  the contract), the preview-hash freshness label, the panel
 *  projection (field-row split, copy resolution, expiry policy,
 *  invariant aggregation), the full preview-result projection, and the
 *  `EndpointSummary` → preview-dispatch-args adapter. */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_KIND_TOKEN_MODE,
  RECEPTION_PRIVACY_INVARIANT_LABELS,
  type EndpointSummary,
  type ReceptionEndpointPreviewResult,
  type ViewAsVisitorPanel,
} from '@recued/contracts';
import {
  RECEPTION_AUDIT_MODE_COPY,
  RECEPTION_PRIVACY_INVARIANT_DETAIL,
  RECEPTION_TOKEN_MODE_COPY,
  RECEPTION_TOKEN_MODES,
  buildEndpointPreviewDispatch,
  buildViewAsVisitorModel,
  buildViewAsVisitorPanelModel,
  computePreviewFreshnessLabel,
  previewDispatchArgsFromSummary,
  resolvePrivacyInvariantDetail,
  resolveTokenModeCopy,
} from '../reception/view-as-visitor.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const mkPanel = (override: Partial<ViewAsVisitorPanel> = {}): ViewAsVisitorPanel => ({
  synthetic: true,
  endpoint_kind: 'scheduling_link',
  packet_kind: 'scheduling_link_packet',
  visible_fields: ['free_windows', 'slot_duration_minutes'],
  field_rows: [
    {
      field: 'free_windows',
      visible: true,
      rationale: "Exposed per the packet kind's fields_visible list.",
    },
    {
      field: 'slot_duration_minutes',
      visible: true,
      rationale: "Exposed per the packet kind's fields_visible list.",
    },
    {
      field: 'raw_calendar_events',
      visible: false,
      rationale: 'Calendar event titles never cross the boundary.',
    },
    {
      field: 'notification_target',
      visible: false,
      rationale: 'Notification routing stays server-side.',
    },
  ],
  expiry_policy: {
    default_label:
      'link-style 90-day default (long-lived permitted with explicit acknowledgement)',
    max_label: 'long-lived permitted (substrate clamps any bounded expiry to 90 days)',
    expires_at: null,
  },
  token_mode: 'bearer_query_param',
  audit_mode: 'operational_log + high_assurance_on_booking',
  privacy_invariant_summary: RECEPTION_PRIVACY_INVARIANT_LABELS.map((invariant) => ({
    invariant,
    satisfied: true,
  })),
  ...override,
});

const mkPreviewResult = (
  override: Partial<ReceptionEndpointPreviewResult> = {},
): ReceptionEndpointPreviewResult => ({
  html: '<!-- preview -->',
  visible_fields: ['free_windows', 'slot_duration_minutes'],
  preview_hash: 'sha256-deadbeef',
  expires_at: NOW + 10 * MINUTE_MS,
  view_as_visitor: mkPanel(),
  ...override,
});

const mkSummary = (override: Partial<EndpointSummary> = {}): EndpointSummary => ({
  endpoint_id: 'ep-1',
  kind: 'scheduling_link',
  enabled: true,
  packet_declaration: {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  },
  created_at: NOW - DAY_MS,
  created_by_client_id: 'cli-admin',
  expires_at: null,
  long_lived_acknowledged_at: NOW - DAY_MS,
  revoked_at: null,
  revocation_reason: null,
  audit_count: 3,
  last_accessed_at: NOW - MINUTE_MS,
  metadata: { display_name: 'Alice' },
  ...override,
});

// ────────────────────────────────────────────────────────────────
// Copy registries
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — copy registries', () => {
  it('RECEPTION_TOKEN_MODE_COPY covers every declared token mode with non-empty copy', () => {
    for (const mode of RECEPTION_TOKEN_MODES) {
      expect(RECEPTION_TOKEN_MODE_COPY[mode].label).toBeTruthy();
      expect(RECEPTION_TOKEN_MODE_COPY[mode].description).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_TOKEN_MODE_COPY)).toHaveLength(RECEPTION_TOKEN_MODES.length);
  });

  it('RECEPTION_TOKEN_MODES is exhaustive over the contract RECEPTION_KIND_TOKEN_MODE values', () => {
    const contractValues = new Set(Object.values(RECEPTION_KIND_TOKEN_MODE));
    // every value some endpoint kind actually carries is a declared mode
    for (const value of contractValues) {
      expect(RECEPTION_TOKEN_MODES).toContain(value);
    }
    // and no declared mode is dead — each is used by some kind
    for (const mode of RECEPTION_TOKEN_MODES) {
      expect(contractValues.has(mode)).toBe(true);
    }
  });

  it('RECEPTION_AUDIT_MODE_COPY covers every endpoint kind with non-empty copy', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      expect(RECEPTION_AUDIT_MODE_COPY[kind].label).toBeTruthy();
      expect(RECEPTION_AUDIT_MODE_COPY[kind].description).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_AUDIT_MODE_COPY)).toHaveLength(RECEPTION_ENDPOINT_KINDS.length);
  });

  it('RECEPTION_PRIVACY_INVARIANT_DETAIL has non-empty detail for every contract invariant label', () => {
    for (const label of RECEPTION_PRIVACY_INVARIANT_LABELS) {
      expect(RECEPTION_PRIVACY_INVARIANT_DETAIL[label]).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_PRIVACY_INVARIANT_DETAIL)).toHaveLength(
      RECEPTION_PRIVACY_INVARIANT_LABELS.length,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// resolveTokenModeCopy
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — resolveTokenModeCopy', () => {
  it('resolves both known modes to their registry copy', () => {
    expect(resolveTokenModeCopy('tokenless_singleton')).toEqual(
      RECEPTION_TOKEN_MODE_COPY.tokenless_singleton,
    );
    expect(resolveTokenModeCopy('bearer_query_param')).toEqual(
      RECEPTION_TOKEN_MODE_COPY.bearer_query_param,
    );
  });

  it('an unknown mode falls back to a neutral shape — label is the raw value, never throws', () => {
    const copy = resolveTokenModeCopy('some_future_mode');
    expect(copy.label).toBe('some_future_mode');
    expect(copy.description).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────
// resolvePrivacyInvariantDetail
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — resolvePrivacyInvariantDetail', () => {
  it('resolves every contract invariant label to its registry detail', () => {
    for (const label of RECEPTION_PRIVACY_INVARIANT_LABELS) {
      expect(resolvePrivacyInvariantDetail(label)).toBe(
        RECEPTION_PRIVACY_INVARIANT_DETAIL[label],
      );
    }
  });

  it('an unknown invariant falls back to the label itself', () => {
    expect(resolvePrivacyInvariantDetail('some future invariant')).toBe(
      'some future invariant',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// computePreviewFreshnessLabel
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — computePreviewFreshnessLabel', () => {
  it('a still-valid hash ⇒ "Preview good for N more minutes" — singular + plural', () => {
    expect(computePreviewFreshnessLabel(NOW + 10 * MINUTE_MS, NOW)).toBe(
      'Preview good for 10 more minutes',
    );
    expect(computePreviewFreshnessLabel(NOW + MINUTE_MS, NOW)).toBe(
      'Preview good for 1 more minute',
    );
  });

  it('ceils a partial minute up', () => {
    expect(computePreviewFreshnessLabel(NOW + 90 * 1000, NOW)).toBe(
      'Preview good for 2 more minutes',
    );
    expect(computePreviewFreshnessLabel(NOW + 1000, NOW)).toBe(
      'Preview good for 1 more minute',
    );
  });

  it('a lapsed hash ⇒ a re-run prompt', () => {
    expect(computePreviewFreshnessLabel(NOW - MINUTE_MS, NOW)).toContain('Look as a visitor again');
  });

  it('exactly at expiry (remaining 0) ⇒ the expired branch', () => {
    expect(computePreviewFreshnessLabel(NOW, NOW)).toContain('Look as a visitor again');
  });
});

// ────────────────────────────────────────────────────────────────
// buildViewAsVisitorPanelModel
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — buildViewAsVisitorPanelModel', () => {
  it('splits the field rows into the visible / stripped sections, preserving order', () => {
    const model = buildViewAsVisitorPanelModel(mkPanel(), NOW);
    expect(model.visible_field_rows.map((r) => r.field)).toEqual([
      'free_windows',
      'slot_duration_minutes',
    ]);
    expect(model.stripped_field_rows.map((r) => r.field)).toEqual([
      'raw_calendar_events',
      'notification_target',
    ]);
    expect(model.visible_field_rows.every((r) => r.visible)).toBe(true);
    expect(model.stripped_field_rows.every((r) => !r.visible)).toBe(true);
    expect(model.visible_field_count).toBe(2);
    expect(model.stripped_field_count).toBe(2);
  });

  it('carries synthetic / endpoint_kind / packet_kind / visible_fields through', () => {
    const model = buildViewAsVisitorPanelModel(mkPanel(), NOW);
    expect(model.synthetic).toBe(true);
    expect(model.endpoint_kind).toBe('scheduling_link');
    expect(model.packet_kind).toBe('scheduling_link_packet');
    expect(model.visible_fields).toEqual(['free_windows', 'slot_duration_minutes']);
  });

  it('resolves the token-mode copy from the panel token_mode', () => {
    const model = buildViewAsVisitorPanelModel(
      mkPanel({ token_mode: 'bearer_query_param' }),
      NOW,
    );
    expect(model.token_mode).toBe('bearer_query_param');
    expect(model.token_mode_label).toBe(RECEPTION_TOKEN_MODE_COPY.bearer_query_param.label);
    expect(model.token_mode_description).toBe(
      RECEPTION_TOKEN_MODE_COPY.bearer_query_param.description,
    );
  });

  it('resolves the tokenless mode for the reception_page singleton', () => {
    const model = buildViewAsVisitorPanelModel(
      mkPanel({
        endpoint_kind: 'reception_page',
        packet_kind: 'reception_page_packet',
        token_mode: 'tokenless_singleton',
      }),
      NOW,
    );
    expect(model.token_mode_label).toBe(RECEPTION_TOKEN_MODE_COPY.tokenless_singleton.label);
  });

  it('resolves the audit-mode copy from the panel endpoint_kind, for every kind', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      const model = buildViewAsVisitorPanelModel(mkPanel({ endpoint_kind: kind }), NOW);
      expect(model.audit_mode_label).toBe(RECEPTION_AUDIT_MODE_COPY[kind].label);
      expect(model.audit_mode_description).toBe(RECEPTION_AUDIT_MODE_COPY[kind].description);
    }
  });

  it('carries the raw audit_mode string through', () => {
    const model = buildViewAsVisitorPanelModel(
      mkPanel({ audit_mode: 'operational_log_only' }),
      NOW,
    );
    expect(model.audit_mode).toBe('operational_log_only');
  });

  it('projects the expiry policy for a long-lived endpoint', () => {
    const model = buildViewAsVisitorPanelModel(mkPanel(), NOW); // expires_at: null
    expect(model.expiry_policy.expires_at).toBeNull();
    expect(model.expiry_policy.is_long_lived).toBe(true);
    expect(model.expiry_policy.expires_at_label).toBe('Never expires');
    expect(model.expiry_policy.default_label).toBeTruthy();
    expect(model.expiry_policy.max_label).toBeTruthy();
  });

  it('projects the expiry policy for a bounded endpoint — labels via the shared computeExpiryLabel', () => {
    const model = buildViewAsVisitorPanelModel(
      mkPanel({
        endpoint_kind: 'drop_link',
        packet_kind: 'drop_link_packet',
        expiry_policy: {
          default_label: 'link-style 7-day default',
          max_label: '30-day hard ceiling',
          expires_at: NOW + 10 * DAY_MS,
        },
      }),
      NOW,
    );
    expect(model.expiry_policy.is_long_lived).toBe(false);
    expect(model.expiry_policy.expires_at).toBe(NOW + 10 * DAY_MS);
    expect(model.expiry_policy.expires_at_label).toBe('Expires in 10 days');
  });

  it('aggregates the invariant summary — all satisfied', () => {
    const model = buildViewAsVisitorPanelModel(mkPanel(), NOW);
    expect(model.invariant_summary.total_count).toBe(RECEPTION_PRIVACY_INVARIANT_LABELS.length);
    expect(model.invariant_summary.satisfied_count).toBe(
      RECEPTION_PRIVACY_INVARIANT_LABELS.length,
    );
    expect(model.invariant_summary.all_satisfied).toBe(true);
    expect(model.invariant_summary.compliance_label).toBe(
      `All ${RECEPTION_PRIVACY_INVARIANT_LABELS.length} privacy promises kept`,
    );
  });

  it('aggregates the invariant summary — a flagged invariant', () => {
    const summary = RECEPTION_PRIVACY_INVARIANT_LABELS.map((invariant, i) => ({
      invariant,
      satisfied: i !== 2, // flag one (the expiry-ceiling invariant)
    }));
    const model = buildViewAsVisitorPanelModel(
      mkPanel({ privacy_invariant_summary: summary }),
      NOW,
    );
    expect(model.invariant_summary.all_satisfied).toBe(false);
    expect(model.invariant_summary.satisfied_count).toBe(
      RECEPTION_PRIVACY_INVARIANT_LABELS.length - 1,
    );
    expect(model.invariant_summary.compliance_label).toContain('look at the 1 marked');
  });

  it('attaches the resolved detail copy to each invariant row', () => {
    const model = buildViewAsVisitorPanelModel(mkPanel(), NOW);
    expect(model.invariant_summary.rows).toHaveLength(
      RECEPTION_PRIVACY_INVARIANT_LABELS.length,
    );
    for (const row of model.invariant_summary.rows) {
      expect(row.detail).toBe(RECEPTION_PRIVACY_INVARIANT_DETAIL[row.invariant]);
      expect(row.detail).toBeTruthy();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// buildViewAsVisitorModel
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — buildViewAsVisitorModel', () => {
  it('a result with view_as_visitor ⇒ panel populated + html / hash passthrough', () => {
    const model = buildViewAsVisitorModel({ result: mkPreviewResult(), now: NOW });
    expect(model.rendered_html).toBe('<!-- preview -->');
    expect(model.preview_hash).toBe('sha256-deadbeef');
    expect(model.preview_hash_expires_at).toBe(NOW + 10 * MINUTE_MS);
    expect(model.panel).not.toBeNull();
    expect(model.panel!.endpoint_kind).toBe('scheduling_link');
    expect(model.panel!.synthetic).toBe(true);
  });

  it('a result WITHOUT view_as_visitor ⇒ panel null, still carries html + hash + freshness', () => {
    const model = buildViewAsVisitorModel({
      result: mkPreviewResult({ view_as_visitor: undefined }),
      now: NOW,
    });
    expect(model.panel).toBeNull();
    expect(model.rendered_html).toBe('<!-- preview -->');
    expect(model.preview_hash).toBe('sha256-deadbeef');
    expect(model.preview_freshness_label).toBeTruthy();
  });

  it('preview_is_fresh is true within the TTL, false at or past it', () => {
    expect(
      buildViewAsVisitorModel({
        result: mkPreviewResult({ expires_at: NOW + MINUTE_MS }),
        now: NOW,
      }).preview_is_fresh,
    ).toBe(true);
    expect(
      buildViewAsVisitorModel({
        result: mkPreviewResult({ expires_at: NOW - MINUTE_MS }),
        now: NOW,
      }).preview_is_fresh,
    ).toBe(false);
    expect(
      buildViewAsVisitorModel({
        result: mkPreviewResult({ expires_at: NOW }),
        now: NOW,
      }).preview_is_fresh,
    ).toBe(false);
  });

  it('the freshness label matches computePreviewFreshnessLabel', () => {
    const result = mkPreviewResult({ expires_at: NOW + 5 * MINUTE_MS });
    const model = buildViewAsVisitorModel({ result, now: NOW });
    expect(model.preview_freshness_label).toBe(
      computePreviewFreshnessLabel(NOW + 5 * MINUTE_MS, NOW),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// previewDispatchArgsFromSummary
// ────────────────────────────────────────────────────────────────

describe('D-149 view-as-visitor — previewDispatchArgsFromSummary', () => {
  it('a bounded-expiry summary ⇒ expires_at included + kind / packet / metadata threaded', () => {
    const args = previewDispatchArgsFromSummary(
      mkSummary({ expires_at: NOW + 5 * DAY_MS }),
    );
    expect(args.expires_at).toBe(NOW + 5 * DAY_MS);
    expect(args.kind).toBe('scheduling_link');
    expect(args.packet_declaration.packet_kind).toBe('scheduling_link_packet');
    expect(args.metadata).toEqual({ display_name: 'Alice' });
  });

  it('a long-lived summary (expires_at null) ⇒ expires_at OMITTED, never null', () => {
    const args = previewDispatchArgsFromSummary(mkSummary({ expires_at: null }));
    expect('expires_at' in args).toBe(false);
    expect(args.expires_at).toBeUndefined();
  });

  it('composes with buildEndpointPreviewDispatch — long-lived ⇒ no expires_at on the wire', () => {
    const dispatch = buildEndpointPreviewDispatch(
      previewDispatchArgsFromSummary(mkSummary({ expires_at: null })),
    );
    expect(dispatch.op).toBe('reception.endpoint.preview_draft');
    expect('expires_at' in dispatch).toBe(false);
  });

  it('composes with buildEndpointPreviewDispatch — bounded ⇒ expires_at on the wire', () => {
    const dispatch = buildEndpointPreviewDispatch(
      previewDispatchArgsFromSummary(mkSummary({ expires_at: NOW + 2 * DAY_MS })),
    );
    expect(dispatch.op).toBe('reception.endpoint.preview_draft');
    expect(dispatch.expires_at).toBe(NOW + 2 * DAY_MS);
  });
});
