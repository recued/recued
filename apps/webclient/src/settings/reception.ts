/** D-149 § A.9 + § A.20.6 — Settings → Server → Reception page renderer.
 *
 *  D-149 closed at P12 as substrate-only — every per-kind phase (P4-P9)
 *  + the visitor-UX phase (P12) deferred its Settings UX. This is the
 *  first Settings-side follow-on: the management *spine* of the § A.9
 *  Reception page — the list view + per-endpoint detail + lifecycle
 *  dispatch. The satellite surfaces (per-kind authoring forms, the
 *  Launch Wizard chrome, the View-As-Visitor panel render, the Abuse
 *  Inbox subview, the Templates browser) attach to this spine and land
 *  as their own follow-on units, consistent with how each phase
 *  deferred its UX.
 *
 *  Three surfaces share these helpers:
 *
 *    - **Reception list view** (Settings → Server → Reception) — the
 *      status header (serving / emergency-disabled / public-exposure
 *      posture + base URL) plus six per-kind sections, each listing its
 *      endpoints with status, § A.20.6 safety labels, audit count, and
 *      expiry. Zero enabled endpoints surfaces the Launch Wizard CTA
 *      (`is_first_run`).
 *    - **Per-endpoint detail** (Settings → Reception → `<endpoint>`) —
 *      the row projection plus the paginated access log (§ A.9 audit
 *      log surface — source-IP hash truncated to an 8-char prefix per
 *      § A.16.7), the distinct-source-IP-hash count, the packet
 *      declaration, and the § A.20.4 Share Cards when the caller still
 *      holds the (never re-readable) share URL from create / rotate
 *      time.
 *    - **Lifecycle controls** — enable / disable / revoke / extend /
 *      rotate-token / emergency-disable-all. The renderer never fires
 *      the rpc; the dispatch builders shape the payload + the page
 *      shell calls the `reception.*` rpc over the WS conn. Same
 *      separation as `buildExposurePageModel` / `buildPresetDispatch`.
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, never synthesizes. `buildReceptionPageModel` is a pure
 *  projection of the `reception.endpoints.list` result + a small
 *  out-of-band status context (the exposure resolution's `reception`
 *  bit + the resolved base URL); the page shell re-runs it after a
 *  `reception.endpoint_changed` broadcast by refetching
 *  `reception.endpoints.list` (the broadcast carries only
 *  `{ op, endpoint_id }`, never the row, so there is no single-row
 *  reducer — a full list refetch is the contract). The
 *  `reception.emergency_disabled` broadcast DOES carry enough to apply
 *  optimistically — `reduceReceptionEmergencyDisabled` does so.
 *
 *  Spec: D-149 § A.9 (Settings UX) + § A.16.7 (access-log
 *  truncation) + § A.20.4 (Share Cards) + § A.20.6 (Safety Labels). */

import {
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  buildSafetyLabels,
  buildShareCards,
  type AccessLogEntry,
  type EndpointSummary,
  type PacketDeclaration,
  type ReceptionAccessAction,
  type ReceptionAccessOutcome,
  type ReceptionEndpointKind,
  type ReceptionEndpointRotateReason,
  type ReceptionRpcErrorCode,
  type SafetyLabel,
  type SafetyLabelKind,
  type ShareCard,
  type ShareCardsInput,
} from '@recued/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** § A.16.7 source-IP-hash truncation length — the access-log surface
 *  shows an 8-char prefix + ellipsis (`ab12cd34…`) before reveal. § A.9
 *  mentions "6-char" in passing, but § A.16.7 ("Settings UX truncation")
 *  is the dedicated normative section + its worked example is exactly
 *  8 chars — 8 wins (it also halves default-display collisions for
 *  nearby hashes). */
export const RECEPTION_SOURCE_IP_HASH_PREFIX_LEN = 8;

// ════════════════════════════════════════════════════════════════
// Copy registries — closed-list kind / error / label / access copy.
// The renderer is the localization seam; the substrate never assembles
// user-facing strings.
// ════════════════════════════════════════════════════════════════

/** § A.9 — per-endpoint-kind user-facing copy. Keys the six list-view
 *  sections; `create_label` labels the section's "+ New" affordance
 *  (for `reception_page` the affordance is a one-time singleton setup,
 *  not a repeatable create — see `ReceptionKindSection.can_create`). */
export const RECEPTION_KIND_COPY: Readonly<
  Record<
    ReceptionEndpointKind,
    {
      section_label: string;
      singular: string;
      description: string;
      create_label: string;
    }
  >
