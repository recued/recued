/** D-149 follow-on — Settings → Server → Reception page renderer.
 *
 *  Covers the § A.9 management-spine projection: copy registries,
 *  EndpointSummary → row projection with § A.20.6 safety labels, the
 *  per-kind sections + status header, the access-log surface, the
 *  per-endpoint detail with § A.20.4 Share Cards, the lifecycle
 *  dispatch builders, and the `reception.emergency_disabled` reducer. */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_ACCESS_ACTIONS,
  RECEPTION_ACCESS_OUTCOMES,
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RECEPTION_RPC_ERROR_CODES,
  SAFETY_LABEL_KINDS,
  type AccessLogEntry,
  type EndpointSummary,
  type ReceptionEndpointKind,
} from '@recued/contracts';
import {
  RECEPTION_ACCESS_ACTION_COPY,
  RECEPTION_ACCESS_OUTCOME_COPY,
  RECEPTION_ERROR_COPY,
  RECEPTION_KIND_COPY,
  RECEPTION_SAFETY_LABEL_TOOLTIP,
  RECEPTION_SOURCE_IP_HASH_PREFIX_LEN,
  UNAVAILABLE_RECEPTION_ENDPOINT_KINDS,
  buildReceptionAccessLogRow,
  buildReceptionDisableDispatch,
  buildReceptionEmergencyDisableAllDispatch,
  buildReceptionEnableDispatch,
  buildReceptionEndpointDetailModel,
  buildReceptionEndpointRow,
  buildReceptionExtendDispatch,
  buildReceptionPageModel,
  buildReceptionRevokeDispatch,
  buildReceptionRotateDispatch,
  deriveReceptionEndpointStatus,
  distinctSourceIpHashCount,
  reduceReceptionEmergencyDisabled,
  truncateSourceIpHash,
} from '../settings/reception.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const mkSummary = (override: Partial<EndpointSummary> = {}): EndpointSummary => ({
  endpoint_id: 'ep-1',
  kind: 'scheduling_link',
  enabled: true,
  packet_declaration: {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  },
  created_at: NOW - 10 * DAY_MS,
  created_by_client_id: 'cli-1',
  expires_at: NOW + 30 * DAY_MS,
  long_lived_acknowledged_at: null,
  revoked_at: null,
  revocation_reason: null,
  audit_count: 4,
  last_accessed_at: NOW - DAY_MS,
  metadata: {},
  ...override,
});

const mkAccessLog = (override: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  id: 'log-1',
  endpoint_id: 'ep-1',
  accessed_at: NOW - 1000,
  source_ip_hash: 'abcdef0123456789',
  user_agent_hash: null,
  action_taken: 'view',
  outcome: 'ok',
  url_path_redacted: '/reception/scheduling/ep-1',
  metadata: {},
  ...override,
});

const okStatus = () => ({
  emergency_disabled: false,
  reception_public: true,
  base_url: 'https://alice.recued.cloud/reception/',
});

