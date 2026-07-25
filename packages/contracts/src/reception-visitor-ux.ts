/** D-149 P12 § A.20 — visitor-facing UX features (Pass-2 additions).
 *
 *  Beyond the per-kind endpoint machinery (P4-P9) + the template pack
 *  (P11), D-149 ships seven user-experience features that operationalise
 *  the privacy + trust contracts. P12 is the substrate layer for all
 *  seven — pure, I/O-free shapes + builders the Settings UX (deferred,
 *  consistent with how P4-P11 deferred their Settings UX) renders, plus
 *  the Abuse Inbox aggregation + IP-block-list contract the backend
 *  store / rpc / listener-enforcement leg (in `backend/server/`) wires.
 *
 *  Seven features, seven sections in this file:
 *
 *    § A.20.1 — Reception Launch Wizard       → buildLaunchWizardPlan
 *    § A.20.2 — View-As-Visitor Preview       → buildViewAsVisitorPanel
 *    § A.20.3 — Visitor Receipt               → buildVisitorReceipt
 *    § A.20.4 — Endpoint Share Cards          → buildShareCards
 *    § A.20.5 — Abuse Inbox                   → buildAbuseInbox
 *    § A.20.6 — Per-Endpoint Safety Labels    → buildSafetyLabels
 *    § A.20.7 — Public Trust Footer           → buildTrustFooter
 *
 *  Everything here is a pure function or a closed-list shape — no I/O,
 *  no substrate state. The backend's `reception-rpc-handler.ts` wires
 *  `buildViewAsVisitorPanel` into `reception.endpoint.preview_draft` +
 *  the `reception.abuse_inbox.*` rpc trio over `buildAbuseInbox` + the
 *  `reception_ip_block_list` store; the visitor renderers' integration
 *  of the footer / labels / receipt is follow-on UI work.
 *
 *  Spec: docs/d-149-spec.md § A.20.1-A.20.7 + § N.7 (MUST list). */

import type { ReceptionEndpointKind } from './reception.js';
import {
  PACKET_FIELDS_VISIBLE,
  type RedactedPacketKind,
} from './redacted-packets.js';
import {
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_PER_KIND_EXPIRY_MAX_MS,
  type AccessLogEntry,
  type PacketDeclaration,
  type ReceptionEndpointPreviewInput,
} from './reception-registry.js';
import {
  validateReceptionPageConfig,
  type ReceptionPageConfig,
  type ReceptionPageUpsertInput,
} from './reception-page-config.js';
import {
  validateSchedulingLinkConfig,
  type SchedulingLinkConfig,
} from './scheduling-link-config.js';
import {
  validateIntakeFormConfig,
  type IntakeFormConfig,
} from './intake-form-config.js';
import {
  validateDropLinkConfig,
  type DropLinkConfig,
} from './drop-link-config.js';
import {
  VISITOR_RECEIPT_DEFAULT_VIA,
  type VisitorReceiptConfig,
  type VisitorReceiptVia,
} from './visitor-receipt-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════
// § A.20.7 — Public Trust Footer
// ════════════════════════════════════════════════════════════════

/** Deployment mode drives which trust-footer copy renders. `pro_cloud`
 *  (auto-managed `<handle>.recued.cloud` + ACME-DNS-01) names the cloud
 *  DNS relay; `byo_ddns` (BYO DDNS + own certbot) omits the relay
 *  reference entirely — there genuinely is no third party. */
export type TrustFooterDeploymentMode = 'byo_ddns' | 'pro_cloud';

export const TRUST_FOOTER_DEPLOYMENT_MODES: ReadonlyArray<TrustFooterDeploymentMode> = [
  'byo_ddns',
  'pro_cloud',
] as const;

export const TRUST_FOOTER_DEPLOYMENT_MODE_SET: ReadonlySet<TrustFooterDeploymentMode> = new Set(
  TRUST_FOOTER_DEPLOYMENT_MODES,
);

export interface TrustFooterInput {
  /** Per-server toggle. Default-on (§ A.20.7) — the substrate treats an
   *  absent toggle as `true`; the caller passes the resolved boolean. */
  readonly enabled: boolean;
  readonly deployment_mode: TrustFooterDeploymentMode;
}

/** Build the Public Trust Footer string. Returns `null` when the toggle
 *  is off — the renderer emits no footer. The text body is FULLY
 *  substrate-fixed (§ A.20.7: "not user-customizable text body; user
 *  toggles on/off only") — nothing is interpolated, so there is no
 *  injection surface and the privacy claim reads correctly for every
 *  reception kind (the earlier per-endpoint `display_name` interpolation
 *  produced nonsense like "served directly by Send me a document's
 *  server" on purpose-named links). Pure function — no I/O. */
export const buildTrustFooter = (input: TrustFooterInput): string | null => {
  if (input.enabled !== true) return null;
  const lead =
    "This page is served directly by this user's own Recued server — your data and uploads stay on it.";
  const tail =
    input.deployment_mode === 'pro_cloud'
      ? 'Recued cloud only relays the DNS record.'
      : 'No third-party services involved.';
  return `${lead} ${tail}`;
};

// ════════════════════════════════════════════════════════════════
// § A.20.6 — Per-Endpoint Safety Labels
// ════════════════════════════════════════════════════════════════

/** Closed list of safety-label kinds. Adding a label = a substrate code
 *  change here (NOT config). Emoji + text are substrate-fixed. */
export type SafetyLabelKind =
  | 'public_url'
  | 'expires_in'
  | 'read_only'
  | 'single_use'
  | 'file_upload'
  | 'pii_collected';

export const SAFETY_LABEL_KINDS: ReadonlyArray<SafetyLabelKind> = [
  'public_url',
  'expires_in',
  'read_only',
  'single_use',
  'file_upload',
  'pii_collected',
] as const;

export const SAFETY_LABEL_KIND_SET: ReadonlySet<SafetyLabelKind> = new Set(SAFETY_LABEL_KINDS);

export interface SafetyLabel {
  readonly kind: SafetyLabelKind;
  readonly emoji: string;
  readonly text: string;
}

