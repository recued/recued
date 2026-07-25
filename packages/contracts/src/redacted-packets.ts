import { COMMITMENT_LIFECYCLE_STATE_SET } from './work-entities.js';

/** D-145 PB12 — Peer-Recued Preview primitive (`redacted_packet` substrate).
 *
 *  Per § B.13. A `RedactedPacket<T>` is a query result projected through
 *  a closed-list `fields_visible` per packet_kind plus per-kind
 *  boundary transformations (calendar events → free windows;
 *  counterparty names → first-name + initial; etc.). The substrate
 *  enforces the privacy contract structurally — adding a field to a
 *  packet kind requires a substrate code change, not a config edit;
 *  the validator-load ratchet pins the closed list so unreviewed
 *  packet_kinds cannot land.
 *
 *  One substrate, two consumers (§ B.13):
 *    - **S2S Preview** (D-145 ships this consumer) — peer-MCP-future
 *      substrate; Bob's Recued asks Alice's Recued for availability;
 *      Alice's substrate emits a `RedactedPacket<'availability'>`
 *      stripped to free_windows + tz + duration_options.
 *    - **Public Reception** (D-149 consumes the same substrate) —
 *      anonymous visitor opens a published scheduling_link; D-149
 *      reception endpoint serves the same packet to the visitor.
 *
 *  Privacy invariants (§ B.13.3 + § B.13.6):
 *    - `fields_visible` is closed-list per packet_kind and
 *      validator-enforced; adding a kind requires a substrate PR.
 *    - `buildRedactedPacket` strict-picks `fields_visible` then runs
 *      the per-kind boundary transformation. Untouched fields on the
 *      raw input never reach the payload — even if the caller hands
 *      a richer object, the strict pick drops everything outside the
 *      closed list before the transformation hook runs.
 *    - D-120 audit emission is wired through the
 *      `RedactedPacketAuditEmitter` seam — `redacted_packet.built`
 *      fires per build, `redacted_packet.accessed` fires per consumer
 *      access (the consumer wires the second emit; the substrate
 *      only owns the build emit).
 *    - Token validation + expiry are enforced at consumer boundary
 *      (substrate exposes `isPacketExpired` + `validateAccessToken`).
 *
 *  Spec: D-145 § B.13. */

// ── PB12.1 — Closed list of packet kinds ────────────────────────────

/** § B.13.1 — closed list of packet kinds the substrate ships at v1.
 *  Adding a new kind requires a substrate PR + a matching entry in
 *  `PACKET_FIELDS_VISIBLE`; the validator-load ratchet asserts the
 *  registries stay in sync.
 *
 *  D-149 P2 (§ A.4) — six anonymous-visitor reception kinds extend
 *  the substrate. They share the strict-pick + boundary-transform +
 *  audit-emit discipline of the D-145 originals; the only consumer-
 *  side discriminator is that reception consumers wrap
 *  `buildRedactedPacket` with `buildReceptionPacket` (which strips
 *  the access_token before returning, since reception tokens are
 *  HMAC-stored in `public_endpoint_registry` rather than embedded in
 *  the envelope per § A.4 line 536). */
export const REDACTED_PACKET_KINDS = [
  /** Calendar events → free windows. Used by S2S Preview + D-149
   *  scheduling_link reception endpoint. */
  'availability',
  /** Project + open commitments + recent activity. Used by S2S
   *  Preview to share project status without exposing task body. */
  'project_status',
  /** Commitments by state + age summary; counterparty names redacted
   *  to first-name + initial. */
  'commitment_summary',
  /** Contact card — name + network_domain only; never aliases, never
   *  engagements. */
  'contact_card',
  /** Event plan view for D-149 status_link — title + date range +
   *  free windows + visible attendees. */
  'event_plan',
  /** Itinerary view for D-149 status_link — title + date range +
   *  visible legs. */
  'itinerary',
  // ── D-149 P2 reception kinds (§ A.4) ───────────────────────────────
  /** Front-door reception page — display name + tagline + projected
   *  CTA buttons + tz_label. Never leaks the private `section_config`
   *  or full `linked_endpoints` map (only the derived `cta_buttons`
   *  list ships). One per server (§ A.5.1). */
  'reception_page_packet',
  /** Calendly-like scheduling link — free windows derived from raw
   *  calendar events at the boundary; raw events NEVER reach the
   *  payload (§ A.5.2 line 593 / 681 no-leak test). */
  'scheduling_link_packet',
  /** Visitor-submitted form — visitor-visible field schema only;
   *  user-only metadata fields stay private at the boundary
   *  (§ A.5.3 line 760 no-leak test). */
  'intake_form_packet',
  /** File-upload drop link — size cap + MIME allowlist + instructions
   *  only; never leaks the storage-path / data_file ids (§ A.5.4
   *  line 836 no-leak test). */
  'drop_link_packet',
  /** Single-purpose scoped action — prompt + options + redacted
   *  context_summary; counterparty aliases + private notes stripped
   *  at boundary (§ A.5.5 line 913 no-leak test). */
  'approval_link_packet',
  /** Read-only entity projection — visible_fields filtered by
   *  `fields_visible_override` clamped to per-projection-kind closed
   *  list ceiling (`STATUS_PROJECTION_FIELDS_VISIBLE`); deep-links
   *  into related entities NEVER surface (§ A.5.6 line 958 no-leak
   *  test). */
  'status_link_packet',
] as const;
export type RedactedPacketKind = (typeof REDACTED_PACKET_KINDS)[number];
export const REDACTED_PACKET_KIND_SET: ReadonlySet<RedactedPacketKind> =
  new Set(REDACTED_PACKET_KINDS);

/** Codex review fold (2026-05-13 P1) — S2S Preview consumer's
 *  closed-list subset of the substrate. The S2S Preview rpc layer
 *  validates `packet_kind` against THIS set rather than the full
 *  `REDACTED_PACKET_KIND_SET` so a peer cannot ask S2S Preview to
 *  build a reception-only kind (e.g., `drop_link_packet`) — those
 *  belong exclusively to D-149's reception consumer (token-stripped
 *  envelope + registry-bound endpoint context). Adding a new D-145
 *  S2S Preview kind = adding it to this list AND to
 *  `REDACTED_PACKET_KINDS`. */
export const S2S_PREVIEW_PACKET_KINDS = [
  'availability',
  'project_status',
  'commitment_summary',
  'contact_card',
  'event_plan',
  'itinerary',
] as const satisfies ReadonlyArray<RedactedPacketKind>;
export type S2SPreviewPacketKind = (typeof S2S_PREVIEW_PACKET_KINDS)[number];
export const S2S_PREVIEW_PACKET_KIND_SET: ReadonlySet<S2SPreviewPacketKind> =
  new Set(S2S_PREVIEW_PACKET_KINDS);

export const isS2SPreviewPacketKind = (value: unknown): value is S2SPreviewPacketKind =>
  typeof value === 'string' && S2S_PREVIEW_PACKET_KIND_SET.has(value as S2SPreviewPacketKind);

// ── PB12.2 — `fields_visible` closed list per packet kind ───────────

/** § B.13.2 — `fields_visible` closed list per packet_kind. Strict-pick
 *  at build time strips every field outside this list before the
 *  per-kind transformation hook runs.
 *
 *  Adding a field requires a substrate PR — the privacy contract is
 *  legible by reading this map. The validator-load ratchet
 *  (`assertRedactedPacketInvariants`) asserts every kind in
 *  `REDACTED_PACKET_KINDS` has a non-empty entry here. */
export const PACKET_FIELDS_VISIBLE: Readonly<Record<RedactedPacketKind, ReadonlyArray<string>>> = {
  availability: ['free_windows', 'tz', 'duration_options'],
  project_status: ['title', 'state', 'open_commitment_count', 'last_activity_at_relative'],
  commitment_summary: ['direction', 'state_counts', 'oldest_pending_age_days', 'counterparties'],
  contact_card: ['name', 'network_domain'],
  event_plan: ['title', 'date_range', 'free_windows', 'visible_attendees'],
  itinerary: ['title', 'date_range', 'visible_legs'],
  // ── D-149 P2 reception kinds (§ A.4) ───────────────────────────────
  reception_page_packet: [
    'display_name',
    'tagline',
    'avatar_url',
    'preferred_contact_methods',
    'cta_buttons',
    'tz_label',
    'response_time_estimate',
  ],
  scheduling_link_packet: [
    'free_windows',
    'tz',
    'duration_options',
    'required_visitor_fields',
    'min_advance_notice_hours',
    'max_lead_time_days',
  ],
  intake_form_packet: [
    'form_definition',
    'required_fields',
    'optional_fields',
    'submit_button_label',
    'success_message_template',
    'rate_limit_hint',
  ],
  drop_link_packet: [
    'size_cap_bytes',
    'allowed_mime_types',
    'instructions',
    'required_visitor_fields',
    'one_time_use',
    'expiry_display',
  ],
  approval_link_packet: [
    'action_kind',
    'prompt',
    'options',
    'expiry_display',
    'visitor_field_constraints',
    'context_summary',
  ],
  status_link_packet: [
    'projection_kind',
    'visible_fields',
    'last_updated_at_relative',
    'updates_visible',
    'comments_enabled',
  ],
} as const;

/** Type guard for the field-visible list — narrows raw input field
 *  reads to the closed-list shape so a transformation that reads a
 *  field outside the closed list compile-errors. */
export const isVisibleField = (kind: RedactedPacketKind, field: string): boolean =>
  PACKET_FIELDS_VISIBLE[kind].includes(field);

// ── PB12.3 — Per-kind raw input shapes ──────────────────────────────

/** Raw calendar event the availability transform consumes. Mirrors
 *  the canonical mail/calendar bistemporal shape (§ D-117 / § D-120)
 *  but kept narrow here so the substrate stays decoupled from full
 *  warehouse types. The transform reads `start_at` + `end_at` only;
 *  every other field is dropped at the strict-pick boundary. */
export interface AvailabilityRawCalendarEvent {
  /** Unix-ms inclusive lower bound. */
  readonly start_at: number;
  /** Unix-ms exclusive upper bound. */
  readonly end_at: number;
}

/** Raw input the `availability` builder consumes — the strict pick
 *  drops calendar_events at the boundary (it never appears on the
 *  payload) and the transformation emits `free_windows`. */
export interface AvailabilityRawInput {
  readonly calendar_events: ReadonlyArray<AvailabilityRawCalendarEvent>;
  readonly window_start: number;
  readonly window_end: number;
  readonly tz: string;
  readonly duration_options: ReadonlyArray<number>;
}

/** Free window emitted by `computeFreeWindows`. Closed shape — the
 *  substrate owns the wire shape so D-149 reception + future D-140
 *  peer-MCP consumers render against one contract. */
export interface FreeWindow {
  /** Unix-ms inclusive lower bound. */
  readonly start_at: number;
  /** Unix-ms exclusive upper bound. */
  readonly end_at: number;
}

