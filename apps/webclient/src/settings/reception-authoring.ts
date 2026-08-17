/** D-149 § A.9 + § A.5.x — Settings → Server → Reception per-kind
 *  authoring forms.
 *
 *  D-149 closed at P12 substrate-only — every per-kind phase (P4-P9)
 *  shipped its config contract + validator but deferred the Settings
 *  authoring UX. The § A.9 management spine (`reception.ts`) landed the
 *  list view + per-endpoint detail + lifecycle dispatch and named five
 *  satellite Settings surfaces; the Abuse Inbox subview
 *  (`reception-abuse-inbox.ts`) landed first. This module is the
 *  biggest remaining satellite: the six per-kind authoring forms
 *  (`reception_page` / `scheduling_link` / `intake_form` / `drop_link`
 *  / `approval_link` / `status_link`).
 *
 *  Each kind has a contract config blob — `ReceptionPageConfig`,
 *  `SchedulingLinkConfig`, … — plus a pure `validate<Kind>Config`
 *  validator. The renderer maintains a "working config" of that exact
 *  shape, binds form inputs to it, and uses this module to:
 *
 *    - **Project** the working config (or `null`, for a fresh create)
 *      into a renderable, copy-annotated form model — `build<Kind>FormModel`.
 *      Each leaf is an `Authoring*Field` carrying its label, help text,
 *      current value, and bounds / closed-list options. The copy lives
 *      inline in the builder (single source — no separate registry to
 *      drift), exactly as `exposure-surface.ts` keeps its row copy.
 *    - **Validate** the working config — `validate<Kind>FormConfig`
 *      wraps the contract validator and resolves each failure code
 *      through the kind's `*_CONFIG_ERROR_COPY` registry (closed-list,
 *      tsc-completeness-enforced — THE established pattern from
 *      `reception.ts`'s `RECEPTION_ERROR_COPY`).
 *    - **Dispatch** — the five link-style kinds funnel through the
 *      shared `buildEndpointPreviewDispatch` / `buildEndpointCreateDispatch`
 *      (`reception.endpoint.preview_draft` then `reception.endpoint.create`,
 *      gated on the returned `preview_hash` per § A.3); the singleton
 *      funnels through `buildReceptionPageUpsertDispatch`
 *      (`reception.page.upsert`). The renderer never fires the rpc — it
 *      shapes the payload + hands it to the page shell, the same
 *      separation the spine + `exposure-surface.ts` use.
 *
 *  Per D-148 § A.4 invariant — the webclient projects state, never
 *  synthesizes. Every `build*` here is a pure function (no I/O). After
 *  a `reception.endpoint_changed` broadcast the page shell refetches +
 *  re-runs the spine builder; the authoring form is local edit state
 *  until the create / upsert rpc lands.
 *
 *  Spec: D-149 § A.9 (Settings UX) + § A.5.1-A.5.6
 *  (per-kind config contracts) + § A.3 (preview-hash-gated create). */

import {
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  // reception_page (§ A.5.1)
  RECEPTION_PAGE_AVATAR_URL_MAX,
  RECEPTION_PAGE_CUSTOM_LINKS_MAX,
  RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX,
  RECEPTION_PAGE_LINK_BUTTONS_MAX,
  RECEPTION_LINK_BUTTON_DESCRIPTION_MAX,
  RECEPTION_PAGE_DISPLAY_NAME_MAX,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHODS,
  RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX,
  RECEPTION_PAGE_TAGLINE_MAX,
  RECEPTION_PAGE_TZ_LABEL_MAX,
  validateReceptionPageConfig,
  resolveReceptionInboxFanoutMode,
  // scheduling_link (§ A.5.2)
  SCHEDULING_LINK_DISPLAY_NAME_MAX,
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED,
  SCHEDULING_LINK_INSTRUCTIONS_MAX,
  SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX,
  SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX,
  SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX,
  SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX,
  SCHEDULING_LINK_SUCCESS_MESSAGE_MAX,
  SCHEDULING_LINK_TZ_MAX,
  validateSchedulingLinkConfig,
  // intake_form (§ A.5.3)
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_DOMAIN_ALLOWLIST_MAX,
  INTAKE_FORM_FIELDS_COUNT_MAX,
  INTAKE_FORM_HONEYPOT_FIELDS_MAX,
  INTAKE_FORM_INSTRUCTIONS_MAX,
  INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
  // D-210 WS3 — the calendar mapping's bounds + authoring default.
  INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN,
  INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX,
  INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
  INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX,
  INTAKE_FORM_SUCCESS_MESSAGE_MAX,
  INTAKE_FORM_TARGET_KINDS,
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  validateIntakeFormConfig,
  // drop_link (§ A.5.4)
  DROP_LINK_ALLOWED_MIME_TYPES,
  DROP_LINK_DISPLAY_NAME_MAX,
  DROP_LINK_DOMAIN_ALLOWLIST_MAX,
  DROP_LINK_EXPIRY_DAYS_DEFAULT,
  DROP_LINK_EXPIRY_DAYS_MAX,
  DROP_LINK_EXPIRY_DAYS_MIN,
  DROP_LINK_INSTRUCTIONS_MAX,
  DROP_LINK_MAX_UPLOADS_PER_DAY_DEFAULT,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MAX,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MIN,
  DROP_LINK_SIZE_CAP_DEFAULT_BYTES,
  DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
  DROP_LINK_SIZE_CAP_MIN_BYTES,
  DROP_LINK_SUBMIT_BUTTON_LABEL_MAX,
  DROP_LINK_SUCCESS_MESSAGE_MAX,
  validateDropLinkConfig,
  // approval_link (§ A.5.5)
  APPROVAL_LINK_ACTION_KINDS,
  APPROVAL_LINK_CONTEXT_SUMMARY_MAX,
  APPROVAL_LINK_DISPLAY_NAME_MAX,
  APPROVAL_LINK_EXPIRY_DAYS_DEFAULT,
  APPROVAL_LINK_EXPIRY_DAYS_MAX,
  APPROVAL_LINK_EXPIRY_DAYS_MIN,
  APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION,
  APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS,
  APPROVAL_LINK_OPTIONS_MAX,
  APPROVAL_LINK_OPTIONS_MIN,
  APPROVAL_LINK_PROMPT_MAX,
  APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX,
  APPROVAL_LINK_SUCCESS_MESSAGE_MAX,
  validateApprovalLinkConfig,
  // status_link (§ A.5.6)
  STATUS_LINK_CAPTION_MAX,
  STATUS_LINK_DISPLAY_NAME_MAX,
  STATUS_LINK_EXPIRY_DAYS_DEFAULT,
  STATUS_LINK_EXPIRY_DAYS_MAX,
  STATUS_LINK_EXPIRY_DAYS_MIN,
  STATUS_LINK_PROJECTION_KINDS,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_DEFAULT,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  validateStatusLinkConfig,
  type ApprovalLinkActionKind,
  type ApprovalLinkConfig,
  type ApprovalLinkConfigValidationCode,
  type ApprovalLinkOnApproveAction,
  type DropLinkAllowedMimeType,
  type DropLinkConfig,
  type DropLinkConfigValidationCode,
  type DropLinkVisitorFieldRequirement,
  type IntakeFormConfig,
  type IntakeFormConfigValidationCode,
  type IntakeFormTargetKind,
  type IntakeFormCalendarMapping,
  type IntakeFormVisitorFieldType,
  type PacketDeclaration,
  type ReceptionEndpointKind,
  type ReceptionInboxFanoutMode,
  type ReceptionPageConfig,
  type ReceptionPageConfigValidationCode,
  type ReceptionPagePreferredContactMethod,
  type SchedulingLinkConfig,
  type SchedulingLinkConfigValidationCode,
  type SchedulingLinkVisitorFieldRequirement,
  type SourceQueryRef,
  type StatusLinkConfig,
  type StatusLinkConfigValidationCode,
  type StatusLinkProjectionKind,
} from '@recued/contracts';
import { isReceptionEndpointKindAvailable } from './reception.js';

// ════════════════════════════════════════════════════════════════
// Shared authoring-field descriptors
// ════════════════════════════════════════════════════════════════
//
// One `control`-discriminated union covers every form input the six
// authoring forms render. `build<Kind>FormModel` projects the working
// config into a typed struct of these; the renderer switches on
// `control`. Repeaters (custom_links, explicit_windows, intake fields,
// approval options, string allowlists) carry their raw contract row
// type + the count bounds — the renderer owns row add / remove, the
// contract validator catches malformed rows.

/** Common base — every authoring field carries a stable `key` (so the
 *  renderer can key its input list), a `label`, and `help` copy. */
export interface AuthoringFieldBase {
  readonly key: string;
  readonly label: string;
  readonly help: string;
}

/** Single-line / multi-line free text — `display_name`, `instructions`,
 *  ids, urls, refs. `multiline` ⇒ render a `<textarea>`. */
export interface AuthoringTextField extends AuthoringFieldBase {
  readonly control: 'text';
  readonly value: string;
  readonly max_length: number;
  readonly required: boolean;
  readonly multiline: boolean;
}

/** Bounded integer — `expiry_days`, `size_cap_bytes`, `rate_limit_per_ip`. */
export interface AuthoringNumberField extends AuthoringFieldBase {
  readonly control: 'number';
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

/** Boolean toggle — section toggles and other explicit yes/no choices. */
export interface AuthoringToggleField extends AuthoringFieldBase {
  readonly control: 'toggle';
  readonly value: boolean;
}

/** One closed-list option — `value` plus its `label` + `help` copy. */
export interface AuthoringOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly help: string;
}

/** Single-select from a closed list — `notification_target`,
 *  `action_kind`, `projection_kind`, the per-field requirement knobs. */
export interface AuthoringSelectField<T extends string | number>
  extends AuthoringFieldBase {
  readonly control: 'select';
  readonly value: T;
  readonly options: ReadonlyArray<AuthoringOption<T>>;
}

/** Multi-select from a closed list — `preferred_contact_methods`,
 *  `duration_options_minutes`, `allowed_mime_types`. */
export interface AuthoringMultiSelectField<T extends string | number>
  extends AuthoringFieldBase {
  readonly control: 'multiselect';
  readonly value: ReadonlyArray<T>;
  readonly options: ReadonlyArray<AuthoringOption<T>>;
  readonly min_selected: number;
  readonly max_selected: number;
}

/** A variable-length list of structured rows — `custom_links`,
 *  `explicit_windows`, intake `fields`, approval `options`, the string
 *  allowlists. `rows` carries the raw contract row type verbatim; the
 *  renderer owns row editing, the contract validator gates row shape. */
export interface AuthoringRepeaterField<Row> extends AuthoringFieldBase {
  readonly control: 'repeater';
  readonly rows: ReadonlyArray<Row>;
  readonly min_rows: number;
  readonly max_rows: number;
}

// ════════════════════════════════════════════════════════════════
// Shared closed-list option copy
// ════════════════════════════════════════════════════════════════

// D-210 Phase C — `ReceptionNotificationTarget`, its copy map and its options
// builder are GONE with the per-endpoint `notification_target` field. They
// existed to unify four structurally-identical per-kind copies of the D-158
// channel vocabulary — the duplication that made retiring it worthwhile.

/** Visitor-field requirement knob — shared across scheduling / intake /
 *  drop (the `'omit'` member is unused by `approval_link`, whose
 *  constraints are `'required' | 'optional'` only; the superset map is
 *  harmless there). */
export type ReceptionVisitorFieldRequirement = 'required' | 'optional' | 'omit';

export const RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY: Readonly<
  Record<ReceptionVisitorFieldRequirement, { label: string; help: string }>
> = {
  required: {
    label: 'Required',
    help: 'The visitor must fill this in — the submission is rejected without it.',
  },
  optional: {
    label: 'Optional',
    help: 'The field is shown but the visitor may leave it blank.',
  },
  omit: {
    label: 'Hidden',
    help: 'The field is not rendered at all — the visitor never sees it.',
  },
};

const buildVisitorFieldRequirementOptions = (
  allowed: ReadonlyArray<ReceptionVisitorFieldRequirement>,
): ReadonlyArray<AuthoringOption<ReceptionVisitorFieldRequirement>> =>
  allowed.map((r) => ({
    value: r,
    label: RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY[r].label,
    help: RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY[r].help,
  }));

// ════════════════════════════════════════════════════════════════
// Shared validation summary
// ════════════════════════════════════════════════════════════════

/** One resolved validation failure — the contract's closed-list `code`,
 *  the renderer-ready remediation `message`, and the contract's raw
 *  `detail` (which field / bound tripped). */
export interface AuthoringValidationFailure<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly detail: string;
}

/** The full validation summary for a working config — `valid` is true
 *  iff the contract validator returned zero failures. */
export interface AuthoringValidationSummary<Code extends string> {
  readonly valid: boolean;
  readonly failures: ReadonlyArray<AuthoringValidationFailure<Code>>;
}

/** Resolve a contract validator's raw `{ code, detail }[]` output
 *  through a closed-list copy registry. Pure — no I/O. The per-kind
 *  `validate<Kind>FormConfig` wrappers are one-liners over this. */
export const summarizeConfigValidation = <Code extends string>(
  failures: ReadonlyArray<{ readonly code: Code; readonly detail: string }>,
  copy: Readonly<Record<Code, string>>,
): AuthoringValidationSummary<Code> => ({
  valid: failures.length === 0,
  failures: failures.map((f) => ({
    code: f.code,
    message: copy[f.code],
    detail: f.detail,
  })),
});