// ────────────────────────────────────────────────────────────────
// Copy registries
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — copy registries', () => {
  it('RECEPTION_KIND_COPY covers every endpoint kind', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      const copy = RECEPTION_KIND_COPY[kind];
      expect(copy.section_label).toBeTruthy();
      expect(copy.singular).toBeTruthy();
      expect(copy.description).toBeTruthy();
      expect(copy.create_label).toBeTruthy();
    }
  });

  it('RECEPTION_ERROR_COPY covers every closed-list rpc error code', () => {
    for (const code of RECEPTION_RPC_ERROR_CODES) {
      expect(RECEPTION_ERROR_COPY[code]).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_ERROR_COPY)).toHaveLength(
      RECEPTION_RPC_ERROR_CODES.length,
    );
  });

  it('RECEPTION_SAFETY_LABEL_TOOLTIP covers every safety-label kind', () => {
    for (const kind of SAFETY_LABEL_KINDS) {
      expect(RECEPTION_SAFETY_LABEL_TOOLTIP[kind]).toBeTruthy();
    }
  });

  it('access action + outcome copy cover every closed-list value', () => {
    for (const action of RECEPTION_ACCESS_ACTIONS) {
      expect(RECEPTION_ACCESS_ACTION_COPY[action]).toBeTruthy();
    }
    for (const outcome of RECEPTION_ACCESS_OUTCOMES) {
      expect(RECEPTION_ACCESS_OUTCOME_COPY[outcome]).toBeTruthy();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// deriveReceptionEndpointStatus
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — deriveReceptionEndpointStatus', () => {
  it('revocation is terminal — wins over enabled + expiry', () => {
    const s = mkSummary({ enabled: true, revoked_at: NOW - 100, expires_at: NOW + DAY_MS });
    expect(deriveReceptionEndpointStatus(s, NOW)).toBe('revoked');
  });

  it('a passed expiry wins over the enabled bit', () => {
    const s = mkSummary({ enabled: true, expires_at: NOW - 1 });
    expect(deriveReceptionEndpointStatus(s, NOW)).toBe('expired');
  });

  it('enabled + future expiry ⇒ active', () => {
    expect(deriveReceptionEndpointStatus(mkSummary({ enabled: true }), NOW)).toBe('active');
  });

  it('disabled + not revoked + not expired ⇒ disabled', () => {
    expect(deriveReceptionEndpointStatus(mkSummary({ enabled: false }), NOW)).toBe('disabled');
  });

  it('long-lived (null expiry) + enabled ⇒ active', () => {
    expect(
      deriveReceptionEndpointStatus(mkSummary({ enabled: true, expires_at: null }), NOW),
    ).toBe('active');
  });
});

// ────────────────────────────────────────────────────────────────
// buildReceptionEndpointRow
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — buildReceptionEndpointRow', () => {
  it('flags the reception_page singleton by its well-known endpoint id', () => {
    const row = buildReceptionEndpointRow(
      mkSummary({ endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, kind: 'reception_page' }),
      NOW,
    );
    expect(row.is_singleton).toBe(true);
    const link = buildReceptionEndpointRow(mkSummary(), NOW);
    expect(link.is_singleton).toBe(false);
  });

  it('computes the expiry label across long-lived / future / past', () => {
    expect(buildReceptionEndpointRow(mkSummary({ expires_at: null }), NOW).expiry_label).toBe(
      'Never expires',
    );
    expect(
      buildReceptionEndpointRow(mkSummary({ expires_at: NOW + 3 * DAY_MS }), NOW).expiry_label,
    ).toBe('Expires in 3 days');
    expect(
      buildReceptionEndpointRow(mkSummary({ expires_at: NOW - 2 * DAY_MS }), NOW).expiry_label,
    ).toBe('Expired 2 days ago');
    expect(
      buildReceptionEndpointRow(mkSummary({ expires_at: NOW - 1000 }), NOW).expiry_label,
    ).toBe('Expired today');
  });

  it('is_long_lived mirrors a null expiry', () => {
    expect(buildReceptionEndpointRow(mkSummary({ expires_at: null }), NOW).is_long_lived).toBe(
      true,
    );
    expect(buildReceptionEndpointRow(mkSummary(), NOW).is_long_lived).toBe(false);
  });

  it('attaches § A.20.6 safety labels — every kind carries Public URL', () => {
    const row = buildReceptionEndpointRow(mkSummary(), NOW);
    expect(row.safety_labels.map((l) => l.kind)).toContain('public_url');
  });

  it('drop_link with link_kind one_time in metadata surfaces the Single-use label', () => {
    const row = buildReceptionEndpointRow(
      mkSummary({ kind: 'drop_link', metadata: { link_kind: 'one_time' } }),
      NOW,
    );
    const kinds = row.safety_labels.map((l) => l.kind);
    expect(kinds).toContain('single_use');
    expect(kinds).toContain('file_upload');
  });

  it('scheduling_link with an email field in metadata surfaces the PII label', () => {
    const row = buildReceptionEndpointRow(
      mkSummary({
        kind: 'scheduling_link',
        metadata: { required_visitor_fields: { email: 'required' } },
      }),
      NOW,
    );
    expect(row.safety_labels.map((l) => l.kind)).toContain('pii_collected');
  });

  it('a malformed metadata blob does not throw — the dependent label is just omitted', () => {
    const row = buildReceptionEndpointRow(
      mkSummary({ kind: 'drop_link', metadata: { link_kind: 42, required_visitor_fields: 'nope' } }),
      NOW,
    );
    // file_upload still present (kind-derived); single_use omitted (bad link_kind).
    const kinds = row.safety_labels.map((l) => l.kind);
    expect(kinds).toContain('file_upload');
    expect(kinds).not.toContain('single_use');
  });
});