/** Raw input the `project_status` builder consumes. */
export interface ProjectStatusRawInput {
  readonly title: string;
  readonly state: string;
  readonly open_commitment_count: number;
  readonly last_activity_at: number;
  /** Wall-clock unix-ms used to derive the `last_activity_at_relative`
   *  string; injected so the builder stays pure (no `Date.now()`
   *  read). */
  readonly now: number;
}

/** Raw input the `commitment_summary` builder consumes. Counterparty
 *  full names land in the input; the boundary transform redacts each
 *  to first-name + initial before any field reaches the payload. */
export interface CommitmentSummaryRawInput {
  readonly direction: 'inbound' | 'outbound' | 'mixed';
  readonly state_counts: Readonly<Record<string, number>>;
  readonly oldest_pending_age_days: number;
  /** Full counterparty names — substrate redacts to first-name + last
   *  initial at the boundary. */
  readonly counterparty_full_names: ReadonlyArray<string>;
}

/** Raw input the `contact_card` builder consumes. */
export interface ContactCardRawInput {
  readonly name: string;
  readonly network_domain: string;
}

/** Raw input the `event_plan` builder consumes. Visible attendees
 *  pass through the transform after redaction (first-name + initial)
 *  to mirror the commitment_summary discipline. */
export interface EventPlanRawInput {
  readonly title: string;
  readonly date_range: { readonly start_at: number; readonly end_at: number };
  readonly calendar_events: ReadonlyArray<AvailabilityRawCalendarEvent>;
  readonly window_start: number;
  readonly window_end: number;
  readonly attendee_full_names: ReadonlyArray<string>;
}

/** Raw input the `itinerary` builder consumes. Visible legs pass
 *  through with title + date range; per-leg detail outside the
 *  closed list is stripped. */
export interface ItineraryRawInput {
  readonly title: string;
  readonly date_range: { readonly start_at: number; readonly end_at: number };
  readonly legs: ReadonlyArray<ItineraryLegRawInput>;
}

/** A single leg inside an itinerary. The transform emits
 *  `visible_legs` with title + start_at + end_at only; richer fields
 *  (notes, costs, attachments) are stripped at the boundary. */
export interface ItineraryLegRawInput {
  readonly title: string;
  readonly start_at: number;
  readonly end_at: number;
  readonly [extra: string]: unknown;
}

// ── D-149 P2 reception raw-input shapes (§ A.4 + § A.5) ─────────────

/** § A.5.1 — `reception_page_packet` raw input. Loaded from the
 *  `reception_page_config` server-internal row + the registered
 *  cross-link endpoint ids. The strict-pick at build time drops
 *  `section_config` + `linked_endpoints` (private — only the
 *  projected `cta_buttons` list reaches the payload). */
export interface ReceptionPagePacketRawInput {
  readonly display_name: string;
  readonly tagline: string;
  readonly avatar_url?: string;
  readonly preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
  readonly tz_label: string;
  readonly response_time_estimate?: string;
  /** Private. Section toggles control which CTAs project; the field
   *  never reaches the payload. */
  readonly section_config?: ReceptionPageSectionConfig;
  /** Private. Map of CTA kind → linked endpoint_id; the boundary
   *  projects this into `cta_buttons` then drops the source map. */
  readonly linked_endpoints?: ReceptionPageLinkedEndpoints;
}

export type ReceptionPagePreferredContactMethod =
  | 'email'
  | 'phone'
  | 'slack'
  | 'telegram';

export const RECEPTION_PAGE_PREFERRED_CONTACT_METHODS: ReadonlyArray<ReceptionPagePreferredContactMethod> = [
  'email',
  'phone',
  'slack',
  'telegram',
] as const;

export const RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET: ReadonlySet<ReceptionPagePreferredContactMethod> =
  new Set(RECEPTION_PAGE_PREFERRED_CONTACT_METHODS);

export interface ReceptionPageSectionConfig {
  readonly contact_card?: boolean;
  readonly contact_methods?: boolean;
  readonly availability_cta?: boolean;
  readonly intake_cta?: boolean;
  readonly drop_cta?: boolean;
  readonly custom_links?: boolean;
  readonly link_buttons?: boolean;
}

export interface ReceptionPageLinkedEndpoints {
  readonly scheduling_link_endpoint_id?: string;
  readonly intake_form_endpoint_id?: string;
  readonly drop_link_endpoint_id?: string;
  // D-149 P4 Codex review fold (2026-05-13) — optional per-CTA full
  // share URL Mary captures from the create-rpc `share_url_once`
  // response + pastes into the reception_page config. The CTA's
  // visitor-facing `href` derives from this value; when unset the
  // projector falls back to a token-less `/reception/<kind>/<id>`
  // path (which renders as a 401 — the user is expected to share
  // the bearer-carrying URL out-of-band). The closed-shape gate at
  // the rpc validator clamps each value to the same URL allowlist
  // as `avatar_url` / `custom_links[].url`.
  readonly scheduling_link_share_url?: string;
  readonly intake_form_share_url?: string;
  readonly drop_link_share_url?: string;
}

/** Projected CTA button — closed shape. Only the visitor-visible
 *  `label` + endpoint_id ships; the source endpoint kind is included
 *  so the visitor-facing rendering can pick an icon / aria-label,
 *  but the registered endpoint's full configuration stays server-
 *  side. */
export interface ReceptionPageCtaButton {
  readonly label: string;
  readonly endpoint_id: string;
  readonly kind: 'scheduling_link' | 'intake_form' | 'drop_link';
  // D-149 P4 Codex review fold (2026-05-13) — visitor-facing href the
  // renderer emits in the CTA's `<a href="…">`. Derived by the
  // projector from `ReceptionPageLinkedEndpoints.<kind>_share_url`
  // when set; otherwise a token-less `/reception/<kind>/<id>`
  // fallback. The substrate validator + the renderer's `htmlEscape`
  // gate the value against the closed-list URL allowlist; the
  // closed-shape field surfaces here so the renderer doesn't have
  // to re-derive at every emit.
  readonly href: string;
}

/** § A.5.2 — `scheduling_link_packet` raw input. The boundary
 *  computes `free_windows` via `computeFreeWindows` then drops
 *  `calendar_events` + the window bounds; per § A.5.2 line 681
 *  no-leak test, raw event titles / attendees / agendas must never
 *  surface. */
export interface SchedulingLinkPacketRawInput {
  readonly calendar_events: ReadonlyArray<AvailabilityRawCalendarEvent>;
  readonly window_start: number;
  readonly window_end: number;
  readonly tz: string;
  readonly duration_options: ReadonlyArray<number>;
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  readonly min_advance_notice_hours: number;
  readonly max_lead_time_days: number;
}

export type SchedulingLinkVisitorFieldRequirement = 'required' | 'optional' | 'omit';

export const SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS: ReadonlyArray<SchedulingLinkVisitorFieldRequirement> = [
  'required',
  'optional',
  'omit',
] as const;

export const SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENT_SET: ReadonlySet<SchedulingLinkVisitorFieldRequirement> =
  new Set(SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS);

/** § A.5.2 line 609-615 — closed shape for the visitor-field
 *  requirement map. Per spec `name` is always `required`; the
 *  remaining fields choose between required / optional / omit.
 *  The substrate accepts the broader `SchedulingLinkVisitorFieldRequirement`
 *  on `name` so the validator gates the spec invariant once, not
 *  per field. */
export interface SchedulingLinkVisitorFieldRequirements {
  readonly name: SchedulingLinkVisitorFieldRequirement;
  readonly email: SchedulingLinkVisitorFieldRequirement;
  readonly topic: SchedulingLinkVisitorFieldRequirement;
  readonly phone: SchedulingLinkVisitorFieldRequirement;
  readonly notes: SchedulingLinkVisitorFieldRequirement;
}

/** § A.5.3 — `intake_form_packet` raw input. The boundary strict-
 *  picks the visitor-visible field schema; user-only metadata
 *  fields (per `IntakeFormDefinitionView.user_only_field_names`)
 *  are stripped at the transformation step. */
export interface IntakeFormPacketRawInput {
  readonly form_definition: IntakeFormDefinitionView;
  readonly required_fields: ReadonlyArray<string>;
  readonly optional_fields: ReadonlyArray<string>;
  readonly submit_button_label: string;
  readonly success_message_template: string;
  readonly rate_limit_hint: string;
}

/** Visitor-facing slice of a `reception_form_definition` row.
 *  Per § A.5.3 line 760 no-leak test, fields marked `user_only_metadata`
 *  in `per_field_visibility` MUST NOT appear here. */
export interface IntakeFormDefinitionView {
  readonly form_definition_id: string;
  readonly visitor_visible_fields: ReadonlyArray<IntakeFormVisitorField>;
}

/** The closed list of visitor-visible field types.
 *
 *  ⚠ The TYPE is DERIVED from this array, not written beside it. It used to be
 *  a hand-maintained union plus a hand-maintained array — a shape where adding
 *  a member to only one side still typechecks (the array is annotated by the
 *  union, so a SUBSET is legal). D-210 WS3 adds `'datetime'`, which is exactly
 *  the edit that drift would have swallowed.
 *
 *  D-210 WS3 — `'datetime'` is `'date'` plus a time-of-day. It exists so an
 *  intake can name a start INSTANT for a `calendar` destination: a `date` field
 *  materializes an ALL-DAY event, a `datetime` field a TIMED one. That is the
 *  only semantic difference between them; both arrive as strings. */
export const INTAKE_FORM_VISITOR_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
  'array<text>',
  'file',
] as const satisfies ReadonlyArray<string>;

export type IntakeFormVisitorFieldType = (typeof INTAKE_FORM_VISITOR_FIELD_TYPES)[number];

export const INTAKE_FORM_VISITOR_FIELD_TYPE_SET: ReadonlySet<IntakeFormVisitorFieldType> =
  new Set(INTAKE_FORM_VISITOR_FIELD_TYPES);

export interface IntakeFormVisitorField {
  readonly name: string;
  readonly type: IntakeFormVisitorFieldType;
  readonly label: string;
  readonly required: boolean;
}

/** § A.5.4 — `drop_link_packet` raw input. Closed-list MIME-type
 *  allowlist + size cap; storage-path / per-blob ids stay server-
 *  side (the visitor sees only the cap + the allowed types). */
export interface DropLinkPacketRawInput {
  readonly size_cap_bytes: number;
  readonly allowed_mime_types: ReadonlyArray<string>;
  readonly instructions: string;
  readonly required_visitor_fields: DropLinkVisitorFieldRequirements;
  readonly one_time_use: boolean;
  readonly expiry_display: string;
}

export type DropLinkVisitorFieldRequirement = 'required' | 'optional' | 'omit';

export const DROP_LINK_VISITOR_FIELD_REQUIREMENTS: ReadonlyArray<DropLinkVisitorFieldRequirement> = [
  'required',
  'optional',
  'omit',
] as const;

export const DROP_LINK_VISITOR_FIELD_REQUIREMENT_SET: ReadonlySet<DropLinkVisitorFieldRequirement> =
  new Set(DROP_LINK_VISITOR_FIELD_REQUIREMENTS);