// ════════════════════════════════════════════════════════════════
// Shared dispatch builders
// ════════════════════════════════════════════════════════════════
//
// The renderer never fires the rpc; it shapes the payload + hands it
// to the page shell, which calls the `reception.*` rpc over the WS
// conn. Same separation as `buildPresetDispatch` in exposure-surface.ts
// + the spine's lifecycle dispatch builders. The five link-style kinds
// share the preview + create builders (the `kind` is an argument); the
// `reception_page` singleton has its own upsert builder (see below).

/** Compose a `PacketDeclaration` for a link-style endpoint. The
 *  `packet_kind` is bound 1:1 to the endpoint `kind` via the contract's
 *  `RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND` map — keeping that binding
 *  in one place so a caller can't pair a mismatched packet kind (the
 *  rpc would reject it as `packet_kind_disallowed_for_endpoint_kind`,
 *  but failing here is friendlier). Pure — no I/O. */
export const buildPacketDeclaration = (args: {
  kind: ReceptionEndpointKind;
  source_query_ref: SourceQueryRef;
  fields_visible_override?: ReadonlyArray<string>;
  transformations?: ReadonlyArray<string>;
  allowed_actions?: ReadonlyArray<string>;
}): PacketDeclaration => ({
  packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[args.kind],
  source_query_ref: args.source_query_ref,
  ...(args.fields_visible_override !== undefined
    ? { fields_visible_override: args.fields_visible_override }
    : {}),
  ...(args.transformations !== undefined
    ? { transformations: args.transformations }
    : {}),
  ...(args.allowed_actions !== undefined
    ? { allowed_actions: args.allowed_actions }
    : {}),
});

/** Payload for `reception.endpoint.preview_draft`. The authoring flow
 *  runs this FIRST — the rpc returns a `preview_hash` (10-min TTL) that
 *  `reception.endpoint.create` requires (§ A.3). `metadata` is the
 *  per-kind config blob (`SchedulingLinkConfig`, …); `expires_at` is a
 *  forward Unix-ms stamp omitted for the long-lived kinds. */
export interface ReceptionEndpointPreviewDispatch {
  readonly op: 'reception.endpoint.preview_draft';
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly expires_at?: number;
}

/** Payload for `reception.endpoint.create`. Requires the `preview_hash`
 *  the preceding `preview_draft` returned — the rpc re-derives the hash
 *  over the canonical `{ kind, packet_declaration, expires_at?, metadata? }`
 *  serialization and rejects a mismatch (so the operator creates
 *  exactly what View-As-Visitor showed).
 *
 *  `expires_at` is `number | undefined` — never `null` on the wire. A
 *  long-lived endpoint is requested by OMITTING `expires_at`, not by
 *  sending `null`: `reception.endpoint.preview_draft`'s input types
 *  `expires_at` as `number` (it cannot carry `null`), so the preview
 *  step always omits it for the long-lived case — and the rpc's
 *  preview-hash check keys on `args.expires_at !== undefined`, so a
 *  `null` on create after an omitted preview is a canonical-serialization
 *  mismatch → `preview_hash_mismatch`. The server's `validateExpiresAt`
 *  treats omitted and `null` identically (omitted ⇒ long-lived for the
 *  no-ceiling kinds, ⇒ `long_lived_not_permitted_for_kind` for the
 *  hard-ceiling drop / approval / status kinds), so omitting loses
 *  nothing. `buildEndpointCreateDispatch` accepts `null` for caller
 *  ergonomics but normalizes it to omitted. */
export interface ReceptionEndpointCreateDispatch {
  readonly op: 'reception.endpoint.create';
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly preview_hash: string;
  readonly expires_at?: number;
}

export const buildEndpointPreviewDispatch = (args: {
  kind: ReceptionEndpointKind;
  packet_declaration: PacketDeclaration;
  metadata: Readonly<Record<string, unknown>>;
  expires_at?: number;
}): ReceptionEndpointPreviewDispatch => ({
  op: 'reception.endpoint.preview_draft',
  kind: args.kind,
  packet_declaration: args.packet_declaration,
  metadata: args.metadata,
  ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
});

export const buildEndpointCreateDispatch = (args: {
  kind: ReceptionEndpointKind;
  packet_declaration: PacketDeclaration;
  metadata: Readonly<Record<string, unknown>>;
  preview_hash: string;
  /** A bounded forward Unix-ms stamp, or `null` / omitted for a
   *  long-lived endpoint. `null` and omitted are equivalent — both
   *  normalize to an omitted `expires_at` on the wire (see the
   *  `ReceptionEndpointCreateDispatch` docstring for why). */
  expires_at?: number | null;
}): ReceptionEndpointCreateDispatch => ({
  op: 'reception.endpoint.create',
  kind: args.kind,
  packet_declaration: args.packet_declaration,
  metadata: args.metadata,
  preview_hash: args.preview_hash,
  // `null` (long-lived intent) is normalized to omitted so the canonical
  // serialization matches the preview step, whose `expires_at` is
  // `number`-only and therefore always omitted for the long-lived case.
  ...(typeof args.expires_at === 'number' ? { expires_at: args.expires_at } : {}),
});

// ════════════════════════════════════════════════════════════════
// reception_page (§ A.5.1) — the per-server singleton
// ════════════════════════════════════════════════════════════════

/** Closed-list `ReceptionPageConfigValidationCode` → remediation copy.
 *  Surfaced when a `reception.page.upsert` round-trip fails its inner
 *  `validateReceptionPageConfig` gate. tsc enforces completeness. */
export const RECEPTION_PAGE_CONFIG_ERROR_COPY: Readonly<
  Record<ReceptionPageConfigValidationCode, string>
> = {
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on your Reception page.',
  display_name_too_long: `Display name is too long (max ${RECEPTION_PAGE_DISPLAY_NAME_MAX} characters).`,
  tagline_too_long: `Tagline is too long (max ${RECEPTION_PAGE_TAGLINE_MAX} characters).`,
  tz_label_empty: 'Enter a timezone label — visitors use it to read your availability hints.',
  tz_label_too_long: `Timezone label is too long (max ${RECEPTION_PAGE_TZ_LABEL_MAX} characters).`,
  response_time_estimate_too_long: `Response-time estimate is too long (max ${RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX} characters).`,
  avatar_url_too_long: `Avatar URL is too long (max ${RECEPTION_PAGE_AVATAR_URL_MAX} characters).`,
  avatar_url_invalid:
    'Avatar URL must be an http(s) link or a path under /reception/_static/ — javascript:/data:/file: URLs are rejected.',
  preferred_contact_method_unknown:
    'Pick contact methods from the closed list (email / phone / Slack / Telegram).',
  sections_enabled_unknown_key:
    'A page section toggle is malformed. Refresh the page + try again.',
  linked_endpoints_unknown_key:
    'A linked-endpoint reference is malformed. Refresh the page + try again.',
  custom_link_url_invalid:
    'Each custom link URL must be an http(s) link or a path under /reception/_static/.',
  custom_link_label_empty: 'Every custom link needs a non-empty label.',
  custom_link_label_too_long: `Custom link labels are too long (max ${RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX} characters).`,
  custom_links_count_exceeded: `Too many custom links (max ${RECEPTION_PAGE_CUSTOM_LINKS_MAX}).`,
  link_button_invalid: `Each link button needs a label, an absolute HTTPS URL, and an optional text description up to ${RECEPTION_LINK_BUTTON_DESCRIPTION_MAX} characters.`,
  link_buttons_count_exceeded: `Too many link buttons (max ${RECEPTION_PAGE_LINK_BUTTONS_MAX}).`,
  trust_footer_enabled_invalid:
    'The trust-footer toggle is malformed. Refresh the page + try again.',
  inbox_fanout_mode_invalid:
    'The inbox notification setting is malformed. Refresh the page + try again.',
};

/** § A.5.1 — per-`ReceptionPagePreferredContactMethod` chip copy. */
export const RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY: Readonly<
  Record<ReceptionPagePreferredContactMethod, { label: string; help: string }>
> = {
  email: { label: 'Email', help: 'Surface email as a preferred way to reach you.' },
  phone: { label: 'Phone', help: 'Surface phone as a preferred way to reach you.' },
  slack: { label: 'Slack', help: 'Surface Slack as a preferred way to reach you.' },
  telegram: { label: 'Telegram', help: 'Surface Telegram as a preferred way to reach you.' },
};

/** § A.5.1 — page-section toggle keys + copy. Each maps a
 *  `ReceptionPageSectionConfig` boolean to a labelled toggle. */
export const RECEPTION_PAGE_SECTION_KEYS = [
  'contact_card',
  'contact_methods',
  'availability_cta',
  'intake_cta',
  'drop_cta',
  'custom_links',
  'link_buttons',
] as const;

export type ReceptionPageSectionKey = (typeof RECEPTION_PAGE_SECTION_KEYS)[number];

export const RECEPTION_PAGE_SECTION_COPY: Readonly<
  Record<ReceptionPageSectionKey, { label: string; help: string }>
> = {
  contact_card: {
    label: 'Contact card',
    help: 'Your display name, tagline, avatar, and timezone — the visitor-facing identity block.',
  },
  contact_methods: {
    label: 'Contact methods',
    help: 'The preferred-contact-method chips you selected above.',
  },
  availability_cta: {
    label: 'Scheduling call-to-action',
    help: 'A button linking to a scheduling link — populate the scheduling link reference below.',
  },
  intake_cta: {
    label: 'Intake call-to-action',
    help: 'A button linking to an intake form — populate the intake form reference below.',
  },
  drop_cta: {
    label: 'Drop call-to-action',
    help: 'A button linking to a drop link — populate the drop link reference below.',
  },
  custom_links: {
    label: 'Custom links',
    help: 'The legacy free-form custom links you add below.',
  },
  link_buttons: {
    label: 'Link buttons',
    help: 'Plain HTTPS navigation buttons with optional descriptions.',
  },
};

/** The six linked-endpoint reference fields (3 endpoint ids + 3 share
 *  URLs) Mary pastes from a per-kind create-rpc response. */
export const RECEPTION_PAGE_LINKED_ENDPOINT_KEYS = [
  'scheduling_link_endpoint_id',
  'intake_form_endpoint_id',
  'drop_link_endpoint_id',
  'scheduling_link_share_url',
  'intake_form_share_url',
  'drop_link_share_url',
] as const;

export type ReceptionPageLinkedEndpointKey =
  (typeof RECEPTION_PAGE_LINKED_ENDPOINT_KEYS)[number];

const RECEPTION_PAGE_LINKED_ENDPOINT_COPY: Readonly<
  Record<ReceptionPageLinkedEndpointKey, { label: string; help: string }>
> = {
  scheduling_link_endpoint_id: {
    label: 'Scheduling link — endpoint id',
    help: 'The endpoint id of a scheduling link to drive the availability call-to-action.',
  },
  intake_form_endpoint_id: {
    label: 'Intake form — endpoint id',
    help: 'The endpoint id of an intake form to drive the intake call-to-action.',
  },
  drop_link_endpoint_id: {
    label: 'Drop link — endpoint id',
    help: 'The endpoint id of a drop link to drive the drop call-to-action.',
  },
  scheduling_link_share_url: {
    label: 'Scheduling link — share URL',
    help: 'The full share URL for the scheduling link — paste it from the create-link response (it is never re-readable later).',
  },
  intake_form_share_url: {
    label: 'Intake form — share URL',
    help: 'The full share URL for the intake form — paste it from the create-link response (it is never re-readable later).',
  },
  drop_link_share_url: {
    label: 'Drop link — share URL',
    help: 'The full share URL for the drop link — paste it from the create-link response (it is never re-readable later).',
  },
};

const RECEPTION_PAGE_SECTION_ENDPOINT_KIND: Partial<
  Record<ReceptionPageSectionKey, ReceptionEndpointKind>
> = {
  availability_cta: 'scheduling_link',
  intake_cta: 'intake_form',
  drop_cta: 'drop_link',
};

const RECEPTION_PAGE_LINKED_ENDPOINT_KIND: Readonly<
  Record<ReceptionPageLinkedEndpointKey, ReceptionEndpointKind>
> = {
  scheduling_link_endpoint_id: 'scheduling_link',
  intake_form_endpoint_id: 'intake_form',
  drop_link_endpoint_id: 'drop_link',
  scheduling_link_share_url: 'scheduling_link',
  intake_form_share_url: 'intake_form',
  drop_link_share_url: 'drop_link',
};

const isReceptionPageSectionAvailable = (sectionKey: ReceptionPageSectionKey): boolean => {
  const kind = RECEPTION_PAGE_SECTION_ENDPOINT_KIND[sectionKey];
  return kind === undefined || isReceptionEndpointKindAvailable(kind);
};

const isReceptionPageLinkedEndpointAvailable = (
  linkedKey: ReceptionPageLinkedEndpointKey,
): boolean => isReceptionEndpointKindAvailable(RECEPTION_PAGE_LINKED_ENDPOINT_KIND[linkedKey]);

/** Full Settings → Reception → Reception page authoring form model. */
export interface ReceptionPageFormModel {
  /** True ⇒ the singleton has never been upserted (fresh-install) — the
   *  renderer shows "Set up" copy rather than "Edit". */
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly tagline: AuthoringTextField;
  readonly tz_label: AuthoringTextField;
  readonly avatar_url: AuthoringTextField;
  readonly response_time_estimate: AuthoringTextField;
  readonly preferred_contact_methods: AuthoringMultiSelectField<ReceptionPagePreferredContactMethod>;
  readonly sections_enabled: ReadonlyArray<AuthoringToggleField>;
  readonly linked_endpoints: ReadonlyArray<AuthoringTextField>;
  readonly custom_links: AuthoringRepeaterField<ReceptionPageCustomLinkRow>;
  readonly link_buttons: AuthoringRepeaterField<ReceptionLinkButtonRow>;
  readonly trust_footer_enabled: AuthoringToggleField;
  /** D-210 Phase C — the GLOBAL inbox device-fanout mode. It rides the
   *  `reception_page` singleton because that is the one server-wide
   *  config blob, not because it describes the public page: nothing
   *  about it is visitor-facing. */
  readonly inbox_fanout_mode: AuthoringSelectField<ReceptionInboxFanoutMode>;
}