/** Substrate-fixed emoji per label kind (§ A.20.6). */
export const SAFETY_LABEL_EMOJI: Readonly<Record<SafetyLabelKind, string>> = {
  public_url: '🌐',
  expires_in: '⏱',
  read_only: '👁',
  single_use: '🔒',
  file_upload: '📎',
  pii_collected: '📝',
} as const;

export interface SafetyLabelsInput {
  readonly kind: ReceptionEndpointKind;
  /** Unix-ms; `null` ⇒ long-lived (no `expires_in` label). */
  readonly expires_at: number | null;
  readonly now: number;
  /** Minimal per-kind config view. Only the fields the label logic
   *  reads — `link_kind` (drop_link single-use) + `required_visitor_fields.email`
   *  (intake_form / scheduling_link PII). Absent ⇒ the label that would
   *  depend on it is omitted. */
  readonly config?: {
    readonly link_kind?: 'one_time' | 'repeated';
    readonly required_visitor_fields?: { readonly email?: 'required' | 'optional' | 'omit' };
  };
}

/** Compute the per-endpoint safety labels (§ A.20.6). Labels reduce
 *  accidental over-sharing — the user sees at a glance that "this link
 *  collects PII" or "this link is single-use" before sharing. Pure
 *  function — no I/O. Order is stable: the closed-list order in
 *  `SAFETY_LABEL_KINDS`. */
export const buildSafetyLabels = (input: SafetyLabelsInput): ReadonlyArray<SafetyLabel> => {
  const labels: SafetyLabel[] = [];
  const push = (kind: SafetyLabelKind, text: string): void => {
    labels.push({ kind, emoji: SAFETY_LABEL_EMOJI[kind], text });
  };

  // 🌐 Public URL — every reception endpoint kind is URL-reachable by
  // anonymous visitors (the singleton at `/reception/`, the rest at
  // `/reception/<kind>/<id>?t=...`).
  push('public_url', 'Public URL');

  // ⏱ Expires in N days — only when the endpoint carries a bounded
  // expiry. Long-lived (`expires_at === null`) endpoints get no label
  // (the absence is itself the signal in the Settings list view).
  if (input.expires_at !== null) {
    const remaining_ms = input.expires_at - input.now;
    const days = Math.max(0, Math.ceil(remaining_ms / DAY_MS));
    push('expires_in', `Expires in ${days} ${days === 1 ? 'day' : 'days'}`);
  }

  // 👁 Read-only — status_link is a pure read projection (GET-only).
  if (input.kind === 'status_link') {
    push('read_only', 'Read-only');
  }

  // 🔒 Single-use — approval_link is single-use by construction; a
  // drop_link with `link_kind: 'one_time'` is single-use too.
  if (input.kind === 'approval_link') {
    push('single_use', 'Single-use');
  } else if (input.kind === 'drop_link' && input.config?.link_kind === 'one_time') {
    push('single_use', 'Single-use');
  }

  // 📎 File upload — drop_link accepts file uploads.
  if (input.kind === 'drop_link') {
    push('file_upload', 'File upload');
  }

  // 📝 PII collected — intake_form always collects visitor input;
  // scheduling_link collects PII when it asks for an email
  // (`required_visitor_fields.email !== 'omit'`).
  if (input.kind === 'intake_form') {
    push('pii_collected', 'PII collected');
  } else if (
    input.kind === 'scheduling_link' &&
    input.config?.required_visitor_fields?.email !== undefined &&
    input.config.required_visitor_fields.email !== 'omit'
  ) {
    push('pii_collected', 'PII collected');
  }

  return labels;
};

// ════════════════════════════════════════════════════════════════
// § A.20.4 — Endpoint Share Cards
// ════════════════════════════════════════════════════════════════

/** Closed list of share-card channels. Each renders a different snippet
 *  shape: email is long-form (title + description + URL + expiry), SMS
 *  is terse (short description + URL), Slack is markdown with a
 *  blockquote. */
export type ShareCardChannel = 'email' | 'sms' | 'slack';

export const SHARE_CARD_CHANNELS: ReadonlyArray<ShareCardChannel> = [
  'email',
  'sms',
  'slack',
] as const;

export const SHARE_CARD_CHANNEL_SET: ReadonlySet<ShareCardChannel> = new Set(SHARE_CARD_CHANNELS);

export interface ShareCard {
  readonly channel: ShareCardChannel;
  readonly snippet: string;
}

export interface ShareCardsInput {
  /** Pre-assembled visitor-facing share URL (the `share_url_once` the
   *  create / rotate rpc returned, or — for the singleton — the bare
   *  `/reception/` URL). The substrate never re-mints a secret here. */
  readonly share_url: string;
  /** Short human title — "Schedule a 30-min meeting with Alice". */
  readonly title: string;
  /** One-line description for the email / Slack long form. */
  readonly description: string;
  /** Optional expiry note — "Expires in 90 days". Omitted ⇒ no expiry
   *  line in any channel. */
  readonly expiry_note?: string;
}

/** Build the per-channel share-card snippets (§ A.20.4). Reduces
 *  friction for the most common Reception use case — sending the link.
 *  Pure function — no I/O. Returns one snippet per `SHARE_CARD_CHANNELS`
 *  entry, in closed-list order. */
export const buildShareCards = (input: ShareCardsInput): ReadonlyArray<ShareCard> => {
  const title = input.title.trim();
  const description = input.description.trim();
  const expiry = input.expiry_note?.trim();
  const url = input.share_url.trim();

  // email — long-form: title line, description line, URL line, then the
  // optional expiry line.
  const emailParts = [title, description, url];
  if (expiry) emailParts.push(expiry);
  const email = emailParts.filter((p) => p.length > 0).join('\n');

  // sms — terse: description + URL on one line (SMS has no formatting +
  // a tight length budget; the title is folded into the description by
  // the caller for SMS, so we lead with description).
  const smsLead = description.length > 0 ? description : title;
  const sms = smsLead.length > 0 ? `${smsLead} ${url}` : url;

  // slack — markdown: bold title, blockquoted description, URL on its
  // own line, optional italic expiry note.
  const slackParts = [`*${title}*`, `> ${description}`, url];
  if (expiry) slackParts.push(`_${expiry}_`);
  const slack = slackParts.filter((p) => p.trim().length > 0 && p.trim() !== '>').join('\n');

  return [
    { channel: 'email', snippet: email },
    { channel: 'sms', snippet: sms },
    { channel: 'slack', snippet: slack },
  ];
};