export interface DropLinkVisitorFieldRequirements {
  readonly name: DropLinkVisitorFieldRequirement;
  readonly email: DropLinkVisitorFieldRequirement;
  readonly description: DropLinkVisitorFieldRequirement;
}

/** § A.5.5 — `approval_link_packet` raw input. The boundary builds
 *  `context_summary` by redacting `context_raw` (strips counterparty
 *  aliases + private notes); per § A.5.5 line 913 no-leak test the
 *  raw context's `counterparty_aliases` / `private_notes` arrays
 *  MUST NOT reach the visitor payload. */
export interface ApprovalLinkPacketRawInput {
  readonly action_kind: ApprovalLinkActionKind;
  readonly prompt: string;
  readonly options?: ReadonlyArray<ApprovalLinkOption>;
  readonly expiry_display: string;
  readonly visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
  readonly context_raw: ApprovalLinkContextRaw;
}

export type ApprovalLinkActionKind =
  | 'pick_time'
  | 'approve_wording'
  | 'confirm_attendance'
  | 'answer_question'
  | 'upload_doc';

export const APPROVAL_LINK_ACTION_KINDS: ReadonlyArray<ApprovalLinkActionKind> = [
  'pick_time',
  'approve_wording',
  'confirm_attendance',
  'answer_question',
  'upload_doc',
] as const;

export const APPROVAL_LINK_ACTION_KIND_SET: ReadonlySet<ApprovalLinkActionKind> =
  new Set(APPROVAL_LINK_ACTION_KINDS);

export interface ApprovalLinkOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ApprovalLinkVisitorFieldConstraints {
  readonly name: 'required' | 'optional';
  readonly email: 'required' | 'optional';
  readonly require_email_match?: string;
}

/** Raw context the user attaches to the approval intent. Only the
 *  `summary` reaches the visitor; aliases + private notes stay
 *  server-side. */
export interface ApprovalLinkContextRaw {
  readonly summary: string;
  readonly counterparty_aliases?: ReadonlyArray<string>;
  readonly private_notes?: ReadonlyArray<string>;
}

/** § A.5.6 — `status_link_packet` raw input. The boundary picks
 *  `visible_fields` from the source entity row, clamped to the
 *  per-projection-kind closed-list ceiling
 *  (`STATUS_PROJECTION_FIELDS_VISIBLE`). Per § A.5.6 line 958
 *  no-leak test, deep-link refs into related entities (mail / tasks
 *  / standing instructions) MUST NEVER surface. */
export interface StatusLinkPacketRawInput {
  readonly projection_kind: StatusLinkProjectionKind;
  /** Source entity row projected onto the closed-list ceiling. */
  readonly source_entity_row: Readonly<Record<string, unknown>>;
  /** Optional user-narrowing within the per-projection ceiling.
   *  Substrate filters this against the closed list — over-broad
   *  override entries that fall outside the ceiling are dropped
   *  silently rather than raising (the user might supply a
   *  superset by mistake; defense in depth on the closed list is
   *  the load-bearing invariant). */
  readonly fields_visible_override?: ReadonlyArray<string>;
  readonly last_updated_at: number;
  /** Wall-clock unix-ms for the relative-time formatter. Injected
   *  so the builder stays pure. */
  readonly now: number;
  readonly updates_visible: boolean;
  readonly comments_enabled: boolean;
}

export type StatusLinkProjectionKind =
  | 'event_plan'
  | 'itinerary'
  | 'project'
  | 'packing_list'
  | 'commitment_summary'
  | 'custom';

export const STATUS_LINK_PROJECTION_KINDS: ReadonlyArray<StatusLinkProjectionKind> = [
  'event_plan',
  'itinerary',
  'project',
  'packing_list',
  'commitment_summary',
  'custom',
] as const;

export const STATUS_LINK_PROJECTION_KIND_SET: ReadonlySet<StatusLinkProjectionKind> =
  new Set(STATUS_LINK_PROJECTION_KINDS);

/** § A.5.6 line 940-946 — per-projection-kind closed-list ceiling.
 *  Even when the user supplies `fields_visible_override`, the
 *  substrate clamps the override to this list before the pick. A
 *  field NOT in the ceiling NEVER reaches the visitor regardless of
 *  what the user (or a buggy caller) sets. The `custom` projection
 *  carries a narrow generic set so a misconfigured custom link
 *  cannot leak arbitrary entity fields. */
export const STATUS_PROJECTION_FIELDS_VISIBLE: Readonly<
  Record<StatusLinkProjectionKind, ReadonlyArray<string>>
> = {
  event_plan: ['title', 'date', 'location_label', 'agenda_summary', 'visible_attendees', 'tz_label'],
  itinerary: ['title', 'date_range', 'visible_legs'],
  project: ['title', 'state', 'open_commitment_count', 'last_activity_at_relative', 'milestone_summary'],
  packing_list: ['title', 'items', 'packed_count', 'total_count', 'due_date_relative'],
  commitment_summary: ['title', 'state', 'due_at_relative', 'counterparty_first_name_initial'],
  custom: ['title', 'summary', 'updated_at_relative', 'tags'],
} as const;

/** Codex review fold (2026-05-13 P1) — closed shape per
 *  `itinerary.visible_legs[*]` element. Per spec § A.5.6 line 942 a
 *  leg exposes ONLY origin / destination / mode / time; confirmation
 *  numbers / booking codes / loyalty IDs MUST NEVER surface. The
 *  status_link transform rebuilds each leg from this closed shape so
 *  nested sensitive fields on a leg object can't slip through the
 *  top-level field pick. */
export interface StatusLinkItineraryVisibleLeg {
  readonly origin: string;
  readonly destination: string;
  readonly mode: string;
  readonly time: string;
}

/** Codex review fold (2026-05-13 P1) — closed shape per
 *  `event_plan.visible_attendees[*]` element. The transform redacts
 *  full names to first-name + initial via `redactCounterpartyName`;
 *  attendees enter the raw source row as strings (full names) and
 *  the transform redacts each at the boundary. */
export type StatusLinkVisibleAttendee = string;

/** Codex review fold (2026-05-13 P1) — per-projection per-field
 *  redactor. Returns the visitor-safe value or `undefined` when the
 *  raw value doesn't match the closed shape. Per-projection bookkeeping
 *  ensures nested sensitive fields (booking codes, confirmation numbers,
 *  full attendee names) get filtered at the boundary even when the
 *  top-level field name is in the per-projection ceiling. */
type StatusLinkFieldRedactor = (raw: unknown) => unknown;

const isStringValue = (v: unknown): v is string => typeof v === 'string';

const redactItineraryLeg = (raw: unknown): StatusLinkItineraryVisibleLeg | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    !isStringValue(r.origin) ||
    !isStringValue(r.destination) ||
    !isStringValue(r.mode) ||
    !isStringValue(r.time)
  ) {
    return undefined;
  }
  return {
    origin: r.origin,
    destination: r.destination,
    mode: r.mode,
    time: r.time,
  };
};

const redactItineraryVisibleLegs = (raw: unknown): ReadonlyArray<StatusLinkItineraryVisibleLeg> => {
  if (!Array.isArray(raw)) return [];
  const out: StatusLinkItineraryVisibleLeg[] = [];
  for (const leg of raw) {
    const redacted = redactItineraryLeg(leg);
    if (redacted !== undefined) out.push(redacted);
  }
  return out;
};

const redactEventPlanVisibleAttendees = (raw: unknown): ReadonlyArray<StatusLinkVisibleAttendee> => {
  if (!Array.isArray(raw)) return [];
  const out: StatusLinkVisibleAttendee[] = [];
  for (const name of raw) {
    if (typeof name !== 'string') continue;
    const redacted = redactCounterpartyName(name);
    if (redacted.length > 0) out.push(redacted);
  }
  return out;
};

const redactDateRange = (
  raw: unknown,
): { readonly start_at: number; readonly end_at: number } | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.start_at !== 'number' || typeof r.end_at !== 'number') return undefined;
  if (!Number.isFinite(r.start_at) || !Number.isFinite(r.end_at)) return undefined;
  return { start_at: r.start_at, end_at: r.end_at };
};

const redactPackingItems = (raw: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
};

const passThroughString = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : undefined;

const passThroughNumber = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;

/** Per-projection per-field redactor table. Each entry knows the
 *  closed shape of the value for its (projection, field) pair and
 *  rebuilds it from the raw source row. Fields NOT listed here pass
 *  through `passThroughString` (any value that isn't a plain string
 *  drops silently). This forces every nested-value redaction to be
 *  declared explicitly — adding a non-string-valued field to a
 *  projection's ceiling requires a new entry here. */
const STATUS_PROJECTION_FIELD_REDACTORS: Readonly<
  Record<StatusLinkProjectionKind, Readonly<Record<string, StatusLinkFieldRedactor>>>
> = {
  event_plan: {
    title: passThroughString,
    date: passThroughString,
    location_label: passThroughString,
    agenda_summary: passThroughString,
    visible_attendees: redactEventPlanVisibleAttendees,
    tz_label: passThroughString,
  },
  itinerary: {
    title: passThroughString,
    date_range: redactDateRange,
    visible_legs: redactItineraryVisibleLegs,
  },
  project: {
    title: passThroughString,
    state: passThroughString,
    open_commitment_count: passThroughNumber,
    last_activity_at_relative: passThroughString,
    milestone_summary: passThroughString,
  },
  packing_list: {
    title: passThroughString,
    items: redactPackingItems,
    packed_count: passThroughNumber,
    total_count: passThroughNumber,
    due_date_relative: passThroughString,
  },
  commitment_summary: {
    title: passThroughString,
    state: passThroughString,
    due_at_relative: passThroughString,
    counterparty_first_name_initial: passThroughString,
  },
  custom: {
    title: passThroughString,
    summary: passThroughString,
    updated_at_relative: passThroughString,
    tags: (raw) => {
      if (!Array.isArray(raw)) return [];
      const tags: string[] = [];
      for (const t of raw) {
        if (typeof t === 'string') tags.push(t);
      }
      return tags;
    },
  },
};

/** Closed mapping — `RedactedPacketKind` → raw input shape the builder
 *  expects. The `buildRedactedPacket` overload uses this so callers
 *  get compile-time checking on per-kind input shapes. */
export interface RedactedPacketRawByKind {
  availability: AvailabilityRawInput;
  project_status: ProjectStatusRawInput;
  commitment_summary: CommitmentSummaryRawInput;
  contact_card: ContactCardRawInput;
  event_plan: EventPlanRawInput;
  itinerary: ItineraryRawInput;
  // D-149 P2 reception kinds
  reception_page_packet: ReceptionPagePacketRawInput;
  scheduling_link_packet: SchedulingLinkPacketRawInput;
  intake_form_packet: IntakeFormPacketRawInput;
  drop_link_packet: DropLinkPacketRawInput;
  approval_link_packet: ApprovalLinkPacketRawInput;
  status_link_packet: StatusLinkPacketRawInput;
}