/** One `custom_links[]` repeater row — mirrors `ReceptionPageCustomLink`. */
export interface ReceptionPageCustomLinkRow {
  readonly label: string;
  readonly url: string;
}

/** One D-196 `link_buttons[]` repeater row. */
export interface ReceptionLinkButtonRow {
  readonly label: string;
  readonly url: string;
  readonly description: string;
}

/** Project a `ReceptionPageConfig` (or `null` for a fresh setup) into
 *  the authoring form model. Pure — no I/O. */
export const buildReceptionPageFormModel = (
  config: ReceptionPageConfig | null,
): ReceptionPageFormModel => {
  const d = config?.display_overrides;
  const sections = config?.sections_enabled;
  const linked = config?.linked_endpoints;
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on your Reception page — typically your name or handle.',
      value: d?.display_name ?? '',
      max_length: RECEPTION_PAGE_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    tagline: {
      control: 'text',
      key: 'tagline',
      label: 'Tagline',
      help: 'A short line under your name — what you do, or how you prefer to be reached.',
      value: d?.tagline ?? '',
      max_length: RECEPTION_PAGE_TAGLINE_MAX,
      required: false,
      multiline: false,
    },
    tz_label: {
      control: 'text',
      key: 'tz_label',
      label: 'Timezone label',
      help: 'A human timezone label (e.g. "Pacific Time") visitors use to read your availability.',
      value: d?.tz_label ?? '',
      max_length: RECEPTION_PAGE_TZ_LABEL_MAX,
      required: true,
      multiline: false,
    },
    avatar_url: {
      control: 'text',
      key: 'avatar_url',
      label: 'Avatar URL',
      help: 'An http(s) image URL, or a path under /reception/_static/. Leave blank for no avatar.',
      value: d?.avatar_url ?? '',
      max_length: RECEPTION_PAGE_AVATAR_URL_MAX,
      required: false,
      multiline: false,
    },
    response_time_estimate: {
      control: 'text',
      key: 'response_time_estimate',
      label: 'Response-time estimate',
      help: 'An optional expectation-setting line, e.g. "Usually replies within a day".',
      value: d?.response_time_estimate ?? '',
      max_length: RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX,
      required: false,
      multiline: false,
    },
    preferred_contact_methods: {
      control: 'multiselect',
      key: 'preferred_contact_methods',
      label: 'Preferred contact methods',
      help: 'Which contact-method chips to surface on the page.',
      value: d?.preferred_contact_methods ?? [],
      options: RECEPTION_PAGE_PREFERRED_CONTACT_METHODS.map((m) => ({
        value: m,
        label: RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY[m].label,
        help: RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY[m].help,
      })),
      min_selected: 0,
      max_selected: RECEPTION_PAGE_PREFERRED_CONTACT_METHODS.length,
    },
    sections_enabled: RECEPTION_PAGE_SECTION_KEYS.filter(
      isReceptionPageSectionAvailable,
    ).map((sectionKey) => ({
      control: 'toggle',
      key: `sections_enabled.${sectionKey}`,
      label: RECEPTION_PAGE_SECTION_COPY[sectionKey].label,
      help: RECEPTION_PAGE_SECTION_COPY[sectionKey].help,
      value: sections?.[sectionKey] ?? false,
    })),
    linked_endpoints: RECEPTION_PAGE_LINKED_ENDPOINT_KEYS.filter(
      isReceptionPageLinkedEndpointAvailable,
    ).map((linkedKey) => ({
      control: 'text',
      key: `linked_endpoints.${linkedKey}`,
      label: RECEPTION_PAGE_LINKED_ENDPOINT_COPY[linkedKey].label,
      help: RECEPTION_PAGE_LINKED_ENDPOINT_COPY[linkedKey].help,
      value: linked?.[linkedKey] ?? '',
      max_length: RECEPTION_PAGE_AVATAR_URL_MAX,
      required: false,
      multiline: false,
    })),
    custom_links: {
      control: 'repeater',
      key: 'custom_links',
      label: 'Custom links',
      help: `Legacy free-form links shown on the page. Up to ${RECEPTION_PAGE_CUSTOM_LINKS_MAX}; URLs may be http(s) or under /reception/_static/.`,
      rows: (config?.custom_links ?? []).map((link) => ({
        label: link.label,
        url: link.url,
      })),
      min_rows: 0,
      max_rows: RECEPTION_PAGE_CUSTOM_LINKS_MAX,
    },
    link_buttons: {
      control: 'repeater',
      key: 'link_buttons',
      label: 'Link buttons',
      help: `Plain navigation shown on the page. Up to ${RECEPTION_PAGE_LINK_BUTTONS_MAX}; each destination must be an absolute HTTPS URL.`,
      rows: (config?.link_buttons ?? []).map((link) => ({
        label: link.label,
        url: link.url,
        description: link.description ?? '',
      })),
      min_rows: 0,
      max_rows: RECEPTION_PAGE_LINK_BUTTONS_MAX,
    },
    trust_footer_enabled: {
      control: 'toggle',
      key: 'trust_footer_enabled',
      label: 'Show the public trust footer',
      help: 'The substrate-rendered "what Recued does / does not do with your data" footer. Default on; disabling it does not change behaviour, only visibility.',
      value: config?.trust_footer_enabled ?? true,
    },
    inbox_fanout_mode: {
      control: 'select',
      key: 'inbox_fanout_mode',
      label: 'How new reception items reach your devices',
      help: 'Everything a visitor submits waits in your inbox either way — this only picks which surface pings you.',
      value: resolveReceptionInboxFanoutMode(config?.inbox_fanout_mode),
      options: [
        {
          value: 'approval',
          label: 'Approve from the notification',
          help: 'Each held item raises an approve/deny card on every device you have enabled, so you can answer without opening the inbox.',
        },
        {
          value: 'notify',
          label: 'Just tell me, I will review in the inbox',
          help: 'Each held item fires a passive heads-up instead. Nothing is approved until you open the inbox and approve it there.',
        },
      ],
    },
  };
};

/** Validate a working `ReceptionPageConfig` through the contract
 *  validator + resolve the failure copy. Pure — no I/O. */
export const validateReceptionPageFormConfig = (
  config: ReceptionPageConfig,
): AuthoringValidationSummary<ReceptionPageConfigValidationCode> =>
  summarizeConfigValidation(
    validateReceptionPageConfig(config),
    RECEPTION_PAGE_CONFIG_ERROR_COPY,
  );

/** Payload for `reception.page.upsert` — the singleton has no bearer
 *  secret, no per-link expiry, and no preview-hash gate, so its
 *  dispatch is a plain config write (contrast the link-style kinds'
 *  preview-then-create flow). */
export interface ReceptionPageUpsertDispatch {
  readonly op: 'reception.page.upsert';
  readonly config: ReceptionPageConfig;
}

export const buildReceptionPageUpsertDispatch = (
  config: ReceptionPageConfig,
): ReceptionPageUpsertDispatch => ({
  op: 'reception.page.upsert',
  config,
});

// ════════════════════════════════════════════════════════════════
// scheduling_link (§ A.5.2)
// ════════════════════════════════════════════════════════════════

/** Closed-list `SchedulingLinkConfigValidationCode` → remediation copy. */
export const SCHEDULING_LINK_CONFIG_ERROR_COPY: Readonly<
  Record<SchedulingLinkConfigValidationCode, string>
> = {
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on the slot picker.',
  display_name_too_long: `Display name is too long (max ${SCHEDULING_LINK_DISPLAY_NAME_MAX} characters).`,
  instructions_too_long: `Instructions are too long (max ${SCHEDULING_LINK_INSTRUCTIONS_MAX} characters).`,
  success_message_too_long: `Success message is too long (max ${SCHEDULING_LINK_SUCCESS_MESSAGE_MAX} characters).`,
  tz_empty: 'Enter a timezone — the slot picker needs it to render your free windows.',
  tz_too_long: `Timezone is too long (max ${SCHEDULING_LINK_TZ_MAX} characters).`,
  duration_options_empty: 'Pick at least one slot duration.',
  duration_option_invalid: 'A slot duration is not in the allowed list (15 / 30 / 45 / 60 / 90 / 120 minutes).',
  duration_option_too_many: 'Too many slot durations — pick at most four so the picker stays usable.',
  // R19 Slice 2 — the SI-reference path is gone from the form (D-186
  // deleted Standing Instructions), so the only authorable availability is
  // explicit windows. The contract still ACCEPTS an SI ref for the
  // substrate, hence the *_ref_invalid codes below stay mapped.
  window_definition_empty:
    'Define availability — add at least one explicit window.',
  explicit_window_invalid:
    'An availability window is malformed — check the day of week and that the start is before the end.',
  visitor_fields_invalid:
    'The visitor-field requirements are malformed — name must be Required; phone and notes cannot be Required.',
  min_advance_notice_out_of_range: `Advance notice must be 0–${SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX} hours.`,
  max_lead_time_out_of_range: `Lead time must be 1–${SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX} days.`,
  max_bookings_per_day_out_of_range: `Per-day booking cap must be 0–${SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX} (0 = no cap).`,
  notification_target_unknown: 'Pick a notification target from the closed list.',
  on_booking_flag_invalid: 'An on-booking option is malformed. Refresh the page + try again.',
  auto_confirm_ref_invalid: 'The auto-confirm Standing Instruction reference must be a non-empty string.',
  standing_instructions_ref_invalid: 'The Standing Instruction reference must be a non-empty string.',
  visitor_receipt_invalid: 'The visitor-receipt configuration is malformed. Check the receipt delivery setting.',
  // ⚠ PRE-EXISTING BUILD BREAK, not part of the standing-closure work: `7f0c46d24`
  // widened `SchedulingLinkConfigValidationCode` with this code and updated the
  // INTAKE map only, so `tsc -b` has been failing on this file since. Copy mirrors
  // the intake one, retargeted at the slot picker.
  visitor_lookup_invalid:
    'The submitter-viewback configuration is not usable. Check that the visitor receipt '
    + 'is switched on (the receipt is what hands the visitor their link) and that the '
    + 'expiry window is set.',
  config_shape_invalid: 'The scheduling link configuration is malformed. Refresh the page + try again.',
};

/** The five visitor fields a scheduling link can collect, with their
 *  per-field allowed requirement values (spec § A.5.2 line 609-615 —
 *  `name` is always Required; `phone` / `notes` are Optional or Hidden
 *  only; `email` / `topic` are Required or Optional). */
export const SCHEDULING_LINK_VISITOR_FIELD_KEYS = [
  'name',
  'email',
  'topic',
  'phone',
  'notes',
] as const;

export type SchedulingLinkVisitorFieldKey =
  (typeof SCHEDULING_LINK_VISITOR_FIELD_KEYS)[number];

const SCHEDULING_LINK_VISITOR_FIELD_ALLOWED: Readonly<
  Record<SchedulingLinkVisitorFieldKey, ReadonlyArray<ReceptionVisitorFieldRequirement>>
> = {
  name: ['required'],
  email: ['required', 'optional'],
  topic: ['required', 'optional'],
  phone: ['optional', 'omit'],
  notes: ['optional', 'omit'],
};

const SCHEDULING_LINK_VISITOR_FIELD_COPY: Readonly<
  Record<SchedulingLinkVisitorFieldKey, { label: string; help: string }>
> = {
  name: { label: 'Visitor name', help: 'Always required — the booking has to be attributable to someone.' },
  email: { label: 'Visitor email', help: 'How you reach the visitor to confirm the booking.' },
  topic: { label: 'Topic', help: 'A short "what is this about" line the visitor supplies.' },
  phone: { label: 'Visitor phone', help: 'Optional contact number — cannot be made required.' },
  notes: { label: 'Notes', help: 'A free-text notes field — cannot be made required.' },
};

/** Full scheduling_link authoring form model. */
export interface SchedulingLinkFormModel {
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly instructions: AuthoringTextField;
  readonly success_message: AuthoringTextField;
  readonly duration_options_minutes: AuthoringMultiSelectField<number>;
  readonly tz: AuthoringTextField;
  readonly explicit_windows: AuthoringRepeaterField<SchedulingLinkExplicitWindowRow>;
  readonly required_visitor_fields: ReadonlyArray<
    AuthoringSelectField<ReceptionVisitorFieldRequirement>
  >;
  readonly min_advance_notice_hours: AuthoringNumberField;
  readonly max_lead_time_days: AuthoringNumberField;
  readonly max_bookings_per_day: AuthoringNumberField;
  readonly notify_visitor_sender: AuthoringTextField;
}

/** One `explicit_windows[]` repeater row — mirrors
 *  `SchedulingLinkExplicitWindow`. */
export interface SchedulingLinkExplicitWindowRow {
  readonly day_of_week: number;
  readonly start_minute: number;
  readonly end_minute: number;
}