// ════════════════════════════════════════════════════════════════
// § A.20.5 — Abuse Inbox
// ════════════════════════════════════════════════════════════════

/** Closed list of abuse-signal kinds (§ A.20.5). Each maps from an
 *  operational-access-log `outcome` (+ optional `metadata.rejection_reason`).
 *  Operationalises the threat model (§ A.11) instead of leaving it
 *  test-only. */
export type AbuseInboxSignalKind =
  | 'spam_burst'
  | 'mime_rejection'
  | 'invalid_token_burst'
  | 'endpoint_ddos'
  | 'oversized_upload'
  | 'suspicious_payload';

export const ABUSE_INBOX_SIGNAL_KINDS: ReadonlyArray<AbuseInboxSignalKind> = [
  'spam_burst',
  'mime_rejection',
  'invalid_token_burst',
  'endpoint_ddos',
  'oversized_upload',
  'suspicious_payload',
] as const;

export const ABUSE_INBOX_SIGNAL_KIND_SET: ReadonlySet<AbuseInboxSignalKind> = new Set(
  ABUSE_INBOX_SIGNAL_KINDS,
);

/** Default cluster threshold — a `(signal_kind, endpoint_id, source_ip_hash)`
 *  group surfaces as an Abuse Inbox row only once it reaches this many
 *  events. Single drive-by hits are noise; a cluster is a signal. */
export const ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD = 3;

/** Default lookback window for `reception.abuse_inbox.list` — 7 days.
 *  The operational access log carries a 90d retention ceiling; the
 *  Abuse Inbox surfaces the recent slice. */
export const ABUSE_INBOX_DEFAULT_WINDOW_MS = 7 * DAY_MS;

/** The `metadata.rejection_reason` value the path-listener writes on a
 *  request rejected because the `(endpoint_id, source_ip_hash)` pair is
 *  on the IP block list. `classifyAbuseSignal` treats it as a
 *  non-signal — the operator already actioned this IP, so the request
 *  stays in the operational log for forensics but is NOT re-clustered
 *  as a fresh Abuse Inbox row. */
export const RECEPTION_IP_BLOCKED_REJECTION_REASON = 'ip_blocked' as const;

/** Delimiter for the composite Abuse Inbox group / block-list keys — a
 *  pipe. Chosen over a NUL byte (Codex P3 fold — a raw NUL in the
 *  source makes this `.ts` file binary to `grep` + other text tooling).
 *  A pipe can never appear in an `endpoint_id` (UUID hex / the literal
 *  `__reception_page__`), a `source_ip_hash` (base64url), or a
 *  `signal_kind` (lowercase identifier), so the two/three key segments
 *  can never collide. */
export const ABUSE_INBOX_KEY_DELIMITER = '|';

/** Canonical block-list key — `(endpoint_id, source_ip_hash)` joined by
 *  `ABUSE_INBOX_KEY_DELIMITER`. The backend `reception_ip_block_list`
 *  store + the listener-enforcement path both build keys through this
 *  helper so the membership test stays consistent end-to-end. */
export const abuseInboxBlockKey = (endpoint_id: string, source_ip_hash: string): string =>
  `${endpoint_id}${ABUSE_INBOX_KEY_DELIMITER}${source_ip_hash}`;

/** Classify a single operational-access-log entry into an abuse-signal
 *  kind, or `null` when the entry is not suspicious (`ok` / `expired` /
 *  `revoked` — normal lifecycle, not abuse). The `rejected` outcome
 *  fans out by `metadata.rejection_reason` when present: a reason
 *  carrying `mime` → MIME rejection; `size` / `oversize` → oversized
 *  upload; anything else (or no reason) → suspicious payload (the
 *  catch-all that covers the XSS-flagged-at-sanitisation case). Pure
 *  function — no I/O. */
export const classifyAbuseSignal = (entry: AccessLogEntry): AbuseInboxSignalKind | null => {
  switch (entry.outcome) {
    case 'rate_limited':
      return 'spam_burst';
    case 'capacity_full':
      return 'endpoint_ddos';
    case 'invalid_token':
      return 'invalid_token_burst';
    case 'rejected': {
      const reasonRaw = (entry.metadata as { rejection_reason?: unknown }).rejection_reason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw.toLowerCase() : '';
      // A request from an already-banned IP is not a NEW signal — the
      // operator actioned it; the row stays in the operational log for
      // forensics but the Abuse Inbox surfaces only actionable clusters.
      if (reason.includes(RECEPTION_IP_BLOCKED_REJECTION_REASON)) return null;
      if (reason.includes('mime')) return 'mime_rejection';
      if (reason.includes('size') || reason.includes('oversize')) return 'oversized_upload';
      return 'suspicious_payload';
    }
    default:
      // 'ok' / 'expired' / 'revoked' — not abuse signals.
      return null;
  }
};

/** One aggregated Abuse Inbox row — a `(signal_kind, endpoint_id,
 *  source_ip_hash)` cluster that reached the threshold. */
export interface AbuseInboxRow {
  readonly signal_kind: AbuseInboxSignalKind;
  readonly endpoint_id: string;
  /** Endpoint-scoped HKDF source-IP hash (§ Must Hold I-9 — the
   *  operational access log stores the endpoint-scoped hash by default,
   *  so the cluster is intrinsically per-endpoint; cross-endpoint
   *  correlation is impossible without the explicit opt-in). */
  readonly source_ip_hash: string;
  readonly event_count: number;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  /** Whether `(endpoint_id, source_ip_hash)` is on the per-server IP
   *  block list — drives the "Banned" badge + the ban/unban toggle in
   *  the Abuse Inbox UX. */
  readonly ip_blocked: boolean;
}