// ────────────────────────────────────────────────────────────────
// buildReceptionPageModel
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — buildReceptionPageModel', () => {
  it('builds six sections in canonical order', () => {
    const model = buildReceptionPageModel({ endpoints: [], status: okStatus(), now: NOW });
    expect(model.sections.map((s) => s.kind)).toEqual([...RECEPTION_ENDPOINT_KINDS]);
  });

  it('groups endpoints into their kind section, preserving input order', () => {
    const endpoints: EndpointSummary[] = [
      mkSummary({ endpoint_id: 's2', kind: 'scheduling_link' }),
      mkSummary({ endpoint_id: 's1', kind: 'scheduling_link' }),
      mkSummary({ endpoint_id: 'd1', kind: 'drop_link', expires_at: NOW + 5 * DAY_MS }),
    ];
    const model = buildReceptionPageModel({ endpoints, status: okStatus(), now: NOW });
    const sched = model.sections.find((s) => s.kind === 'scheduling_link')!;
    expect(sched.rows.map((r) => r.endpoint_id)).toEqual(['s2', 's1']);
    const drop = model.sections.find((s) => s.kind === 'drop_link')!;
    expect(drop.rows).toHaveLength(1);
  });

  it('reception_page section can_create is true only until the singleton exists', () => {
    const empty = buildReceptionPageModel({ endpoints: [], status: okStatus(), now: NOW });
    expect(empty.sections.find((s) => s.kind === 'reception_page')!.can_create).toBe(true);

    const withSingleton = buildReceptionPageModel({
      endpoints: [
        mkSummary({ endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, kind: 'reception_page' }),
      ],
      status: okStatus(),
      now: NOW,
    });
    expect(
      withSingleton.sections.find((s) => s.kind === 'reception_page')!.can_create,
    ).toBe(false);
    // scheduling_link is creatable since D-173 P4.2 (cold-start visitor
    // slot picker is served). status_link stays listed-but-not-creatable
    // until its visitor reader lands.
    expect(
      withSingleton.sections.find((s) => s.kind === 'scheduling_link')!.can_create,
    ).toBe(true);
    expect(
      withSingleton.sections.find((s) => s.kind === 'status_link')!.can_create,
    ).toBe(false);
    expect(
      withSingleton.sections.find((s) => s.kind === 'intake_form')!.can_create,
    ).toBe(true);
  });

  it('the only launch-hidden kind is status_link (scheduling un-hid in D-173 P4.2)', () => {
    expect([...UNAVAILABLE_RECEPTION_ENDPOINT_KINDS].sort()).toEqual(['status_link']);
  });

  it('is_first_run is true with zero enabled endpoints, false once one is enabled', () => {
    expect(
      buildReceptionPageModel({ endpoints: [], status: okStatus(), now: NOW }).is_first_run,
    ).toBe(true);
    expect(
      buildReceptionPageModel({
        endpoints: [mkSummary({ enabled: false })],
        status: okStatus(),
        now: NOW,
      }).is_first_run,
    ).toBe(true);
    expect(
      buildReceptionPageModel({
        endpoints: [mkSummary({ enabled: true })],
        status: okStatus(),
        now: NOW,
      }).is_first_run,
    ).toBe(false);
  });

  it('counts total + active endpoints (expired enabled rows are not active)', () => {
    const endpoints: EndpointSummary[] = [
      mkSummary({ endpoint_id: 'a', enabled: true }),
      mkSummary({ endpoint_id: 'b', enabled: false }),
      mkSummary({ endpoint_id: 'c', enabled: true, expires_at: NOW - 1 }),
      mkSummary({ endpoint_id: 'd', enabled: true, revoked_at: NOW - 1 }),
    ];
    const model = buildReceptionPageModel({ endpoints, status: okStatus(), now: NOW });
    expect(model.total_endpoints).toBe(4);
    expect(model.active_endpoints).toBe(1);
  });

  it('status header — serving when public + not emergency-disabled', () => {
    const model = buildReceptionPageModel({ endpoints: [], status: okStatus(), now: NOW });
    expect(model.status_header.serving).toBe(true);
    expect(model.status_header.status_label).toBe('Enabled');
    expect(model.status_header.base_url).toBe('https://alice.recued.cloud/reception/');
  });

  it('status header — emergency-disabled wins over not-public for the label', () => {
    const model = buildReceptionPageModel({
      endpoints: [],
      status: { emergency_disabled: true, reception_public: false, base_url: null },
      now: NOW,
    });
    expect(model.status_header.serving).toBe(false);
    expect(model.status_header.status_label).toBe('Switched off in a hurry');
  });

  it('status header — not publicly exposed when reception_public is false', () => {
    const model = buildReceptionPageModel({
      endpoints: [],
      status: { emergency_disabled: false, reception_public: false, base_url: null },
      now: NOW,
    });
    expect(model.status_header.serving).toBe(false);
    expect(model.status_header.status_label).toBe('Not open to the internet');
  });
});