/** Project a `SchedulingLinkConfig` (or `null`) into the form model. */
export const buildSchedulingLinkFormModel = (
  config: SchedulingLinkConfig | null,
): SchedulingLinkFormModel => {
  const w = config?.available_window_definition;
  const rvf = config?.required_visitor_fields;
  const ob = config?.on_booking;
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on the slot picker — typically your name or handle.',
      value: config?.display_name ?? '',
      max_length: SCHEDULING_LINK_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    instructions: {
      control: 'text',
      key: 'instructions',
      label: 'Instructions',
      help: 'An optional paragraph shown above the slot picker.',
      value: config?.instructions ?? '',
      max_length: SCHEDULING_LINK_INSTRUCTIONS_MAX,
      required: false,
      multiline: true,
    },
    success_message: {
      control: 'text',
      key: 'success_message',
      label: 'Success message',
      help: 'Confirmation-page copy. Leave blank for the substrate default ("Booking received").',
      value: config?.success_message ?? '',
      max_length: SCHEDULING_LINK_SUCCESS_MESSAGE_MAX,
      required: false,
      multiline: true,
    },
    duration_options_minutes: {
      control: 'multiselect',
      key: 'duration_options_minutes',
      label: 'Slot durations',
      help: 'Which slot lengths the visitor can pick. At least one, at most four.',
      value: config?.duration_options_minutes ?? [30],
      options: SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED.map((m) => ({
        value: m,
        label: `${m} minutes`,
        help: `Offer a ${m}-minute slot.`,
      })),
      min_selected: 1,
      max_selected: 4,
    },
    tz: {
      control: 'text',
      key: 'available_window_definition.tz',
      label: 'Timezone',
      help: 'IANA timezone id (e.g. "America/New_York") your availability is defined in.',
      value: w?.tz ?? '',
      max_length: SCHEDULING_LINK_TZ_MAX,
      required: true,
      multiline: false,
    },
    explicit_windows: {
      control: 'repeater',
      key: 'available_window_definition.explicit_windows',
      label: 'Availability windows',
      help: 'Recurring weekly windows (day of week + start/end minute of day).',
      rows: (w?.explicit_windows ?? []).map((ew) => ({
        day_of_week: ew.day_of_week,
        start_minute: ew.start_minute,
        end_minute: ew.end_minute,
      })),
      min_rows: 0,
      max_rows: 21,
    },
    required_visitor_fields: SCHEDULING_LINK_VISITOR_FIELD_KEYS.map((fieldKey) => ({
      control: 'select',
      key: `required_visitor_fields.${fieldKey}`,
      label: SCHEDULING_LINK_VISITOR_FIELD_COPY[fieldKey].label,
      help: SCHEDULING_LINK_VISITOR_FIELD_COPY[fieldKey].help,
      value: (rvf?.[fieldKey] as ReceptionVisitorFieldRequirement | undefined) ??
        SCHEDULING_LINK_VISITOR_FIELD_ALLOWED[fieldKey][0]!,
      options: buildVisitorFieldRequirementOptions(
        SCHEDULING_LINK_VISITOR_FIELD_ALLOWED[fieldKey],
      ),
    })),
    min_advance_notice_hours: {
      control: 'number',
      key: 'min_advance_notice_hours',
      label: 'Minimum advance notice (hours)',
      help: 'The earliest a visitor can book — measured forward from now.',
      value: config?.min_advance_notice_hours ?? 24,
      min: 0,
      max: SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX,
    },
    max_lead_time_days: {
      control: 'number',
      key: 'max_lead_time_days',
      label: 'Maximum lead time (days)',
      help: 'How far into the future the slot picker exposes.',
      value: config?.max_lead_time_days ?? 30,
      min: 1,
      max: SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX,
    },
    max_bookings_per_day: {
      control: 'number',
      key: 'max_bookings_per_day',
      label: 'Per-day booking cap',
      help: 'Maximum bookings accepted per day. 0 means no cap.',
      value: config?.max_bookings_per_day ?? 0,
      min: 0,
      max: SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX,
    },
    notify_visitor_sender: {
      control: 'text',
      key: 'on_booking.notify_visitor_sender',
      label: 'Visitor notification sender',
      help:
        'Optional send-capable mail instance. Set it before using “Notify visitor” on approval.',
      value: ob?.notify_visitor_sender ?? '',
      max_length: SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX,
      required: false,
      multiline: false,
    },
  };
};

/** Validate a working `SchedulingLinkConfig`. Pure — no I/O. */
export const validateSchedulingLinkFormConfig = (
  config: unknown,
): AuthoringValidationSummary<SchedulingLinkConfigValidationCode> =>
  summarizeConfigValidation(
    validateSchedulingLinkConfig(config),
    SCHEDULING_LINK_CONFIG_ERROR_COPY,
  );

// ════════════════════════════════════════════════════════════════
// intake_form (§ A.5.3)
// ════════════════════════════════════════════════════════════════

/** Closed-list `IntakeFormConfigValidationCode` → remediation copy. */
export const INTAKE_FORM_CONFIG_ERROR_COPY: Readonly<
  Record<IntakeFormConfigValidationCode, string>
> = {
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on the form.',
  display_name_too_long: `Display name is too long (max ${INTAKE_FORM_DISPLAY_NAME_MAX} characters).`,
  instructions_too_long: `Instructions are too long (max ${INTAKE_FORM_INSTRUCTIONS_MAX} characters).`,
  success_message_too_long: `Success message is too long (max ${INTAKE_FORM_SUCCESS_MESSAGE_MAX} characters).`,
  submit_button_label_too_long: `Submit-button label is too long (max ${INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX} characters).`,
  template_ref_invalid: 'The template reference must be a non-empty string when present.',
  template_version_invalid: 'The template version is malformed. Refresh the page + try again.',
  form_definition_invalid: 'The form definition is malformed. Refresh the page + try again.',
  form_definition_id_empty: 'The form needs a non-empty form-definition id.',
  fields_empty: 'Add at least one field to the form.',
  fields_too_many: `Too many fields (max ${INTAKE_FORM_FIELDS_COUNT_MAX}).`,
  field_name_invalid: 'Each field name must be lowercase and start with a letter (a–z, 0–9, underscore).',
  field_name_reserved: 'A field name collides with a substrate-reserved key (form_nonce / visitor_email / t). Rename it.',
  field_name_duplicate: 'Two fields share the same name — field names must be unique.',
  field_label_too_long: 'A field label is too long.',
  field_type_unknown: 'A field type is not in the allowed list.',
  field_enum_values_empty: 'An enum field has no values — add at least one choice.',
  field_enum_values_too_many: 'An enum field has too many values.',
  field_enum_value_too_long: 'An enum value is too long or empty.',
  user_only_field_unknown: 'A user-only field name is malformed.',
  user_only_field_overlaps_visible: 'A user-only field name is also a visitor-visible field — names must not overlap.',
  submission_processing_rule_invalid: 'The submission-processing rule is malformed. Refresh the page + try again.',
  auto_accept_invalid:
    'Auto-accept has been retired — every submission is held for review in your inbox. '
    + 'Remove the auto_accept field from this endpoint.',
  // D-210 A.8 slice 2b step 3 — "you did not choose" reads differently from
  // "you chose something that is not real"; keep them apart for the author.
  target_kind_missing:
    'Pick what approval creates from the submission. If the answers themselves are the record, '
    + 'choose Response list.',
  target_kind_unknown: 'Pick a submission target kind from the closed list.',
  fields_to_include_unknown: 'A field routed into the target entity is not one of the form fields.',
  fields_to_attach_unknown: 'A field attached as metadata is not one of the form fields.',
  fields_include_attach_overlap: 'A field is both routed into the target and attached as metadata — pick one.',
  // D-210 A.8 slice 2b — say what is LOST, not just what is missing. "Place
  // every field" reads like paperwork; "the answer is discarded" is the reason.
  field_not_placed:
    'A form field is neither routed into the target nor attached as metadata, so what the '
    + 'visitor typed there would be discarded. Put it in one of the two, or mark it a honeypot.',
  triggered_recipe_id_invalid:
    'Triggered recipes have been retired here — watch the destination entity instead. '
    + 'Remove the field.',
  calendar_mapping_invalid: 'The calendar mapping is incomplete — pick which field carries the start.',
  calendar_mapping_field_unknown: 'A field named in the calendar mapping is not one of the form fields.',
  calendar_mapping_field_type_invalid: 'A field named in the calendar mapping is the wrong type — start and end must be date or date & time fields, and a duration must be a number field.',
  calendar_mapping_end_spec_invalid: 'Pick exactly one way to end the event: a second date field, a duration the visitor enters, or a fixed length.',
  contact_mapping_invalid: 'The contact name field is not one of the form fields.',
  notification_target_unknown: 'Pick a notification target from the closed list.',
  anti_spam_invalid: 'The anti-spam configuration is malformed. Refresh the page + try again.',
  honeypot_unknown_field: 'A honeypot field name is not one of the form fields.',
  honeypot_too_many: `Too many honeypot fields (max ${INTAKE_FORM_HONEYPOT_FIELDS_MAX}).`,
  rate_limit_out_of_range: `The per-IP rate limit must be ${INTAKE_FORM_RATE_LIMIT_PER_IP_MIN}–${INTAKE_FORM_RATE_LIMIT_PER_IP_MAX} submissions per hour.`,
  domain_allowlist_too_many: `Too many allowlisted domains (max ${INTAKE_FORM_DOMAIN_ALLOWLIST_MAX}).`,
  domain_allowlist_entry_too_long: 'An allowlisted domain entry is too long or empty.',
  visitor_fields_invalid: 'The visitor-email requirement must be Required, Optional, or Hidden.',
  visitor_receipt_invalid: 'The visitor-receipt configuration is malformed. Check the receipt delivery setting.',
  // D-240 — the viewback config failed its own validator. The detail the
  // parent forwards names WHICH rule, so the copy points at the two an owner
  // can actually act on rather than restating the code.
  visitor_lookup_invalid:
    'The submitter-viewback configuration is not usable. Check that the visitor receipt '
    + 'is switched on (the receipt is what hands the submitter their link) and that the '
    + 'expiry window is set.',
  config_shape_invalid: 'The intake form configuration is malformed. Refresh the page + try again.',
};

// D-210 A.8 slice 2b step 3 — `INTAKE_FORM_LOG_ONLY_TARGET_VALUE` (`''`) and
// `INTAKE_FORM_LOG_ONLY_TARGET_COPY` are RETIRED. The empty option authored an
// ABSENT `target_kind`, which the contract no longer accepts
// (`target_kind_missing`). "Keep the responses and mint nothing else" is not
// the absence of a destination any more — it is the `form_response`
// destination, and it appears in the picker as "Response list" like every
// other choice. Re-adding an empty option would author a config the validator
// refuses.

/** § A.5.3 — per-`IntakeFormTargetKind` copy. */
export const INTAKE_FORM_TARGET_KIND_COPY: Readonly<
  Record<IntakeFormTargetKind, { label: string; help: string }>
> = {
  task: { label: 'Task', help: 'Each submission becomes a task work-entity.' },
  note: { label: 'Note', help: 'Each submission becomes a note work-entity.' },
  // D-210 A.7 — `commitment` and `inbox_item` left this list with the intake
  // vocabulary: nothing in reception mints a commitment, and `inbox_item` was
  // only ever an alias for `task`.
  booking: {
    label: 'Booking',
    help: 'Each approved submission becomes a booking you can mark completed, cancelled, or a no-show.',
  },
  // D-210 A.4 — the generic destination: the answers ARE the record. For an
  // event roster or an application list, where you work the responses
  // themselves rather than spawning something else from them.
  form_response: {
    label: 'Response list',
    help: 'Keep the responses as your working list and move each one through received, in review, accepted, declined, or no-show.',
  },
  // D-210 WS3 — the two destinations that are not work entities.
  calendar: {
    label: 'Calendar event',
    help: 'Each approved submission becomes an event on your calendar. You choose which field carries the start and how the end is worked out.',
  },
  contact: {
    label: 'Contact',
    help: 'Each approved submission adds or updates a contact, keyed on the visitor’s email address.',
  },
};

/** Resolve display copy for a destination. D-210 A.8 slice 2b step 3 removed
 *  the `undefined` arm along with the absent `target_kind` it described. */
export const intakeFormTargetKindCopy = (
  target_kind: IntakeFormTargetKind,
): { label: string; help: string } => INTAKE_FORM_TARGET_KIND_COPY[target_kind];

/** D-210 WS3 — which of the three end-specs a calendar mapping uses. NOT a
 *  contract field: the contract expresses the choice by which of `end_field` /
 *  `duration_field` / `default_duration_minutes` is present (exactly one). This
 *  is the AUTHORING discriminator — the form needs a single control to switch
 *  between them, and the mount translates a switch into "set the chosen key,
 *  delete the other two". Same shape as `status_link`'s `source_ref.kind`. */
export const INTAKE_FORM_CALENDAR_END_MODES = [
  'default_duration_minutes',
  'duration_field',
  'end_field',
] as const;
export type IntakeFormCalendarEndMode = (typeof INTAKE_FORM_CALENDAR_END_MODES)[number];

/** The synthetic field key the end-mode select writes through. Prefixed to
 *  make it unmistakably not a contract path — nothing may persist under it. */
export const INTAKE_FORM_CALENDAR_END_MODE_KEY =
  'submission_processing_rule.calendar_mapping.__end_mode';

export const INTAKE_FORM_CALENDAR_END_MODE_COPY: Readonly<
  Record<IntakeFormCalendarEndMode, { label: string; help: string }>
> = {
  default_duration_minutes: {
    label: 'A fixed length',
    help: 'Every booking runs the same length — a 90-minute sitting, say. The visitor never sees it.',
  },
  duration_field: {
    label: 'A duration the visitor enters',
    help: 'The visitor says how long, in hours, in one of your number fields.',
  },
  end_field: {
    label: 'A second date field',
    help: 'The visitor picks an end as well as a start — a check-out date, a return time. For whole days the end date is the day they leave.',
  },
};

/** D-210 WS3 — read the end-mode back out of a saved mapping. Derived from
 *  which key is present rather than stored, so the form and the config can
 *  never disagree about which spec is in force. */