/** Closed mapping — `RedactedPacketKind` → wire payload shape the
 *  builder emits. Each entry mirrors the per-kind `fields_visible`
 *  list verbatim; type drift between this map and
 *  `PACKET_FIELDS_VISIBLE` is caught by the
 *  `assertRedactedPacketInvariants` ratchet. */
export interface RedactedPacketPayloadByKind {
  availability: {
    readonly free_windows: ReadonlyArray<FreeWindow>;
    readonly tz: string;
    readonly duration_options: ReadonlyArray<number>;
  };
  project_status: {
    readonly title: string;
    readonly state: string;
    readonly open_commitment_count: number;
    readonly last_activity_at_relative: string;
  };
  commitment_summary: {
    readonly direction: 'inbound' | 'outbound' | 'mixed';
    readonly state_counts: Readonly<Record<string, number>>;
    readonly oldest_pending_age_days: number;
    readonly counterparties: ReadonlyArray<string>;
  };
  contact_card: {
    readonly name: string;
    readonly network_domain: string;
  };
  event_plan: {
    readonly title: string;
    readonly date_range: { readonly start_at: number; readonly end_at: number };
    readonly free_windows: ReadonlyArray<FreeWindow>;
    readonly visible_attendees: ReadonlyArray<string>;
  };
  itinerary: {
    readonly title: string;
    readonly date_range: { readonly start_at: number; readonly end_at: number };
    readonly visible_legs: ReadonlyArray<{
      readonly title: string;
      readonly start_at: number;
      readonly end_at: number;
    }>;
  };
  // ── D-149 P2 reception payloads (§ A.4) ────────────────────────────
  reception_page_packet: {
    readonly display_name: string;
    readonly tagline: string;
    readonly avatar_url?: string;
    readonly preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
    readonly cta_buttons: ReadonlyArray<ReceptionPageCtaButton>;
    readonly tz_label: string;
    readonly response_time_estimate?: string;
  };
  scheduling_link_packet: {
    readonly free_windows: ReadonlyArray<FreeWindow>;
    readonly tz: string;
    readonly duration_options: ReadonlyArray<number>;
    readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
    readonly min_advance_notice_hours: number;
    readonly max_lead_time_days: number;
  };
  intake_form_packet: {
    readonly form_definition: IntakeFormDefinitionView;
    readonly required_fields: ReadonlyArray<string>;
    readonly optional_fields: ReadonlyArray<string>;
    readonly submit_button_label: string;
    readonly success_message_template: string;
    readonly rate_limit_hint: string;
  };
  drop_link_packet: {
    readonly size_cap_bytes: number;
    readonly allowed_mime_types: ReadonlyArray<string>;
    readonly instructions: string;
    readonly required_visitor_fields: DropLinkVisitorFieldRequirements;
    readonly one_time_use: boolean;
    readonly expiry_display: string;
  };
  approval_link_packet: {
    readonly action_kind: ApprovalLinkActionKind;
    readonly prompt: string;
    readonly options?: ReadonlyArray<ApprovalLinkOption>;
    readonly expiry_display: string;
    readonly visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
    readonly context_summary: string;
  };
  status_link_packet: {
    readonly projection_kind: StatusLinkProjectionKind;
    readonly visible_fields: Readonly<Record<string, unknown>>;
    readonly last_updated_at_relative: string;
    readonly updates_visible: boolean;
    readonly comments_enabled: boolean;
  };
}

// ── PB12.4 — RedactedPacket envelope shape ──────────────────────────

/** § B.13.1 — wire envelope. Carries the closed-list packet_kind, the
 *  closed-list `fields_visible`, the per-kind payload, and optional
 *  consumer-facing metadata (expiry / access token / audit row id).
 *
 *  Closed shape — adding a top-level field requires a substrate PR. */
export interface RedactedPacket<K extends RedactedPacketKind = RedactedPacketKind> {
  readonly packet_kind: K;
  /** Mirrors `PACKET_FIELDS_VISIBLE[K]` verbatim — included on the
   *  envelope so consumers can verify the privacy contract without
   *  re-reading the substrate registry. */
  readonly fields_visible: ReadonlyArray<string>;
  readonly payload: RedactedPacketPayloadByKind[K];
  /** Unix-ms expiry. Substrate enforces a default
   *  (`REDACTED_PACKET_DEFAULT_TTL_MS` past `created_at`) when the
   *  caller does not supply an explicit value. */
  readonly expires_at: number;
  /** Unix-ms creation timestamp. */
  readonly created_at: number;
  /** Opaque token the consumer presents to read the packet. The
   *  substrate generates a random token at build time when the caller
   *  does not supply one. */
  readonly access_token: string;
  /** D-120 audit row id (`redacted_packet.built`) so consumer-side
   *  emits (`redacted_packet.accessed`) can link back to the build
   *  row in the timeline. */
  readonly audit_target_id?: string;
}

/** § B.13.1 — default TTL is 7 days. The substrate clamps caller-
 *  supplied TTLs to `[1m, 30d]` so a malformed input cannot persist
 *  packets indefinitely or expire them before they can be consumed. */
export const REDACTED_PACKET_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REDACTED_PACKET_MIN_TTL_MS = 60 * 1000;
export const REDACTED_PACKET_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── PB12.5 — Validation issue kinds ─────────────────────────────────

/** Validator issue kinds — each closed-list reason the builder /
 *  validator can reject a build / consume call with. Pinned by the
 *  ratchet test (every kind has a triggering case). */
export const REDACTED_PACKET_VALIDATION_ISSUE_KINDS = [
  /** `packet_kind` not in `REDACTED_PACKET_KINDS`. */
  'unknown_packet_kind',
  /** Raw input failed per-kind structural validation (missing
   *  required field / wrong type). */
  'raw_input_invalid',
  /** Caller supplied an explicit `expires_at` outside the clamp
   *  window. */
  'expires_at_out_of_range',
  /** Caller supplied an `access_token` that does not match the
   *  substrate's accepted shape (non-string / empty / over-length). */
  'access_token_invalid',
  /** Token presented at consume time has expired. */
  'token_expired',
  /** Token presented at consume time does not match a stored packet. */
  'token_unknown',
] as const;
export type RedactedPacketValidationIssueKind =
  (typeof REDACTED_PACKET_VALIDATION_ISSUE_KINDS)[number];
export const REDACTED_PACKET_VALIDATION_ISSUE_KIND_SET: ReadonlySet<RedactedPacketValidationIssueKind> =
  new Set(REDACTED_PACKET_VALIDATION_ISSUE_KINDS);

export interface RedactedPacketValidationIssue {
  readonly kind: RedactedPacketValidationIssueKind;
  readonly detail?: string;
}

export class RedactedPacketValidationError extends Error {
  readonly code = 'REDACTED_PACKET_VALIDATION_ERROR' as const;
  constructor(public readonly issues: ReadonlyArray<RedactedPacketValidationIssue>) {
    super(
      `redacted_packet build/consume failed validation: ${issues
        .map((i) => `${i.kind}${i.detail !== undefined ? `(${i.detail})` : ''}`)
        .join(', ')}`,
    );
    this.name = 'RedactedPacketValidationError';
  }
}

// ── PB12.6 — Builder options + audit seam ───────────────────────────

/** Per-build options. The substrate accepts caller-supplied
 *  `expires_at` (clamped) + `access_token` (validated); when omitted,
 *  the substrate derives both from `now` + `randomToken`. */
export interface BuildRedactedPacketOptions {
  /** Unix-ms now. Injected so the builder stays pure — tests pin a
   *  deterministic clock; production passes `Date.now()`. */
  readonly now: number;
  /** Caller-supplied expiry. Clamped to
   *  `[now + REDACTED_PACKET_MIN_TTL_MS, now + max_ttl_ms]`;
   *  out-of-range values raise `expires_at_out_of_range`. Omitted →
   *  substrate uses `now + REDACTED_PACKET_DEFAULT_TTL_MS`. */
  readonly expires_at?: number;
  /** Codex review fold (2026-05-13 P1) — per-consumer max-TTL
   *  override. D-145 S2S Preview keeps the substrate's 30d ceiling
   *  (default when omitted); D-149 reception passes its 90d
   *  ceiling so `status_link` (max 90d per § N.4) doesn't fail
   *  the clamp. The substrate still applies the clamp using
   *  `opts.max_ttl_ms ?? REDACTED_PACKET_MAX_TTL_MS`, so a bug or
   *  malformed input outside the per-consumer ceiling raises
   *  `expires_at_out_of_range` — defense in depth is preserved. */
  readonly max_ttl_ms?: number;
  /** Caller-supplied access token (e.g. for deterministic test
   *  fixtures). Substrate validates it (non-empty string ≤ 256
   *  chars) and raises `access_token_invalid` otherwise. Omitted →
   *  substrate calls `randomToken` to generate one. */
  readonly access_token?: string;
  /** Random-token generator. Injected so the builder stays pure;
   *  production wires a CSPRNG-backed implementation. */
  readonly randomToken: () => string;
  /** D-120 audit emission seam. Substrate calls this with the build
   *  event payload; the wrapping audit-store wires the actual
   *  persist + activity_id assignment. Returning the activity_id lets
   *  the substrate stamp `audit_target_id` on the envelope. */
  readonly emitAudit?: RedactedPacketAuditEmitter['build'];
}

/** D-120 audit emission seam (§ B.13.3). Substrate exposes the seam
 *  rather than calling the audit store directly so callers can wire
 *  signing audit logs / per-pair auditors / test stubs against the
 *  same interface. */
export interface RedactedPacketAuditEmitter {
  /** Emit the `redacted_packet.built` row. Returns the audit row's
   *  `activity_id` so the envelope can carry it for consumer-side
   *  emit linkage. */
  build(event: RedactedPacketBuildAuditEvent): string | undefined;
  /** Emit the `redacted_packet.accessed` row. Consumer-side; the
   *  substrate exposes the helper but the consumer wires the call. */
  access(event: RedactedPacketAccessAuditEvent): void;
}