export interface AbuseInboxSummary {
  readonly rows: ReadonlyArray<AbuseInboxRow>;
  /** Total clusters surfaced (= `rows.length`; mirrored for the UX
   *  header without a second walk). */
  readonly total_signals: number;
  readonly window_start_at: number;
  readonly window_end_at: number;
  /** The cluster threshold this summary was built with — surfaced so
   *  the UX can explain "showing clusters of ≥ N". */
  readonly cluster_threshold: number;
}

export interface AbuseInboxInput {
  /** Operational-access-log entries in the lookback window. The caller
   *  (`reception.abuse_inbox.list`) reads these server-wide from
   *  `public_endpoint_access_log`. */
  readonly entries: ReadonlyArray<AccessLogEntry>;
  /** `(endpoint_id, source_ip_hash)` pairs currently on the per-server
   *  block list — encoded via `abuseInboxBlockKey` so the membership
   *  test is a single Set lookup. */
  readonly blocked_keys: ReadonlySet<string>;
  readonly window_start_at: number;
  readonly window_end_at: number;
  /** Cluster threshold; defaults to `ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD`. */
  readonly cluster_threshold?: number;
}

/** Aggregate operational-access-log entries into the Abuse Inbox
 *  summary (§ A.20.5). Groups by `(signal_kind, endpoint_id,
 *  source_ip_hash)`, drops entries with a `null` source-IP hash
 *  (internal probes — not abuse), and surfaces only clusters that reach
 *  `cluster_threshold`. Rows sort by `last_seen_at` descending (most
 *  recent abuse first). Pure function — no I/O. */