export const intakeFormCalendarEndMode = (
  mapping: IntakeFormCalendarMapping | undefined,
): IntakeFormCalendarEndMode => {
  if (mapping?.end_field !== undefined) return 'end_field';
  if (mapping?.duration_field !== undefined) return 'duration_field';
  return 'default_duration_minutes';
};

/** § A.5.3 — per-`IntakeFormVisitorFieldType` copy for the field-builder
 *  repeater's type select. */
export const INTAKE_FORM_FIELD_TYPE_COPY: Readonly<
  Record<IntakeFormVisitorFieldType, { label: string; help: string }>
> = {
  text: { label: 'Short text', help: 'A single-line text input.' },
  textarea: { label: 'Long text', help: 'A multi-line text area.' },
  number: { label: 'Number', help: 'A numeric input.' },
  boolean: { label: 'Yes / no', help: 'A checkbox or toggle.' },
  date: { label: 'Date', help: 'A date picker — a day, with no time of day.' },
  datetime: {
    label: 'Date & time',
    help: 'A date and time-of-day picker. Use it when a calendar destination needs a start time rather than a whole day.',
  },
  enum: { label: 'Choice', help: 'A single choice from a closed list of values you define.' },
  'array<text>': { label: 'Text list', help: 'A repeatable list of short text entries.' },
  file: { label: 'File', help: 'A file upload — requires a companion drop link; opt-in.' },
};

/** Full intake_form authoring form model. */
export interface IntakeFormFormModel {
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly instructions: AuthoringTextField;
  readonly success_message: AuthoringTextField;
  readonly submit_button_label: AuthoringTextField;
  readonly template_ref: AuthoringTextField;
  readonly form_definition_id: AuthoringTextField;
  readonly fields: AuthoringRepeaterField<IntakeFormFieldRow>;
  /** D-210 A.8 slice 2b step 3 — every option is a real destination; there is
   *  no empty choice, because there is no absent `target_kind`. */
  readonly target_kind: AuthoringSelectField<IntakeFormTargetKind>;
  readonly fields_to_include_in_target: AuthoringMultiSelectField<string>;
  readonly fields_to_attach_as_metadata: AuthoringMultiSelectField<string>;
  /** D-210 WS3 — the `calendar` destination's field→slot mapping.
   *
   *  ⚠ PRESENT ONLY WHEN THE TARGET IS `calendar`, and that is load-bearing:
   *  `seedWorkingConfig` walks EVERY model leaf into the working config, so a
   *  field that is always present would seed a `calendar_mapping` into every
   *  intake form — including note and task ones that have no calendar. Absent
   *  from the model = absent from the config. */
  readonly calendar_start_field?: AuthoringSelectField<string>;
  readonly calendar_end_mode?: AuthoringSelectField<IntakeFormCalendarEndMode>;
  readonly calendar_end_field?: AuthoringSelectField<string>;
  readonly calendar_duration_field?: AuthoringSelectField<string>;
  readonly calendar_default_duration_minutes?: AuthoringNumberField;
  readonly calendar_timezone?: AuthoringTextField;
  /** D-210 WS3 — the `contact` destination's only authorable slot; same
   *  target-gated presence as the calendar block above. The EMAIL is
   *  deliberately absent: a contact is keyed on the visitor email the
   *  substrate already sealed, resolved server-side at approval. */
  readonly contact_name_field?: AuthoringSelectField<string>;
  readonly honeypot_fields: AuthoringMultiSelectField<string>;
  readonly rate_limit_per_ip: AuthoringNumberField;
  /** Reserved contract fields kept in the model so existing configs still
   *  round-trip and fresh configs satisfy the contract. Deliberately not
   *  rendered: neither protection has an implementation. */
  readonly require_proof_of_work: AuthoringToggleField;
  readonly require_captcha: AuthoringToggleField;
  readonly known_domain_allowlist: AuthoringRepeaterField<string>;
  readonly visitor_email_requirement: AuthoringSelectField<ReceptionVisitorFieldRequirement>;
}

/** One `form_definition.fields[]` repeater row — mirrors
 *  `IntakeFormConfigField`. */
export interface IntakeFormFieldRow {
  readonly name: string;
  readonly type: IntakeFormVisitorFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly values: ReadonlyArray<string>;
}

const buildFieldNameOptions = (
  fieldNames: ReadonlyArray<string>,
): ReadonlyArray<AuthoringOption<string>> =>
  fieldNames.map((n) => ({ value: n, label: n, help: `The "${n}" form field.` }));

/** D-210 WS3 — a field-name select that may legitimately hold NOTHING needs an
 *  explicit empty option.
 *
 *  ⚠ Found by a browser verify: `renderSelectField` marks an option `selected`
 *  only when it matches the value, so a select whose value is `''` with no
 *  matching option renders with the browser's own fallback — the FIRST option —
 *  and reads as if that field were chosen. The config said nothing; the form
 *  said `arrives_at`. A control must not claim a choice nobody made.
 *
 *  Choosing the empty option writes nothing: `putConfigField` maps an empty
 *  select back to an omitted key. */
const withEmptyOption = (
  options: ReadonlyArray<AuthoringOption<string>>,
  label: string,
): ReadonlyArray<AuthoringOption<string>> => [
  { value: '', label, help: 'No field is mapped to this slot.' },
  ...options,
];

/** Project an `IntakeFormConfig` (or `null`) into the form model. The
 *  field-name-derived multiselects (`fields_to_include_in_target`,
 *  `honeypot_fields`, …) draw their options from the current
 *  `form_definition.fields` so the renderer always offers exactly the
 *  fields the form defines. */
export const buildIntakeFormFormModel = (
  config: IntakeFormConfig | null,
): IntakeFormFormModel => {
  const fd = config?.form_definition;
  const rule = config?.submission_processing_rule;
  const spam = config?.anti_spam;
  const fieldNames = (fd?.fields ?? []).map((f) => f.name);
  const fieldNameOptions = buildFieldNameOptions(fieldNames);
  // D-210 WS3 — the calendar mapping may only name fields that can actually
  // carry what it asks for. Offering every field would let an owner point a
  // start at a textarea and only learn at save time; worse, an end-mode with
  // no eligible field would be a choice that cannot stick.
  const instantFieldNames = (fd?.fields ?? [])
    .filter((f) => f.type === 'date' || f.type === 'datetime')
    .map((f) => f.name);
  const numberFieldNames = (fd?.fields ?? [])
    .filter((f) => f.type === 'number')
    .map((f) => f.name);
  const calendarMapping = rule?.calendar_mapping;
  const endMode = intakeFormCalendarEndMode(calendarMapping);
  // An end-mode whose field list is empty is omitted rather than offered: the
  // form has nothing to point it at, so choosing it could not be saved.
  const endModeOptions = INTAKE_FORM_CALENDAR_END_MODES
    .filter((m) => (
      m === 'end_field' ? instantFieldNames.length > 1
        : m === 'duration_field' ? numberFieldNames.length > 0
          : true
    ))
    .map((m) => ({
      value: m,
      label: INTAKE_FORM_CALENDAR_END_MODE_COPY[m].label,
      help: INTAKE_FORM_CALENDAR_END_MODE_COPY[m].help,
    }));
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on the form — typically your name or the form purpose.',
      value: config?.display_name ?? '',
      max_length: INTAKE_FORM_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    instructions: {
      control: 'text',
      key: 'instructions',
      label: 'Instructions',
      help: 'An optional paragraph shown above the form fields.',
      value: config?.instructions ?? '',
      max_length: INTAKE_FORM_INSTRUCTIONS_MAX,
      required: false,
      multiline: true,
    },
    success_message: {
      control: 'text',
      key: 'success_message',
      label: 'Success message',
      help: 'Confirmation-page copy. Leave blank for the substrate default ("Submission received").',
      value: config?.success_message ?? '',
      max_length: INTAKE_FORM_SUCCESS_MESSAGE_MAX,
      required: false,
      multiline: true,
    },
    submit_button_label: {
      control: 'text',
      key: 'submit_button_label',
      label: 'Submit button label',
      help: 'Leave blank for the substrate default ("Submit").',
      value: config?.submit_button_label ?? '',
      max_length: INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX,
      required: false,
      multiline: false,
    },
    template_ref: {
      control: 'text',
      key: 'template_ref',
      label: 'Template reference',
      help: 'Set automatically when you start from a Foundation-pack template. Leave blank for a hand-built form.',
      value: config?.template_ref ?? '',
      max_length: 100,
      required: false,
      multiline: false,
    },
    form_definition_id: {
      control: 'text',
      key: 'form_definition.form_definition_id',
      label: 'Form definition id',
      help: 'A stable id for this form definition — used to correlate submissions.',
      value: fd?.form_definition_id ?? '',
      max_length: 100,
      required: true,
      multiline: false,
    },
    fields: {
      control: 'repeater',
      key: 'form_definition.fields',
      label: 'Form fields',
      help: `The fields the visitor fills in. Up to ${INTAKE_FORM_FIELDS_COUNT_MAX}; each name must be lowercase and unique.`,
      rows: (fd?.fields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        label: f.label,
        required: f.required,
        values: f.values ?? [],
      })),
      min_rows: 1,
      max_rows: INTAKE_FORM_FIELDS_COUNT_MAX,
    },
    target_kind: {
      control: 'select',
      key: 'submission_processing_rule.target_kind',
      label: 'After approval',
      // ⚠ Was "The response itself is always recorded" — that stopped being
      // true in 2b. A response row is written only when `form_response` IS the
      // destination; otherwise the record is the entity this creates.
      help: 'What approval creates from the submission.',
      // D-210 A.8 slice 2b step 3 — `form_response` is the default: it is what
      // an unconfigured form used to mean by an absent target_kind.
      value: rule?.target_kind ?? 'form_response',
      options: [
        ...INTAKE_FORM_TARGET_KINDS.map((k) => ({
          value: k,
          label: INTAKE_FORM_TARGET_KIND_COPY[k].label,
          help: INTAKE_FORM_TARGET_KIND_COPY[k].help,
        })),
      ],
    },
    fields_to_include_in_target: {
      control: 'multiselect',
      key: 'submission_processing_rule.fields_to_include_in_target',
      label: 'Fields routed into the target entity',
      help: 'Form fields written into the target entity body / fields.',
      value: rule?.fields_to_include_in_target ?? [],
      options: fieldNameOptions,
      min_selected: 0,
      max_selected: fieldNames.length,
    },
    fields_to_attach_as_metadata: {
      control: 'multiselect',
      key: 'submission_processing_rule.fields_to_attach_as_metadata',
      label: 'Fields attached as metadata',
      help: 'Form fields stashed in the entity metadata blob — must not overlap the routed fields above.',
      value: rule?.fields_to_attach_as_metadata ?? [],
      options: fieldNameOptions,
      min_selected: 0,
      max_selected: fieldNames.length,
    },
    ...(rule?.target_kind === 'calendar' ? {
    calendar_start_field: {
      control: 'select',
      key: 'submission_processing_rule.calendar_mapping.start_field',
      label: 'Field carrying the start',
      help: instantFieldNames.length === 0
        ? 'Add a Date or Date & time field to the form first — a calendar event needs a start.'
        : 'Which field holds when it starts. A Date field books the whole day; a Date & time field books an exact time.',
      value: calendarMapping?.start_field ?? '',
      options: withEmptyOption(buildFieldNameOptions(instantFieldNames), 'Select a field…'),
    },
    calendar_end_mode: {
      control: 'select',
      key: INTAKE_FORM_CALENDAR_END_MODE_KEY,
      label: 'How the end is worked out',
      help: 'Pick one. Switching clears the others so only one is ever in force.',
      value: endMode,
      options: endModeOptions,
    },
    calendar_end_field: {
      control: 'select',
      key: 'submission_processing_rule.calendar_mapping.end_field',
      label: 'Field carrying the end',
      help: 'Which field holds when it ends. For whole days this is the day they leave — a stay from the 20th to the 23rd is three nights.',
      value: calendarMapping?.end_field ?? '',
      options: withEmptyOption(
        buildFieldNameOptions(
          instantFieldNames.filter((n) => n !== calendarMapping?.start_field),
        ),
        'Select a field…',
      ),
    },
    calendar_duration_field: {
      control: 'select',
      key: 'submission_processing_rule.calendar_mapping.duration_field',
      label: 'Field carrying the duration (hours)',
      help: 'Which number field holds how long, in hours.',
      value: calendarMapping?.duration_field ?? '',
      options: withEmptyOption(buildFieldNameOptions(numberFieldNames), 'Select a field…'),
    },
    calendar_default_duration_minutes: {
      control: 'number',
      key: 'submission_processing_rule.calendar_mapping.default_duration_minutes',
      label: 'Fixed length (minutes)',
      help: 'How long every booking runs. The visitor never sees this.',
      value: calendarMapping?.default_duration_minutes
        ?? INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES,
      min: INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN,
      max: INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX,
    },
    calendar_timezone: {
      control: 'text',
      key: 'submission_processing_rule.calendar_mapping.timezone',
      label: 'Timezone',
      help: 'The zone a visitor’s chosen time is read in — e.g. Europe/Paris. Leave blank for UTC.',
      value: calendarMapping?.timezone ?? '',
      max_length: 64,
      required: false,
      multiline: false,
    },
    } : {}),
    ...(rule?.target_kind === 'contact' ? {
    contact_name_field: {
      control: 'select',
      key: 'submission_processing_rule.contact_mapping.contact_name_field',
      label: 'Field carrying the contact’s name',
      help: 'Optional. The contact is keyed on the visitor’s email either way — this only adds a display name.',
      value: rule?.contact_mapping?.contact_name_field ?? '',
      options: withEmptyOption(fieldNameOptions, '— no name field —'),
    },
    } : {}),
    honeypot_fields: {
      control: 'multiselect',
      key: 'anti_spam.honeypot_fields',
      label: 'Honeypot fields',
      help: 'Form fields rendered hidden as bot bait — a submission that fills any of them is tagged spam.',
      value: spam?.honeypot_fields ?? [],
      options: fieldNameOptions,
      min_selected: 0,
      max_selected: Math.min(INTAKE_FORM_HONEYPOT_FIELDS_MAX, fieldNames.length),
    },
    rate_limit_per_ip: {
      control: 'number',
      key: 'anti_spam.rate_limit_per_ip',
      label: 'Per-IP rate limit (per hour)',
      help: 'Maximum submissions accepted from one IP per hour.',
      value: spam?.rate_limit_per_ip ?? INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT,
      min: INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
      max: INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
    },
    require_proof_of_work: {
      control: 'toggle',
      key: 'anti_spam.require_proof_of_work',
      label: 'Require proof-of-work',
      help: 'Reserved compatibility setting. Proof-of-work is not currently implemented or enforced.',
      value: spam?.require_proof_of_work ?? false,
    },
    require_captcha: {
      control: 'toggle',
      key: 'anti_spam.require_captcha',
      label: 'Require CAPTCHA',
      help: 'Reserved compatibility setting. CAPTCHA is not currently implemented or enforced.',
      value: spam?.require_captcha ?? false,
    },
    known_domain_allowlist: {
      control: 'repeater',
      key: 'anti_spam.known_domain_allowlist',
      label: 'Email domain allowlist',
      help: `Optional — submissions whose email domain is not listed are tagged rejected. Up to ${INTAKE_FORM_DOMAIN_ALLOWLIST_MAX}.`,
      rows: spam?.known_domain_allowlist ?? [],
      min_rows: 0,
      max_rows: INTAKE_FORM_DOMAIN_ALLOWLIST_MAX,
    },
    visitor_email_requirement: {
      control: 'select',
      key: 'required_visitor_fields.email',
      label: 'Visitor email',
      help: 'Whether the substrate-injected email field is required, optional, or hidden.',
      value: config?.required_visitor_fields.email ?? 'optional',
      options: buildVisitorFieldRequirementOptions(['required', 'optional', 'omit']),
    },
  };
};