> = {
  reception_page: {
    section_label: 'Reception page',
    singular: 'reception page',
    description:
      'Your front door at /reception/. It shows who you are, how to reach you, and buttons for what people can do. There is one per server. It needs no key and never runs out.',
    create_label: 'Set up Reception page',
  },
  scheduling_link: {
    section_label: 'Scheduling links',
    singular: 'scheduling link',
    description:
      'People pick a time from when you are free. When you say yes, it becomes a real booking with its own time and history.',
    create_label: 'New scheduling link',
  },
  intake_form: {
    section_label: 'Intake forms',
    singular: 'intake form',
    description:
      'Forms people fill in. Each answer you say yes to becomes something you can work through: a list, a task, a note, a booking, a calendar event, or a contact. Build your own, or start from a ready-made one.',
    create_label: 'New intake form',
  },
  drop_link: {
    section_label: 'Drop links',
    singular: 'drop link',
    description:
      'A “send me a file” link. Files go straight to your server, and only the kinds you allow. These links can never last more than 30 days.',
    create_label: 'New drop link',
  },
  approval_link: {
    section_label: 'Approval links',
    singular: 'approval link',
    description:
      'A link that works once, for one thing: pick a time, say yes to some wording, confirm you are coming, answer a question, or send a document. Once used, it is dead.',
    create_label: 'New approval link',
  },
  status_link: {
    section_label: 'Status pages',
    singular: 'status page',
    description:
      'A page people can look at to follow progress, with no account. They can only look, never change anything. These pages can never last more than 90 days.',
    create_label: 'New status page',
  },
};

/** Launch-prep availability seam. A kind is hidden from create/share
 *  while its public visitor reader is unwired (visitors would hit the
 *  fail-closed 503 path). D-173 P4.2 un-hid `scheduling_link`: bookings
 *  are now review-by-default proposals materialized as a local
 *  commitment held at the Reception Inbox (the cold-start null calendar
 *  reader is the correct posture — free/busy availability is out of
 *  scope per D7), so the visitor slot picker is served. `status_link`
 *  stays hidden until its projection/entity reader lands. */
export const UNAVAILABLE_RECEPTION_ENDPOINT_KINDS: ReadonlySet<ReceptionEndpointKind> =
  new Set(['status_link']);

export const isReceptionEndpointKindAvailable = (
  kind: ReceptionEndpointKind,
): boolean => !UNAVAILABLE_RECEPTION_ENDPOINT_KINDS.has(kind);

/** § A.9 — closed-list `ReceptionRpcErrorCode` → remediation copy. The
 *  Settings page surfaces this when a `reception.*` rpc round-trip
 *  fails. Mirrors `EXPOSURE_ERROR_COPY` in `exposure-surface.ts`. The
 *  per-kind `*_config_invalid` codes carry the inner validator's first
 *  failure code in the rpc detail message — the renderer appends it. */