export const buildAbuseInbox = (input: AbuseInboxInput): AbuseInboxSummary => {
  const threshold =
    typeof input.cluster_threshold === 'number' && input.cluster_threshold >= 1
      ? Math.floor(input.cluster_threshold)
      : ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD;

  // Group key: signal_kind ∥ endpoint_id ∥ source_ip_hash, joined by
  // `ABUSE_INBOX_KEY_DELIMITER` (the pipe collision-proof separator).
  const groups = new Map<
    string,
    {
      signal_kind: AbuseInboxSignalKind;
      endpoint_id: string;
      source_ip_hash: string;
      event_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }
  >();

  for (const entry of input.entries) {
    if (entry.source_ip_hash === null) continue; // internal probe — skip
    const signal_kind = classifyAbuseSignal(entry);
    if (signal_kind === null) continue; // not an abuse signal
    const key = `${signal_kind}${ABUSE_INBOX_KEY_DELIMITER}${entry.endpoint_id}${ABUSE_INBOX_KEY_DELIMITER}${entry.source_ip_hash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.event_count += 1;
      if (entry.accessed_at < existing.first_seen_at) existing.first_seen_at = entry.accessed_at;
      if (entry.accessed_at > existing.last_seen_at) existing.last_seen_at = entry.accessed_at;
    } else {
      groups.set(key, {
        signal_kind,
        endpoint_id: entry.endpoint_id,
        source_ip_hash: entry.source_ip_hash,
        event_count: 1,
        first_seen_at: entry.accessed_at,
        last_seen_at: entry.accessed_at,
      });
    }
  }

  const rows: AbuseInboxRow[] = [];
  for (const g of groups.values()) {
    if (g.event_count < threshold) continue;
    rows.push({
      signal_kind: g.signal_kind,
      endpoint_id: g.endpoint_id,
      source_ip_hash: g.source_ip_hash,
      event_count: g.event_count,
      first_seen_at: g.first_seen_at,
      last_seen_at: g.last_seen_at,
      ip_blocked: input.blocked_keys.has(abuseInboxBlockKey(g.endpoint_id, g.source_ip_hash)),
    });
  }
  // Most-recent abuse first; tiebreak on event_count desc for a stable
  // order when two clusters share a last_seen_at.
  rows.sort((a, b) =>
    b.last_seen_at !== a.last_seen_at
      ? b.last_seen_at - a.last_seen_at
      : b.event_count - a.event_count,
  );

  return {
    rows,
    total_signals: rows.length,
    window_start_at: input.window_start_at,
    window_end_at: input.window_end_at,
    cluster_threshold: threshold,
  };
};

// ════════════════════════════════════════════════════════════════
// § A.20.3 — Visitor Receipt
// ════════════════════════════════════════════════════════════════
//
// The config-side half — `VisitorReceiptVia`, `VisitorReceiptConfig`,
// `validateVisitorReceiptConfig` — lives in `visitor-receipt-config.ts`
// so the four per-kind config contracts can carry an optional
// `visitor_receipt?` field without an import cycle back through this
// file. The "built receipt" half stays here.

/** One echoed field on the receipt — the visitor-submitted label +
 *  value. The caller is responsible for having already redacted any
 *  field the substrate would not echo back; the receipt is a verbatim
 *  echo of what the visitor themselves typed. */
export interface VisitorReceiptFieldEcho {
  readonly label: string;
  readonly value: string;
}

export interface VisitorReceipt {
  /** Opaque reference id the visitor can quote — surfaced so a
   *  follow-up ("did you get my submission, ref ABC?") is answerable. */
  readonly reference_id: string;
  readonly submitted_at: number;
  readonly endpoint_kind: ReceptionEndpointKind;
  /** Verbatim echo of the visitor-submitted fields ("what was shared"). */
  readonly fields_echo: ReadonlyArray<VisitorReceiptFieldEcho>;
  /** Recued's Public Trust Footer (§ A.20.7) — `null` when the footer
   *  toggle is off. Reinforces the privacy thesis at the receipt layer. */
  readonly privacy_footer: string | null;
  /** Resolved delivery mode — `config.via` when set, else
   *  `VISITOR_RECEIPT_DEFAULT_VIA` ('page'). */
  readonly via: VisitorReceiptVia;
}

export interface VisitorReceiptInput {
  readonly reference_id: string;
  readonly submitted_at: number;
  readonly endpoint_kind: ReceptionEndpointKind;
  readonly fields_echo: ReadonlyArray<VisitorReceiptFieldEcho>;
  readonly config: VisitorReceiptConfig;
  /** Pre-built trust footer (from `buildTrustFooter`) — `null` when the
   *  footer is disabled server-wide. */
  readonly privacy_footer: string | null;
}

/** Build a Visitor Receipt (§ A.20.3) — "Submitted at X, reference ID
 *  Y, what was shared: Z." Builds trust + reduces duplicate submissions
 *  (the visitor knows the submission landed). Returns `null` when the
 *  per-endpoint config has receipts disabled. An omitted `config.via`
 *  resolves to `VISITOR_RECEIPT_DEFAULT_VIA`. Pure function — no I/O. */
export const buildVisitorReceipt = (input: VisitorReceiptInput): VisitorReceipt | null => {
  if (input.config.enabled !== true) return null;
  return {
    reference_id: input.reference_id,
    submitted_at: input.submitted_at,
    endpoint_kind: input.endpoint_kind,
    fields_echo: input.fields_echo.map((f) => ({ label: f.label, value: f.value })),
    privacy_footer: input.privacy_footer,
    via: input.config.via ?? VISITOR_RECEIPT_DEFAULT_VIA,
  };
};

// ════════════════════════════════════════════════════════════════
// § A.20.2 — View-As-Visitor Preview
// ════════════════════════════════════════════════════════════════

/** Per-packet-kind stripped-field rationale map (§ A.20.2 "Fields
 *  stripped at boundary — with rationale per packet kind"). Each entry
 *  is a field the substrate's `redacted_packet` boundary strips from
 *  the raw source before the visitor payload is built, paired with the
 *  human rationale the View-As-Visitor panel surfaces. The visible side
 *  is `PACKET_FIELDS_VISIBLE` (the closed allowlist); this is the
 *  legible "and here's what does NOT cross the boundary, and why" side.
 *
 *  Adding a stripped field = a substrate code change here — the privacy
 *  contract stays legible by reading these two maps side by side. */
export const PACKET_STRIPPED_FIELDS_RATIONALE: Readonly<
  Record<RedactedPacketKind, Readonly<Record<string, string>>>
> = {
  // D-145 S2S Preview originals — reception does not author these
  // packet kinds, but the map is total over `RedactedPacketKind` so a
  // future reception consumer of an S2S kind still gets a panel.
  availability: {
    raw_calendar_events: 'Calendar event titles / attendees / agendas never cross the boundary — only computed free windows.',
  },
  project_status: {
    commitments: 'Individual commitment rows stay server-side — only aggregate counts surface.',
  },
  commitment_summary: {
    raw_commitments: 'Per-commitment detail stays server-side — only direction + state counts surface.',
  },
  contact_card: {
    annotations: 'Contact annotations + the links graph stay server-side.',
  },
  event_plan: {
    hidden_attendees: 'Non-visible attendees + raw event metadata stay server-side.',
  },
  itinerary: {
    raw_legs: 'Booking codes / confirmation numbers on each leg are rebuilt from a closed shape — never surface.',
  },
  // ── D-149 reception kinds ──────────────────────────────────────────
  reception_page_packet: {
    linked_endpoints:
      'Endpoint ids stay server-internal — only the CTA href derives from the share URL.',
    sections_enabled:
      'Section toggles are server-side layout state, not visitor data.',
  },
  scheduling_link_packet: {
    raw_calendar_events:
      'Calendar event titles / attendees / agendas never cross the boundary — only computed free windows.',
    standing_instructions_ref:
      'Standing-instruction refs + auto-confirm routing stay server-side.',
    notification_target:
      'Notification routing (where the booking lands) stays server-side.',
  },
  intake_form_packet: {
    user_only_field_names:
      'User-only annotation fields never reach the visitor renderer (§ A.5.3).',
    submission_processing_rule:
      'Routing rule + target entity kind + triggered recipe stay server-side.',
    anti_spam:
      'Anti-spam config (honeypot field list, allowlist) stays server-side — only a rate-limit hint surfaces.',
  },
  drop_link_packet: {
    on_upload:
      'Upload routing (triggered recipe / project attach / notification) stays server-side.',
    contact_scoping:
      'Contact-scoping + the domain allowlist never surface.',
    storage_paths:
      'Content-hash-keyed storage paths + blob ids stay server-side.',
  },
  approval_link_packet: {
    counterparty_aliases:
      'Counterparty aliases are stripped at the context_raw → context_summary boundary.',
    private_notes:
      'Private notes are stripped at the context_raw → context_summary boundary.',
    on_action:
      'Target id + on_action callback config + triggered recipe stay server-side.',
  },
  status_link_packet: {
    source_entity_ref:
      'The source entity reference + raw timestamps stay server-side.',
    redacted_identifiers:
      'Booking codes / confirmation numbers / loyalty IDs / internal codenames are rebuilt from a closed shape — never surface.',
  },
} as const;

/** Per-endpoint-kind token presentation mode (§ A.18.3). The singleton
 *  `reception_page` is token-less (the bare `/reception/` path); every
 *  link-style kind carries the bearer as a `?t=` query parameter. */
export const RECEPTION_KIND_TOKEN_MODE: Readonly<Record<ReceptionEndpointKind, string>> = {
  reception_page: 'tokenless_singleton',
  scheduling_link: 'bearer_query_param',
  intake_form: 'bearer_query_param',
  drop_link: 'bearer_query_param',
  approval_link: 'bearer_query_param',
  status_link: 'bearer_query_param',
} as const;

/** Per-endpoint-kind audit-mode summary (§ A.16.5). Every kind writes
 *  the operational `public_endpoint_access_log` row per request; the
 *  label names the additional D-120 high-assurance signed event the
 *  kind emits (none for the read-only `status_link`). */
export const RECEPTION_KIND_AUDIT_MODE: Readonly<Record<ReceptionEndpointKind, string>> = {
  reception_page: 'operational_log + high_assurance_on_config_update',
  scheduling_link: 'operational_log + high_assurance_on_booking',
  intake_form: 'operational_log + high_assurance_on_submission',
  drop_link: 'operational_log + high_assurance_on_drop_receipt',
  approval_link: 'operational_log + high_assurance_on_consumption',
  status_link: 'operational_log_only',
} as const;

/** Closed list of the § N.7 MUST invariants the View-As-Visitor panel
 *  surfaces as a compliance checklist. Each label is a substrate-fixed
 *  string; `buildViewAsVisitorPanel` pairs each with a `satisfied`
 *  boolean (most are structurally true; the expiry-within-ceiling one
 *  is computed against the per-kind ceiling). */
export const RECEPTION_PRIVACY_INVARIANT_LABELS: ReadonlyArray<string> = [
  'Endpoint is default-off until explicitly enabled',
  'Only the closed fields_visible list crosses the boundary',
  'Expiry is within the per-kind ceiling',
  'Bearer token is HMAC-keyed and never re-readable',
  'Source IP is endpoint-scoped HKDF-hashed (no cross-endpoint tracking)',
  'No recipe content or visitor data is relayed through the cloud',
] as const;

export interface ViewAsVisitorFieldRow {
  readonly field: string;
  readonly visible: boolean;
  /** For visible fields: "exposed per the packet kind's fields_visible
   *  list". For stripped fields: the rationale from
   *  `PACKET_STRIPPED_FIELDS_RATIONALE`. */
  readonly rationale: string;
}

export interface ViewAsVisitorInvariantRow {
  readonly invariant: string;
  readonly satisfied: boolean;
}

export interface ViewAsVisitorPanel {
  /** Always `true` — the panel is a synthetic visitor session, never a
   *  real access-log entry (§ A.20.2). Flagged so any debug output that
   *  echoes the panel makes the synthetic origin unmistakable. */
  readonly synthetic: true;
  readonly endpoint_kind: ReceptionEndpointKind;
  readonly packet_kind: RedactedPacketKind;
  /** The closed list of fields the visitor sees (= `fields_visible_override`
   *  when the declaration clamps it, else `PACKET_FIELDS_VISIBLE[packet_kind]`). */
  readonly visible_fields: ReadonlyArray<string>;
  /** Per-field rows — visible fields first (in fields_visible order),
   *  then stripped fields (in `PACKET_STRIPPED_FIELDS_RATIONALE` order). */
  readonly field_rows: ReadonlyArray<ViewAsVisitorFieldRow>;
  readonly expiry_policy: {
    /** Human label for the default expiry posture. */
    readonly default_label: string;
    /** Human label for the per-kind ceiling. */
    readonly max_label: string;
    /** The endpoint's own `expires_at` (Unix-ms; `null` ⇒ long-lived). */
    readonly expires_at: number | null;
  };
  readonly token_mode: string;
  readonly audit_mode: string;
  readonly privacy_invariant_summary: ReadonlyArray<ViewAsVisitorInvariantRow>;
}

export interface ViewAsVisitorInput {
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  /** The endpoint's `expires_at` (Unix-ms; `null` ⇒ long-lived). For a
   *  not-yet-created draft the caller passes the proposed value. */
  readonly expires_at: number | null;
  readonly now: number;
}

const expiryCeilingLabel = (kind: ReceptionEndpointKind): string => {
  const ceiling = RECEPTION_PER_KIND_EXPIRY_MAX_MS[kind];
  if (ceiling === null) return 'long-lived permitted (substrate clamps any bounded expiry to 90 days)';
  const days = Math.round(ceiling / DAY_MS);
  return `${days}-day hard ceiling`;
};

/** Build the View-As-Visitor panel (§ A.20.2) — the load-bearing
 *  privacy-trust UX. The caller (`reception.endpoint.preview_draft`)
 *  surfaces this so the user reviews exactly what a visitor would see,
 *  what is stripped (and why), the expiry / token / audit posture, and
 *  the § N.7 MUST-invariant compliance summary BEFORE enabling an
 *  endpoint. Pure function — no I/O; `synthetic: true` is hard-coded so
 *  the panel can never be mistaken for a real visitor session. */
export const buildViewAsVisitorPanel = (input: ViewAsVisitorInput): ViewAsVisitorPanel => {
  const packet_kind = RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[input.kind];
  const visible_fields =
    input.packet_declaration.fields_visible_override ?? PACKET_FIELDS_VISIBLE[packet_kind];

  const field_rows: ViewAsVisitorFieldRow[] = [];
  for (const f of visible_fields) {
    field_rows.push({
      field: f,
      visible: true,
      rationale: "Exposed per the packet kind's fields_visible list.",
    });
  }
  const stripped = PACKET_STRIPPED_FIELDS_RATIONALE[packet_kind];
  for (const [field, rationale] of Object.entries(stripped)) {
    field_rows.push({ field, visible: false, rationale });
  }

  const ceiling = RECEPTION_PER_KIND_EXPIRY_MAX_MS[input.kind];
  // The expiry-within-ceiling invariant: long-lived is satisfied when
  // the kind permits it (`ceiling === null`); a bounded expiry is
  // satisfied when it does not exceed the kind's ceiling measured from
  // now.
  const expirySatisfied =
    input.expires_at === null
      ? ceiling === null
      : ceiling === null
        ? true
        : input.expires_at - input.now <= ceiling;

  const privacy_invariant_summary: ViewAsVisitorInvariantRow[] = RECEPTION_PRIVACY_INVARIANT_LABELS.map(
    (invariant) => {
      if (invariant === 'Expiry is within the per-kind ceiling') {
        return { invariant, satisfied: expirySatisfied };
      }
      if (invariant === 'Bearer token is HMAC-keyed and never re-readable') {
        // The singleton reception_page is token-less; the invariant is
        // vacuously satisfied (there is no token to leak).
        return { invariant, satisfied: true };
      }
      return { invariant, satisfied: true };
    },
  );

  return {
    synthetic: true,
    endpoint_kind: input.kind,
    packet_kind,
    visible_fields,
    field_rows,
    expiry_policy: {
      default_label:
        ceiling === null
          ? 'link-style 90-day default (long-lived permitted with explicit acknowledgement)'
          : 'link-style 7-day default',
      max_label: expiryCeilingLabel(input.kind),
      expires_at: input.expires_at,
    },
    token_mode: RECEPTION_KIND_TOKEN_MODE[input.kind],
    audit_mode: RECEPTION_KIND_AUDIT_MODE[input.kind],
    privacy_invariant_summary,
  };
};

// ════════════════════════════════════════════════════════════════
// § A.20.1 — Reception Launch Wizard
// ════════════════════════════════════════════════════════════════

/** Closed list of the seven Launch Wizard steps (§ A.20.1). The
 *  Settings UX renders the wizard chrome from this list; the substrate
 *  planner (`buildLaunchWizardPlan`) emits the actionable steps (the
 *  page upsert + the endpoint create-drafts) — `profile_check` /
 *  `view_as_visitor` / `share` are UI affordances surfaced by the other
 *  P12 builders, not plan rows. */
export type LaunchWizardStepId =
  | 'profile_check'
  | 'reception_page'
  | 'scheduling_link'
  | 'intake_form'
  | 'drop_link'
  | 'view_as_visitor'
  | 'share';

export const LAUNCH_WIZARD_STEPS: ReadonlyArray<LaunchWizardStepId> = [
  'profile_check',
  'reception_page',
  'scheduling_link',
  'intake_form',
  'drop_link',
  'view_as_visitor',
  'share',
] as const;

export const LAUNCH_WIZARD_STEP_SET: ReadonlySet<LaunchWizardStepId> = new Set(LAUNCH_WIZARD_STEPS);

/** The exposure profile the Launch Wizard's step-1 profile check
 *  recommends — § A.20.1 step 1: "if exposure profile is not
 *  `public_webhooks_and_clients`, prompt user to switch". */
export const RECEPTION_RECOMMENDED_EXPOSURE_PROFILE = 'public_webhooks_and_clients' as const;

/** A single endpoint create-intent the wizard plan emits — structurally
 *  a `reception.endpoint.preview_draft` / `.create` input minus the
 *  `preview_hash` the caller mints by running preview first. */
export interface LaunchWizardEndpointDraft {
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Omitted ⇒ long-lived (`scheduling_link` / `intake_form` permit
   *  `null` expiry); present ⇒ explicit bounded expiry (`drop_link`
   *  requires it — the planner derives it from the config's
   *  `expiry_days`). */
  readonly expires_at?: number;
}

/** The wizard's user-supplied answers — the per-kind configs the caller
 *  has already built from the wizard form (the reception_page config,
 *  the first scheduling link, the first intake form picked from the
 *  `client_inquiry` Foundation pack template, and the optional drop
 *  link). The planner's job is the orchestration: profile check + the
 *  ordered page-upsert-then-creates sequence — NOT re-building configs. */
export interface LaunchWizardInput {
  /** The server's current exposure profile id — the planner flags
   *  `profile_switch_needed` when it is not the recommended one. */
  readonly current_exposure_profile: string;
  readonly reception_page: ReceptionPageConfig;
  readonly scheduling_link: SchedulingLinkConfig;
  /** First intake form — wizard step 4 picks the `client_inquiry`
   *  Foundation pack template; the caller resolves it via
   *  `intakeFormConfigFromTemplate` and passes the resolved config. */
  readonly intake_form: IntakeFormConfig;
  /** Optional drop link (wizard step 5 — "send me a file"). Omitted
   *  when the user skips the optional step. */
  readonly drop_link?: DropLinkConfig;
}

export interface LaunchWizardPlan {
  readonly profile_switch_needed: boolean;
  readonly current_exposure_profile: string;
  readonly recommended_exposure_profile: string;
  /** `reception.page.upsert` input (wizard step 2). */
  readonly page_upsert: ReceptionPageUpsertInput;
  /** Ordered create-intents — `scheduling_link`, then `intake_form`,
   *  then `drop_link` when the optional step was included. Each is a
   *  valid `reception.endpoint.preview_draft` input shape; the caller
   *  runs preview → create per draft. */
  readonly endpoint_drafts: ReadonlyArray<LaunchWizardEndpointDraft>;
  /** Total endpoints the wizard provisions — the reception_page
   *  singleton (always) plus each draft. The § P12 acceptance ("creates
   *  3 endpoints") is page + scheduling + intake; the optional drop
   *  link makes it 4. */
  readonly endpoint_count: number;
}

export type LaunchWizardValidationCode =
  | 'input_shape_invalid'
  | 'reception_page_invalid'
  | 'scheduling_link_invalid'
  | 'intake_form_invalid'
  | 'drop_link_invalid';

export interface LaunchWizardValidationFailure {
  readonly code: LaunchWizardValidationCode;
  /** The wizard step the failure belongs to — drives the "fix step N"
   *  UX. */
  readonly step: LaunchWizardStepId;
  readonly detail: string;
}

/** Structural pre-check on the reception_page config blob. Mirrors the
 *  rpc handler's `parseAndValidatePageConfig` guard: `validateReceptionPageConfig`
 *  dereferences `config.display_overrides.*` / `.sections_enabled` /
 *  `.linked_endpoints` WITHOUT a null-guard, so a partial `{}` blob
 *  would make it throw. The wizard validator must return a structured
 *  failure, never throw (Codex P2 fold) — so it gates the three
 *  load-bearing sub-objects here before delegating. */
const receptionPageConfigShapeOk = (raw: unknown): raw is ReceptionPageConfig => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  const isObj = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
  return isObj(o.display_overrides) && isObj(o.sections_enabled) && isObj(o.linked_endpoints);
};

/** Validate a `LaunchWizardInput`. Delegates each per-kind config to
 *  the SAME validator the `reception.endpoint.create` rpc runs
 *  (`validateReceptionPageConfig` / `validateSchedulingLinkConfig` /
 *  `validateIntakeFormConfig` / `validateDropLinkConfig`), re-emitting
 *  the first failure per step tagged with the owning step — so "the
 *  wizard input validates clean" structurally implies "every endpoint
 *  the plan provisions validates clean". Pure function — no I/O; never
 *  throws (a malformed blob surfaces as a structured failure). */
export const validateLaunchWizardInput = (
  input: unknown,
): ReadonlyArray<LaunchWizardValidationFailure> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [
      {
        code: 'input_shape_invalid',
        step: 'profile_check',
        detail: 'launch wizard input must be an object',
      },
    ];
  }
  const i = input as Record<string, unknown>;
  const failures: LaunchWizardValidationFailure[] = [];

  if (typeof i.current_exposure_profile !== 'string' || i.current_exposure_profile.length === 0) {
    failures.push({
      code: 'input_shape_invalid',
      step: 'profile_check',
      detail: 'current_exposure_profile must be a non-empty string',
    });
  }

  // Codex P2 fold — `validateReceptionPageConfig` assumes its three
  // load-bearing sub-objects exist + dereferences them; gate the shape
  // structurally first so a partial / malformed `reception_page` blob
  // returns a `reception_page_invalid` failure instead of throwing.
  if (!receptionPageConfigShapeOk(i.reception_page)) {
    failures.push({
      code: 'reception_page_invalid',
      step: 'reception_page',
      detail:
        'reception_page config must be an object with display_overrides + sections_enabled + linked_endpoints objects',
    });
  } else {
    const pageFailures = validateReceptionPageConfig(i.reception_page);
    if (pageFailures.length > 0) {
      failures.push({
        code: 'reception_page_invalid',
        step: 'reception_page',
        detail: `${pageFailures[0]!.code} — ${pageFailures[0]!.detail}`,
      });
    }
  }

  const schedFailures = validateSchedulingLinkConfig(i.scheduling_link);
  if (schedFailures.length > 0) {
    failures.push({
      code: 'scheduling_link_invalid',
      step: 'scheduling_link',
      detail: `${schedFailures[0]!.code} — ${schedFailures[0]!.detail}`,
    });
  }

  const intakeFailures = validateIntakeFormConfig(i.intake_form);
  if (intakeFailures.length > 0) {
    failures.push({
      code: 'intake_form_invalid',
      step: 'intake_form',
      detail: `${intakeFailures[0]!.code} — ${intakeFailures[0]!.detail}`,
    });
  }

  // drop_link is the optional step — validate only when present.
  if (i.drop_link !== undefined) {
    const dropFailures = validateDropLinkConfig(i.drop_link);
    if (dropFailures.length > 0) {
      failures.push({
        code: 'drop_link_invalid',
        step: 'drop_link',
        detail: `${dropFailures[0]!.code} — ${dropFailures[0]!.detail}`,
      });
    }
  }

  return failures;
};

/** Opaque drop-config ref the wizard's drop_link `source_query_ref`
 *  carries. The drop_link handler reads its config from the registry
 *  row's `metadata_blob`, not from this ref — but the typed
 *  `source_query_ref` allowlist requires a `drop_config_id`, so the
 *  wizard supplies a stable substrate-owned value. */
export const LAUNCH_WIZARD_DROP_CONFIG_ID = 'launch_wizard_drop_link' as const;

/** Build the Launch Wizard plan (§ A.20.1) — the ordered sequence of
 *  substrate operations the wizard executes: the reception_page
 *  singleton upsert, then the scheduling_link + intake_form (+ optional
 *  drop_link) create-drafts. Each draft is a valid
 *  `reception.endpoint.preview_draft` input; the caller runs preview →
 *  create per draft so the under-10-minute onboarding goal in § DoD is
 *  one drivable plan. Pure function — no I/O; the caller is responsible
 *  for having validated the input via `validateLaunchWizardInput`. */
export const buildLaunchWizardPlan = (
  input: LaunchWizardInput,
  now: number,
): LaunchWizardPlan => {
  const profile_switch_needed =
    input.current_exposure_profile !== RECEPTION_RECOMMENDED_EXPOSURE_PROFILE;

  const page_upsert: ReceptionPageUpsertInput = { config: input.reception_page };

  const endpoint_drafts: LaunchWizardEndpointDraft[] = [];

  // Step 3 — first scheduling link. Long-lived permitted (ceiling null);
  // the planner omits expires_at so the endpoint is long-lived by
  // default (the user can shorten it later via reception.endpoint.extend).
  endpoint_drafts.push({
    kind: 'scheduling_link',
    packet_declaration: {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    },
    metadata: input.scheduling_link as unknown as Readonly<Record<string, unknown>>,
  });

  // Step 4 — first intake form. The form_definition_id comes straight
  // from the resolved IntakeFormConfig (the template conversion stamped
  // it); long-lived permitted, expires_at omitted.
  endpoint_drafts.push({
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: input.intake_form.form_definition.form_definition_id,
      },
    },
    metadata: input.intake_form as unknown as Readonly<Record<string, unknown>>,
  });

  // Step 5 — optional drop link. drop_link carries a 30-day hard
  // ceiling, so the planner MUST supply an explicit expires_at; it
  // derives it from the config's own `expiry_days` (validated ∈ [1,30]
  // by validateDropLinkConfig, so the value is always within ceiling).
  if (input.drop_link !== undefined) {
    endpoint_drafts.push({
      kind: 'drop_link',
      packet_declaration: {
        packet_kind: 'drop_link_packet',
        source_query_ref: {
          kind: 'reception_drop_config',
          drop_config_id: LAUNCH_WIZARD_DROP_CONFIG_ID,
        },
      },
      metadata: input.drop_link as unknown as Readonly<Record<string, unknown>>,
      expires_at: now + input.drop_link.expiry_days * DAY_MS,
    });
  }

  return {
    profile_switch_needed,
    current_exposure_profile: input.current_exposure_profile,
    recommended_exposure_profile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
    page_upsert,
    endpoint_drafts,
    // page singleton (always) + one per draft.
    endpoint_count: 1 + endpoint_drafts.length,
  };
};

/** Type-only re-export so callers that drive the wizard plan through
 *  the rpc surface can reference the preview-input shape the drafts are
 *  structurally compatible with. */
export type { ReceptionEndpointPreviewInput };