/** Validate a working `IntakeFormConfig`. Pure — no I/O. */
export const validateIntakeFormFormConfig = (
  config: unknown,
): AuthoringValidationSummary<IntakeFormConfigValidationCode> =>
  summarizeConfigValidation(
    validateIntakeFormConfig(config),
    INTAKE_FORM_CONFIG_ERROR_COPY,
  );

// ════════════════════════════════════════════════════════════════
// drop_link (§ A.5.4)
// ════════════════════════════════════════════════════════════════

/** Closed-list `DropLinkConfigValidationCode` → remediation copy. */
export const DROP_LINK_CONFIG_ERROR_COPY: Readonly<
  Record<DropLinkConfigValidationCode, string>
> = {
  config_shape_invalid: 'The drop link configuration is malformed. Refresh the page + try again.',
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on the upload form.',
  display_name_too_long: `Display name is too long (max ${DROP_LINK_DISPLAY_NAME_MAX} characters).`,
  instructions_too_long: `Instructions are too long (max ${DROP_LINK_INSTRUCTIONS_MAX} characters).`,
  success_message_too_long: `Success message is too long (max ${DROP_LINK_SUCCESS_MESSAGE_MAX} characters).`,
  submit_button_label_too_long: `Submit-button label is too long (max ${DROP_LINK_SUBMIT_BUTTON_LABEL_MAX} characters).`,
  template_ref_invalid: 'The template reference must be a non-empty string when present.',
  link_kind_unknown: 'Pick whether the link is one-time or repeated.',
  contact_scoping_invalid: 'The contact-scoping configuration is malformed. Refresh the page + try again.',
  size_cap_out_of_range: 'The size cap must be between 1 KB and 1 GB.',
  allowed_mime_types_empty: 'Pick at least one allowed file type.',
  allowed_mime_types_too_many: 'Too many file types selected.',
  allowed_mime_type_unknown: 'A selected file type is not in the closed allowlist.',
  expiry_days_out_of_range: `Expiry must be ${DROP_LINK_EXPIRY_DAYS_MIN}–${DROP_LINK_EXPIRY_DAYS_MAX} days (drop links carry a hard 30-day ceiling).`,
  max_uploads_out_of_range: `The per-day upload cap must be ${DROP_LINK_MAX_UPLOADS_PER_DAY_MIN}–${DROP_LINK_MAX_UPLOADS_PER_DAY_MAX}.`,
  visitor_fields_invalid: 'A visitor-field requirement is malformed — name / email / description must each be Required, Optional, or Hidden.',
  on_upload_invalid: 'The on-upload configuration is malformed. Refresh the page + try again.',
  notification_target_unknown: 'Pick a notification target from the closed list.',
  triggered_recipe_id_invalid:
    'Triggered recipes have been retired here — watch the destination entity instead. '
    + 'Remove the field.',
  auto_attach_to_project_id_invalid: 'The auto-attach project id must be a non-empty string when present.',
  domain_allowlist_too_many: `Too many allowlisted domains (max ${DROP_LINK_DOMAIN_ALLOWLIST_MAX}).`,
  domain_allowlist_entry_too_long: 'An allowlisted domain entry is too long or empty.',
  visitor_receipt_invalid: 'The visitor-receipt configuration is malformed. Check the receipt delivery setting.',
};

/** § A.5.4 — per-`DropLinkAllowedMimeType` chip copy. */
export const DROP_LINK_MIME_TYPE_COPY: Readonly<
  Record<DropLinkAllowedMimeType, { label: string; help: string }>
> = {
  'application/pdf': { label: 'PDF', help: 'PDF documents.' },
  'image/jpeg': { label: 'JPEG image', help: 'JPEG photos / images.' },
  'image/png': { label: 'PNG image', help: 'PNG images.' },
  'image/webp': { label: 'WebP image', help: 'WebP images.' },
  'image/gif': { label: 'GIF image', help: 'GIF images.' },
  'text/plain': { label: 'Plain text', help: 'Plain-text files.' },
};

/** The three visitor fields a drop link can collect. */
export const DROP_LINK_VISITOR_FIELD_KEYS = ['name', 'email', 'description'] as const;

export type DropLinkVisitorFieldKey = (typeof DROP_LINK_VISITOR_FIELD_KEYS)[number];

const DROP_LINK_VISITOR_FIELD_COPY: Readonly<
  Record<DropLinkVisitorFieldKey, { label: string; help: string }>
> = {
  name: { label: 'Visitor name', help: 'Who is sending the file.' },
  email: { label: 'Visitor email', help: 'How you reach the sender about the upload.' },
  description: { label: 'Description', help: 'A short "what is this file" line from the sender.' },
};

/** Full drop_link authoring form model. */
export interface DropLinkFormModel {
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly instructions: AuthoringTextField;
  readonly success_message: AuthoringTextField;
  readonly submit_button_label: AuthoringTextField;
  readonly template_ref: AuthoringTextField;
  readonly link_kind: AuthoringSelectField<'one_time' | 'repeated'>;
  readonly size_cap_bytes: AuthoringNumberField;
  readonly allowed_mime_types: AuthoringMultiSelectField<DropLinkAllowedMimeType>;
  readonly expiry_days: AuthoringNumberField;
  readonly max_uploads_per_endpoint_per_day: AuthoringNumberField;
  readonly required_visitor_fields: ReadonlyArray<
    AuthoringSelectField<ReceptionVisitorFieldRequirement>
  >;
  readonly create_data_file_entity: AuthoringToggleField;
  readonly auto_attach_to_contact: AuthoringToggleField;
  readonly auto_attach_to_project_id: AuthoringTextField;
  readonly known_domain_allowlist: AuthoringRepeaterField<string>;
}

/** Project a `DropLinkConfig` (or `null`) into the form model. */
export const buildDropLinkFormModel = (
  config: DropLinkConfig | null,
): DropLinkFormModel => {
  const rvf = config?.required_visitor_fields;
  const ou = config?.on_upload;
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on the upload form.',
      value: config?.display_name ?? '',
      max_length: DROP_LINK_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    instructions: {
      control: 'text',
      key: 'instructions',
      label: 'Instructions',
      help: 'An optional paragraph shown above the upload widget.',
      value: config?.instructions ?? '',
      max_length: DROP_LINK_INSTRUCTIONS_MAX,
      required: false,
      multiline: true,
    },
    success_message: {
      control: 'text',
      key: 'success_message',
      label: 'Success message',
      help: 'Confirmation-page copy. Leave blank for the substrate default ("Upload received").',
      value: config?.success_message ?? '',
      max_length: DROP_LINK_SUCCESS_MESSAGE_MAX,
      required: false,
      multiline: true,
    },
    submit_button_label: {
      control: 'text',
      key: 'submit_button_label',
      label: 'Submit button label',
      help: 'Leave blank for the substrate default ("Upload").',
      value: config?.submit_button_label ?? '',
      max_length: DROP_LINK_SUBMIT_BUTTON_LABEL_MAX,
      required: false,
      multiline: false,
    },
    template_ref: {
      control: 'text',
      key: 'template_ref',
      label: 'Template reference',
      help: 'Set automatically when you start from a template. Leave blank for a hand-built link.',
      value: config?.template_ref ?? '',
      max_length: 100,
      required: false,
      multiline: false,
    },
    link_kind: {
      control: 'select',
      key: 'link_kind',
      label: 'Link kind',
      help: 'One-time links revoke themselves after a single successful upload; repeated links accept uploads up to the per-day cap.',
      value: config?.link_kind ?? 'repeated',
      options: [
        { value: 'repeated', label: 'Repeated', help: 'Accepts uploads up to the per-day cap, until expiry.' },
        { value: 'one_time', label: 'One-time', help: 'Revokes itself after the first successful upload.' },
      ],
    },
    size_cap_bytes: {
      control: 'number',
      key: 'size_cap_bytes',
      label: 'Size cap (bytes)',
      help: 'Per-file size cap. Between 1 KB and 1 GB; the handler rejects oversize uploads at the body parse.',
      value: config?.size_cap_bytes ?? DROP_LINK_SIZE_CAP_DEFAULT_BYTES,
      min: DROP_LINK_SIZE_CAP_MIN_BYTES,
      max: DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
    },
    allowed_mime_types: {
      control: 'multiselect',
      key: 'allowed_mime_types',
      label: 'Allowed file types',
      help: 'The closed allowlist of file types the magic-byte detector will accept.',
      value: config?.allowed_mime_types ?? ['application/pdf'],
      options: DROP_LINK_ALLOWED_MIME_TYPES.map((m) => ({
        value: m,
        label: DROP_LINK_MIME_TYPE_COPY[m].label,
        help: DROP_LINK_MIME_TYPE_COPY[m].help,
      })),
      min_selected: 1,
      max_selected: DROP_LINK_ALLOWED_MIME_TYPES.length,
    },
    expiry_days: {
      control: 'number',
      key: 'expiry_days',
      label: 'Expiry (days)',
      help: 'Drop links carry a hard 30-day ceiling — pick 1–30 days.',
      value: config?.expiry_days ?? DROP_LINK_EXPIRY_DAYS_DEFAULT,
      min: DROP_LINK_EXPIRY_DAYS_MIN,
      max: DROP_LINK_EXPIRY_DAYS_MAX,
    },
    max_uploads_per_endpoint_per_day: {
      control: 'number',
      key: 'max_uploads_per_endpoint_per_day',
      label: 'Per-day upload cap',
      help: 'Maximum uploads accepted per day so a single link cannot flood disk.',
      value: config?.max_uploads_per_endpoint_per_day ?? DROP_LINK_MAX_UPLOADS_PER_DAY_DEFAULT,
      min: DROP_LINK_MAX_UPLOADS_PER_DAY_MIN,
      max: DROP_LINK_MAX_UPLOADS_PER_DAY_MAX,
    },
    // drop_link's contract validator restricts each visitor field to
    // `'required' | 'optional'` (spec § A.5.4 line 783-787 — NO `'omit'`,
    // unlike intake_form / scheduling_link's phone+notes). Offering
    // `'omit'` here would let the operator pick a value the validator
    // rejects with `visitor_fields_invalid`, so the select is the
    // two-value set only.
    required_visitor_fields: DROP_LINK_VISITOR_FIELD_KEYS.map((fieldKey) => ({
      control: 'select',
      key: `required_visitor_fields.${fieldKey}`,
      label: DROP_LINK_VISITOR_FIELD_COPY[fieldKey].label,
      help: DROP_LINK_VISITOR_FIELD_COPY[fieldKey].help,
      value:
        (rvf?.[fieldKey] as DropLinkVisitorFieldRequirement | undefined) ?? 'optional',
      options: buildVisitorFieldRequirementOptions(['required', 'optional']),
    })),
    create_data_file_entity: {
      control: 'toggle',
      key: 'on_upload.create_data_file_entity',
      label: 'Create a file entity on upload',
      help: 'When an upload lands, your engine creates the matching data.file work-entity.',
      value: ou?.create_data_file_entity ?? true,
    },
    auto_attach_to_contact: {
      control: 'toggle',
      key: 'on_upload.auto_attach_to_contact',
      label: 'Auto-attach to a contact',
      help: 'When the uploader email resolves to a known contact, attach the file to that contact.',
      value: ou?.auto_attach_to_contact ?? false,
    },
    auto_attach_to_project_id: {
      control: 'text',
      key: 'on_upload.auto_attach_to_project_id',
      label: 'Auto-attach to project id',
      help: 'Optionally attach every upload to a specific project.',
      value: ou?.auto_attach_to_project_id ?? '',
      max_length: 100,
      required: false,
      multiline: false,
    },
    known_domain_allowlist: {
      control: 'repeater',
      key: 'known_domain_allowlist',
      label: 'Email domain allowlist',
      help: `Optional — uploads whose email domain is not listed are tagged rejected. Up to ${DROP_LINK_DOMAIN_ALLOWLIST_MAX}.`,
      rows: config?.known_domain_allowlist ?? [],
      min_rows: 0,
      max_rows: DROP_LINK_DOMAIN_ALLOWLIST_MAX,
    },
  };
};