export const RECEPTION_ERROR_COPY: Readonly<Record<ReceptionRpcErrorCode, string>> = {
  unknown_endpoint_kind: 'Recued does not know that kind of link. Load the page again and try once more.',
  unknown_packet_kind: 'Recued does not know that setting. Load the page again and try once more.',
  packet_kind_disallowed_for_endpoint_kind:
    'Those settings do not match that kind of link. Each kind goes with one set. Load the page again and try once more.',
  fields_visible_override_exceeds_ceiling:
    'You have picked more to show than this kind of link allows. Choose from the list in the preview.',
  fields_visible_unknown_field:
    'You have picked something this kind of link does not have. Choose from the list in the preview.',
  preview_hash_missing:
    'Look at this the way a visitor would before you make it. Use View as visitor first.',
  preview_hash_mismatch:
    'Something changed since you looked. Use View as visitor again, so you make exactly what you saw.',
  preview_hash_expired:
    'Your preview ran out after 10 minutes. Use View as visitor again, then make it.',
  expires_at_in_past: 'That date has already gone. Pick one in the future.',
  expires_at_exceeds_ceiling:
    'That is longer than this kind of link can last. File-drop and approval links last 30 days. Status pages last 90. Pick an earlier date.',
  long_lived_not_permitted_for_kind:
    'This kind of link cannot last forever. Give it an end date.',
  source_query_not_object: 'Recued could not read that. Load the page again and try once more.',
  source_query_unknown_kind: 'Recued does not know that kind. Load the page again and try once more.',
  source_query_missing_id_field:
    'That is missing an id. Load the page again and try once more.',
  source_query_disallowed_for_packet:
    'You cannot use that here. Load the page again and try once more.',
  endpoint_not_found:
    'That link is gone. Someone may have switched it off on another device. Load the list again.',
  endpoint_already_enabled: 'That link is already on. Load the list again.',
  endpoint_already_disabled: 'That link is already off. Load the list again.',
  endpoint_already_revoked:
    'That link is already switched off for good. You cannot bring it back. Make a new one.',
  endpoint_revoked_cannot_extend:
    'You cannot give a switched-off link longer. Make a new one.',
  transformation_unknown:
    'Recued does not know one of those settings. Load the page again and try once more.',
  allowed_action_unknown_for_kind:
    'This kind of link cannot do that. Load the page again and try once more.',
  reception_page_config_invalid:
    'Something on your Reception page is wrong. Check your details, the sections, and the links.',
  scheduling_link_config_invalid:
    'Something about your booking link is wrong. Check the meeting lengths and when you are free.',
  intake_form_config_invalid:
    'Something about your form is wrong. Check the boxes, and what happens when someone sends it.',
  drop_link_config_invalid:
    'Something about your file-drop link is wrong. Check which file kinds you allow, the size limit, and the end date.',
  approval_link_config_invalid:
    'Something about your approval link is wrong. Check what you are asking, and what you are showing.',
  status_link_config_invalid:
    'Something about your status page is wrong. Check what it is showing, and which parts.',
  intake_recipe_pair_invalid:
    'Recued could not read that. Load the form and the Recipe again, then try once more.',
  intake_recipe_pair_wrong_endpoint_kind:
    'You can only pair a form with a checkout Recipe.',
  intake_recipe_pair_recipe_not_found:
    'That Recipe is gone. Load the list again and pick another.',
  intake_recipe_pair_recipe_invalid:
    'That Recipe is broken, or is not the one Recued saved. Fix it or replace it first.',
  intake_recipe_pair_incompatible:
    'That form and that Recipe do not go together. Check what the form makes, and that it asks for an email.',
  intake_recipe_pair_conflict:
    'Someone changed this on another device. Load it again before you save.',
  intake_recipe_pair_recipe_not_editable:
    'You cannot change this Recipe here. Make your own copy with a new name, then pair that.',
  intake_recipe_pair_stored_invalid:
    'What Recued saved is broken. Clear it, then pair the form and the Recipe again.',
  compose_intent_invalid:
    'Recued could not read that. Try a shorter description, or load the page again.',
  compose_ai_unavailable:
    'The AI is not available on this server right now. Check your AI settings and try again.',
  compose_proposal_invalid:
    'What the AI came back with could not be used. Change your description and try again.',
  compose_compile_error:
    'Recued stopped this, because it did not pass the safety checks.',
};

/** § A.20.6 — per-`SafetyLabelKind` tooltip copy. The label’s emoji +
 *  short text come from the contract (`SAFETY_LABEL_EMOJI` +
 *  `buildSafetyLabels`); this is the longer "why it matters" hover copy
 *  the list view + Share Card surface on the label chip. */
export const RECEPTION_SAFETY_LABEL_TOOLTIP: Readonly<Record<SafetyLabelKind, string>> = {
  public_url:
    'Anyone with the link can use it. They need no Recued account. Treat the link itself like a key.',
  expires_in:
    'This link stops working on its end date. Give it longer before then if you still need it.',
  read_only:
    'People can only look. They cannot send anything, upload anything, or start anything.',
  single_use:
    'This link works once. After that it is dead, and nobody can use it again.',
  file_upload:
    'People can send files straight to your server. Only the kinds you allow, and only up to your size limit.',
  pii_collected:
    'People give you personal details: a name, an email, and whatever they write. Recued keeps it locked away, and only unlocks it here when you look.',
};

/** § A.9 audit-log surface — per-`ReceptionAccessAction` display copy. */
export const RECEPTION_ACCESS_ACTION_COPY: Readonly<Record<ReceptionAccessAction, string>> = {
  view: 'Viewed',
  submit: 'Submitted',
  upload: 'Uploaded',
  approve: 'Approved',
  reject: 'Rejected',
  expired: 'Used a link that had run out',
  invalid_token: 'That link is not right',
  rate_limited: 'Rate limited',
  revoked: 'Used a link that was switched off',
};

