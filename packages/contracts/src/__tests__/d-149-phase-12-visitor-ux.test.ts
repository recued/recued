/** D-149 P12 § A.20 — visitor-facing UX feature substrate tests.
 *
 *  Covers the seven pure builders + their closed-list ratchets:
 *    § A.20.1 buildLaunchWizardPlan / validateLaunchWizardInput
 *    § A.20.2 buildViewAsVisitorPanel (+ synthetic flag, stripped map)
 *    § A.20.3 validateVisitorReceiptConfig / buildVisitorReceipt
 *    § A.20.4 buildShareCards
 *    § A.20.5 classifyAbuseSignal / buildAbuseInbox / abuseInboxBlockKey
 *    § A.20.6 buildSafetyLabels
 *    § A.20.7 buildTrustFooter */

import { describe, expect, it } from 'vitest';
import {
  // § A.20.7
  TRUST_FOOTER_DEPLOYMENT_MODES,
  TRUST_FOOTER_DEPLOYMENT_MODE_SET,
  buildTrustFooter,
  // § A.20.6
  SAFETY_LABEL_KINDS,
  SAFETY_LABEL_KIND_SET,
  SAFETY_LABEL_EMOJI,
  buildSafetyLabels,
  // § A.20.4
  SHARE_CARD_CHANNELS,
  SHARE_CARD_CHANNEL_SET,
  buildShareCards,
  // § A.20.5
  ABUSE_INBOX_SIGNAL_KINDS,
  ABUSE_INBOX_SIGNAL_KIND_SET,
  ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD,
  ABUSE_INBOX_DEFAULT_WINDOW_MS,
  ABUSE_INBOX_KEY_DELIMITER,
  RECEPTION_IP_BLOCKED_REJECTION_REASON,
  classifyAbuseSignal,
  abuseInboxBlockKey,
  buildAbuseInbox,
  // § A.20.3
  VISITOR_RECEIPT_VIA_VALUES,
  VISITOR_RECEIPT_VIA_SET,
  VISITOR_RECEIPT_DEFAULT_VIA,
  validateVisitorReceiptConfig,
  buildVisitorReceipt,
  // § A.20.2
  PACKET_STRIPPED_FIELDS_RATIONALE,
  RECEPTION_KIND_TOKEN_MODE,
  RECEPTION_KIND_AUDIT_MODE,
  RECEPTION_PRIVACY_INVARIANT_LABELS,
  buildViewAsVisitorPanel,
  // § A.20.1
  LAUNCH_WIZARD_STEPS,
  LAUNCH_WIZARD_STEP_SET,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  LAUNCH_WIZARD_DROP_CONFIG_ID,
  validateLaunchWizardInput,
  buildLaunchWizardPlan,
  REDACTED_PACKET_KINDS,
  RECEPTION_ENDPOINT_KINDS,
  type AccessLogEntry,
  type DropLinkConfig,
  type IntakeFormConfig,
  type LaunchWizardInput,
  type PacketDeclaration,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
} from '../index.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════
// § A.20.7 — Public Trust Footer
// ════════════════════════════════════════════════════════════════