/** Validate a working `DropLinkConfig`. Pure — no I/O. */
export const validateDropLinkFormConfig = (
  config: unknown,
): AuthoringValidationSummary<DropLinkConfigValidationCode> =>
  summarizeConfigValidation(
    validateDropLinkConfig(config),
    DROP_LINK_CONFIG_ERROR_COPY,
  );

// ════════════════════════════════════════════════════════════════
// approval_link (§ A.5.5)
// ════════════════════════════════════════════════════════════════

/** Closed-list `ApprovalLinkConfigValidationCode` → remediation copy. */
export const APPROVAL_LINK_CONFIG_ERROR_COPY: Readonly<
  Record<ApprovalLinkConfigValidationCode, string>
> = {
  config_shape_invalid: 'The approval link configuration is malformed. Refresh the page + try again.',
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on the approval page.',
  display_name_too_long: `Display name is too long (max ${APPROVAL_LINK_DISPLAY_NAME_MAX} characters).`,
  action_kind_unknown: 'Pick an action kind from the closed list.',
  prompt_empty: 'Enter a prompt — it is the question the visitor is asked.',
  prompt_too_long: `Prompt is too long (max ${APPROVAL_LINK_PROMPT_MAX} characters).`,
  context_raw_invalid: 'The context block is malformed — it needs at least a summary.',
  context_summary_empty: 'Enter a context summary — it is the only context the visitor sees.',
  context_summary_too_long: `Context summary is too long (max ${APPROVAL_LINK_CONTEXT_SUMMARY_MAX} characters).`,
  counterparty_aliases_invalid: 'Counterparty aliases must each be a string. They are never shown to the visitor.',
  private_notes_invalid: 'Private notes must each be a string. They are never shown to the visitor.',
  options_required_for_action_kind: 'This action kind needs an options list — add at least one option.',
  options_not_permitted_for_action_kind: 'This action kind does not take options — remove the options list.',
  options_shape_invalid: 'Each option needs a non-empty id and label.',
  options_too_few: `Add at least ${APPROVAL_LINK_OPTIONS_MIN} option.`,
  options_too_many: `Too many options (max ${APPROVAL_LINK_OPTIONS_MAX}).`,
  options_duplicate_id: 'Two options share the same id — option ids must be unique.',
  option_id_invalid: 'An option id is too long.',
  option_label_invalid: 'An option label is too long.',
  option_description_invalid: 'An option description is too long.',
  visitor_field_constraints_invalid: 'The visitor-field constraints are malformed. Refresh the page + try again.',
  visitor_field_name_invalid: 'The visitor-name constraint must be Required or Optional.',
  visitor_field_email_invalid: 'The visitor-email constraint must be Required or Optional.',
  require_email_match_invalid: 'The require-email-match value must be a well-formed email address.',
  expiry_days_out_of_range: `Expiry must be ${APPROVAL_LINK_EXPIRY_DAYS_MIN}–${APPROVAL_LINK_EXPIRY_DAYS_MAX} days (approval links carry a hard 30-day ceiling).`,
  on_action_invalid: 'The on-action configuration is malformed. Refresh the page + try again.',
  on_action_target_id_invalid: 'Enter a target id — it binds this link to one thing to act on.',
  on_approve_action_unknown: 'Pick an on-approve action from the closed list.',
  on_approve_action_unsupported:
    'That on-approve action can no longer be honoured — a response would sit unprocessed '
    + 'and never reach you. Choose "Create a commitment": the reply is held at the approval '
    + 'gate and lands in your Reception Inbox.',
  notification_target_unknown: 'Pick a notification target from the closed list.',
  triggered_recipe_id_invalid:
    'Triggered recipes have been retired here — watch the destination entity instead. '
    + 'Remove the field.',
  success_message_too_long: `Success message is too long (max ${APPROVAL_LINK_SUCCESS_MESSAGE_MAX} characters).`,
  submit_button_label_too_long: `Submit-button label is too long (max ${APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX} characters).`,
  template_ref_invalid: 'The template reference must be a non-empty string (max 100 characters) when present.',
  visitor_receipt_invalid: 'The visitor-receipt configuration is malformed. Check the receipt delivery setting.',
};

/** § A.5.5 — per-`ApprovalLinkActionKind` copy. `requires_options` flags
 *  the two kinds (`pick_time` / `confirm_attendance`) that need an
 *  options list; the renderer hides the options repeater for the rest. */
export const APPROVAL_LINK_ACTION_KIND_COPY: Readonly<
  Record<ApprovalLinkActionKind, { label: string; help: string; requires_options: boolean }>
> = {
  pick_time: {
    label: 'Pick a time',
    help: 'The visitor picks one option from a list of times you offer.',
    requires_options: true,
  },
  approve_wording: {
    label: 'Approve wording',
    help: 'The visitor approves or rejects a piece of wording — rejection can carry a comment.',
    requires_options: false,
  },
  confirm_attendance: {
    label: 'Confirm attendance',
    help: 'The visitor confirms yes / no against one option from a list.',
    requires_options: true,
  },
  answer_question: {
    label: 'Answer a question',
    help: 'The visitor types a free-text answer to your prompt.',
    requires_options: false,
  },
  upload_doc: {
    label: 'Upload a document',
    help: 'The visitor is prompted to upload a document (the file flow routes through a companion drop link).',
    requires_options: false,
  },
};

/** § A.5.5 — per-`ApprovalLinkOnApproveAction` copy. */
export const APPROVAL_LINK_ON_APPROVE_ACTION_COPY: Readonly<
  Record<ApprovalLinkOnApproveAction, { label: string; help: string }>
> = {
  mark_resolved: {
    label: 'Mark resolved',
    help: 'Resolve the target entity when the visitor approves.',
  },
  create_commitment: {
    label: 'Create a commitment',
    help: 'Create a commitment work-entity when the visitor approves.',
  },
  fire_recipe: {
    label: 'Fire a recipe',
    help: 'Fire the reactive recipe named below when the visitor approves.',
  },
};

/** Full approval_link authoring form model. */
export interface ApprovalLinkFormModel {
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly action_kind: AuthoringSelectField<ApprovalLinkActionKind>;
  /** Mirrors `APPROVAL_LINK_ACTION_KIND_COPY[action_kind].requires_options`
   *  — surfaced on the model so the renderer can show / hide the
   *  `options` repeater without re-deriving it. */
  readonly action_kind_requires_options: boolean;
  readonly prompt: AuthoringTextField;
  readonly context_summary: AuthoringTextField;
  readonly counterparty_aliases: AuthoringRepeaterField<string>;
  readonly private_notes: AuthoringRepeaterField<string>;
  readonly options: AuthoringRepeaterField<ApprovalLinkOptionRow>;
  readonly visitor_name_constraint: AuthoringSelectField<'required' | 'optional'>;
  readonly visitor_email_constraint: AuthoringSelectField<'required' | 'optional'>;
  readonly require_email_match: AuthoringTextField;
  readonly expiry_days: AuthoringNumberField;
  readonly target_id: AuthoringTextField;
  readonly on_approve_action: AuthoringSelectField<ApprovalLinkOnApproveAction>;
  readonly success_message: AuthoringTextField;
  readonly submit_button_label: AuthoringTextField;
  readonly template_ref: AuthoringTextField;
}

/** One `options[]` repeater row — mirrors `ApprovalLinkOption`. */
export interface ApprovalLinkOptionRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

const APPROVAL_LINK_VISITOR_CONSTRAINT_OPTIONS: ReadonlyArray<
  AuthoringOption<'required' | 'optional'>
> = [
  { value: 'required', label: 'Required', help: 'The visitor must supply this.' },
  { value: 'optional', label: 'Optional', help: 'The visitor may leave this blank.' },
];

/** Project an `ApprovalLinkConfig` (or `null`) into the form model. */
export const buildApprovalLinkFormModel = (
  config: ApprovalLinkConfig | null,
): ApprovalLinkFormModel => {
  const actionKind: ApprovalLinkActionKind = config?.action_kind ?? 'approve_wording';
  const ctx = config?.context_raw;
  const vfc = config?.visitor_field_constraints;
  const oa = config?.on_action;
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on the approval page.',
      value: config?.display_name ?? '',
      max_length: APPROVAL_LINK_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    action_kind: {
      control: 'select',
      key: 'action_kind',
      label: 'Action kind',
      help: 'The single scoped action this link grants. Each link does exactly one thing.',
      value: actionKind,
      options: APPROVAL_LINK_ACTION_KINDS.map((k) => ({
        value: k,
        label: APPROVAL_LINK_ACTION_KIND_COPY[k].label,
        help: APPROVAL_LINK_ACTION_KIND_COPY[k].help,
      })),
    },
    action_kind_requires_options: APPROVAL_LINK_ACTION_KIND_COPY[actionKind].requires_options,
    prompt: {
      control: 'text',
      key: 'prompt',
      label: 'Prompt',
      help: 'The question the visitor is asked.',
      value: config?.prompt ?? '',
      max_length: APPROVAL_LINK_PROMPT_MAX,
      required: true,
      multiline: true,
    },
    context_summary: {
      control: 'text',
      key: 'context_raw.summary',
      label: 'Context summary',
      help: 'The context the visitor sees alongside the prompt. Counterparty aliases and private notes below are stripped before the visitor sees anything.',
      value: ctx?.summary ?? '',
      max_length: APPROVAL_LINK_CONTEXT_SUMMARY_MAX,
      required: true,
      multiline: true,
    },
    counterparty_aliases: {
      control: 'repeater',
      key: 'context_raw.counterparty_aliases',
      label: 'Counterparty aliases (private)',
      help: 'Names for your own reference — stripped at the packet boundary; never shown to the visitor.',
      rows: ctx?.counterparty_aliases ?? [],
      min_rows: 0,
      max_rows: 32,
    },
    private_notes: {
      control: 'repeater',
      key: 'context_raw.private_notes',
      label: 'Private notes',
      help: 'Notes for your own reference — stripped at the packet boundary; never shown to the visitor.',
      rows: ctx?.private_notes ?? [],
      min_rows: 0,
      max_rows: 32,
    },
    options: {
      control: 'repeater',
      key: 'options',
      label: 'Options',
      help: 'The choices the visitor picks from. Required for "Pick a time" and "Confirm attendance"; not used by the other action kinds.',
      rows: (config?.options ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description ?? '',
      })),
      min_rows: 0,
      max_rows: APPROVAL_LINK_OPTIONS_MAX,
    },
    visitor_name_constraint: {
      control: 'select',
      key: 'visitor_field_constraints.name',
      label: 'Visitor name',
      help: 'Whether the visitor must identify themselves by name.',
      value: vfc?.name ?? 'required',
      options: APPROVAL_LINK_VISITOR_CONSTRAINT_OPTIONS,
    },
    visitor_email_constraint: {
      control: 'select',
      key: 'visitor_field_constraints.email',
      label: 'Visitor email',
      help: 'Whether the visitor must supply an email.',
      value: vfc?.email ?? 'required',
      options: APPROVAL_LINK_VISITOR_CONSTRAINT_OPTIONS,
    },
    require_email_match: {
      control: 'text',
      key: 'visitor_field_constraints.require_email_match',
      label: 'Require email match',
      help: 'Optionally require the visitor email to match a specific address — a soft-trust gate. Leave blank to skip.',
      value: vfc?.require_email_match ?? '',
      max_length: 254,
      required: false,
      multiline: false,
    },
    expiry_days: {
      control: 'number',
      key: 'expiry_days',
      label: 'Expiry (days)',
      help: 'Approval links carry a hard 30-day ceiling — pick 1–30 days.',
      value: config?.expiry_days ?? APPROVAL_LINK_EXPIRY_DAYS_DEFAULT,
      min: APPROVAL_LINK_EXPIRY_DAYS_MIN,
      max: APPROVAL_LINK_EXPIRY_DAYS_MAX,
    },
    target_id: {
      control: 'text',
      key: 'on_action.target_id',
      label: 'Target id',
      help: 'The id of the thing this approval acts on (a proposal, a commitment, …).',
      value: oa?.target_id ?? '',
      max_length: 200,
      required: true,
      multiline: false,
    },
    on_approve_action: {
      control: 'select',
      key: 'on_action.on_approve_action',
      label: 'On approve',
      help: 'What your engine does when the visitor approves.',
      // ⛔ Offer only what the write path will accept, and default to it. The
      // picker used to list all three and DEFAULT to `mark_resolved` — whose
      // effect seam nothing supplies, so every consumption sat pending forever
      // while the visitor was shown a success page. Both lists derive from the
      // one contracts const, so a picker option that the validator refuses is
      // not expressible.
      value: oa?.on_approve_action ?? APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION,
      options: APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS.map((a) => ({
        value: a,
        label: APPROVAL_LINK_ON_APPROVE_ACTION_COPY[a].label,
        help: APPROVAL_LINK_ON_APPROVE_ACTION_COPY[a].help,
      })),
    },
    success_message: {
      control: 'text',
      key: 'success_message',
      label: 'Success message',
      help: 'Confirmation-page copy. Leave blank for the substrate default.',
      value: config?.success_message ?? '',
      max_length: APPROVAL_LINK_SUCCESS_MESSAGE_MAX,
      required: false,
      multiline: true,
    },
    submit_button_label: {
      control: 'text',
      key: 'submit_button_label',
      label: 'Submit button label',
      help: 'Leave blank for the substrate default ("Submit").',
      value: config?.submit_button_label ?? '',
      max_length: APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX,
      required: false,
      multiline: false,
    },
    template_ref: {
      control: 'text',
      key: 'template_ref',
      label: 'Template reference',
      help: 'Set automatically when you start from a template. Leave blank for a hand-built link.',
      value: config?.template_ref ?? '',
      max_length: 100,
      required: false,
      multiline: false,
    },
  };
};