/** § A.9 audit-log surface — per-`ReceptionAccessOutcome` display copy. */
export const RECEPTION_ACCESS_OUTCOME_COPY: Readonly<Record<ReceptionAccessOutcome, string>> = {
  ok: 'OK',
  rejected: 'Rejected',
  rate_limited: 'Rate limited',
  expired: 'Expired',
  invalid_token: 'That link is not right',
  revoked: 'Revoked',
  capacity_full: 'Capacity full',
};

// ════════════════════════════════════════════════════════════════
// Endpoint status + per-endpoint row projection
// ════════════════════════════════════════════════════════════════

/** Lifecycle status of a single endpoint, derived from the registry
 *  row. `revoked` is terminal (irreversible); `expired` is reachable
 *  back to `active` via extend; `disabled` is the reversible pause. */
export type ReceptionEndpointStatus = 'active' | 'disabled' | 'revoked' | 'expired';

/** Derive the lifecycle status of an endpoint. Revocation wins over
 *  everything (terminal); a passed expiry wins over the enabled bit (an
 *  enabled-but-expired endpoint is `expired`, not `active`); otherwise
 *  the enabled bit decides `active` vs `disabled`. Pure — no I/O. */
export const deriveReceptionEndpointStatus = (
  summary: EndpointSummary,
  now: number,
): ReceptionEndpointStatus => {
  if (summary.revoked_at !== null) return 'revoked';
  if (summary.expires_at !== null && summary.expires_at <= now) return 'expired';
  return summary.enabled ? 'active' : 'disabled';
};

/** Human label for an endpoint’s expiry posture. Long-lived ⇒ "Never
 *  expires"; a passed expiry ⇒ "Expired …"; a future expiry ⇒ "Expires
 *  in N days". Pure — no I/O. Exported as the one expiry-label rule
 *  across the Reception Settings surface — the View-As-Visitor satellite
 *  reuses it for the panel’s `expiry_policy.expires_at` (same discipline
 *  as the shared `truncateSourceIpHash`). */
export const computeExpiryLabel = (expires_at: number | null, now: number): string => {
  if (expires_at === null) return 'Never expires';
  const remaining = expires_at - now;
  if (remaining <= 0) {
    const daysAgo = Math.floor(-remaining / DAY_MS);
    if (daysAgo <= 0) return 'Expired today';
    return `Expired ${daysAgo} ${daysAgo === 1 ? 'day' : 'days'} ago`;
  }
  const days = Math.ceil(remaining / DAY_MS);
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
};

/** Defensively extract the minimal per-kind config view `buildSafetyLabels`
 *  reads from an `EndpointSummary.metadata` blob (untyped at the rpc
 *  layer). Only `link_kind` (drop_link single-use) +
 *  `required_visitor_fields.email` (scheduling_link PII) are needed;
 *  anything malformed is simply omitted so the label that depends on it
 *  is skipped — never throws. */
const extractSafetyLabelConfig = (
  metadata: Readonly<Record<string, unknown>>,
): { link_kind?: 'one_time' | 'repeated'; required_visitor_fields?: { email?: 'required' | 'optional' | 'omit' } } => {
  const out: {
    link_kind?: 'one_time' | 'repeated';
    required_visitor_fields?: { email?: 'required' | 'optional' | 'omit' };
  } = {};
  const lk = metadata.link_kind;
  if (lk === 'one_time' || lk === 'repeated') out.link_kind = lk;
  const rvf = metadata.required_visitor_fields;
  if (rvf !== null && typeof rvf === 'object') {
    const email = (rvf as Record<string, unknown>).email;
    if (email === 'required' || email === 'optional' || email === 'omit') {
      out.required_visitor_fields = { email };
    }
  }
  return out;
};

/** Per-endpoint list-view row — the projection of one `EndpointSummary`.
 *  Carries derived status + § A.20.6 safety labels + the expiry label;
 *  the renderer maps `status` / `is_singleton` / `is_long_lived` onto
 *  the visible controls (the substrate enumerates data, not buttons,
 *  per the `exposure-surface.ts` convention). */