describe('D-149 P12 § A.20.7 — buildTrustFooter', () => {
  it('returns null when the toggle is off', () => {
    expect(buildTrustFooter({ enabled: false, deployment_mode: 'byo_ddns' })).toBeNull();
  });

  it('BYO-DDNS copy omits any cloud-relay reference', () => {
    const footer = buildTrustFooter({ enabled: true, deployment_mode: 'byo_ddns' });
    expect(footer).toContain("served directly by this user's own Recued server");
    expect(footer).toContain('No third-party services involved.');
    expect(footer).not.toContain('cloud');
  });

  it('Pro-cloud copy names the DNS relay', () => {
    const footer = buildTrustFooter({ enabled: true, deployment_mode: 'pro_cloud' });
    expect(footer).toContain("served directly by this user's own Recued server");
    expect(footer).toContain('Recued cloud only relays the DNS record.');
  });

  it('copy is fully substrate-fixed — no per-endpoint value is interpolated', () => {
    // The footer body carries no caller-supplied text, so a hostile or
    // purpose-style endpoint name can neither inject markup nor leak into
    // the privacy claim (§ A.20.7 "not user-customizable text body").
    const byo = buildTrustFooter({ enabled: true, deployment_mode: 'byo_ddns' });
    const pro = buildTrustFooter({ enabled: true, deployment_mode: 'pro_cloud' });
    expect(byo).not.toContain('<');
    expect(byo).not.toContain("'s server"); // no possessive endpoint name
    expect(pro).not.toContain('<');
  });

  it('deployment-mode closed list ratchet', () => {
    expect(TRUST_FOOTER_DEPLOYMENT_MODES).toEqual(['byo_ddns', 'pro_cloud']);
    expect(TRUST_FOOTER_DEPLOYMENT_MODE_SET.size).toBe(TRUST_FOOTER_DEPLOYMENT_MODES.length);
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.6 — Per-Endpoint Safety Labels
// ════════════════════════════════════════════════════════════════

describe('D-149 P12 § A.20.6 — buildSafetyLabels', () => {
  it('every endpoint kind gets the public_url label', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      const labels = buildSafetyLabels({ kind, expires_at: null, now: NOW });
      expect(labels.some((l) => l.kind === 'public_url')).toBe(true);
    }
  });

  it('a bounded expiry surfaces an expires_in label with the day count', () => {
    const labels = buildSafetyLabels({
      kind: 'scheduling_link',
      expires_at: NOW + 5 * DAY,
      now: NOW,
    });
    const expiry = labels.find((l) => l.kind === 'expires_in');
    expect(expiry?.text).toBe('Expires in 5 days');
    expect(expiry?.emoji).toBe('⏱');
  });

  it('a long-lived endpoint gets no expires_in label', () => {
    const labels = buildSafetyLabels({ kind: 'scheduling_link', expires_at: null, now: NOW });
    expect(labels.some((l) => l.kind === 'expires_in')).toBe(false);
  });

  it('status_link gets the read-only label', () => {
    const labels = buildSafetyLabels({ kind: 'status_link', expires_at: null, now: NOW });
    expect(labels.some((l) => l.kind === 'read_only')).toBe(true);
  });

  it('approval_link gets the single-use label', () => {
    const labels = buildSafetyLabels({ kind: 'approval_link', expires_at: null, now: NOW });
    expect(labels.some((l) => l.kind === 'single_use')).toBe(true);
  });

  it('drop_link gets file_upload always + single_use only when one_time', () => {
    const repeated = buildSafetyLabels({
      kind: 'drop_link',
      expires_at: null,
      now: NOW,
      config: { link_kind: 'repeated' },
    });
    expect(repeated.some((l) => l.kind === 'file_upload')).toBe(true);
    expect(repeated.some((l) => l.kind === 'single_use')).toBe(false);

    const oneTime = buildSafetyLabels({
      kind: 'drop_link',
      expires_at: null,
      now: NOW,
      config: { link_kind: 'one_time' },
    });
    expect(oneTime.some((l) => l.kind === 'single_use')).toBe(true);
  });

  it('intake_form always flags pii_collected; scheduling_link only with an email field', () => {
    expect(
      buildSafetyLabels({ kind: 'intake_form', expires_at: null, now: NOW }).some(
        (l) => l.kind === 'pii_collected',
      ),
    ).toBe(true);

    const schedWithEmail = buildSafetyLabels({
      kind: 'scheduling_link',
      expires_at: null,
      now: NOW,
      config: { required_visitor_fields: { email: 'required' } },
    });
    expect(schedWithEmail.some((l) => l.kind === 'pii_collected')).toBe(true);

    const schedNoEmail = buildSafetyLabels({
      kind: 'scheduling_link',
      expires_at: null,
      now: NOW,
      config: { required_visitor_fields: { email: 'omit' } },
    });
    expect(schedNoEmail.some((l) => l.kind === 'pii_collected')).toBe(false);
  });

  it('safety-label closed list ratchet — every kind has an emoji', () => {
    expect(SAFETY_LABEL_KIND_SET.size).toBe(SAFETY_LABEL_KINDS.length);
    for (const k of SAFETY_LABEL_KINDS) {
      expect(typeof SAFETY_LABEL_EMOJI[k]).toBe('string');
      expect(SAFETY_LABEL_EMOJI[k].length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.4 — Endpoint Share Cards
// ════════════════════════════════════════════════════════════════

describe('D-149 P12 § A.20.4 — buildShareCards', () => {
  const input = {
    share_url: 'https://alice.recued.cloud/reception/scheduling/abc?t=zzz',
    title: 'Schedule a 30-min meeting with Alice',
    description: 'Available Tue-Thu, 10am-4pm.',
    expiry_note: 'Expires in 90 days.',
  };

  it('returns one snippet per channel in closed-list order', () => {
    const cards = buildShareCards(input);
    expect(cards.map((c) => c.channel)).toEqual(['email', 'sms', 'slack']);
  });

  it('email snippet is long-form with title + description + URL + expiry', () => {
    const email = buildShareCards(input).find((c) => c.channel === 'email')!;
    expect(email.snippet).toContain(input.title);
    expect(email.snippet).toContain(input.description);
    expect(email.snippet).toContain(input.share_url);
    expect(email.snippet).toContain(input.expiry_note);
  });

  it('sms snippet is terse — description + URL on one line', () => {
    const sms = buildShareCards(input).find((c) => c.channel === 'sms')!;
    expect(sms.snippet).toBe(`${input.description} ${input.share_url}`);
  });

  it('slack snippet is markdown with a bold title + blockquote', () => {
    const slack = buildShareCards(input).find((c) => c.channel === 'slack')!;
    expect(slack.snippet).toContain(`*${input.title}*`);
    expect(slack.snippet).toContain(`> ${input.description}`);
  });

  it('omits the expiry line across channels when expiry_note is absent', () => {
    const cards = buildShareCards({ ...input, expiry_note: undefined });
    for (const c of cards) {
      expect(c.snippet).not.toContain('Expires');
    }
  });

  it('share-card channel closed list ratchet', () => {
    expect(SHARE_CARD_CHANNELS).toEqual(['email', 'sms', 'slack']);
    expect(SHARE_CARD_CHANNEL_SET.size).toBe(SHARE_CARD_CHANNELS.length);
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.5 — Abuse Inbox
// ════════════════════════════════════════════════════════════════

const accessEntry = (over: Partial<AccessLogEntry>): AccessLogEntry => ({
  id: over.id ?? `log_${Math.random()}`,
  endpoint_id: over.endpoint_id ?? 'ep_1',
  accessed_at: over.accessed_at ?? NOW,
  // `'source_ip_hash' in over` (not `??`) so an explicit `null` override
  // is preserved — `null ?? default` would silently re-apply the default.
  source_ip_hash: 'source_ip_hash' in over ? over.source_ip_hash! : 'iphash_a',
  user_agent_hash: over.user_agent_hash ?? null,
  action_taken: over.action_taken ?? 'view',
  outcome: over.outcome ?? 'ok',
  url_path_redacted: over.url_path_redacted ?? '/reception/scheduling/ep_1',
  metadata: over.metadata ?? {},
});

describe('D-149 P12 § A.20.5 — classifyAbuseSignal', () => {
  it('maps each suspicious outcome to its signal kind', () => {
    expect(classifyAbuseSignal(accessEntry({ outcome: 'rate_limited' }))).toBe('spam_burst');
    expect(classifyAbuseSignal(accessEntry({ outcome: 'capacity_full' }))).toBe('endpoint_ddos');
    expect(classifyAbuseSignal(accessEntry({ outcome: 'invalid_token' }))).toBe(
      'invalid_token_burst',
    );
  });

  it('fans the rejected outcome out by rejection_reason', () => {
    expect(
      classifyAbuseSignal(
        accessEntry({ outcome: 'rejected', metadata: { rejection_reason: 'rejected_mime' } }),
      ),
    ).toBe('mime_rejection');
    expect(
      classifyAbuseSignal(
        accessEntry({ outcome: 'rejected', metadata: { rejection_reason: 'rejected_size' } }),
      ),
    ).toBe('oversized_upload');
    expect(classifyAbuseSignal(accessEntry({ outcome: 'rejected', metadata: {} }))).toBe(
      'suspicious_payload',
    );
  });

  it('an already-banned IP request is NOT re-clustered as a fresh signal', () => {
    expect(
      classifyAbuseSignal(
        accessEntry({
          outcome: 'rejected',
          metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
        }),
      ),
    ).toBeNull();
  });

  it('normal lifecycle outcomes are not abuse signals', () => {
    expect(classifyAbuseSignal(accessEntry({ outcome: 'ok' }))).toBeNull();
    expect(classifyAbuseSignal(accessEntry({ outcome: 'expired' }))).toBeNull();
    expect(classifyAbuseSignal(accessEntry({ outcome: 'revoked' }))).toBeNull();
  });
});

describe('D-149 P12 § A.20.5 — buildAbuseInbox', () => {
  it('clusters by (signal_kind, endpoint_id, source_ip_hash) above the threshold', () => {
    const entries: AccessLogEntry[] = [
      ...Array.from({ length: 4 }, () =>
        accessEntry({ outcome: 'invalid_token', endpoint_id: 'ep_1', source_ip_hash: 'ip_x' }),
      ),
      // below threshold — only 2 hits
      accessEntry({ outcome: 'rate_limited', endpoint_id: 'ep_2', source_ip_hash: 'ip_y' }),
      accessEntry({ outcome: 'rate_limited', endpoint_id: 'ep_2', source_ip_hash: 'ip_y' }),
    ];
    const summary = buildAbuseInbox({
      entries,
      blocked_keys: new Set(),
      window_start_at: NOW - DAY,
      window_end_at: NOW,
    });
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]!.signal_kind).toBe('invalid_token_burst');
    expect(summary.rows[0]!.event_count).toBe(4);
    expect(summary.total_signals).toBe(1);
    expect(summary.cluster_threshold).toBe(ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD);
  });

  it('annotates ip_blocked when the (endpoint, hash) pair is on the block list', () => {
    const entries = Array.from({ length: 3 }, () =>
      accessEntry({ outcome: 'rate_limited', endpoint_id: 'ep_1', source_ip_hash: 'ip_b' }),
    );
    const summary = buildAbuseInbox({
      entries,
      blocked_keys: new Set([abuseInboxBlockKey('ep_1', 'ip_b')]),
      window_start_at: NOW - DAY,
      window_end_at: NOW,
    });
    expect(summary.rows[0]!.ip_blocked).toBe(true);
  });

  it('skips entries with a null source_ip_hash (internal probes)', () => {
    const entries = Array.from({ length: 5 }, () =>
      accessEntry({ outcome: 'invalid_token', source_ip_hash: null }),
    );
    const summary = buildAbuseInbox({
      entries,
      blocked_keys: new Set(),
      window_start_at: NOW - DAY,
      window_end_at: NOW,
    });
    expect(summary.rows).toHaveLength(0);
  });

  it('respects a custom cluster_threshold', () => {
    const entries = Array.from({ length: 2 }, () =>
      accessEntry({ outcome: 'rate_limited', source_ip_hash: 'ip_c' }),
    );
    const summary = buildAbuseInbox({
      entries,
      blocked_keys: new Set(),
      window_start_at: NOW - DAY,
      window_end_at: NOW,
      cluster_threshold: 2,
    });
    expect(summary.rows).toHaveLength(1);
  });

  it('rows sort by last_seen_at descending', () => {
    const old = Array.from({ length: 3 }, (_, i) =>
      accessEntry({
        outcome: 'invalid_token',
        endpoint_id: 'ep_old',
        source_ip_hash: 'ip_old',
        accessed_at: NOW - 10 * DAY + i,
      }),
    );
    const recent = Array.from({ length: 3 }, (_, i) =>
      accessEntry({
        outcome: 'invalid_token',
        endpoint_id: 'ep_new',
        source_ip_hash: 'ip_new',
        accessed_at: NOW - i,
      }),
    );
    const summary = buildAbuseInbox({
      entries: [...old, ...recent],
      blocked_keys: new Set(),
      window_start_at: NOW - 30 * DAY,
      window_end_at: NOW,
    });
    expect(summary.rows[0]!.endpoint_id).toBe('ep_new');
    expect(summary.rows[1]!.endpoint_id).toBe('ep_old');
  });

  it('abuseInboxBlockKey is collision-safe across the two segments', () => {
    expect(abuseInboxBlockKey('a', 'b c')).not.toBe(abuseInboxBlockKey('a b', 'c'));
  });

  it('the key delimiter is a plain pipe — text-clean, not a raw NUL (Codex P3 fold)', () => {
    expect(ABUSE_INBOX_KEY_DELIMITER).toBe('|');
    // a pipe is collision-proof for the real key alphabets (UUID hex /
    // base64url hash / lowercase signal_kind) — none contain a pipe.
    expect(abuseInboxBlockKey('ep_1', 'hash_a')).toBe('ep_1|hash_a');
  });

  it('abuse-signal closed list + window/threshold constants ratchet', () => {
    expect(ABUSE_INBOX_SIGNAL_KIND_SET.size).toBe(ABUSE_INBOX_SIGNAL_KINDS.length);
    expect(ABUSE_INBOX_SIGNAL_KINDS).toContain('spam_burst');
    expect(ABUSE_INBOX_SIGNAL_KINDS).toContain('suspicious_payload');
    expect(ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD).toBe(3);
    expect(ABUSE_INBOX_DEFAULT_WINDOW_MS).toBe(7 * DAY);
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.3 — Visitor Receipt
// ════════════════════════════════════════════════════════════════

describe('D-149 P12 § A.20.3 — validateVisitorReceiptConfig', () => {
  it('accepts a valid config', () => {
    expect(validateVisitorReceiptConfig({ enabled: true, via: 'page' })).toEqual([]);
    expect(validateVisitorReceiptConfig({ enabled: false, via: 'email' })).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateVisitorReceiptConfig(null)[0]?.code).toBe('config_shape_invalid');
  });

  it('rejects a non-boolean enabled', () => {
    const f = validateVisitorReceiptConfig({ enabled: 'yes', via: 'page' });
    expect(f.some((x) => x.code === 'enabled_invalid')).toBe(true);
  });

  it('rejects an unknown via (when present)', () => {
    const f = validateVisitorReceiptConfig({ enabled: true, via: 'carrier_pigeon' });
    expect(f.some((x) => x.code === 'via_unknown')).toBe(true);
  });

  it('accepts an omitted via — the documented page-only default (Codex P2 fold)', () => {
    expect(validateVisitorReceiptConfig({ enabled: true })).toEqual([]);
    expect(validateVisitorReceiptConfig({ enabled: false })).toEqual([]);
  });

  it('via closed list + default ratchet', () => {
    expect(VISITOR_RECEIPT_VIA_VALUES).toEqual(['email', 'page']);
    expect(VISITOR_RECEIPT_VIA_SET.size).toBe(2);
    expect(VISITOR_RECEIPT_DEFAULT_VIA).toBe('page');
  });
});

describe('D-149 P12 § A.20.3 — buildVisitorReceipt', () => {
  const base = {
    reference_id: 'ref_abc',
    submitted_at: NOW,
    endpoint_kind: 'intake_form' as const,
    fields_echo: [{ label: 'Your name', value: 'Bob' }],
    privacy_footer: 'served directly by Alice',
  };

  it('returns null when receipts are disabled', () => {
    expect(buildVisitorReceipt({ ...base, config: { enabled: false, via: 'page' } })).toBeNull();
  });

  it('round-trips the reference id, field echo, and footer when enabled', () => {
    const receipt = buildVisitorReceipt({ ...base, config: { enabled: true, via: 'page' } });
    expect(receipt).not.toBeNull();
    expect(receipt!.reference_id).toBe('ref_abc');
    expect(receipt!.fields_echo).toEqual([{ label: 'Your name', value: 'Bob' }]);
    expect(receipt!.privacy_footer).toBe('served directly by Alice');
    expect(receipt!.via).toBe('page');
  });

  it('carries a null privacy footer through when the trust footer is off', () => {
    const receipt = buildVisitorReceipt({
      ...base,
      privacy_footer: null,
      config: { enabled: true, via: 'email' },
    });
    expect(receipt!.privacy_footer).toBeNull();
    expect(receipt!.via).toBe('email');
  });

  it('an omitted config.via resolves to the page-only default (Codex P2 fold)', () => {
    const receipt = buildVisitorReceipt({ ...base, config: { enabled: true } });
    expect(receipt!.via).toBe('page');
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.2 — View-As-Visitor Preview
// ════════════════════════════════════════════════════════════════

describe('D-149 P12 § A.20.2 — buildViewAsVisitorPanel', () => {
  const schedDecl: PacketDeclaration = {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  };

  it('is always flagged synthetic: true', () => {
    const panel = buildViewAsVisitorPanel({
      kind: 'scheduling_link',
      packet_declaration: schedDecl,
      expires_at: null,
      now: NOW,
    });
    expect(panel.synthetic).toBe(true);
  });

  it('field rows split into visible (from PACKET_FIELDS_VISIBLE) + stripped (with rationale)', () => {
    const panel = buildViewAsVisitorPanel({
      kind: 'scheduling_link',
      packet_declaration: schedDecl,
      expires_at: null,
      now: NOW,
    });
    const visible = panel.field_rows.filter((r) => r.visible);
    const stripped = panel.field_rows.filter((r) => !r.visible);
    expect(visible.map((r) => r.field)).toEqual(panel.visible_fields);
    expect(stripped.length).toBeGreaterThan(0);
    // every stripped row carries a non-empty rationale
    for (const r of stripped) {
      expect(r.rationale.length).toBeGreaterThan(0);
    }
    // the calendar-event strip is part of the scheduling_link panel
    expect(stripped.some((r) => r.field === 'raw_calendar_events')).toBe(true);
  });

  it('honours a fields_visible_override clamp', () => {
    const panel = buildViewAsVisitorPanel({
      kind: 'scheduling_link',
      packet_declaration: { ...schedDecl, fields_visible_override: ['free_windows', 'tz'] },
      expires_at: null,
      now: NOW,
    });
    expect(panel.visible_fields).toEqual(['free_windows', 'tz']);
  });

  it('surfaces token + audit mode per kind', () => {
    const sched = buildViewAsVisitorPanel({
      kind: 'scheduling_link',
      packet_declaration: schedDecl,
      expires_at: null,
      now: NOW,
    });
    expect(sched.token_mode).toBe('bearer_query_param');
    const page = buildViewAsVisitorPanel({
      kind: 'reception_page',
      packet_declaration: {
        packet_kind: 'reception_page_packet',
        source_query_ref: { kind: 'reception_page_config' },
      },
      expires_at: null,
      now: NOW,
    });
    expect(page.token_mode).toBe('tokenless_singleton');
    expect(page.audit_mode).toContain('high_assurance_on_config_update');
  });

  it('the expiry invariant fails when a bounded expiry exceeds the per-kind ceiling', () => {
    // drop_link has a 30-day hard ceiling
    const overCeiling = buildViewAsVisitorPanel({
      kind: 'drop_link',
      packet_declaration: {
        packet_kind: 'drop_link_packet',
        source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'd1' },
      },
      expires_at: NOW + 60 * DAY,
      now: NOW,
    });
    const expiryRow = overCeiling.privacy_invariant_summary.find(
      (r) => r.invariant === 'Expiry is within the per-kind ceiling',
    );
    expect(expiryRow?.satisfied).toBe(false);

    const withinCeiling = buildViewAsVisitorPanel({
      kind: 'drop_link',
      packet_declaration: {
        packet_kind: 'drop_link_packet',
        source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'd1' },
      },
      expires_at: NOW + 10 * DAY,
      now: NOW,
    });
    expect(
      withinCeiling.privacy_invariant_summary.find(
        (r) => r.invariant === 'Expiry is within the per-kind ceiling',
      )?.satisfied,
    ).toBe(true);
  });

  it('the stripped-field map + per-kind maps are total over RedactedPacketKind / endpoint kinds', () => {
    for (const pk of REDACTED_PACKET_KINDS) {
      expect(PACKET_STRIPPED_FIELDS_RATIONALE[pk]).toBeDefined();
    }
    for (const ek of RECEPTION_ENDPOINT_KINDS) {
      expect(typeof RECEPTION_KIND_TOKEN_MODE[ek]).toBe('string');
      expect(typeof RECEPTION_KIND_AUDIT_MODE[ek]).toBe('string');
    }
    expect(RECEPTION_PRIVACY_INVARIANT_LABELS.length).toBeGreaterThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════
// § A.20.1 — Reception Launch Wizard
// ════════════════════════════════════════════════════════════════

const goodReceptionPage: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Reach me here',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: [],
  },
  sections_enabled: {},
  linked_endpoints: {},
};

const goodScheduling: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};

const goodIntake: IntakeFormConfig = {
  display_name: 'Mary Smith',
  form_definition: {
    form_definition_id: 'fd_client_inquiry_v1',
    fields: [{ name: 'your_name', type: 'text', label: 'Your name', required: true }],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

const goodDrop: DropLinkConfig = {
  display_name: 'Mary Smith',
  link_kind: 'repeated',
  size_cap_bytes: 10 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: { name: 'required', email: 'required', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
};

const goodWizardInput = (over: Partial<LaunchWizardInput> = {}): LaunchWizardInput => ({
  current_exposure_profile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  reception_page: goodReceptionPage,
  scheduling_link: goodScheduling,
  intake_form: goodIntake,
  ...over,
});

describe('D-149 P12 § A.20.1 — validateLaunchWizardInput', () => {
  it('accepts a valid input (no drop link)', () => {
    expect(validateLaunchWizardInput(goodWizardInput())).toEqual([]);
  });

  it('accepts a valid input with the optional drop link', () => {
    expect(validateLaunchWizardInput(goodWizardInput({ drop_link: goodDrop }))).toEqual([]);
  });

  it('rejects a non-object input', () => {
    expect(validateLaunchWizardInput(null)[0]?.code).toBe('input_shape_invalid');
  });

  it('a malformed reception_page returns a structured failure, never throws (Codex P2 fold)', () => {
    // `{}` is object-shaped but missing display_overrides / sections_enabled
    // / linked_endpoints — `validateReceptionPageConfig` would dereference
    // those + throw; the wizard validator must return a failure instead.
    const partial = validateLaunchWizardInput({ ...goodWizardInput(), reception_page: {} });
    expect(partial.some((f) => f.code === 'reception_page_invalid' && f.step === 'reception_page')).toBe(
      true,
    );
    // a non-object reception_page is also a structured failure, not a throw.
    const nonObject = validateLaunchWizardInput({
      ...goodWizardInput(),
      reception_page: 'nope',
    });
    expect(nonObject.some((f) => f.code === 'reception_page_invalid')).toBe(true);
  });

  it('delegates to per-kind validators + tags the owning step', () => {
    const bad = goodWizardInput({
      scheduling_link: { ...goodScheduling, display_name: '' },
    });
    const failures = validateLaunchWizardInput(bad);
    expect(failures.some((f) => f.code === 'scheduling_link_invalid' && f.step === 'scheduling_link')).toBe(
      true,
    );
  });

  it('only validates the drop link when it is present', () => {
    const badDrop = goodWizardInput({
      drop_link: { ...goodDrop, expiry_days: 999 },
    });
    const failures = validateLaunchWizardInput(badDrop);
    expect(failures.some((f) => f.code === 'drop_link_invalid' && f.step === 'drop_link')).toBe(true);
  });
});

describe('D-149 P12 § A.20.1 — buildLaunchWizardPlan', () => {
  it('flags profile_switch_needed when not on the recommended profile', () => {
    const plan = buildLaunchWizardPlan(
      goodWizardInput({ current_exposure_profile: 'lan_only' }),
      NOW,
    );
    expect(plan.profile_switch_needed).toBe(true);
    expect(plan.recommended_exposure_profile).toBe(RECEPTION_RECOMMENDED_EXPOSURE_PROFILE);
  });

  it('does not flag a switch when already on the recommended profile', () => {
    expect(buildLaunchWizardPlan(goodWizardInput(), NOW).profile_switch_needed).toBe(false);
  });

  it('provisions 3 endpoints (page + scheduling + intake) without the optional drop link', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput(), NOW);
    expect(plan.endpoint_count).toBe(3);
    expect(plan.endpoint_drafts.map((d) => d.kind)).toEqual([
      'scheduling_link',
      'intake_form',
    ]);
  });

  it('provisions 4 endpoints when the optional drop link is included', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput({ drop_link: goodDrop }), NOW);
    expect(plan.endpoint_count).toBe(4);
    expect(plan.endpoint_drafts.map((d) => d.kind)).toEqual([
      'scheduling_link',
      'intake_form',
      'drop_link',
    ]);
  });

  it('the scheduling + intake drafts are long-lived (expires_at omitted)', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput(), NOW);
    expect(plan.endpoint_drafts[0]!.expires_at).toBeUndefined();
    expect(plan.endpoint_drafts[1]!.expires_at).toBeUndefined();
  });

  it('the drop_link draft carries an explicit expires_at derived from expiry_days', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput({ drop_link: goodDrop }), NOW);
    const dropDraft = plan.endpoint_drafts.find((d) => d.kind === 'drop_link')!;
    expect(dropDraft.expires_at).toBe(NOW + goodDrop.expiry_days * DAY);
  });

  it('the intake draft pulls its form_definition_id from the resolved config', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput(), NOW);
    const intakeDraft = plan.endpoint_drafts.find((d) => d.kind === 'intake_form')!;
    expect(intakeDraft.packet_declaration.source_query_ref).toEqual({
      kind: 'reception_form_definition',
      form_definition_id: 'fd_client_inquiry_v1',
    });
  });

  it('the drop draft uses the substrate-owned drop_config_id', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput({ drop_link: goodDrop }), NOW);
    const dropDraft = plan.endpoint_drafts.find((d) => d.kind === 'drop_link')!;
    expect(dropDraft.packet_declaration.source_query_ref).toEqual({
      kind: 'reception_drop_config',
      drop_config_id: LAUNCH_WIZARD_DROP_CONFIG_ID,
    });
  });

  it('the page upsert carries the reception_page config', () => {
    const plan = buildLaunchWizardPlan(goodWizardInput(), NOW);
    expect(plan.page_upsert.config).toEqual(goodReceptionPage);
  });

  it('launch-wizard step closed list ratchet', () => {
    expect(LAUNCH_WIZARD_STEPS).toEqual([
      'profile_check',
      'reception_page',
      'scheduling_link',
      'intake_form',
      'drop_link',
      'view_as_visitor',
      'share',
    ]);
    expect(LAUNCH_WIZARD_STEP_SET.size).toBe(LAUNCH_WIZARD_STEPS.length);
  });
});