export interface RedactedPacketBuildAuditEvent {
  readonly packet_kind: RedactedPacketKind;
  readonly fields_visible: ReadonlyArray<string>;
  readonly created_at: number;
  readonly expires_at: number;
  /** Caller-provided context (e.g. recipe id, consumer hint). Free-
   *  form so adapters can carry recipe / plan id without extending
   *  the substrate. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export interface RedactedPacketAccessAuditEvent {
  readonly packet_kind: RedactedPacketKind;
  readonly fields_visible: ReadonlyArray<string>;
  readonly accessed_at: number;
  readonly audit_target_id?: string;
  readonly consumer?: string;
}

// ── PB12.7 — `computeFreeWindows` boundary primitive ────────────────

/** Compute the free windows inside `[window_start, window_end)` after
 *  subtracting every `calendar_events[i]` interval. Substrate-owned
 *  so D-149 reception + S2S Preview emit identical free_windows for
 *  the same inputs; downstream consumers can rely on the wire shape.
 *
 *  Pure function — no clock read, no IO. Returns intervals in
 *  ascending start order; adjacent free intervals are merged. */
export const computeFreeWindows = (
  calendar_events: ReadonlyArray<AvailabilityRawCalendarEvent>,
  window_start: number,
  window_end: number,
): ReadonlyArray<FreeWindow> => {
  if (!Number.isFinite(window_start) || !Number.isFinite(window_end)) return [];
  if (window_end <= window_start) return [];

  // Clip events to window + drop empties.
  const clipped: Array<{ start_at: number; end_at: number }> = [];
  for (const ev of calendar_events) {
    if (
      !ev ||
      typeof ev.start_at !== 'number' ||
      typeof ev.end_at !== 'number' ||
      !Number.isFinite(ev.start_at) ||
      !Number.isFinite(ev.end_at)
    ) {
      continue;
    }
    const start = Math.max(ev.start_at, window_start);
    const end = Math.min(ev.end_at, window_end);
    if (end > start) clipped.push({ start_at: start, end_at: end });
  }

  // Sort + merge overlapping busy intervals.
  clipped.sort((a, b) => a.start_at - b.start_at);
  const busy: Array<{ start_at: number; end_at: number }> = [];
  for (const c of clipped) {
    const last = busy[busy.length - 1];
    if (last && c.start_at <= last.end_at) {
      last.end_at = Math.max(last.end_at, c.end_at);
    } else {
      busy.push({ start_at: c.start_at, end_at: c.end_at });
    }
  }

  // Subtract busy intervals from window.
  const free: Array<FreeWindow> = [];
  let cursor = window_start;
  for (const b of busy) {
    if (b.start_at > cursor) {
      free.push({ start_at: cursor, end_at: b.start_at });
    }
    cursor = Math.max(cursor, b.end_at);
  }
  if (cursor < window_end) free.push({ start_at: cursor, end_at: window_end });

  return free;
};

// ── PB12.8 — Counterparty / attendee redaction ──────────────────────

/** Redact a full name to "first-name + last-initial" (e.g.
 *  "Mary Smith" → "Mary S."). The substrate strips middle names +
 *  honorifics; whitespace-only / single-token inputs pass through
 *  unchanged so a single-name handle ("Madonna") still renders.
 *
 *  Pure function — no IO, no locale-dependent collation. */
export const redactCounterpartyName = (name: string): string => {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  // Strip parenthetical handles ("Mary Smith (mary@example.com)").
  const stripped = trimmed.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0]!;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  // First letter of last token, uppercased + period.
  const initial = last.charAt(0).toUpperCase();
  return `${first} ${initial}.`;
};

/** § B.13.4 — relative timestamp formatter for `project_status`. Pure
 *  function over a fixed `now`. Closed buckets so the wire shape
 *  stays stable across consumers. */