export interface ReceptionEndpointRow {
  endpoint_id: string;
  kind: ReceptionEndpointKind;
  /** True for the per-server `reception_page` singleton (well-known
   *  endpoint id). The singleton is token-less + has no per-link expiry
   *  / revocation — the renderer shows "Edit page", not the link-style
   *  copy-url / rotate / revoke controls. */
  is_singleton: boolean;
  status: ReceptionEndpointStatus;
  /** § A.20.6 safety-label chips, in the contract’s closed-list order. */
  safety_labels: ReadonlyArray<SafetyLabel>;
  /** `expires_at === null` — a long-lived endpoint (only the
   *  Settings-managed kinds permit it; carries the
   *  `long_lived_acknowledged_at` ack stamp). */
  is_long_lived: boolean;
  expiry_label: string;
  expires_at: number | null;
  long_lived_acknowledged_at: number | null;
  revoked_at: number | null;
  revocation_reason: string | null;
  audit_count: number;
  last_accessed_at: number | null;
  created_at: number;
}

/** Project one `EndpointSummary` into a list-view row. Calls the
 *  contract’s `buildSafetyLabels` over the kind + expiry + the minimal
 *  per-kind config view extracted from the metadata blob. Pure — no I/O. */
export const buildReceptionEndpointRow = (
  summary: EndpointSummary,
  now: number,
): ReceptionEndpointRow => ({
  endpoint_id: summary.endpoint_id,
  kind: summary.kind,
  is_singleton: summary.endpoint_id === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  status: deriveReceptionEndpointStatus(summary, now),
  safety_labels: buildSafetyLabels({
    kind: summary.kind,
    expires_at: summary.expires_at,
    now,
    config: extractSafetyLabelConfig(summary.metadata),
  }),
  is_long_lived: summary.expires_at === null,
  expiry_label: computeExpiryLabel(summary.expires_at, now),
  expires_at: summary.expires_at,
  long_lived_acknowledged_at: summary.long_lived_acknowledged_at,
  revoked_at: summary.revoked_at,
  revocation_reason: summary.revocation_reason,
  audit_count: summary.audit_count,
  last_accessed_at: summary.last_accessed_at,
  created_at: summary.created_at,
});

// ════════════════════════════════════════════════════════════════
// Per-kind section + status header + full page model
// ════════════════════════════════════════════════════════════════

/** One per-kind list-view section — the kind’s copy + its endpoint
 *  rows + whether the "+ New" affordance is available. */
export interface ReceptionKindSection {
  kind: ReceptionEndpointKind;
  section_label: string;
  singular: string;
  description: string;
  create_label: string;
  /** False for `reception_page` once its singleton row exists (you
   *  *edit* the singleton via its row, you do not create a second one);
   *  always true for the five link-style kinds. */
  can_create: boolean;
  rows: ReadonlyArray<ReceptionEndpointRow>;
}

/** Out-of-band status context the page shell assembles from the
 *  exposure resolution + server config — `buildReceptionPageModel`
 *  takes it alongside the `reception.endpoints.list` result, the same
 *  way `buildExposurePageModel` takes `has_ddns`. */
export interface ReceptionStatusInput {
  /** The `reception_emergency_disabled` override (§ A.6) — Mary’s
   *  one-click kill switch overlaid on the exposure resolution. */
  emergency_disabled: boolean;
  /** Whether the `/reception` path resolves public in the live exposure
   *  state — Reception only serves anonymous visitors when this is on. */
  reception_public: boolean;
  /** The resolved `/reception/` base URL (one of Mary’s configured TLS
   *  domains). `null` when it cannot be derived (no public exposure /
   *  no domain configured yet). */
  base_url: string | null;
}

/** The Reception page status header — the top band of the § A.9 page. */
export interface ReceptionStatusHeader {
  /** True iff Reception is actively serving visitors — publicly
   *  exposed AND not emergency-disabled. */
  serving: boolean;
  emergency_disabled: boolean;
  reception_public: boolean;
  base_url: string | null;
  /** Closed-list status word: "Emergency disabled" wins over
   *  "Not publicly exposed" wins over "Enabled". */
  status_label: string;
}

/** Full Settings → Server → Reception page model. */
export interface ReceptionPageModel {
  status_header: ReceptionStatusHeader;
  /** Six per-kind sections, in `RECEPTION_ENDPOINT_KINDS` canonical
   *  order. */
  sections: ReadonlyArray<ReceptionKindSection>;
  /** True iff zero endpoints are enabled — surfaces the § A.20.1 Launch
   *  Wizard "Set up Reception" CTA. */
  is_first_run: boolean;
  total_endpoints: number;
  active_endpoints: number;
}