/** Validate a working `ApprovalLinkConfig`. Pure — no I/O. */
export const validateApprovalLinkFormConfig = (
  config: unknown,
): AuthoringValidationSummary<ApprovalLinkConfigValidationCode> =>
  summarizeConfigValidation(
    validateApprovalLinkConfig(config),
    APPROVAL_LINK_CONFIG_ERROR_COPY,
  );

// ════════════════════════════════════════════════════════════════
// status_link (§ A.5.6)
// ════════════════════════════════════════════════════════════════

/** Closed-list `StatusLinkConfigValidationCode` → remediation copy. */
export const STATUS_LINK_CONFIG_ERROR_COPY: Readonly<
  Record<StatusLinkConfigValidationCode, string>
> = {
  config_shape_invalid: 'The status page configuration is malformed. Refresh the page + try again.',
  display_name_empty: 'Enter a display name — it is the visitor-facing heading on the status page.',
  display_name_too_long: `Display name is too long (max ${STATUS_LINK_DISPLAY_NAME_MAX} characters).`,
  caption_too_long: `Caption is too long (max ${STATUS_LINK_CAPTION_MAX} characters).`,
  projection_kind_unknown: 'Pick a projection kind from the closed list.',
  source_ref_invalid: 'The source entity reference is malformed. Refresh the page + try again.',
  source_ref_kind_unknown: 'Pick a source entity kind from the closed list.',
  source_ref_missing_id_field: 'Enter the source entity id.',
  source_ref_disallowed_for_status_link: 'That source entity kind is not allowed for a status page.',
  fields_visible_override_invalid: 'The visible-fields override is malformed.',
  fields_visible_override_exceeds_ceiling:
    'The visible-fields override names a field outside this projection kind’s allowed list.',
  refresh_policy_invalid: 'The refresh policy is malformed. Refresh the page + try again.',
  refresh_interval_required_when_enabled:
    'Set a refresh interval — it is required when auto-refresh is on.',
  refresh_interval_out_of_range: `The refresh interval must be ${STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN}–${STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX} seconds.`,
  expiry_days_out_of_range: `Expiry must be ${STATUS_LINK_EXPIRY_DAYS_MIN}–${STATUS_LINK_EXPIRY_DAYS_MAX} days (status pages carry a hard 90-day ceiling).`,
  comments_enabled_must_be_false_at_v1: 'Comments are a deferred feature — leave them off at v1.',
  shows_update_history_invalid: 'The "show update history" toggle is malformed.',
  template_ref_invalid: 'The template reference must be a non-empty string when present.',
};

/** § A.5.6 — per-`StatusLinkProjectionKind` copy. */
export const STATUS_LINK_PROJECTION_KIND_COPY: Readonly<
  Record<StatusLinkProjectionKind, { label: string; help: string }>
> = {
  event_plan: {
    label: 'Event plan',
    help: 'A read-only view of an event — title, date, location, agenda, attendees.',
  },
  itinerary: {
    label: 'Itinerary',
    help: 'A read-only view of a travel itinerary — title, date range, legs.',
  },
  project: {
    label: 'Project',
    help: 'A read-only view of a project — title, state, open commitments, milestones.',
  },
  packing_list: {
    label: 'Packing list',
    help: 'A read-only view of a packing list — title, items, packed / total counts.',
  },
  commitment_summary: {
    label: 'Commitment summary',
    help: 'A read-only view of a commitment — title, state, due date.',
  },
  custom: {
    label: 'Custom',
    help: 'A narrow generic view — title, summary, updated-at, tags.',
  },
};

/** The seven source entity kinds a status page can project, with the
 *  id field each carries (mirrors `STATUS_LINK_SOURCE_REF_ID_FIELD` in
 *  the contract). A ratchet test asserts the two stay in lockstep. */
export const STATUS_LINK_SOURCE_KINDS = [
  'data.task',
  'data.note',
  'data.commitment',
  'data.project',
  'data.event',
  'data.packing_list',
  'data.itinerary',
] as const;

export type StatusLinkSourceKind = (typeof STATUS_LINK_SOURCE_KINDS)[number];

export const STATUS_LINK_SOURCE_KIND_ID_FIELD: Readonly<
  Record<StatusLinkSourceKind, string>
> = {
  'data.task': 'task_id',
  'data.note': 'note_id',
  'data.commitment': 'commitment_id',
  'data.project': 'project_id',
  'data.event': 'event_id',
  'data.packing_list': 'list_id',
  'data.itinerary': 'itinerary_id',
};

const STATUS_LINK_SOURCE_KIND_COPY: Readonly<
  Record<StatusLinkSourceKind, { label: string; help: string }>
> = {
  'data.task': { label: 'Task', help: 'Project a task entity.' },
  'data.note': { label: 'Note', help: 'Project a note entity.' },
  'data.commitment': { label: 'Commitment', help: 'Project a commitment entity.' },
  'data.project': { label: 'Project', help: 'Project a project entity.' },
  'data.event': { label: 'Event', help: 'Project an event entity.' },
  'data.packing_list': { label: 'Packing list', help: 'Project a packing-list entity.' },
  'data.itinerary': { label: 'Itinerary', help: 'Project an itinerary entity.' },
};

/** Assemble a status-link `SourceQueryRef` from the form's split
 *  kind + id fields. The contract's `SourceQueryRef` is a discriminated
 *  union keyed on `kind` with a per-kind id field; the form surfaces
 *  the two halves separately so the renderer has a stable kind select
 *  + id input, and this helper reassembles them. Pure — no I/O. */
export const buildStatusLinkSourceRef = (
  kind: StatusLinkSourceKind,
  id: string,
): SourceQueryRef =>
  ({ kind, [STATUS_LINK_SOURCE_KIND_ID_FIELD[kind]]: id }) as unknown as SourceQueryRef;

/** Read the id off a status-link `SourceQueryRef` for the form model.
 *  Returns `''` when the ref kind is not a recognised status-link kind
 *  or the id field is missing. Pure — no I/O. Exported so the
 *  working-config container (`reception-authoring-mount.ts`) can
 *  round-trip the split `source_ref.kind` / `source_ref.id` form fields
 *  back through `buildStatusLinkSourceRef` on edit. */
export const readStatusLinkSourceId = (ref: SourceQueryRef | undefined): string => {
  if (ref === undefined) return '';
  const idField = STATUS_LINK_SOURCE_KIND_ID_FIELD[ref.kind as StatusLinkSourceKind];
  if (idField === undefined) return '';
  const value = (ref as unknown as Record<string, unknown>)[idField];
  return typeof value === 'string' ? value : '';
};

/** Full status_link authoring form model. */
export interface StatusLinkFormModel {
  readonly is_new: boolean;
  readonly display_name: AuthoringTextField;
  readonly caption: AuthoringTextField;
  readonly projection_kind: AuthoringSelectField<StatusLinkProjectionKind>;
  readonly source_ref_kind: AuthoringSelectField<StatusLinkSourceKind>;
  readonly source_ref_id: AuthoringTextField;
  /** Narrowing within the projection kind's closed-list field ceiling.
   *  `options` is the full ceiling for the current `projection_kind`;
   *  an empty `value` means "show the whole ceiling". */
  readonly fields_visible_override: AuthoringMultiSelectField<string>;
  readonly auto_refresh_enabled: AuthoringToggleField;
  readonly refresh_interval_seconds: AuthoringNumberField;
  readonly comments_enabled: AuthoringToggleField;
  readonly shows_update_history: AuthoringToggleField;
  readonly expiry_days: AuthoringNumberField;
  readonly template_ref: AuthoringTextField;
}

/** Project a `StatusLinkConfig` (or `null`) into the form model. The
 *  `fields_visible_override` options are drawn from the contract's
 *  per-projection-kind ceiling so the renderer always offers exactly
 *  the fields that projection kind permits. */
export const buildStatusLinkFormModel = (
  config: StatusLinkConfig | null,
): StatusLinkFormModel => {
  const projectionKind: StatusLinkProjectionKind = config?.projection_kind ?? 'custom';
  const sourceKind: StatusLinkSourceKind =
    (config?.source_ref?.kind as StatusLinkSourceKind | undefined) ?? 'data.task';
  const rp = config?.refresh_policy;
  const ceiling = STATUS_PROJECTION_FIELDS_VISIBLE[projectionKind];
  return {
    is_new: config === null,
    display_name: {
      control: 'text',
      key: 'display_name',
      label: 'Display name',
      help: 'The visitor-facing heading on the status page.',
      value: config?.display_name ?? '',
      max_length: STATUS_LINK_DISPLAY_NAME_MAX,
      required: true,
      multiline: false,
    },
    caption: {
      control: 'text',
      key: 'caption',
      label: 'Caption',
      help: 'A sub-header beneath the display name. Leave blank for the substrate default.',
      value: config?.caption ?? '',
      max_length: STATUS_LINK_CAPTION_MAX,
      required: false,
      multiline: false,
    },
    projection_kind: {
      control: 'select',
      key: 'projection_kind',
      label: 'Projection kind',
      help: 'Which shape the read-only projection takes — it gates exactly which fields can ever surface.',
      value: projectionKind,
      options: STATUS_LINK_PROJECTION_KINDS.map((k) => ({
        value: k,
        label: STATUS_LINK_PROJECTION_KIND_COPY[k].label,
        help: STATUS_LINK_PROJECTION_KIND_COPY[k].help,
      })),
    },
    source_ref_kind: {
      control: 'select',
      key: 'source_ref.kind',
      label: 'Source entity kind',
      help: 'Which kind of work entity this page projects.',
      value: sourceKind,
      options: STATUS_LINK_SOURCE_KINDS.map((k) => ({
        value: k,
        label: STATUS_LINK_SOURCE_KIND_COPY[k].label,
        help: STATUS_LINK_SOURCE_KIND_COPY[k].help,
      })),
    },
    source_ref_id: {
      control: 'text',
      key: 'source_ref.id',
      label: 'Source entity id',
      help: 'The id of the specific entity to project.',
      value: readStatusLinkSourceId(config?.source_ref),
      max_length: 200,
      required: true,
      multiline: false,
    },
    fields_visible_override: {
      control: 'multiselect',
      key: 'fields_visible_override',
      label: 'Visible fields',
      help: 'Optionally narrow which fields surface. Leave all unselected to show the whole projection-kind ceiling.',
      value: config?.fields_visible_override ?? [],
      options: ceiling.map((f) => ({
        value: f,
        label: f,
        help: `Surface the "${f}" field.`,
      })),
      min_selected: 0,
      max_selected: ceiling.length,
    },
    auto_refresh_enabled: {
      control: 'toggle',
      key: 'refresh_policy.auto_refresh_enabled',
      label: 'Auto-refresh',
      help: 'When on, the visitor’s browser polls for updates on the interval below.',
      value: rp?.auto_refresh_enabled ?? false,
    },
    refresh_interval_seconds: {
      control: 'number',
      key: 'refresh_policy.refresh_interval_seconds',
      label: 'Refresh interval (seconds)',
      help: 'Polling cadence — used only when auto-refresh is on.',
      value: rp?.refresh_interval_seconds ?? STATUS_LINK_REFRESH_INTERVAL_SECONDS_DEFAULT,
      min: STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN,
      max: STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX,
    },
    comments_enabled: {
      control: 'toggle',
      key: 'comments_enabled',
      label: 'Comments',
      help: 'A deferred feature — must stay off at v1. Feedback runs through a separate approval link.',
      value: config?.comments_enabled ?? false,
    },
    shows_update_history: {
      control: 'toggle',
      key: 'shows_update_history',
      label: 'Show "updated X ago"',
      help: 'Surface a relative-time "last updated" hint beside the projection.',
      value: config?.shows_update_history ?? true,
    },
    expiry_days: {
      control: 'number',
      key: 'expiry_days',
      label: 'Expiry (days)',
      help: 'Status pages carry a hard 90-day ceiling — pick 1–90 days.',
      value: config?.expiry_days ?? STATUS_LINK_EXPIRY_DAYS_DEFAULT,
      min: STATUS_LINK_EXPIRY_DAYS_MIN,
      max: STATUS_LINK_EXPIRY_DAYS_MAX,
    },
    template_ref: {
      control: 'text',
      key: 'template_ref',
      label: 'Template reference',
      help: 'Set automatically when you start from a template. Leave blank for a hand-built page.',
      value: config?.template_ref ?? '',
      max_length: 100,
      required: false,
      multiline: false,
    },
  };
};

/** Validate a working `StatusLinkConfig`. Pure — no I/O. */
export const validateStatusLinkFormConfig = (
  config: unknown,
): AuthoringValidationSummary<StatusLinkConfigValidationCode> =>
  summarizeConfigValidation(
    validateStatusLinkConfig(config),
    STATUS_LINK_CONFIG_ERROR_COPY,
  );