// ────────────────────────────────────────────────────────────────
// Access-log surface
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — access-log surface', () => {
  it('truncateSourceIpHash returns the 8-char prefix (§ A.16.7), empty string for null', () => {
    expect(truncateSourceIpHash('abcdef0123456789')).toBe('abcdef01');
    expect(truncateSourceIpHash('abcdef0123456789')).toHaveLength(
      RECEPTION_SOURCE_IP_HASH_PREFIX_LEN,
    );
    expect(RECEPTION_SOURCE_IP_HASH_PREFIX_LEN).toBe(8);
    expect(truncateSourceIpHash(null)).toBe('');
  });

  it('distinctSourceIpHashCount counts distinct non-null hashes', () => {
    const entries = [
      mkAccessLog({ source_ip_hash: 'aaa' }),
      mkAccessLog({ source_ip_hash: 'aaa' }),
      mkAccessLog({ source_ip_hash: 'bbb' }),
      mkAccessLog({ source_ip_hash: null }),
    ];
    expect(distinctSourceIpHashCount(entries)).toBe(2);
    expect(distinctSourceIpHashCount([])).toBe(0);
  });

  it('buildReceptionAccessLogRow projects + resolves action / outcome copy', () => {
    const row = buildReceptionAccessLogRow(
      mkAccessLog({ action_taken: 'submit', outcome: 'rate_limited' }),
    );
    expect(row.source_ip_hash_prefix).toBe('abcdef01');
    expect(row.source_ip_hash).toBe('abcdef0123456789');
    expect(row.action_label).toBe(RECEPTION_ACCESS_ACTION_COPY.submit);
    expect(row.outcome_label).toBe(RECEPTION_ACCESS_OUTCOME_COPY.rate_limited);
  });

  it('buildReceptionAccessLogRow handles a null-hash internal probe', () => {
    const row = buildReceptionAccessLogRow(mkAccessLog({ source_ip_hash: null }));
    expect(row.source_ip_hash_prefix).toBe('');
    expect(row.source_ip_hash).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// buildReceptionEndpointDetailModel
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — buildReceptionEndpointDetailModel', () => {
  it('projects the row + access log + distinct-IP count + packet declaration', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: mkSummary(),
      access_log: [
        mkAccessLog({ id: 'l1', source_ip_hash: 'aaa' }),
        mkAccessLog({ id: 'l2', source_ip_hash: 'bbb' }),
      ],
      now: NOW,
    });
    expect(detail.row.endpoint_id).toBe('ep-1');
    expect(detail.access_log_rows.map((r) => r.id)).toEqual(['l1', 'l2']);
    expect(detail.distinct_source_ip_count).toBe(2);
    expect(detail.packet_declaration.packet_kind).toBe('scheduling_link_packet');
  });

  it('share_cards empty + share_url_available false when no share input', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: mkSummary(),
      access_log: [],
      now: NOW,
    });
    expect(detail.share_cards).toEqual([]);
    expect(detail.share_url_available).toBe(false);
  });

  it('builds § A.20.4 Share Cards when the caller still holds the share URL', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: mkSummary({
        kind: 'intake_form',
        packet_declaration: {
          packet_kind: 'intake_form_packet',
          source_query_ref: {
            kind: 'reception_form_definition',
            form_definition_id: 'fd-1',
          },
        },
      }),
      access_log: [],
      share: {
        share_url: 'https://alice.recued.cloud/reception/intake/ep-1?t=secret',
        title: 'Send Alice an intake',
        description: 'Tell me what you need.',
        expiry_note: 'Expires in 30 days.',
      },
      now: NOW,
    });
    expect(detail.share_url_available).toBe(true);
    expect(detail.share_cards.map((c) => c.channel)).toEqual(['email', 'sms', 'slack']);
    for (const card of detail.share_cards) {
      expect(card.snippet).toContain(
        'https://alice.recued.cloud/reception/intake/ep-1?t=secret',
      );
    }
  });

  it('suppresses Share Cards for unavailable endpoint kinds even when a share URL is cached', () => {
    for (const kind of UNAVAILABLE_RECEPTION_ENDPOINT_KINDS) {
      const detail = buildReceptionEndpointDetailModel({
        summary: mkSummary({ kind }),
        access_log: [],
        share: {
          share_url: `https://alice.recued.cloud/reception/${kind}/ep-1?t=secret`,
          title: 'Unavailable link',
          description: 'Should not be surfaced.',
        },
        now: NOW,
      });
      expect(detail.share_url_available).toBe(false);
      expect(detail.share_cards).toEqual([]);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Dispatch builders
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — dispatch builders', () => {
  it('enable / disable carry just the endpoint id', () => {
    expect(buildReceptionEnableDispatch({ endpoint_id: 'ep-1' })).toEqual({
      op: 'reception.endpoint.enable',
      endpoint_id: 'ep-1',
    });
    expect(buildReceptionDisableDispatch({ endpoint_id: 'ep-1' })).toEqual({
      op: 'reception.endpoint.disable',
      endpoint_id: 'ep-1',
    });
  });

  it('revoke omits an undefined reason, includes a present one', () => {
    expect(buildReceptionRevokeDispatch({ endpoint_id: 'ep-1' })).toEqual({
      op: 'reception.endpoint.revoke',
      endpoint_id: 'ep-1',
    });
    expect(
      buildReceptionRevokeDispatch({ endpoint_id: 'ep-1', reason: 'leaked' }),
    ).toEqual({ op: 'reception.endpoint.revoke', endpoint_id: 'ep-1', reason: 'leaked' });
  });

  it('extend carries new_expires_at including the long-lived null', () => {
    expect(
      buildReceptionExtendDispatch({ endpoint_id: 'ep-1', new_expires_at: NOW + DAY_MS }),
    ).toEqual({
      op: 'reception.endpoint.extend',
      endpoint_id: 'ep-1',
      new_expires_at: NOW + DAY_MS,
    });
    expect(
      buildReceptionExtendDispatch({ endpoint_id: 'ep-1', new_expires_at: null }),
    ).toEqual({ op: 'reception.endpoint.extend', endpoint_id: 'ep-1', new_expires_at: null });
  });

  it('rotate omits an undefined reason, includes a typed one', () => {
    expect(buildReceptionRotateDispatch({ endpoint_id: 'ep-1' })).toEqual({
      op: 'reception.endpoint.rotate_token',
      endpoint_id: 'ep-1',
    });
    expect(
      buildReceptionRotateDispatch({ endpoint_id: 'ep-1', reason: 'suspected_leak' }),
    ).toEqual({
      op: 'reception.endpoint.rotate_token',
      endpoint_id: 'ep-1',
      reason: 'suspected_leak',
    });
  });

  it('emergency-disable-all omits / includes the optional reason', () => {
    expect(buildReceptionEmergencyDisableAllDispatch({})).toEqual({
      op: 'reception.emergency_disable_all',
    });
    expect(
      buildReceptionEmergencyDisableAllDispatch({ reason: 'incident' }),
    ).toEqual({ op: 'reception.emergency_disable_all', reason: 'incident' });
  });
});

// ────────────────────────────────────────────────────────────────
// reduceReceptionEmergencyDisabled
// ────────────────────────────────────────────────────────────────

describe('D-149 settings-reception — reduceReceptionEmergencyDisabled', () => {
  const baseModel = (kinds: ReadonlyArray<Partial<EndpointSummary>>) =>
    buildReceptionPageModel({
      endpoints: kinds.map((k, i) => mkSummary({ endpoint_id: `e${i}`, ...k })),
      status: okStatus(),
      now: NOW,
    });

  it('flips active rows to disabled, leaves revoked / expired untouched', () => {
    const model = baseModel([
      { endpoint_id: 'active', enabled: true },
      { endpoint_id: 'revoked', enabled: true, revoked_at: NOW - 1 },
      { endpoint_id: 'expired', enabled: true, expires_at: NOW - 1 },
      { endpoint_id: 'disabled', enabled: false },
    ]);
    const next = reduceReceptionEmergencyDisabled(model);
    const allRows = next.sections.flatMap((s) => s.rows);
    expect(allRows.find((r) => r.endpoint_id === 'active')!.status).toBe('disabled');
    expect(allRows.find((r) => r.endpoint_id === 'revoked')!.status).toBe('revoked');
    expect(allRows.find((r) => r.endpoint_id === 'expired')!.status).toBe('expired');
    expect(allRows.find((r) => r.endpoint_id === 'disabled')!.status).toBe('disabled');
  });

  it('sets the emergency-disabled header + recomputes serving / counts / first-run', () => {
    const model = baseModel([{ enabled: true }, { enabled: true }]);
    expect(model.active_endpoints).toBe(2);
    expect(model.status_header.serving).toBe(true);

    const next = reduceReceptionEmergencyDisabled(model);
    expect(next.status_header.emergency_disabled).toBe(true);
    expect(next.status_header.serving).toBe(false);
    expect(next.status_header.status_label).toBe('Switched off in a hurry');
    expect(next.active_endpoints).toBe(0);
    expect(next.is_first_run).toBe(true);
    expect(next.total_endpoints).toBe(2);
  });

  it('preserves the base URL + public-exposure bit from the prior header', () => {
    const model = baseModel([{ enabled: true }]);
    const next = reduceReceptionEmergencyDisabled(model);
    expect(next.status_header.base_url).toBe('https://alice.recued.cloud/reception/');
    expect(next.status_header.reception_public).toBe(true);
  });

  it('is pure — does not mutate the input model', () => {
    const model = baseModel([{ enabled: true }]);
    reduceReceptionEmergencyDisabled(model);
    expect(model.status_header.emergency_disabled).toBe(false);
    expect(model.active_endpoints).toBe(1);
    expect(model.sections.flatMap((s) => s.rows)[0].status).toBe('active');
  });
});