const buildStatusHeader = (status: ReceptionStatusInput): ReceptionStatusHeader => {
  const serving = status.reception_public && !status.emergency_disabled;
  const status_label = status.emergency_disabled
    ? 'Switched off in a hurry'
    : !status.reception_public
      ? 'Not open to the internet'
      : 'Enabled';
  return {
    serving,
    emergency_disabled: status.emergency_disabled,
    reception_public: status.reception_public,
    base_url: status.base_url,
    status_label,
  };
};

/** Build the renderable Reception page model from the
 *  `reception.endpoints.list` result + the out-of-band status context.
 *  Groups endpoints into the six canonical-order sections (preserving
 *  the rpc’s `created_at DESC` row order within each); flags
 *  `is_first_run` when no endpoint is enabled. Pure projection — the
 *  page shell re-runs it after a `reception.endpoint_changed` broadcast
 *  by refetching the list. */
export const buildReceptionPageModel = (args: {
  endpoints: ReadonlyArray<EndpointSummary>;
  status: ReceptionStatusInput;
  now: number;
}): ReceptionPageModel => {
  const { endpoints, status, now } = args;

  const rowsByKind = new Map<ReceptionEndpointKind, ReceptionEndpointRow[]>();
  for (const kind of RECEPTION_ENDPOINT_KINDS) rowsByKind.set(kind, []);
  let active_endpoints = 0;
  for (const summary of endpoints) {
    const bucket = rowsByKind.get(summary.kind);
    // Defensive — the rpc layer gates `kind ∈ RECEPTION_ENDPOINT_KINDS`,
    // so an unknown kind is unreachable; skip rather than throw if the
    // contract ever widens ahead of this renderer.
    if (!bucket) continue;
    const row = buildReceptionEndpointRow(summary, now);
    bucket.push(row);
    if (row.status === 'active') active_endpoints += 1;
  }

  const sections: ReceptionKindSection[] = RECEPTION_ENDPOINT_KINDS.map((kind) => {
    const rows = rowsByKind.get(kind) ?? [];
    const copy = RECEPTION_KIND_COPY[kind];
    return {
      kind,
      section_label: copy.section_label,
      singular: copy.singular,
      description: copy.description,
      create_label: copy.create_label,
      // The reception_page singleton can only be set up once — once a
      // row exists it is edited in place, never re-created.
      can_create:
        isReceptionEndpointKindAvailable(kind) &&
        (kind === 'reception_page' ? rows.length === 0 : true),
      rows,
    };
  });

  return {
    status_header: buildStatusHeader(status),
    sections,
    is_first_run: !endpoints.some((e) => e.enabled),
    total_endpoints: endpoints.length,
    active_endpoints,
  };
};

// ════════════════════════════════════════════════════════════════
// § A.9 audit-log surface — access-log row projection
// ════════════════════════════════════════════════════════════════

/** Truncate a source-IP hash to its § A.16.7 display prefix (8 chars).
 *  `null` (internal probe — no hash) ⇒ empty string; the renderer
 *  paints an em-dash. Pure — no I/O. */
export const truncateSourceIpHash = (hash: string | null): string =>
  hash === null ? '' : hash.slice(0, RECEPTION_SOURCE_IP_HASH_PREFIX_LEN);

/** Count distinct non-null source-IP hashes across a set of access-log
 *  entries — the "source-IP-hash distinct count" stat the § A.9
 *  per-endpoint detail surfaces. Internal probes (`null` hash) are not
 *  counted. Pure — no I/O. */
export const distinctSourceIpHashCount = (
  entries: ReadonlyArray<AccessLogEntry>,
): number => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.source_ip_hash !== null) seen.add(entry.source_ip_hash);
  }
  return seen.size;
};

/** One projected access-log row for the § A.9 audit-log surface. */
export interface ReceptionAccessLogRow {
  id: string;
  accessed_at: number;
  /** 8-char prefix of the source-IP hash (§ A.16.7); empty string for
   *  an internal-probe (`null`-hash) row. */
  source_ip_hash_prefix: string;
  /** Full hash — `null` for an internal probe. Carried so a user who
   *  opted into raw-IP logging can expand the prefix (§ A.9). */
  source_ip_hash: string | null;
  action_taken: ReceptionAccessAction;
  action_label: string;
  outcome: ReceptionAccessOutcome;
  outcome_label: string;
  url_path_redacted: string | null;
  /** Per-action metadata (submission_id for forms, blob_hash for drops,
   *  …) — opaque to the projection; the renderer formats per-action. */
  metadata: Readonly<Record<string, unknown>>;
}