export const relativizeTimestamp = (ts: number, now: number): string => {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return 'unknown';
  const delta = now - ts;
  if (delta < 0) return 'in the future';
  const sec = 1000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;
  if (delta < min) return 'just now';
  if (delta < hour) return `${Math.floor(delta / min)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  if (delta < 30 * day) return `${Math.floor(delta / (7 * day))}w ago`;
  if (delta < 365 * day) return `${Math.floor(delta / (30 * day))}mo ago`;
  return `${Math.floor(delta / (365 * day))}y ago`;
};

// ── PB12.9 — Strict-pick + boundary transformations ─────────────────

/** Strict-pick a closed-list of fields from a raw object. Only fields
 *  in `fieldsVisible` propagate; everything else is dropped at the
 *  boundary. Pure function — no IO. */
const strictPick = <T extends object>(
  source: T,
  fieldsVisible: ReadonlyArray<string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fieldsVisible) {
    if (Object.prototype.hasOwnProperty.call(source, f)) {
      out[f] = (source as Record<string, unknown>)[f];
    }
  }
  return out;
};

/** Per-kind boundary transformation table. Each entry takes the
 *  fully-typed raw input + returns the closed-shape payload. The
 *  builder calls the matching entry after `strictPick`; the pick
 *  guarantees no out-of-list field reaches the transformation, and
 *  the transformation guarantees the on-wire shape. Adding a kind
 *  requires a new entry here AND a new entry in
 *  `PACKET_FIELDS_VISIBLE` AND an update to
 *  `RedactedPacketPayloadByKind` — the ratchet test asserts the
 *  three stay in sync. */
const PACKET_TRANSFORMS: {
  [K in RedactedPacketKind]: (raw: RedactedPacketRawByKind[K]) => RedactedPacketPayloadByKind[K];
} = {
  availability: (raw) => ({
    free_windows: computeFreeWindows(raw.calendar_events, raw.window_start, raw.window_end),
    tz: raw.tz,
    duration_options: raw.duration_options,
  }),
  project_status: (raw) => ({
    title: raw.title,
    state: raw.state,
    open_commitment_count: raw.open_commitment_count,
    last_activity_at_relative: relativizeTimestamp(raw.last_activity_at, raw.now),
  }),
  commitment_summary: (raw) => {
    // Codex P2 fold (2026-05-10) — rebuild state_counts from the
    // canonical `COMMITMENT_LIFECYCLE_STATE_SET` so unknown keys
    // never propagate even if the validator lets them slip past
    // (defense in depth — the validator already gates them, but the
    // boundary rebuild closes the leak path one more time). Missing
    // states default to 0 so downstream consumers can render a
    // stable schema without per-state existence checks.
    const stateCounts: Record<string, number> = {};
    for (const state of COMMITMENT_LIFECYCLE_STATE_SET) {
      const v = raw.state_counts[state];
      stateCounts[state] = isFiniteNumber(v) ? v : 0;
    }
    return {
      direction: raw.direction,
      state_counts: stateCounts,
      oldest_pending_age_days: raw.oldest_pending_age_days,
      counterparties: raw.counterparty_full_names.map(redactCounterpartyName),
    };
  },
  contact_card: (raw) => ({
    name: raw.name,
    network_domain: raw.network_domain,
  }),
  event_plan: (raw) => ({
    title: raw.title,
    // Codex P1 fold (2026-05-10) — rebuild date_range from the closed
    // shape rather than passing `raw.date_range` through. The strict-
    // pick at the top boundary only enforces top-level fields; if the
    // caller hands a `date_range` carrying extra keys (`location_id`,
    // `calendar_id`, `description`), those nested extras would
    // serialize verbatim into the visible payload. Explicit rebuild
    // closes the nested-leak path.
    date_range: { start_at: raw.date_range.start_at, end_at: raw.date_range.end_at },
    free_windows: computeFreeWindows(raw.calendar_events, raw.window_start, raw.window_end),
    visible_attendees: raw.attendee_full_names.map(redactCounterpartyName),
  }),
  itinerary: (raw) => ({
    title: raw.title,
    // Codex P1 fold (2026-05-10) — same nested-leak invariant as
    // `event_plan` above; rebuild date_range from the closed shape so
    // a caller-supplied `date_range.notes` / `date_range.timezone_id`
    // can't slip through the substrate boundary.
    date_range: { start_at: raw.date_range.start_at, end_at: raw.date_range.end_at },
    visible_legs: raw.legs.map((leg) => ({
      title: leg.title,
      start_at: leg.start_at,
      end_at: leg.end_at,
    })),
  }),
  // ── D-149 P2 reception transforms (§ A.4) ──────────────────────────
  reception_page_packet: (raw) => {
    // Project cta_buttons from section_config + linked_endpoints. The
    // section toggle gates each CTA — a missing toggle (or false)
    // means the CTA is suppressed even if the linked endpoint id is
    // set. Rebuilds the array from the closed-shape items so caller-
    // supplied extras can't smuggle through the boundary.
    const ctaButtons: ReceptionPageCtaButton[] = projectReceptionPageCtaButtons(
      raw.section_config,
      raw.linked_endpoints,
    );
    const payload: {
      display_name: string;
      tagline: string;
      avatar_url?: string;
      preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
      cta_buttons: ReadonlyArray<ReceptionPageCtaButton>;
      tz_label: string;
      response_time_estimate?: string;
    } = {
      display_name: raw.display_name,
      tagline: raw.tagline,
      preferred_contact_methods: raw.preferred_contact_methods,
      cta_buttons: ctaButtons,
      tz_label: raw.tz_label,
    };
    if (raw.avatar_url !== undefined) payload.avatar_url = raw.avatar_url;
    if (raw.response_time_estimate !== undefined) {
      payload.response_time_estimate = raw.response_time_estimate;
    }
    return payload;
  },
  scheduling_link_packet: (raw) => ({
    free_windows: computeFreeWindows(raw.calendar_events, raw.window_start, raw.window_end),
    tz: raw.tz,
    duration_options: raw.duration_options,
    // Rebuild from the closed shape — closes the nested-leak path
    // even if the caller hands a richer `required_visitor_fields`
    // (extra keys can't slip through the strict-pick because the
    // boundary picks top-level fields only).
    required_visitor_fields: {
      name: raw.required_visitor_fields.name,
      email: raw.required_visitor_fields.email,
      topic: raw.required_visitor_fields.topic,
      phone: raw.required_visitor_fields.phone,
      notes: raw.required_visitor_fields.notes,
    },
    min_advance_notice_hours: raw.min_advance_notice_hours,
    max_lead_time_days: raw.max_lead_time_days,
  }),
  intake_form_packet: (raw) => {
    // Rebuild form_definition from closed shape — strips any extra
    // keys (e.g., `per_field_visibility` metadata) the caller might
    // have left attached. The visitor-visible-fields array is
    // rebuilt per-item for the same reason.
    const visibleFields = raw.form_definition.visitor_visible_fields.map((f) => ({
      name: f.name,
      type: f.type,
      label: f.label,
      required: f.required,
    }));
    // Codex review fold (2026-05-13 P2) — intersect the
    // required/optional name arrays with the visitor-visible field
    // set. If the source row carries names referring to user-only
    // metadata fields (e.g., `internal_classification`), those names
    // would leak through verbatim AND the public form would require
    // / mention fields not rendered. Intersection forces the visitor-
    // visible payload to remain self-consistent.
    const visibleNames = new Set(visibleFields.map((f) => f.name));
    const required = raw.required_fields.filter((name) => visibleNames.has(name));
    const optional = raw.optional_fields.filter((name) => visibleNames.has(name));
    return {
      form_definition: {
        form_definition_id: raw.form_definition.form_definition_id,
        visitor_visible_fields: visibleFields,
      },
      required_fields: required,
      optional_fields: optional,
      submit_button_label: raw.submit_button_label,
      success_message_template: raw.success_message_template,
      rate_limit_hint: raw.rate_limit_hint,
    };
  },
  drop_link_packet: (raw) => ({
    size_cap_bytes: raw.size_cap_bytes,
    allowed_mime_types: [...raw.allowed_mime_types],
    instructions: raw.instructions,
    required_visitor_fields: {
      name: raw.required_visitor_fields.name,
      email: raw.required_visitor_fields.email,
      description: raw.required_visitor_fields.description,
    },
    one_time_use: raw.one_time_use,
    expiry_display: raw.expiry_display,
  }),
  approval_link_packet: (raw) => {
    const base: {
      action_kind: ApprovalLinkActionKind;
      prompt: string;
      options?: ReadonlyArray<ApprovalLinkOption>;
      expiry_display: string;
      visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
      context_summary: string;
    } = {
      action_kind: raw.action_kind,
      prompt: raw.prompt,
      expiry_display: raw.expiry_display,
      // Rebuild constraints from closed shape; require_email_match
      // is optional + propagates verbatim when present.
      visitor_field_constraints: {
        name: raw.visitor_field_constraints.name,
        email: raw.visitor_field_constraints.email,
        ...(raw.visitor_field_constraints.require_email_match !== undefined
          ? { require_email_match: raw.visitor_field_constraints.require_email_match }
          : {}),
      },
      // The boundary returns ONLY the `summary` from context_raw;
      // counterparty_aliases + private_notes never propagate.
      context_summary: raw.context_raw.summary,
    };
    if (raw.options !== undefined) {
      base.options = raw.options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.description !== undefined ? { description: o.description } : {}),
      }));
    }
    return base;
  },
  status_link_packet: (raw) => {
    const ceiling = STATUS_PROJECTION_FIELDS_VISIBLE[raw.projection_kind];
    // Override is clamped to the ceiling; an override that names a
    // field NOT in the ceiling drops the field silently (defense in
    // depth — the validator already gates ceiling membership at
    // build time; this re-pick closes the leak path even if the
    // validator regresses).
    const allowed = raw.fields_visible_override
      ? raw.fields_visible_override.filter((f) => ceiling.includes(f))
      : ceiling;
    // Codex review fold (2026-05-13 P1) — per-projection per-field
    // redactor. The top-level ceiling pick is necessary but NOT
    // sufficient: nested values under an allowed key (e.g.,
    // `itinerary.visible_legs[*].confirmation_number`) would leak
    // verbatim without per-field rebuild. The redactor table
    // declares the closed shape per (projection, field) pair and
    // rebuilds each value from the raw source row.
    const redactors = STATUS_PROJECTION_FIELD_REDACTORS[raw.projection_kind];
    const visible_fields: Record<string, unknown> = {};
    for (const f of allowed) {
      if (!Object.prototype.hasOwnProperty.call(raw.source_entity_row, f)) continue;
      const redactor = redactors[f] ?? passThroughString;
      const redacted = redactor(raw.source_entity_row[f]);
      if (redacted !== undefined) visible_fields[f] = redacted;
    }
    return {
      projection_kind: raw.projection_kind,
      visible_fields,
      last_updated_at_relative: relativizeTimestamp(raw.last_updated_at, raw.now),
      updates_visible: raw.updates_visible,
      comments_enabled: raw.comments_enabled,
    };
  },
};

/** § A.5.1 — project CTA buttons from the user's section toggles +
 *  linked endpoint ids. Pure function. Each CTA appears only when
 *  BOTH the section is enabled AND the linked endpoint id is set
 *  (a section toggled on without an endpoint id is a configuration
 *  in progress; the CTA stays hidden until the link is wired).
 *
 *  Codex review P2 fold (2026-05-13 P4) — the `href` field is
 *  required on `ReceptionPageCtaButton`. Source: the matching
 *  `<kind>_share_url` from `linked_endpoints` when set; else a
 *  token-less `/reception/<kind>/<endpoint_id>` fallback. The
 *  fallback lets Mary wire CTAs that visitors see as "Schedule a
 *  meeting" while she still shares the bearer-carrying URL
 *  out-of-band; visitors who click the CTA without the token URL
 *  land on the link-style handler's 401 (P5+ wires friendly copy
 *  there). With share_url captured, the CTA round-trips end-to-end. */
const PATH_SEGMENT_BY_CTA_KIND: Readonly<
  Record<ReceptionPageCtaButton['kind'], string>
> = {
  scheduling_link: 'scheduling',
  intake_form: 'intake',
  drop_link: 'drop',
};

const projectReceptionPageCtaButtons = (
  section_config: ReceptionPageSectionConfig | undefined,
  linked_endpoints: ReceptionPageLinkedEndpoints | undefined,
): ReceptionPageCtaButton[] => {
  const buttons: ReceptionPageCtaButton[] = [];
  if (!section_config || !linked_endpoints) return buttons;
  const pickHref = (
    kind: ReceptionPageCtaButton['kind'],
    endpoint_id: string,
    share_url: string | undefined,
  ): string => {
    if (typeof share_url === 'string' && share_url.length > 0) return share_url;
    return `/reception/${PATH_SEGMENT_BY_CTA_KIND[kind]}/${endpoint_id}`;
  };
  if (
    section_config.availability_cta === true &&
    typeof linked_endpoints.scheduling_link_endpoint_id === 'string' &&
    linked_endpoints.scheduling_link_endpoint_id.length > 0
  ) {
    buttons.push({
      label: 'Schedule a meeting',
      endpoint_id: linked_endpoints.scheduling_link_endpoint_id,
      kind: 'scheduling_link',
      href: pickHref(
        'scheduling_link',
        linked_endpoints.scheduling_link_endpoint_id,
        linked_endpoints.scheduling_link_share_url,
      ),
    });
  }
  if (
    section_config.intake_cta === true &&
    typeof linked_endpoints.intake_form_endpoint_id === 'string' &&
    linked_endpoints.intake_form_endpoint_id.length > 0
  ) {
    buttons.push({
      label: 'Send a message',
      endpoint_id: linked_endpoints.intake_form_endpoint_id,
      kind: 'intake_form',
      href: pickHref(
        'intake_form',
        linked_endpoints.intake_form_endpoint_id,
        linked_endpoints.intake_form_share_url,
      ),
    });
  }
  if (
    section_config.drop_cta === true &&
    typeof linked_endpoints.drop_link_endpoint_id === 'string' &&
    linked_endpoints.drop_link_endpoint_id.length > 0
  ) {
    buttons.push({
      label: 'Drop a file',
      endpoint_id: linked_endpoints.drop_link_endpoint_id,
      kind: 'drop_link',
      href: pickHref(
        'drop_link',
        linked_endpoints.drop_link_endpoint_id,
        linked_endpoints.drop_link_share_url,
      ),
    });
  }
  return buttons;
};

// ── PB12.10 — Per-kind raw-input validators ─────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown): v is ReadonlyArray<string> =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const isNumberArray = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) && v.every(isFiniteNumber);

const isCalendarEventArray = (v: unknown): v is ReadonlyArray<AvailabilityRawCalendarEvent> =>
  Array.isArray(v) &&
  v.every(
    (ev) =>
      ev !== null &&
      typeof ev === 'object' &&
      isFiniteNumber((ev as { start_at: unknown }).start_at) &&
      isFiniteNumber((ev as { end_at: unknown }).end_at),
  );

/** Codex P2 fold (2026-05-10) — narrow `state_counts` to the canonical
 *  `COMMITMENT_LIFECYCLE_STATE_SET` keys (`pending` / `fulfilled` /
 *  `cancelled` / `expired`). The previous validator allowed arbitrary
 *  string keys; a malformed caller could smuggle sensitive labels
 *  (counterparty names, project handles) through the visible
 *  `state_counts` field by setting them as keys with numeric values.
 *  Rebuilding through the closed-list state set in
 *  `commitment_summary` transform also drops unknown keys at the
 *  boundary; the validator gate raises `raw_input_invalid` so the
 *  caller surfaces the bug rather than silently dropping their data. */
const isStateCounts = (v: unknown): v is Readonly<Record<string, number>> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!COMMITMENT_LIFECYCLE_STATE_SET.has(key as never)) return false;
    if (!isFiniteNumber(value)) return false;
  }
  return true;
};

const isDateRange = (v: unknown): v is { start_at: number; end_at: number } =>
  v !== null &&
  typeof v === 'object' &&
  isFiniteNumber((v as { start_at: unknown }).start_at) &&
  isFiniteNumber((v as { end_at: unknown }).end_at);

const isLegArray = (v: unknown): v is ReadonlyArray<ItineraryLegRawInput> =>
  Array.isArray(v) &&
  v.every(
    (leg) =>
      leg !== null &&
      typeof leg === 'object' &&
      isNonEmptyString((leg as { title: unknown }).title) &&
      isFiniteNumber((leg as { start_at: unknown }).start_at) &&
      isFiniteNumber((leg as { end_at: unknown }).end_at),
  );

/** Per-kind raw-input validator. Returns the issue array (empty =
 *  valid). Substrate calls this before strict-pick so a malformed
 *  input never reaches the transformation hook. */
const validateRawInput = (
  kind: RedactedPacketKind,
  raw: unknown,
): ReadonlyArray<RedactedPacketValidationIssue> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ kind: 'raw_input_invalid', detail: `raw input is not an object (kind=${kind})` }];
  }
  const r = raw as Record<string, unknown>;
  switch (kind) {
    case 'availability':
      if (
        !isCalendarEventArray(r.calendar_events) ||
        !isFiniteNumber(r.window_start) ||
        !isFiniteNumber(r.window_end) ||
        !isNonEmptyString(r.tz) ||
        !isNumberArray(r.duration_options)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'availability shape mismatch' }];
      }
      return [];
    case 'project_status':
      if (
        !isNonEmptyString(r.title) ||
        !isNonEmptyString(r.state) ||
        !isFiniteNumber(r.open_commitment_count) ||
        !isFiniteNumber(r.last_activity_at) ||
        !isFiniteNumber(r.now)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'project_status shape mismatch' }];
      }
      return [];
    case 'commitment_summary':
      if (
        (r.direction !== 'inbound' && r.direction !== 'outbound' && r.direction !== 'mixed') ||
        !isStateCounts(r.state_counts) ||
        !isFiniteNumber(r.oldest_pending_age_days) ||
        !isStringArray(r.counterparty_full_names)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'commitment_summary shape mismatch' }];
      }
      return [];
    case 'contact_card':
      if (!isNonEmptyString(r.name) || !isNonEmptyString(r.network_domain)) {
        return [{ kind: 'raw_input_invalid', detail: 'contact_card shape mismatch' }];
      }
      return [];
    case 'event_plan':
      if (
        !isNonEmptyString(r.title) ||
        !isDateRange(r.date_range) ||
        !isCalendarEventArray(r.calendar_events) ||
        !isFiniteNumber(r.window_start) ||
        !isFiniteNumber(r.window_end) ||
        !isStringArray(r.attendee_full_names)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'event_plan shape mismatch' }];
      }
      return [];
    case 'itinerary':
      if (
        !isNonEmptyString(r.title) ||
        !isDateRange(r.date_range) ||
        !isLegArray(r.legs)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'itinerary shape mismatch' }];
      }
      return [];
    // ── D-149 P2 reception validators ─────────────────────────────────
    case 'reception_page_packet':
      // D-149 P4 — tagline is optional copy (per § A.5.1 the page can
      // ship just display_name + contact card without a tagline). The
      // validator accepts any string (including empty); the renderer
      // suppresses an empty tagline so the visitor never sees an empty
      // `<p>` block.
      if (
        !isNonEmptyString(r.display_name) ||
        typeof r.tagline !== 'string' ||
        !isPreferredContactMethodArray(r.preferred_contact_methods) ||
        !isNonEmptyString(r.tz_label)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'reception_page_packet shape mismatch' }];
      }
      if (r.avatar_url !== undefined && typeof r.avatar_url !== 'string') {
        return [{ kind: 'raw_input_invalid', detail: 'reception_page_packet.avatar_url must be string' }];
      }
      if (r.response_time_estimate !== undefined && typeof r.response_time_estimate !== 'string') {
        return [{ kind: 'raw_input_invalid', detail: 'reception_page_packet.response_time_estimate must be string' }];
      }
      if (r.section_config !== undefined && !isSectionConfig(r.section_config)) {
        return [{ kind: 'raw_input_invalid', detail: 'reception_page_packet.section_config shape mismatch' }];
      }
      if (r.linked_endpoints !== undefined && !isLinkedEndpoints(r.linked_endpoints)) {
        return [{ kind: 'raw_input_invalid', detail: 'reception_page_packet.linked_endpoints shape mismatch' }];
      }
      return [];
    case 'scheduling_link_packet':
      if (
        !isCalendarEventArray(r.calendar_events) ||
        !isFiniteNumber(r.window_start) ||
        !isFiniteNumber(r.window_end) ||
        !isNonEmptyString(r.tz) ||
        !isNumberArray(r.duration_options) ||
        !isSchedulingVisitorFieldRequirements(r.required_visitor_fields) ||
        !isFiniteNumber(r.min_advance_notice_hours) ||
        !isFiniteNumber(r.max_lead_time_days)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'scheduling_link_packet shape mismatch' }];
      }
      return [];
    case 'intake_form_packet':
      if (
        !isIntakeFormDefinitionView(r.form_definition) ||
        !isStringArray(r.required_fields) ||
        !isStringArray(r.optional_fields) ||
        !isNonEmptyString(r.submit_button_label) ||
        typeof r.success_message_template !== 'string' ||
        typeof r.rate_limit_hint !== 'string'
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'intake_form_packet shape mismatch' }];
      }
      return [];
    case 'drop_link_packet':
      if (
        !isFiniteNumber(r.size_cap_bytes) ||
        r.size_cap_bytes <= 0 ||
        !isStringArray(r.allowed_mime_types) ||
        typeof r.instructions !== 'string' ||
        !isDropLinkVisitorFieldRequirements(r.required_visitor_fields) ||
        typeof r.one_time_use !== 'boolean' ||
        typeof r.expiry_display !== 'string'
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'drop_link_packet shape mismatch' }];
      }
      return [];
    case 'approval_link_packet':
      if (
        !isApprovalActionKind(r.action_kind) ||
        !isNonEmptyString(r.prompt) ||
        typeof r.expiry_display !== 'string' ||
        !isApprovalVisitorFieldConstraints(r.visitor_field_constraints) ||
        !isApprovalContextRaw(r.context_raw)
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'approval_link_packet shape mismatch' }];
      }
      if (r.options !== undefined && !isApprovalOptionArray(r.options)) {
        return [{ kind: 'raw_input_invalid', detail: 'approval_link_packet.options shape mismatch' }];
      }
      return [];
    case 'status_link_packet':
      if (
        !isStatusProjectionKind(r.projection_kind) ||
        !isSourceEntityRow(r.source_entity_row) ||
        !isFiniteNumber(r.last_updated_at) ||
        !isFiniteNumber(r.now) ||
        typeof r.updates_visible !== 'boolean' ||
        typeof r.comments_enabled !== 'boolean'
      ) {
        return [{ kind: 'raw_input_invalid', detail: 'status_link_packet shape mismatch' }];
      }
      if (r.fields_visible_override !== undefined && !isStringArray(r.fields_visible_override)) {
        return [{ kind: 'raw_input_invalid', detail: 'status_link_packet.fields_visible_override must be string[]' }];
      }
      return [];
    default: {
      // Exhaustiveness check — adding a new kind without updating
      // this switch surfaces here.
      const _exhaustive: never = kind;
      void _exhaustive;
      return [{ kind: 'unknown_packet_kind', detail: String(kind) }];
    }
  }
};

// ── D-149 P2 reception per-kind type guards ─────────────────────────

const isPreferredContactMethodArray = (
  v: unknown,
): v is ReadonlyArray<ReceptionPagePreferredContactMethod> =>
  Array.isArray(v) &&
  v.every((m) =>
    typeof m === 'string' &&
    RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET.has(m as ReceptionPagePreferredContactMethod),
  );

const isSectionConfig = (v: unknown): v is ReceptionPageSectionConfig => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const allowed = [
    'contact_card',
    'contact_methods',
    'availability_cta',
    'intake_cta',
    'drop_cta',
    'custom_links',
    'link_buttons',
  ] as const;
  for (const key of Object.keys(r)) {
    if (!allowed.includes(key as (typeof allowed)[number])) return false;
    if (r[key] !== undefined && typeof r[key] !== 'boolean') return false;
  }
  return true;
};

const isLinkedEndpoints = (v: unknown): v is ReceptionPageLinkedEndpoints => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const allowed = [
    'scheduling_link_endpoint_id',
    'intake_form_endpoint_id',
    'drop_link_endpoint_id',
    // D-149 P4 Codex review fold (2026-05-13) — per-CTA full share
    // URLs Mary captures from create-rpc. Type-gated below as
    // string-when-present like the endpoint_id slots.
    'scheduling_link_share_url',
    'intake_form_share_url',
    'drop_link_share_url',
  ] as const;
  for (const key of Object.keys(r)) {
    if (!allowed.includes(key as (typeof allowed)[number])) return false;
    if (r[key] !== undefined && typeof r[key] !== 'string') return false;
  }
  return true;
};

/** Codex review fold (2026-05-13 P2) — per-field allowed values per
 *  spec § A.5.2 line 609-615. `name` MUST be `'required'`; `email` /
 *  `topic` are `'required' | 'optional'`; `phone` / `notes` are
 *  `'optional' | 'omit'`. The shared `SchedulingLinkVisitorFieldRequirement`
 *  union is broader (union of all three values) so the validator
 *  gates each field against its OWN allowed set rather than the
 *  union — closes the contract-leak path where e.g. a malformed
 *  endpoint published a scheduler that required `notes` or omitted
 *  `email`. */
const SCHEDULING_LINK_PER_FIELD_ALLOWED: Readonly<
  Record<keyof SchedulingLinkVisitorFieldRequirements, ReadonlySet<SchedulingLinkVisitorFieldRequirement>>
> = {
  name: new Set<SchedulingLinkVisitorFieldRequirement>(['required']),
  email: new Set<SchedulingLinkVisitorFieldRequirement>(['required', 'optional']),
  topic: new Set<SchedulingLinkVisitorFieldRequirement>(['required', 'optional']),
  phone: new Set<SchedulingLinkVisitorFieldRequirement>(['optional', 'omit']),
  notes: new Set<SchedulingLinkVisitorFieldRequirement>(['optional', 'omit']),
};

const isSchedulingVisitorFieldRequirements = (
  v: unknown,
): v is SchedulingLinkVisitorFieldRequirements => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  for (const key of ['name', 'email', 'topic', 'phone', 'notes'] as const) {
    const value = r[key];
    if (typeof value !== 'string') return false;
    const allowed = SCHEDULING_LINK_PER_FIELD_ALLOWED[key];
    if (!allowed.has(value as SchedulingLinkVisitorFieldRequirement)) return false;
  }
  return true;
};

const isIntakeFormDefinitionView = (v: unknown): v is IntakeFormDefinitionView => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!isNonEmptyString(r.form_definition_id)) return false;
  if (!Array.isArray(r.visitor_visible_fields)) return false;
  for (const field of r.visitor_visible_fields) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return false;
    const f = field as Record<string, unknown>;
    if (
      !isNonEmptyString(f.name) ||
      typeof f.type !== 'string' ||
      !INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(f.type as IntakeFormVisitorFieldType) ||
      typeof f.label !== 'string' ||
      typeof f.required !== 'boolean'
    ) {
      return false;
    }
  }
  return true;
};

/** Codex review fold (2026-05-13 P2) — per-field allowed values per
 *  spec § A.5.4 line 783-786. None of the three drop_link visitor
 *  fields may be `'omit'`: `name` / `email` are `'required' | 'optional'`,
 *  `description` is `'optional' | 'required'`. The shared
 *  `DropLinkVisitorFieldRequirement` union is broader so the
 *  validator gates per-field. */
const DROP_LINK_PER_FIELD_ALLOWED: Readonly<
  Record<keyof DropLinkVisitorFieldRequirements, ReadonlySet<DropLinkVisitorFieldRequirement>>
> = {
  name: new Set<DropLinkVisitorFieldRequirement>(['required', 'optional']),
  email: new Set<DropLinkVisitorFieldRequirement>(['required', 'optional']),
  description: new Set<DropLinkVisitorFieldRequirement>(['required', 'optional']),
};

const isDropLinkVisitorFieldRequirements = (
  v: unknown,
): v is DropLinkVisitorFieldRequirements => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  for (const key of ['name', 'email', 'description'] as const) {
    const value = r[key];
    if (typeof value !== 'string') return false;
    const allowed = DROP_LINK_PER_FIELD_ALLOWED[key];
    if (!allowed.has(value as DropLinkVisitorFieldRequirement)) return false;
  }
  return true;
};

const isApprovalActionKind = (v: unknown): v is ApprovalLinkActionKind =>
  typeof v === 'string' && APPROVAL_LINK_ACTION_KIND_SET.has(v as ApprovalLinkActionKind);

const isApprovalOptionArray = (v: unknown): v is ReadonlyArray<ApprovalLinkOption> =>
  Array.isArray(v) &&
  v.every((o) => {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
    const opt = o as Record<string, unknown>;
    if (!isNonEmptyString(opt.id) || !isNonEmptyString(opt.label)) return false;
    if (opt.description !== undefined && typeof opt.description !== 'string') return false;
    return true;
  });

const isApprovalVisitorFieldConstraints = (
  v: unknown,
): v is ApprovalLinkVisitorFieldConstraints => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.name !== 'required' && r.name !== 'optional') return false;
  if (r.email !== 'required' && r.email !== 'optional') return false;
  if (r.require_email_match !== undefined && typeof r.require_email_match !== 'string') return false;
  return true;
};

const isApprovalContextRaw = (v: unknown): v is ApprovalLinkContextRaw => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.summary !== 'string') return false;
  if (r.counterparty_aliases !== undefined && !isStringArray(r.counterparty_aliases)) return false;
  if (r.private_notes !== undefined && !isStringArray(r.private_notes)) return false;
  return true;
};

const isStatusProjectionKind = (v: unknown): v is StatusLinkProjectionKind =>
  typeof v === 'string' && STATUS_LINK_PROJECTION_KIND_SET.has(v as StatusLinkProjectionKind);

const isSourceEntityRow = (v: unknown): v is Readonly<Record<string, unknown>> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ── PB12.11 — Token + expiry helpers ────────────────────────────────

/** Maximum length the substrate accepts for a caller-supplied
 *  `access_token`. 256 chars covers UUIDv4 + base64-encoded 32-byte
 *  tokens with margin. */
export const REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH = 256;

/** Validate caller-supplied access token shape. */
const isValidAccessToken = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH;

/** True when `now` ≥ `packet.expires_at`. Pure function — substrate
 *  exposes for consumer-side expiry checks (`s2s_preview.consume`
 *  calls this before fetching the payload). */
export const isPacketExpired = (packet: Pick<RedactedPacket, 'expires_at'>, now: number): boolean =>
  Number.isFinite(now) && now >= packet.expires_at;

/** Validate access token shape at consumer side. Returns issue
 *  array (empty = valid). */
export const validateAccessToken = (
  token: unknown,
): ReadonlyArray<RedactedPacketValidationIssue> => {
  if (!isValidAccessToken(token)) {
    return [{ kind: 'access_token_invalid', detail: 'token must be 1-256 char string' }];
  }
  return [];
};

// ── PB12.12 — buildRedactedPacket ───────────────────────────────────

/** § B.13.3 — strict-pick + per-kind transformation + audit emit.
 *  Throws `RedactedPacketValidationError` on bad input; never throws
 *  on a successful build.
 *
 *  Determinism: all clock + token reads are injected via opts so the
 *  builder is testable with a fixed seed. */
export const buildRedactedPacket = <K extends RedactedPacketKind>(
  kind: K,
  raw: RedactedPacketRawByKind[K],
  opts: BuildRedactedPacketOptions,
  context?: Readonly<Record<string, string | number | boolean>>,
): RedactedPacket<K> => {
  const issues: RedactedPacketValidationIssue[] = [];
  if (!REDACTED_PACKET_KIND_SET.has(kind)) {
    issues.push({ kind: 'unknown_packet_kind', detail: String(kind) });
    throw new RedactedPacketValidationError(issues);
  }

  if (!isFiniteNumber(opts.now)) {
    throw new RedactedPacketValidationError([
      { kind: 'raw_input_invalid', detail: 'opts.now must be a finite number' },
    ]);
  }

  const rawIssues = validateRawInput(kind, raw);
  for (const i of rawIssues) issues.push(i);
  if (issues.length > 0) throw new RedactedPacketValidationError(issues);

  // Resolve expiry — clamp caller-supplied or derive default.
  // Codex review fold (2026-05-13 P1) — `opts.max_ttl_ms` lets the
  // wrapping consumer (D-149 reception) raise the substrate's 30d
  // ceiling for kinds with longer ceilings (status_link max 90d).
  // The clamp still applies; bad inputs still raise.
  let expires_at: number;
  const maxTtlMs =
    opts.max_ttl_ms !== undefined && isFiniteNumber(opts.max_ttl_ms) && opts.max_ttl_ms > 0
      ? opts.max_ttl_ms
      : REDACTED_PACKET_MAX_TTL_MS;
  if (opts.expires_at !== undefined) {
    if (!isFiniteNumber(opts.expires_at)) {
      issues.push({ kind: 'expires_at_out_of_range', detail: String(opts.expires_at) });
      throw new RedactedPacketValidationError(issues);
    }
    const min = opts.now + REDACTED_PACKET_MIN_TTL_MS;
    const max = opts.now + maxTtlMs;
    if (opts.expires_at < min || opts.expires_at > max) {
      issues.push({
        kind: 'expires_at_out_of_range',
        detail: `expires_at=${opts.expires_at} outside [${min}, ${max}]`,
      });
      throw new RedactedPacketValidationError(issues);
    }
    expires_at = opts.expires_at;
  } else {
    expires_at = opts.now + REDACTED_PACKET_DEFAULT_TTL_MS;
  }

  // Resolve access token — validate caller-supplied or generate.
  let access_token: string;
  if (opts.access_token !== undefined) {
    const tokenIssues = validateAccessToken(opts.access_token);
    for (const i of tokenIssues) issues.push(i);
    if (issues.length > 0) throw new RedactedPacketValidationError(issues);
    access_token = opts.access_token;
  } else {
    const generated = opts.randomToken();
    if (!isValidAccessToken(generated)) {
      throw new RedactedPacketValidationError([
        {
          kind: 'access_token_invalid',
          detail: 'randomToken() returned an invalid token shape',
        },
      ]);
    }
    access_token = generated;
  }

  // Strict-pick (defense in depth) — closes the boundary even if the
  // raw input carries extra fields. The transform reads from `raw`
  // directly (typed by `RedactedPacketRawByKind[K]`) but the strict-
  // pick proves the substrate honours the closed list at runtime.
  const fields_visible = PACKET_FIELDS_VISIBLE[kind];
  const _picked = strictPick(raw as object, fields_visible);
  void _picked;

  const transform = PACKET_TRANSFORMS[kind] as (
    r: RedactedPacketRawByKind[K],
  ) => RedactedPacketPayloadByKind[K];
  const payload = transform(raw);

  // Defense-in-depth — strict-pick the transform output against the
  // closed list. Every field in `payload` MUST appear in
  // `fields_visible`; the transform tables are typed but a future
  // edit could regress. The strict-pick guarantees the on-wire
  // payload never carries a field outside the closed list.
  const enforced = strictPick(payload as unknown as object, fields_visible);

  const created_at = opts.now;

  // Audit emit — substrate hands the build event to the seam; the
  // wrapping audit-store assigns the activity_id. Returned id is
  // stamped on the envelope so consumer-side emits link back.
  let audit_target_id: string | undefined;
  if (opts.emitAudit) {
    audit_target_id = opts.emitAudit({
      packet_kind: kind,
      fields_visible,
      created_at,
      expires_at,
      ...(context !== undefined ? { context } : {}),
    });
  }

  const envelope: RedactedPacket<K> = {
    packet_kind: kind,
    fields_visible,
    payload: enforced as unknown as RedactedPacketPayloadByKind[K],
    expires_at,
    created_at,
    access_token,
    ...(audit_target_id !== undefined ? { audit_target_id } : {}),
  };
  return envelope;
};

// ── PB12.13 — Substrate self-check (ratchet) ────────────────────────

/** § B.13.6 — validator-load ratchet. Asserts every entry in
 *  `REDACTED_PACKET_KINDS` has matching declarations across the
 *  three substrate registries:
 *    - `PACKET_FIELDS_VISIBLE` — non-empty closed-list per kind.
 *    - `PACKET_TRANSFORMS` — implementation per kind (this is checked
 *      structurally via the transform-table key set).
 *    - The TypeScript `RedactedPacketPayloadByKind` map — checked at
 *      compile time via the transform table's typed signature.
 *
 *  Throws `RedactedPacketValidationError` on substrate misconfig so
 *  registry drift surfaces at module load (callers wire this into
 *  the boot path). */
export const assertRedactedPacketInvariants = (): void => {
  const issues: RedactedPacketValidationIssue[] = [];
  // The closed list is statically declared so the empty-tuple branch
  // is impossible at runtime; the cast lets the defensive check
  // survive `as const`'s literal-length narrowing without a
  // tautological-comparison warning. If a future edit ever drops the
  // tuple to zero entries, this guard surfaces it at boot.
  if ((REDACTED_PACKET_KINDS as ReadonlyArray<RedactedPacketKind>).length === 0) {
    issues.push({ kind: 'unknown_packet_kind', detail: 'REDACTED_PACKET_KINDS is empty' });
  }
  if (REDACTED_PACKET_KIND_SET.size !== REDACTED_PACKET_KINDS.length) {
    issues.push({
      kind: 'unknown_packet_kind',
      detail: 'REDACTED_PACKET_KINDS contains duplicates',
    });
  }
  for (const kind of REDACTED_PACKET_KINDS) {
    const fields = PACKET_FIELDS_VISIBLE[kind];
    if (!fields || fields.length === 0) {
      issues.push({
        kind: 'unknown_packet_kind',
        detail: `PACKET_FIELDS_VISIBLE missing or empty for '${kind}'`,
      });
    } else {
      // Per-kind list must be deduplicated.
      if (new Set(fields).size !== fields.length) {
        issues.push({
          kind: 'unknown_packet_kind',
          detail: `PACKET_FIELDS_VISIBLE['${kind}'] contains duplicates`,
        });
      }
    }
    if (typeof (PACKET_TRANSFORMS as Record<string, unknown>)[kind] !== 'function') {
      issues.push({
        kind: 'unknown_packet_kind',
        detail: `PACKET_TRANSFORMS missing transform for '${kind}'`,
      });
    }
  }
  // Symmetric — every key in `PACKET_FIELDS_VISIBLE` must be in
  // `REDACTED_PACKET_KINDS`. Catches registry drift in either
  // direction.
  for (const k of Object.keys(PACKET_FIELDS_VISIBLE)) {
    if (!REDACTED_PACKET_KIND_SET.has(k as RedactedPacketKind)) {
      issues.push({
        kind: 'unknown_packet_kind',
        detail: `PACKET_FIELDS_VISIBLE has unknown kind '${k}'`,
      });
    }
  }
  for (const k of Object.keys(PACKET_TRANSFORMS)) {
    if (!REDACTED_PACKET_KIND_SET.has(k as RedactedPacketKind)) {
      issues.push({
        kind: 'unknown_packet_kind',
        detail: `PACKET_TRANSFORMS has unknown kind '${k}'`,
      });
    }
  }
  if (issues.length > 0) throw new RedactedPacketValidationError(issues);
};

// ── PB12.14 — S2S Preview rpc shapes ────────────────────────────────

/** Input shape for the `s2s_preview.build` rpc. Substrate exposes the
 *  closed-shape request so the rpc layer + the engine + UI all
 *  reference one type.
 *
 *  `raw` is intentionally typed `unknown` at the wire boundary — the
 *  handler dispatches per `packet_kind` and runs the per-kind
 *  validator; callers that hold the full raw input shape can use the
 *  `buildRedactedPacket` direct API instead. */
export interface S2SPreviewBuildRequest {
  readonly packet_kind: RedactedPacketKind;
  readonly raw: unknown;
  readonly opts?: {
    readonly expires_at?: number;
    readonly access_token?: string;
    readonly context?: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface S2SPreviewBuildResponse {
  readonly packet: RedactedPacket;
}

/** Input shape for the `s2s_preview.consume` rpc. The handler
 *  validates the token shape + expiry, looks up the persisted
 *  packet, and returns it to the consumer. */
export interface S2SPreviewConsumeRequest {
  readonly access_token: string;
  /** Optional consumer hint (e.g. peer instance id) recorded on the
   *  `redacted_packet.accessed` audit row. Substrate trusts the
   *  caller — the consumer side is responsible for populating it
   *  faithfully. */
  readonly consumer?: string;
}

export interface S2SPreviewConsumeResponse {
  readonly packet: RedactedPacket;
}