/** Project one `AccessLogEntry` into an audit-log row — truncates the
 *  source-IP hash + resolves the action / outcome display copy. Pure —
 *  no I/O. */
export const buildReceptionAccessLogRow = (
  entry: AccessLogEntry,
): ReceptionAccessLogRow => ({
  id: entry.id,
  accessed_at: entry.accessed_at,
  source_ip_hash_prefix: truncateSourceIpHash(entry.source_ip_hash),
  source_ip_hash: entry.source_ip_hash,
  action_taken: entry.action_taken,
  action_label: RECEPTION_ACCESS_ACTION_COPY[entry.action_taken],
  outcome: entry.outcome,
  outcome_label: RECEPTION_ACCESS_OUTCOME_COPY[entry.outcome],
  url_path_redacted: entry.url_path_redacted,
  metadata: entry.metadata,
});

// ════════════════════════════════════════════════════════════════
// Per-endpoint detail model
// ════════════════════════════════════════════════════════════════

/** Full Settings → Reception → `<endpoint>` detail model — the row
 *  projection plus the access log, the distinct-source-IP count, the
 *  packet declaration, and the § A.20.4 Share Cards. */
export interface ReceptionEndpointDetailModel {
  row: ReceptionEndpointRow;
  /** The endpoint’s packet declaration — surfaces the closed
   *  `fields_visible` list + source query for the "edit packet
   *  declaration" affordance (§ A.9). */
  packet_declaration: PacketDeclaration;
  /** Per-kind metadata blob — the renderer reads the kind-specific
   *  config summary off it. Opaque to this projection. */
  metadata: Readonly<Record<string, unknown>>;
  /** Most-recent-first access-log rows (the rpc returns
   *  `accessed_at DESC`; this projection preserves it). */
  access_log_rows: ReadonlyArray<ReceptionAccessLogRow>;
  distinct_source_ip_count: number;
  /** § A.20.4 per-channel Share Cards — populated only when the caller
   *  still holds the share URL (the bearer secret is never re-readable,
   *  so the URL is available only from a cached create result or a
   *  fresh `rotate_token`). Empty otherwise. */
  share_cards: ReadonlyArray<ShareCard>;
  /** False ⇒ the renderer shows "rotate the token to mint a fresh
   *  share URL" instead of the Share Cards. */
  share_url_available: boolean;
}

/** Build the per-endpoint detail model. `share` is optional — the
 *  caller passes it (with the cached / freshly-rotated share URL) when
 *  it has one; absent ⇒ `share_cards: []` + `share_url_available:
 *  false`, and the renderer surfaces the rotate affordance instead.
 *  Pure — no I/O. */
export const buildReceptionEndpointDetailModel = (args: {
  summary: EndpointSummary;
  access_log: ReadonlyArray<AccessLogEntry>;
  share?: ShareCardsInput;
  now: number;
}): ReceptionEndpointDetailModel => {
  const { summary, access_log, share, now } = args;
  const shareAllowed = isReceptionEndpointKindAvailable(summary.kind);
  return {
    row: buildReceptionEndpointRow(summary, now),
    packet_declaration: summary.packet_declaration,
    metadata: summary.metadata,
    access_log_rows: access_log.map(buildReceptionAccessLogRow),
    distinct_source_ip_count: distinctSourceIpHashCount(access_log),
    share_cards: shareAllowed && share !== undefined ? buildShareCards(share) : [],
    share_url_available: shareAllowed && share !== undefined,
  };
};

// ════════════════════════════════════════════════════════════════
// Dispatch builders
// ════════════════════════════════════════════════════════════════
//
// The renderer never fires the rpc; it shapes the payload + hands it
// to the page shell, which calls the `reception.*` rpc over the WS
// conn. Same separation as `buildPresetDispatch` in exposure-surface.ts.

/** Payload for `reception.endpoint.enable`. */
export interface ReceptionEnableDispatch {
  op: 'reception.endpoint.enable';
  endpoint_id: string;
}

/** Payload for `reception.endpoint.disable` — the reversible pause. */
export interface ReceptionDisableDispatch {
  op: 'reception.endpoint.disable';
  endpoint_id: string;
}

/** Payload for `reception.endpoint.revoke` — irreversible; the access
 *  log is preserved for forensics. */
export interface ReceptionRevokeDispatch {
  op: 'reception.endpoint.revoke';
  endpoint_id: string;
  reason?: string;
}

/** Payload for `reception.endpoint.extend` — `new_expires_at: null`
 *  sets the endpoint long-lived (only the kinds that permit it; the
 *  rpc rejects `null` for the hard-ceiling kinds). */
export interface ReceptionExtendDispatch {
  op: 'reception.endpoint.extend';
  endpoint_id: string;
  new_expires_at: number | null;
}

/** Payload for `reception.endpoint.rotate_token` — mints a fresh bearer
 *  secret (lost-URL recovery / suspected-leak / hygiene). */
export interface ReceptionRotateDispatch {
  op: 'reception.endpoint.rotate_token';
  endpoint_id: string;
  reason?: ReceptionEndpointRotateReason;
}

/** Payload for `reception.emergency_disable_all` — the § A.9 bulk kill
 *  switch. */
export interface ReceptionEmergencyDisableAllDispatch {
  op: 'reception.emergency_disable_all';
  reason?: string;
}

export type ReceptionDispatch =
  | ReceptionEnableDispatch
  | ReceptionDisableDispatch
  | ReceptionRevokeDispatch
  | ReceptionExtendDispatch
  | ReceptionRotateDispatch
  | ReceptionEmergencyDisableAllDispatch;

export const buildReceptionEnableDispatch = (args: {
  endpoint_id: string;
}): ReceptionEnableDispatch => ({
  op: 'reception.endpoint.enable',
  endpoint_id: args.endpoint_id,
});

export const buildReceptionDisableDispatch = (args: {
  endpoint_id: string;
}): ReceptionDisableDispatch => ({
  op: 'reception.endpoint.disable',
  endpoint_id: args.endpoint_id,
});

export const buildReceptionRevokeDispatch = (args: {
  endpoint_id: string;
  reason?: string;
}): ReceptionRevokeDispatch => ({
  op: 'reception.endpoint.revoke',
  endpoint_id: args.endpoint_id,
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const buildReceptionExtendDispatch = (args: {
  endpoint_id: string;
  new_expires_at: number | null;
}): ReceptionExtendDispatch => ({
  op: 'reception.endpoint.extend',
  endpoint_id: args.endpoint_id,
  new_expires_at: args.new_expires_at,
});

export const buildReceptionRotateDispatch = (args: {
  endpoint_id: string;
  reason?: ReceptionEndpointRotateReason;
}): ReceptionRotateDispatch => ({
  op: 'reception.endpoint.rotate_token',
  endpoint_id: args.endpoint_id,
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const buildReceptionEmergencyDisableAllDispatch = (args: {
  reason?: string;
}): ReceptionEmergencyDisableAllDispatch => ({
  op: 'reception.emergency_disable_all',
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

// ════════════════════════════════════════════════════════════════
// Broadcast reducer
// ════════════════════════════════════════════════════════════════

/** Apply a `reception.emergency_disabled` broadcast to the page model
 *  optimistically. The event carries enough to apply without a refetch:
 *  the emergency-disable override flips on (header recomputes) + every
 *  `active` row drops to `disabled` (`revoked` / `expired` rows are
 *  unaffected — emergency disable is the `reception_emergency_disabled`
 *  overlay, it does not revoke or un-expire). `is_first_run` +
 *  `active_endpoints` recompute off the new row states. Pure — no I/O.
 *
 *  Note: there is no companion reducer for `reception.endpoint_changed`
 *  — that broadcast carries only `{ op, endpoint_id }` (never the row),
 *  so the page shell re-runs `buildReceptionPageModel` after refetching
 *  `reception.endpoints.list`. */
export const reduceReceptionEmergencyDisabled = (
  model: ReceptionPageModel,
): ReceptionPageModel => {
  const sections: ReceptionKindSection[] = model.sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) =>
      row.status === 'active' ? { ...row, status: 'disabled' as const } : row,
    ),
  }));
  let active_endpoints = 0;
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.status === 'active') active_endpoints += 1;
    }
  }
  return {
    status_header: buildStatusHeader({
      emergency_disabled: true,
      reception_public: model.status_header.reception_public,
      base_url: model.status_header.base_url,
    }),
    sections,
    // Emergency disable drops every active endpoint to disabled, so the
    // page is back in the "zero endpoints enabled" first-run state.
    is_first_run: active_endpoints === 0,
    total_endpoints: model.total_endpoints,
    active_endpoints,
  };
};
