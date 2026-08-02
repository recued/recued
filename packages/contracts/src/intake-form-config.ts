/** D-149 P6 § A.5.3 — `intake_form` per-endpoint config contract.
 *
 *  Each `intake_form` endpoint stores an `IntakeFormConfig` blob inside
 *  the `public_endpoint_registry.metadata_blob` column. The reception
 *  handler reads the blob at request time + renders the form (GET) /
 *  validates a submission (POST); the rpc admin layer writes the blob
 *  via `reception.endpoint.create` (the same path the other link-style
 *  kinds use).
 *
 *  Validators in this file:
 *
 *    - Closed-shape gate on every field (defense in depth at the rpc
 *      edge before the registry write).
 *    - `form_definition` shape — `form_definition_id` non-empty,
 *      `visitor_visible_fields[*]` ⊆ `IntakeFormVisitorFieldType`
 *      closed list, per-field name uniqueness, label / value length
 *      bounds, enum-values closed list bounded.
 *    - `submission_processing_rule.target_kind` ∈ closed list per spec
 *      § A.5.3 line 697; `fields_to_include_in_target` ⊆ visible-field
 *      names; `notification_target` ∈ closed list per § A.5.3 line 701.
 *    - `anti_spam.honeypot_fields` ⊆ visible-field names (we accept
 *      bot-bait fields that are part of the rendered form but tagged
 *      hidden by the renderer; submissions where they are non-empty
 *      are tagged `'spam'`).
 *    - `anti_spam.rate_limit_per_ip` bounded; `require_proof_of_work`
 *      / `require_captcha` flags are booleans; `known_domain_allowlist`
 *      capped + each entry length-bounded.
 *    - `required_visitor_fields.*` per § A.5.3 line 710 — `email` is
 *      `'required' | 'optional' | 'omit'`.
 *    - `display_name` / `success_message` length bounds so the rendered
 *      HTML stays compact + the no-leak surface stays bounded.
 *
 *  Privacy contract (§ A.5.3 lines 760-762):
 *
 *    - The redacted packet exposes ONLY visitor-visible fields +
 *      submit-button label + success-message template + rate-limit hint.
 *    - It NEVER exposes user-only annotations in `per_field_visibility`
 *      (the field-visibility map stays server-side at every boundary).
 *    - The renderer mirrors the closed-list IntakeFormVisitorField
 *      shape — `password` / `signature` / `trusted_html` / `ref<T>` are
 *      structurally absent from `IntakeFormVisitorFieldType`.
 *
 *  The substrate enforces the privacy contract via the closed-shape
 *  `RedactedPacketPayloadByKind['intake_form_packet']` map in
 *  `redacted-packets.ts`; this config file gates the *config blob* shape
 *  at admin-write time so a corrupt config never reaches the visitor
 *  path.
 *
 *  Spec: D-149 § A.5.3 + § Must Hold I-1 + § A.10 + § A.11
 *  (TR-2 + TR-7 + TR-14). */

import {
  INTAKE_FORM_VISITOR_FIELD_TYPE_SET,
  type IntakeFormVisitorField,
  type IntakeFormVisitorFieldType,
} from './redacted-packets.js';
import {
  validateVisitorReceiptConfig,
  type VisitorReceiptConfig,
} from './visitor-receipt-config.js';

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.3 — display-name length cap. Length-bounded so the
 *  rendered `<title>` + `<h1>` stay compact + the HTML payload is small. */
export const INTAKE_FORM_DISPLAY_NAME_MAX = 100;
export const INTAKE_FORM_INSTRUCTIONS_MAX = 800;
export const INTAKE_FORM_SUCCESS_MESSAGE_MAX = 400;
export const INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX = 60;

/** D-149 P11 — `template_version` provenance string length cap. The
 *  template layer enforces the strict semver shape; the config layer
 *  keeps a loose non-empty + length-bounded check. */
export const INTAKE_FORM_TEMPLATE_VERSION_MAX = 32;

/** Per-field rendered label + name caps. Bounded so a single form
 *  definition can't bloat the rendered HTML; the field name doubles as
 *  the HTML `<input name="...">` so it must stay URL-safe. */
export const INTAKE_FORM_FIELD_NAME_MAX = 64;
export const INTAKE_FORM_FIELD_LABEL_MAX = 200;
export const INTAKE_FORM_FIELD_ENUM_VALUE_MAX = 100;
export const INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX = 32;
export const INTAKE_FORM_FIELDS_COUNT_MAX = 32;

/** Visitor-supplied text caps per type. Each field is sub_dek-encrypted
 *  in the submission_blob via `form-pii.ts`; the cap is what the
 *  renderer's `<input maxlength=…>` advertises + what the handler
 *  enforces server-side. */
export const INTAKE_FORM_VISITOR_TEXT_MAX = 500;
export const INTAKE_FORM_VISITOR_TEXTAREA_MAX = 4000;
export const INTAKE_FORM_VISITOR_EMAIL_MAX = 254;
export const INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX = 16;

/** Spec § A.5.3 line 762 — per-IP submission rate ceiling. The
 *  substrate's `per_endpoint_kind.intake_form` default in
 *  `reception-rate-limit.ts` is 10/hour; the per-config override here
 *  can clamp lower but never higher (the substrate clamps before the
 *  rate-limiter consults the cached row). */
export const INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT = 10;
export const INTAKE_FORM_RATE_LIMIT_PER_IP_MAX = 60;
export const INTAKE_FORM_RATE_LIMIT_PER_IP_MIN = 1;

export const INTAKE_FORM_HONEYPOT_FIELDS_MAX = 4;

/** D-210 WS3 — the field types a calendar mapping's `start_field` / `end_field`
 *  may name. `date` ⇒ an ALL-DAY event, `datetime` ⇒ a TIMED one; the field's
 *  own type carries that decision, so there is no separate all-day flag that
 *  could contradict the form. */
export const CALENDAR_MAPPING_INSTANT_FIELD_TYPES: ReadonlySet<string> = new Set([
  'date',
  'datetime',
]);

/** D-210 WS3 — the exact shape an `<input type="datetime-local">` submits: a
 *  wall-clock instant with NO zone suffix. Seconds are optional (browsers emit
 *  them only when the input declares a step). Anchored so a zone-bearing string
 *  (`…Z`, `…+02:00`) is refused rather than silently re-interpreted — the
 *  calendar mapping's `timezone` is the single authority on which zone a
 *  visitor's wall clock belongs to. */
export const INTAKE_FORM_LOCAL_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** D-210 WS3 — bounds on a calendar mapping's fixed `default_duration_minutes`.
 *  One minute is the floor a real sitting/appointment can take; 24h is the
 *  ceiling at which the owner should be naming an `end_field` instead (a
 *  multi-day span is a two-date form, not a long default). */
export const INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN = 1;
/** The fixed length a fresh calendar mapping starts at — an hour, the length
 *  most appointments default to everywhere else. Authoring convenience only;
 *  the contract has no default (an absent end-spec is a config error). */
export const INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES = 60;
export const INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX = 24 * 60;
export const INTAKE_FORM_DOMAIN_ALLOWLIST_MAX = 32;
export const INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX = 254;

/** Closed list of submission-processing DESTINATIONS — the record a reviewed
 *  submission materializes on approval. The rule must name one explicitly;
 *  forms whose answers are the record use the mutable `form_response`
 *  destination, backed by the sealed submission as immutable evidence.
 *
 *  D-210 A.7 (centre/leaf) — the destination is the CENTRE; the submission and
 *  the commitment are leaves. Three corrections landed with that ruling:
 *
 *  - **`booking` ADDED.** Scheduling froze its destination into the schema, so
 *    the primary destination never joined the vocabulary. Its absence is why
 *    the shipped booking compose template had to name `commitment` instead.
 *  - **`commitment` REMOVED.** Nothing in the reception picture mints one
 *    (A.5): a commitment is *attested* — `derivation` is REQUIRED, so it must
 *    be inferred from something someone said. A booking has no inference step,
 *    and already carries everything a promise needs. ⚠ This removes the value
 *    from the INTAKE vocabulary only — the `commitment` projection arm stays,
 *    because `approval_link` still reaches it.
 *  - **`inbox_item` DROPPED.** It was already dead weight: `topTierKindForTarget`
 *    mapped it to `task` with "no distinct `top_tier_kind`".
 *
 *  A.8 slice 2 adds a fourth:
 *
 *  - **`form_response` RE-ADDED** as the generic MUTABLE destination (A.4 —
 *    event roster / public apply). ⚠ **This reverses a documented WS2 ruling,
 *    and on a CHANGED PREMISE rather than a changed judgement.** WS2 made
 *    `form_response` the always-on submission LOG and dropped it from this
 *    union, because at the time nothing else universally recorded a
 *    submission. `reception_form_submission` is now exactly that — the sealed
 *    provenance anchor every surface keys off, written before anything else
 *    and kept even for spam. With the evidence held there, `form_response` is
 *    free to be what an owner actually needs: a mutable landing zone that
 *    carries a lifecycle. Same shape as A.3 reversing the siblings ruling.
 *    ⇒ see internal design notes (2026-07-19). */
export const INTAKE_FORM_TARGET_KINDS = [
  'task',
  'note',
  // D-210 A.4 / A.8 slice 2 — the generic destination, for an intake whose
  // answers ARE the record (roster, applications). It owns a lifecycle
  // (`FORM_RESPONSE_LIFECYCLE_STATES`) precisely so it is a real tier-2
  // destination rather than a log wearing a destination's name.
  'form_response',
  // D-210 A.7 — the primary destination. A reservation is a mutable business
  // record that owns its own lifecycle (`completed` / `no_show` / `cancelled`),
  // which is why it is neither a commitment nor a calendar event.
  'booking',
  // D-210 WS3 — a reviewed submission may materialize a local CALENDAR EVENT or
  // a CONTACT. Both projection arms already existed and are generic; what was
  // missing is the intake-side selection plus a field→slot mapping (below),
  // because an intake's fields are role-agnostic: nothing in a form says which
  // one is "the start time" or "the name".
  'calendar',
  'contact',
] as const;

export type IntakeFormTargetKind = (typeof INTAKE_FORM_TARGET_KINDS)[number];

export const INTAKE_FORM_TARGET_KIND_SET: ReadonlySet<IntakeFormTargetKind> = new Set(
  INTAKE_FORM_TARGET_KINDS,
);

/** D-210 A.7.1 — the ONE axis that separates destinations. Not
 *  engagement-vs-data: a roster tracks show / no-show without anyone owing
 *  anything, so the line is whether the destination carries a STATE over time.
 *
 *  ⛔ There is deliberately no commitment tier. No destination mints a
 *  commitment (A.5) — that whole slice was deleted by the pressure test, not
 *  deferred. */
/** ⚠ D-210 audit finding 14 — DECLARED, AND NOT YET READ AT RUNTIME.
 *  A.7.1 calls this "the ONLY axis", but an exhaustive sweep finds references
 *  only in this file and the contracts barrel: nothing gates a lifecycle
 *  affordance on `track_state`, and nothing suppresses one for `record_fact`.
 *
 *  It is NOT dead weight, and that distinction is the reason it stays: the
 *  total `Record<IntakeFormTargetKind, ReceptionDestinationTier>` below makes
 *  adding a destination without classifying it a COMPILE ERROR. That is a real
 *  guarantee — a compile-time checklist — just not a runtime one.
 *
 *  Kept honest rather than quietly deleted or quietly "used": this remains a
 *  compile-time destination checklist, not a runtime capability gate. The
 *  `form_response` lifecycle is now backed independently; surfaces still key
 *  their controls from the concrete destination kind. */
export type ReceptionDestinationTier =
  /** Tier 1 — record a fact. Written once, then it just IS. */
  | 'record_fact'
  /** Tier 2 — track a state. Carries a lifecycle the owner advances. */
  | 'track_state';

/** ⚠ A total `Record` on purpose, NOT a lookup with a fallback. Adding a member
 *  to `INTAKE_FORM_TARGET_KINDS` without classifying it here is a COMPILE
 *  error — which is the point: a `?? 'record_fact'` default would silently
 *  strip the lifecycle off the next destination that needs one. */
export const RECEPTION_DESTINATION_TIERS: Readonly<
  Record<IntakeFormTargetKind, ReceptionDestinationTier>
> = {
  note: 'record_fact',
  contact: 'record_fact',
  booking: 'track_state',
  task: 'track_state',
  // D-210 A.7.1 — a roster tracks show / no-show with NOBODY owing anything,
  // which is the case that proved lifecycle and commitment are separate axes.
  form_response: 'track_state',
  // Personal-only, and it keeps its RFC5545 three states — `confirmed |
  // cancelled | tentative` is the gcal/CalDAV enum synced BOTH ways, not a
  // Recued vocabulary, so it gains nothing from this axis (A.2).
  calendar: 'track_state',
};

export const destinationTier = (kind: IntakeFormTargetKind): ReceptionDestinationTier =>
  RECEPTION_DESTINATION_TIERS[kind];

/** Visitor-field requirement enum mirroring the scheduling-link shape. */
export type IntakeFormVisitorFieldRequirement = 'required' | 'optional' | 'omit';

export const INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS: ReadonlyArray<IntakeFormVisitorFieldRequirement> = [
  'required',
  'optional',
  'omit',
] as const;

export const INTAKE_FORM_VISITOR_FIELD_REQUIREMENT_SET: ReadonlySet<IntakeFormVisitorFieldRequirement> =
  new Set(INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS);

/** Per § A.5.3 — visitor-name + visitor-email requirement bundle. The
 *  email field has a separate `required_visitor_fields.email` knob so
 *  Mary can host an anonymous-collection form (every form_definition
 *  field is still per-field-required-or-not — this knob gates whether
 *  the substrate-injected email field is emitted at all). */
export interface IntakeFormVisitorFieldRequirements {
  readonly email: IntakeFormVisitorFieldRequirement;
}

// ────────────────────────────────────────────────────────────────
// Form definition (config-level; persisted via metadata_blob)
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.3 — extended visitor-visible field shape with optional
 *  per-type validators. `enum` fields carry the closed-list `values[]`.
 *  Other field types ignore the `values[]` field. */
export interface IntakeFormConfigField {
  readonly name: string;
  readonly type: IntakeFormVisitorFieldType;
  readonly label: string;
  readonly required: boolean;
  /** Closed-list values for `enum` fields. Ignored for other types. */
  readonly values?: ReadonlyArray<string>;
}

/** Submission processing rule per spec § A.5.3 line 696-702. */
export interface IntakeFormSubmissionProcessingRule {
  /** The DESTINATION a reviewed submission materializes on approval.
   *
   *  ⚠ REQUIRED since D-210 A.8 slice 2b step 3. It was optional, and absent
   *  meant "log-only" — which, once `form_response` became a selectable
   *  destination (A.4), was simply a SECOND SPELLING of `'form_response'`.
   *  Two spellings of one meaning is how a vocabulary starts drifting: every
   *  reader had to know that absent and `'form_response'` were the same thing,
   *  and one that forgot would branch. Say it once, explicitly.
   *
   *  There is no "no destination" any more. An intake whose answers ARE the
   *  record names `'form_response'`. */
  readonly target_kind: IntakeFormTargetKind;
  /** Visible-field names projected into an entity target's body / fields.
   *  Ignored for `form_response`: its held review summary includes every
   *  visible non-honeypot field, and its canonical record retains every
   *  submitted value. */
  readonly fields_to_include_in_target: ReadonlyArray<string>;
  /** Visible-field names stashed in an entity target's metadata blob (e.g.,
   *  budget / timeline columns the user wants to keep but not bury in
   *  the body). Ignored for `form_response`; they do not narrow its canonical
   *  record. Substrate validator enforces ⊆ form_definition field names +
   *  disjoint from `fields_to_include_in_target`.
   *
   *  ⚠ D-210 A.8 slice 2b adds the ⊇ direction for a real (non-`form_response`)
   *  destination: the two lists TOGETHER must cover every visible non-honeypot
   *  field (`field_not_placed`). A destination projects only what is named, so
   *  an unplaced field is discarded — and the sealed evidence row is not an
   *  owner-queryable substitute for a complete destination. */
  readonly fields_to_attach_as_metadata: ReadonlyArray<string>;
  // D-210 Phase C — `triggered_recipe_id` RETIRED (owner ruling, 2026-07-18).
  // It was a hook on the auto-accept path, and the contract already called it
  // legacy: "Reviewed responses use the canonical `form_response.accepted`
  // trigger instead." With `auto_accept` retired its whole scope went, and its
  // named replacement is the destination collection's approval-time create event.
  //
  // The capability survives without a per-endpoint string: the approve leg
  // creates the DESTINATION entity, so a reactive recipe on that collection's
  // `created` event fires exactly when the owner approves. A `form_response`
  // destination emits the same event from its approval-time promotion.
  // The validator REFUSES a stale key rather than ignoring it.
  // D-210 Phase C — `notification_target` RETIRED (owner ruling, 2026-07-18).
  // It was a per-endpoint copy of the D-158 notification-channel vocabulary
  // (`webclient`/`mail` where the block says `ui`/`email`, slack+telegram
  // hardcoded instead of spliced from `MESSENGER_VENDOR_SLUGS`) — a second
  // closed list that could only drift from the first. Its own doc admitted it
  // never dispatched: "the substrate here only persists Mary's stated intent."
  //
  // Replaced by two things that already exist: the D-158 block owns WHICH
  // channels are enabled, and Phase C's `inbox_fanout_mode` owns WHICH SURFACE
  // a held item reaches (actionable ask vs passive notify). Per-endpoint
  // routing, if ever wanted, belongs on the block's channel selector — not a
  // parallel vocabulary. The validator REFUSES a stale key.
  // D-210 Phase C — `auto_accept` RETIRED (owner ruling, 2026-07-18).
  // Every non-spam submission now holds at the D-157 gate and is reviewed in
  // the inbox; there is no per-endpoint pre-grant that skips it. Retired on
  // all three reception kinds at once (`drop_link.on_upload`,
  // `approval_link.on_action`) so inbox model "B" — nothing a visitor submits
  // reaches the owner's world without approval — holds without an asterisk.
  // The validator REFUSES the key rather than ignoring it: an author who set
  // it was expecting a bypass, and silently reviewing instead would be a
  // behaviour change they never see.
  /** D-210 WS3 — how this form's fields map onto a `calendar` destination.
   *  REQUIRED when `target_kind === 'calendar'`, ignored otherwise.
   *
   *  🔑 TWO KNOBS, NOT A SHAPE PER USE CASE. A restaurant booking, a hotel
   *  stay, a car rental and a single all-day request are the SAME mapping with
   *  different field types and end-specs — so the contract names a start field
   *  and how the end is derived, and lets the configs differ. Recurring events
   *  and one-submission-many-events are deliberately OUT of scope: both need a
   *  second entity per submission, which the one-row-one-destination projection
   *  cannot express. */
  readonly calendar_mapping?: IntakeFormCalendarMapping;
  /** D-210 WS3 — how this form's fields map onto a `contact` destination.
   *  Ignored unless `target_kind === 'contact'`. Optional even then: a contact
   *  is keyed on the visitor's email, which the substrate already holds sealed
   *  and resolves server-side — a name is the only thing a FIELD can add. */
  readonly contact_mapping?: IntakeFormContactMapping;
}

/** D-210 WS3 — the `calendar` destination's field→slot mapping.
 *
 *  `start_field` names the visible field carrying the event start; its TYPE
 *  decides all-day vs timed (`date` ⇒ all-day, `datetime` ⇒ timed), so the
 *  form's own shape carries that decision and there is no separate all-day
 *  flag to contradict it.
 *
 *  The end is derived by EXACTLY ONE of three specs, checked in this order:
 *    `end_field`              — a second date/datetime field (hotel check-out,
 *                               rental return). All-day spans use two `date`s.
 *    `duration_field`         — a `number` field the visitor fills in, in HOURS
 *                               (the unit a person types; minutes would invite
 *                               "2" meaning two minutes).
 *    `default_duration_minutes` — a fixed length the visitor never sees
 *                               (a 90-minute dinner sitting).
 *  Naming more than one is a config error, not a precedence puzzle. */
export interface IntakeFormCalendarMapping {
  /** Visible field carrying the start. Must exist in `form_definition.fields`
   *  and be of type `date` or `datetime`. */
  readonly start_field: string;
  /** End-spec (1): a second `date` / `datetime` field. */
  readonly end_field?: string;
  /** End-spec (2): a `number` field holding a duration in HOURS. */
  readonly duration_field?: string;
  /** End-spec (3): a fixed duration in minutes, invisible to the visitor. */
  readonly default_duration_minutes?: number;
  /** IANA timezone the start is interpreted in. Absent ⇒ the projection's
   *  `'UTC'` default, matching the scheduling path. */
  readonly timezone?: string;
}

/** D-210 WS3 — the `contact` destination's field→slot mapping. The EMAIL is
 *  deliberately not nameable here: it is the visitor email the substrate
 *  already sealed at submit, resolved server-side at materialize. A form field
 *  claiming to be "the email" would be visitor-authored data keying an identity
 *  record — a different and much weaker thing. */
export interface IntakeFormContactMapping {
  /** Visible field carrying the contact's display name. Must exist in
   *  `form_definition.fields`. Absent ⇒ the contact is created from the sealed
   *  email alone. */
  readonly contact_name_field?: string;
}

/** Anti-spam config per spec § A.5.3 line 703-709. Substrate enforces
 *  honeypot field presence + rate limit at request time. PoW + CAPTCHA are
 *  reserved compatibility fields: neither is currently implemented or
 *  exposed by the authoring UI, and validation therefore requires both flags
 *  to remain false rather than accepting an unenforced security promise. */
export interface IntakeFormAntiSpamConfig {
  /** Bot-bait field names — substrate-rendered hidden inputs. A
   *  submission where ANY honeypot field carries a non-empty value is
   *  marked `'spam'` + the row is still persisted (so Mary can review
   *  her abuse inbox) but no reactive trigger fires. */
  readonly honeypot_fields: ReadonlyArray<string>;
  /** Per-IP submission rate ceiling (clamps below the substrate
   *  default; never above). */
  readonly rate_limit_per_ip: number;
  /** Reserved for a possible client-side hash-puzzle challenge; must remain
   *  false until runtime enforcement ships. */
  readonly require_proof_of_work: boolean;
  /** Reserved for a possible CAPTCHA challenge; must remain false until
   *  runtime enforcement ships. */
  readonly require_captcha: boolean;
  /** Optional email-domain allowlist — submissions where the visitor's
   *  email's domain is NOT in this list are tagged `'rejected_domain'`. */
  readonly known_domain_allowlist?: ReadonlyArray<string>;
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every form render + POST submit; write only via
 *  `reception.endpoint.create` / future update rpcs. */
export interface IntakeFormConfig {
  /** Visitor-facing display name on the form (typically Mary's first
   *  name or handle). Length-bounded so the renderer's `<title>` +
   *  `<h1>` stay compact + the HTML payload is small. */
  readonly display_name: string;
  /** Optional visitor-facing instructions paragraph (rendered above
   *  the form fields; htmlEscape'd). */
  readonly instructions?: string;
  /** Optional confirmation-page copy. Defaults to the substrate's
   *  generic "Submission received" if absent. */
  readonly success_message?: string;
  /** Optional submit-button label. Defaults to "Submit". */
  readonly submit_button_label?: string;
  /** Optional Foundation-pack template reference per § A.10. Free-form
   *  string at the substrate; the marketplace tracks the closed list
   *  (`INTAKE_FORM_TEMPLATE_REFS`). Stamped by `intakeFormConfigFromTemplate`
   *  at "Use template" time. */
  readonly template_ref?: string;
  /** Optional Foundation-pack template *version* (semver string) the
   *  endpoint was created from — recorded alongside `template_ref` so
   *  Settings / engine logic can tell which template schema + copy +
   *  suggested action an endpoint is based on after the Foundation pack
   *  revs a template (D-149 P11 Codex fold). Always present when
   *  `template_ref` is set + the config came through
   *  `intakeFormConfigFromTemplate`; absent for hand-authored configs. */
  readonly template_version?: string;
  /** Form definition — closed-shape per-field schema rendered in
   *  public mode (`ref<T>` / `password` / `signature` / `trusted_html`
   *  structurally absent from the field-type enum). */
  readonly form_definition: {
    readonly form_definition_id: string;
    readonly fields: ReadonlyArray<IntakeFormConfigField>;
    /** User-only annotation field names — substrate enforces these
     *  NEVER reach the visitor-facing payload (§ A.5.3 line 760). */
    readonly user_only_field_names?: ReadonlyArray<string>;
  };
  readonly submission_processing_rule: IntakeFormSubmissionProcessingRule;
  readonly anti_spam: IntakeFormAntiSpamConfig;
  readonly required_visitor_fields: IntakeFormVisitorFieldRequirements;
  /** D-149 § A.20.3 — optional per-endpoint visitor-receipt config.
   *  Absent ⇒ receipts disabled (opt-in). When `enabled`, the POST
   *  submit handler renders a receipt (reference id + field echo +
   *  privacy footer) on the success page. */
  readonly visitor_receipt?: VisitorReceiptConfig;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type IntakeFormConfigValidationCode =
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'instructions_too_long'
  | 'success_message_too_long'
  | 'submit_button_label_too_long'
  | 'template_ref_invalid'
  | 'template_version_invalid'
  | 'form_definition_invalid'
  | 'form_definition_id_empty'
  | 'fields_empty'
  | 'fields_too_many'
  | 'field_name_invalid'
  | 'field_name_reserved'
  | 'field_name_duplicate'
  | 'field_label_too_long'
  | 'field_type_unknown'
  | 'field_enum_values_empty'
  | 'field_enum_values_too_many'
  | 'field_enum_value_too_long'
  | 'user_only_field_unknown'
  | 'user_only_field_overlaps_visible'
  | 'submission_processing_rule_invalid'
  | 'auto_accept_invalid'
  | 'target_kind_unknown'
  | 'target_kind_missing'
  | 'fields_to_include_unknown'
  | 'fields_to_attach_unknown'
  | 'fields_include_attach_overlap'
  | 'field_not_placed'
  | 'triggered_recipe_id_invalid'
  // D-210 WS3 — the calendar / contact destination mappings.
  | 'calendar_mapping_invalid'
  | 'calendar_mapping_field_unknown'
  | 'calendar_mapping_field_type_invalid'
  | 'calendar_mapping_end_spec_invalid'
  | 'contact_mapping_invalid'
  | 'notification_target_unknown'
  | 'anti_spam_invalid'
  | 'honeypot_unknown_field'
  | 'honeypot_too_many'
  | 'rate_limit_out_of_range'
  | 'domain_allowlist_too_many'
  | 'domain_allowlist_entry_too_long'
  | 'visitor_fields_invalid'
  | 'visitor_receipt_invalid'
  | 'config_shape_invalid';

export interface IntakeFormConfigValidationFailure {
  readonly code: IntakeFormConfigValidationCode;
  readonly detail: string;
}

const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Codex review fold (P2 #3, 2026-05-13) — closed set of substrate-
 *  reserved POST-body keys + URL params. A form field carrying any of
 *  these names would collide with the substrate's hidden controls
 *  (`form_nonce` from the CSRF guard; `visitor_email` from the email
 *  knob; `t` from the bearer-token query param), corrupting the
 *  visitor's submission or silently swallowing the value. The config
 *  validator rejects these names at admin-write time so a malformed
 *  form never reaches the visitor renderer / POST handler. */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'form_nonce',
  'visitor_email',
  't',
]);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const isFiniteIntegerInRange = (
  v: unknown,
  min: number,
  max: number,
): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const isStringWithMax = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length <= max;

const isFieldShape = (v: unknown): v is IntakeFormConfigField => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.name !== 'string' || !FIELD_NAME_RE.test(r.name)) return false;
  if (typeof r.type !== 'string') return false;
  if (!INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(r.type as IntakeFormVisitorFieldType)) return false;
  if (typeof r.label !== 'string' || r.label.length === 0) return false;
  if (r.label.length > INTAKE_FORM_FIELD_LABEL_MAX) return false;
  if (typeof r.required !== 'boolean') return false;
  return true;
};

/** Validate an `IntakeFormConfig`. Pure function — no I/O. Returns the
 *  list of failures; empty array ⇒ valid. */
export const validateIntakeFormConfig = (
  config: unknown,
): ReadonlyArray<IntakeFormConfigValidationFailure> => {
  const failures: IntakeFormConfigValidationFailure[] = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    failures.push({
      code: 'config_shape_invalid',
      detail: 'intake_form config must be an object',
    });
    return failures;
  }
  const c = config as Record<string, unknown>;

  // display_name
  if (!isNonEmptyString(c.display_name) || (c.display_name as string).trim().length === 0) {
    failures.push({ code: 'display_name_empty', detail: 'display_name must be non-empty' });
  } else if ((c.display_name as string).length > INTAKE_FORM_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name must be ≤ ${INTAKE_FORM_DISPLAY_NAME_MAX} characters`,
    });
  }

  // instructions
  if (c.instructions !== undefined) {
    if (typeof c.instructions !== 'string') {
      failures.push({
        code: 'instructions_too_long',
        detail: 'instructions must be a string when present',
      });
    } else if (c.instructions.length > INTAKE_FORM_INSTRUCTIONS_MAX) {
      failures.push({
        code: 'instructions_too_long',
        detail: `instructions must be ≤ ${INTAKE_FORM_INSTRUCTIONS_MAX} characters`,
      });
    }
  }

  // success_message
  if (c.success_message !== undefined) {
    if (typeof c.success_message !== 'string') {
      failures.push({
        code: 'success_message_too_long',
        detail: 'success_message must be a string when present',
      });
    } else if (c.success_message.length > INTAKE_FORM_SUCCESS_MESSAGE_MAX) {
      failures.push({
        code: 'success_message_too_long',
        detail: `success_message must be ≤ ${INTAKE_FORM_SUCCESS_MESSAGE_MAX} characters`,
      });
    }
  }

  // submit_button_label
  if (c.submit_button_label !== undefined) {
    if (typeof c.submit_button_label !== 'string') {
      failures.push({
        code: 'submit_button_label_too_long',
        detail: 'submit_button_label must be a string when present',
      });
    } else if (c.submit_button_label.length > INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX) {
      failures.push({
        code: 'submit_button_label_too_long',
        detail: `submit_button_label must be ≤ ${INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX} characters`,
      });
    }
  }

  // template_ref
  if (c.template_ref !== undefined) {
    if (typeof c.template_ref !== 'string' || c.template_ref.length === 0) {
      failures.push({
        code: 'template_ref_invalid',
        detail: 'template_ref must be a non-empty string when present',
      });
    }
  }

  // template_version — semver-ish string when present (D-149 P11 Codex
  // fold). The template layer's `validateIntakeFormTemplate` enforces
  // the strict semver regex; the config layer keeps a loose
  // non-empty-string + length cap so a hand-authored config can still
  // record provenance without coupling to the template version grammar.
  if (c.template_version !== undefined) {
    if (
      typeof c.template_version !== 'string' ||
      c.template_version.length === 0 ||
      c.template_version.length > INTAKE_FORM_TEMPLATE_VERSION_MAX
    ) {
      failures.push({
        code: 'template_version_invalid',
        detail: `template_version must be a non-empty string ≤ ${INTAKE_FORM_TEMPLATE_VERSION_MAX} characters when present`,
      });
    }
  }

  // form_definition
  let visibleFieldNames: ReadonlySet<string> = new Set();
  /** D-210 WS3 — visible field name → declared type, for the calendar mapping's
   *  type checks (`start_field` must be a date/datetime, `duration_field` a
   *  number). Populated at the SAME site as `visibleFieldNames` so a field can
   *  never be known by name but unknown by type. */
  const visibleFieldTypes = new Map<string, string>();
  if (
    c.form_definition === null ||
    typeof c.form_definition !== 'object' ||
    Array.isArray(c.form_definition)
  ) {
    failures.push({
      code: 'form_definition_invalid',
      detail: 'form_definition must be an object',
    });
  } else {
    const fd = c.form_definition as Record<string, unknown>;
    if (!isNonEmptyString(fd.form_definition_id)) {
      failures.push({
        code: 'form_definition_id_empty',
        detail: 'form_definition.form_definition_id must be non-empty',
      });
    }
    if (!Array.isArray(fd.fields) || fd.fields.length === 0) {
      failures.push({
        code: 'fields_empty',
        detail: 'form_definition.fields must be a non-empty array',
      });
    } else {
      if (fd.fields.length > INTAKE_FORM_FIELDS_COUNT_MAX) {
        failures.push({
          code: 'fields_too_many',
          detail: `form_definition.fields length ${fd.fields.length} exceeds max ${INTAKE_FORM_FIELDS_COUNT_MAX}`,
        });
      }
      const seen = new Set<string>();
      const names: string[] = [];
      for (const f of fd.fields) {
        if (!isFieldShape(f)) {
          if (
            f !== null &&
            typeof f === 'object' &&
            typeof (f as Record<string, unknown>).type === 'string' &&
            !INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(
              (f as Record<string, unknown>).type as IntakeFormVisitorFieldType,
            )
          ) {
            failures.push({
              code: 'field_type_unknown',
              detail: `form_definition.fields[*].type '${String(
                (f as Record<string, unknown>).type,
              )}' is not in the closed list`,
            });
          } else if (
            f !== null &&
            typeof f === 'object' &&
            typeof (f as Record<string, unknown>).label === 'string' &&
            ((f as Record<string, unknown>).label as string).length > INTAKE_FORM_FIELD_LABEL_MAX
          ) {
            failures.push({
              code: 'field_label_too_long',
              detail: `form_definition.fields[*].label exceeds ${INTAKE_FORM_FIELD_LABEL_MAX} chars`,
            });
          } else {
            failures.push({
              code: 'field_name_invalid',
              detail:
                'form_definition.fields[*] must declare { name, type, label, required } with name matching /^[a-z][a-z0-9_]{0,63}$/',
            });
          }
          continue;
        }
        // Codex review fold (P2 #3, 2026-05-13) — substrate-reserved
        // names collide with the renderer's hidden controls. The
        // closed set is small (`form_nonce` / `visitor_email` / `t`)
        // + reject at the config layer so a corrupt schema never
        // reaches the visitor renderer.
        if (RESERVED_FIELD_NAMES.has(f.name)) {
          failures.push({
            code: 'field_name_reserved',
            detail: `form_definition.fields[*].name '${f.name}' collides with a substrate-reserved form key`,
          });
        }
        if (seen.has(f.name)) {
          failures.push({
            code: 'field_name_duplicate',
            detail: `form_definition.fields[*].name '${f.name}' is duplicated`,
          });
        } else {
          seen.add(f.name);
          names.push(f.name);
          visibleFieldTypes.set(f.name, f.type);
        }
        if (f.type === 'enum') {
          if (!Array.isArray(f.values) || f.values.length === 0) {
            failures.push({
              code: 'field_enum_values_empty',
              detail: `form_definition.fields['${f.name}'].values must be a non-empty array for enum type`,
            });
          } else {
            if (f.values.length > INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX) {
              failures.push({
                code: 'field_enum_values_too_many',
                detail: `form_definition.fields['${f.name}'].values length ${f.values.length} exceeds max ${INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX}`,
              });
            }
            for (const v of f.values) {
              if (typeof v !== 'string' || v.length === 0) {
                failures.push({
                  code: 'field_enum_value_too_long',
                  detail: `form_definition.fields['${f.name}'].values entries must be non-empty strings`,
                });
                break;
              }
              if (v.length > INTAKE_FORM_FIELD_ENUM_VALUE_MAX) {
                failures.push({
                  code: 'field_enum_value_too_long',
                  detail: `form_definition.fields['${f.name}'].values entry exceeds ${INTAKE_FORM_FIELD_ENUM_VALUE_MAX} chars`,
                });
                break;
              }
            }
          }
        }
      }
      visibleFieldNames = seen;
    }

    if (fd.user_only_field_names !== undefined) {
      if (!Array.isArray(fd.user_only_field_names)) {
        failures.push({
          code: 'user_only_field_unknown',
          detail: 'form_definition.user_only_field_names must be an array when present',
        });
      } else {
        for (const name of fd.user_only_field_names) {
          if (typeof name !== 'string' || name.length === 0) {
            failures.push({
              code: 'user_only_field_unknown',
              detail: 'form_definition.user_only_field_names entries must be non-empty strings',
            });
            continue;
          }
          if (visibleFieldNames.has(name)) {
            failures.push({
              code: 'user_only_field_overlaps_visible',
              detail: `form_definition.user_only_field_names entry '${name}' is also a visitor-visible field`,
            });
          }
        }
      }
    }
  }

  // submission_processing_rule
  if (
    c.submission_processing_rule === null ||
    typeof c.submission_processing_rule !== 'object' ||
    Array.isArray(c.submission_processing_rule)
  ) {
    failures.push({
      code: 'submission_processing_rule_invalid',
      detail: 'submission_processing_rule must be an object',
    });
  } else {
    const r = c.submission_processing_rule as Record<string, unknown>;
    // D-210: `target_kind` is required and must be one of the closed destination
    // kinds. Runtime validation matters because stored JSON bypasses TypeScript.
    // ⚠ A REQUIRED TypeScript field guards nothing at runtime — a stored or
    // hand-authored JSON config never passes through the compiler. This is the
    // only thing that refuses an absent destination, so it is its own failure
    // with its own code: "you did not choose" and "you chose something that is
    // not real" are different mistakes and read differently to whoever hits them.
    if (r.target_kind === undefined) {
      failures.push({
        code: 'target_kind_missing',
        detail:
          'submission_processing_rule.target_kind is required. An absent value used to mean '
          + "log-only, which is now spelled 'form_response' — name the destination explicitly.",
      });
    } else if (
      typeof r.target_kind !== 'string' ||
      !INTAKE_FORM_TARGET_KIND_SET.has(r.target_kind as IntakeFormTargetKind)
    ) {
      failures.push({
        code: 'target_kind_unknown',
        detail: `submission_processing_rule.target_kind must be one of ${INTAKE_FORM_TARGET_KINDS.join(', ')}`,
      });
    }
    // D-210 Phase C — `auto_accept` is RETIRED. Refuse the key outright
    // rather than ignoring a stale one: it used to mean "skip review", and an
    // endpoint still carrying it would now hold every submission instead. That
    // is the safe direction, but silently — so say it.
    //
    // This also subsumes WS3's rule refusing `auto_accept` + `calendar` /
    // `contact`. That rule existed only because the auto-accept path wrote
    // through the work-entity store and would have silently written a TASK for
    // a booking; with the path gone there is no combination left to refuse.
    if ((r as { auto_accept?: unknown }).auto_accept !== undefined) {
      failures.push({
        code: 'auto_accept_invalid',
        detail:
          'submission_processing_rule.auto_accept has been retired — every submission is '
          + 'held for review in the inbox. Remove the field.',
      });
    }
    const include = Array.isArray(r.fields_to_include_in_target)
      ? r.fields_to_include_in_target.filter((x): x is string => typeof x === 'string')
      : [];
    const attach = Array.isArray(r.fields_to_attach_as_metadata)
      ? r.fields_to_attach_as_metadata.filter((x): x is string => typeof x === 'string')
      : [];
    if (
      !Array.isArray(r.fields_to_include_in_target) ||
      r.fields_to_include_in_target.length !== include.length
    ) {
      failures.push({
        code: 'fields_to_include_unknown',
        detail: 'submission_processing_rule.fields_to_include_in_target must be an array of strings',
      });
    }
    if (
      !Array.isArray(r.fields_to_attach_as_metadata) ||
      r.fields_to_attach_as_metadata.length !== attach.length
    ) {
      failures.push({
        code: 'fields_to_attach_unknown',
        detail: 'submission_processing_rule.fields_to_attach_as_metadata must be an array of strings',
      });
    }
    for (const n of include) {
      if (!visibleFieldNames.has(n)) {
        failures.push({
          code: 'fields_to_include_unknown',
          detail: `submission_processing_rule.fields_to_include_in_target entry '${n}' is not a visible field`,
        });
      }
    }
    for (const n of attach) {
      if (!visibleFieldNames.has(n)) {
        failures.push({
          code: 'fields_to_attach_unknown',
          detail: `submission_processing_rule.fields_to_attach_as_metadata entry '${n}' is not a visible field`,
        });
      }
    }
    // Codex-prevention — disjoint sets so we don't double-write the
    // same field into both body + metadata at engine reaction time.
    const attachSet = new Set(attach);
    for (const n of include) {
      if (attachSet.has(n)) {
        failures.push({
          code: 'fields_include_attach_overlap',
          detail: `submission_processing_rule '${n}' appears in both fields_to_include_in_target and fields_to_attach_as_metadata`,
        });
      }
    }
    // ── D-210 A.8 slice 2b — COVERAGE. The ⊇ direction, which never existed.
    //
    // The two lists above were validated ⊆ only (every NAMED field must be
    // real). Nothing required them to COVER the form, and `buildEntityShape`
    // is asymmetric: `form_response` retains every visible non-honeypot field,
    // while entity destinations project ONLY the named ones. A field in neither
    // list is therefore dropped from the destination entirely.
    //
    // NO owner surface exposes `submission_blob_encrypted` (the reception
    // Records projection deliberately omits it). Without this rule an unplaced field becomes
    // unreadable to the owner permanently and silently.
    //
    // ⛔ Scoped to a REAL non-`form_response` destination:
    //   - `form_response` ⇒ "its canonical record retains every submitted
    //     value" (see the field docs above), so coverage is automatic;
    //   - an INVALID `target_kind` already has its own failure — do not pile a
    //     second, confusing one on top of it.
    const targetKind = r.target_kind;
    if (
      typeof targetKind === 'string'
      && targetKind !== 'form_response'
      && INTAKE_FORM_TARGET_KIND_SET.has(targetKind as IntakeFormTargetKind)
    ) {
      // Honeypots are visible fields by construction (they render; real people
      // leave them empty), so they are excluded here exactly as
      // `buildEntityShape` excludes them. A spam trap is not owner content.
      const antiSpam = c.anti_spam as { honeypot_fields?: unknown } | undefined;
      const honeypots = new Set(
        Array.isArray(antiSpam?.honeypot_fields)
          ? antiSpam.honeypot_fields.filter((x): x is string => typeof x === 'string')
          : [],
      );
      // ⚠ A field can be placed by the DESTINATION'S OWN MAPPING rather than by
      // the two generic lists, and those fields are emphatically not discarded:
      // a `calendar` target consumes `start_field` / `end_field` /
      // `duration_field` into the event's actual time, and a `contact` target
      // consumes `contact_name_field` into the contact's name. Counting only
      // the two lists rejects every valid calendar and contact config — six
      // existing WS3 tests said so before this clause existed.
      const mappingFields = new Set<string>();
      const calMap = r.calendar_mapping as Record<string, unknown> | undefined;
      const conMap = r.contact_mapping as Record<string, unknown> | undefined;
      for (const key of ['start_field', 'end_field', 'duration_field'] as const) {
        const v = calMap?.[key];
        if (typeof v === 'string' && v.length > 0) mappingFields.add(v);
      }
      const contactName = conMap?.contact_name_field;
      if (typeof contactName === 'string' && contactName.length > 0) {
        mappingFields.add(contactName);
      }
      const placed = new Set([...include, ...attach, ...mappingFields]);
      for (const name of visibleFieldNames) {
        if (honeypots.has(name) || placed.has(name)) continue;
        failures.push({
          code: 'field_not_placed',
          detail:
            `form_definition field '${name}' is in neither `
            + 'fields_to_include_in_target nor fields_to_attach_as_metadata, so a '
            + `'${targetKind}' destination would discard what the visitor typed there. `
            + 'Place every field in one of the two lists, or make it a honeypot.',
        });
      }
    }
    // D-210 Phase C — retired; refuse a stale key (see the field's removal note).
    if ((r as { triggered_recipe_id?: unknown }).triggered_recipe_id !== undefined) {
      failures.push({
        code: 'triggered_recipe_id_invalid',
        detail:
          'submission_processing_rule.triggered_recipe_id has been retired — watch the '
          + "destination entity's `created` event instead. Remove the field.",
      });
    }
    // D-210 Phase C — retired; refuse a stale key (see the removal note).
    if ((r as { notification_target?: unknown }).notification_target !== undefined) {
      failures.push({
        code: 'notification_target_unknown',
        detail:
          'submission_processing_rule.notification_target has been retired — notification channels are '
          + 'chosen in Settings, and the inbox fanout mode picks the surface. Remove the field.',
      });
    }

    // ── D-210 WS3 — the calendar destination's field→slot mapping ──────────
    //
    // Validated ONLY for its own target. A mapping left behind after the owner
    // switched the destination away is INERT, not invalid — nothing reads it,
    // and failing the whole config over dead config would make switching
    // targets a destructive act. It is re-validated the moment the target
    // comes back.
    if (r.target_kind === 'calendar' && r.calendar_mapping === undefined) {
      failures.push({
        code: 'calendar_mapping_invalid',
        detail: 'submission_processing_rule.calendar_mapping is required when target_kind is calendar',
      });
    }
    if (r.target_kind === 'calendar' && r.calendar_mapping !== undefined) {
      const m = r.calendar_mapping as Record<string, unknown> | null;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        failures.push({
          code: 'calendar_mapping_invalid',
          detail: 'submission_processing_rule.calendar_mapping must be an object',
        });
      } else {
        // start_field — must name a visible field of a date-ish type. The
        // TYPE is the all-day-vs-timed decision, so a wrong type here is not
        // cosmetic: it silently changes what the event means.
        if (typeof m.start_field !== 'string' || m.start_field.length === 0) {
          failures.push({
            code: 'calendar_mapping_invalid',
            detail: 'submission_processing_rule.calendar_mapping.start_field must be a non-empty string',
          });
        } else if (!visibleFieldNames.has(m.start_field)) {
          failures.push({
            code: 'calendar_mapping_field_unknown',
            detail: `submission_processing_rule.calendar_mapping.start_field '${m.start_field}' is not a visible field`,
          });
        } else if (!CALENDAR_MAPPING_INSTANT_FIELD_TYPES.has(
          visibleFieldTypes.get(m.start_field) ?? '',
        )) {
          failures.push({
            code: 'calendar_mapping_field_type_invalid',
            detail: `submission_processing_rule.calendar_mapping.start_field '${m.start_field}' must be of type ${[...CALENDAR_MAPPING_INSTANT_FIELD_TYPES].join(' or ')}`,
          });
        }

        // EXACTLY ONE end-spec. Naming none leaves the event with no end;
        // naming two is a precedence puzzle nobody should have to resolve by
        // reading the implementation.
        const endSpecs = (['end_field', 'duration_field', 'default_duration_minutes'] as const)
          .filter((k) => m[k] !== undefined);
        if (endSpecs.length !== 1) {
          failures.push({
            code: 'calendar_mapping_end_spec_invalid',
            detail: endSpecs.length === 0
              ? 'submission_processing_rule.calendar_mapping must name exactly one of end_field / duration_field / default_duration_minutes'
              : `submission_processing_rule.calendar_mapping names ${endSpecs.length} end specs (${endSpecs.join(', ')}) — exactly one is allowed`,
          });
        }
        if (m.end_field !== undefined) {
          if (typeof m.end_field !== 'string' || !visibleFieldNames.has(m.end_field)) {
            failures.push({
              code: 'calendar_mapping_field_unknown',
              detail: `submission_processing_rule.calendar_mapping.end_field '${String(m.end_field)}' is not a visible field`,
            });
          } else if (!CALENDAR_MAPPING_INSTANT_FIELD_TYPES.has(
            visibleFieldTypes.get(m.end_field) ?? '',
          )) {
            failures.push({
              code: 'calendar_mapping_field_type_invalid',
              detail: `submission_processing_rule.calendar_mapping.end_field '${m.end_field}' must be of type ${[...CALENDAR_MAPPING_INSTANT_FIELD_TYPES].join(' or ')}`,
            });
          } else if (m.end_field === m.start_field) {
            failures.push({
              code: 'calendar_mapping_end_spec_invalid',
              detail: 'submission_processing_rule.calendar_mapping.end_field must differ from start_field',
            });
          }
        }
        if (m.duration_field !== undefined) {
          if (typeof m.duration_field !== 'string' || !visibleFieldNames.has(m.duration_field)) {
            failures.push({
              code: 'calendar_mapping_field_unknown',
              detail: `submission_processing_rule.calendar_mapping.duration_field '${String(m.duration_field)}' is not a visible field`,
            });
          } else if (visibleFieldTypes.get(m.duration_field) !== 'number') {
            failures.push({
              code: 'calendar_mapping_field_type_invalid',
              detail: `submission_processing_rule.calendar_mapping.duration_field '${m.duration_field}' must be of type number (hours)`,
            });
          }
        }
        if (m.default_duration_minutes !== undefined) {
          const d = m.default_duration_minutes;
          if (
            typeof d !== 'number'
            || !Number.isSafeInteger(d)
            || d < INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN
            || d > INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX
          ) {
            failures.push({
              code: 'calendar_mapping_end_spec_invalid',
              detail: `submission_processing_rule.calendar_mapping.default_duration_minutes must be an integer ${INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN}–${INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX}`,
            });
          }
        }
        if (
          m.timezone !== undefined
          && (typeof m.timezone !== 'string' || m.timezone.length === 0)
        ) {
          failures.push({
            code: 'calendar_mapping_invalid',
            detail: 'submission_processing_rule.calendar_mapping.timezone must be a non-empty string when present',
          });
        }
      }
    }

    // ── D-210 WS3 — the contact destination's mapping ─────────────────────
    //
    // No `contact_email_field`, deliberately: the contact is keyed on the
    // visitor email the substrate sealed at submit and resolves server-side.
    // A name is all a visitor FIELD can contribute.
    if (r.target_kind === 'contact' && r.contact_mapping !== undefined) {
      const cm = r.contact_mapping as Record<string, unknown> | null;
      if (cm === null || typeof cm !== 'object' || Array.isArray(cm)) {
        failures.push({
          code: 'contact_mapping_invalid',
          detail: 'submission_processing_rule.contact_mapping must be an object',
        });
      } else if (cm.contact_name_field !== undefined) {
        if (
          typeof cm.contact_name_field !== 'string'
          || !visibleFieldNames.has(cm.contact_name_field)
        ) {
          failures.push({
            code: 'contact_mapping_invalid',
            detail: `submission_processing_rule.contact_mapping.contact_name_field '${String(cm.contact_name_field)}' is not a visible field`,
          });
        }
      }
    }
  }

  // anti_spam
  if (
    c.anti_spam === null ||
    typeof c.anti_spam !== 'object' ||
    Array.isArray(c.anti_spam)
  ) {
    failures.push({
      code: 'anti_spam_invalid',
      detail: 'anti_spam must be an object',
    });
  } else {
    const a = c.anti_spam as Record<string, unknown>;
    if (!Array.isArray(a.honeypot_fields)) {
      failures.push({
        code: 'honeypot_unknown_field',
        detail: 'anti_spam.honeypot_fields must be an array',
      });
    } else {
      if (a.honeypot_fields.length > INTAKE_FORM_HONEYPOT_FIELDS_MAX) {
        failures.push({
          code: 'honeypot_too_many',
          detail: `anti_spam.honeypot_fields length ${a.honeypot_fields.length} exceeds max ${INTAKE_FORM_HONEYPOT_FIELDS_MAX}`,
        });
      }
      for (const n of a.honeypot_fields) {
        if (typeof n !== 'string' || !visibleFieldNames.has(n)) {
          failures.push({
            code: 'honeypot_unknown_field',
            detail: `anti_spam.honeypot_fields entry '${String(n)}' is not a visible field`,
          });
        }
      }
    }
    if (
      !isFiniteIntegerInRange(
        a.rate_limit_per_ip,
        INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
        INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
      )
    ) {
      failures.push({
        code: 'rate_limit_out_of_range',
        detail: `anti_spam.rate_limit_per_ip must be ${INTAKE_FORM_RATE_LIMIT_PER_IP_MIN}..${INTAKE_FORM_RATE_LIMIT_PER_IP_MAX}`,
      });
    }
    if (typeof a.require_proof_of_work !== 'boolean') {
      failures.push({
        code: 'anti_spam_invalid',
        detail: 'anti_spam.require_proof_of_work must be boolean',
      });
    } else if (a.require_proof_of_work) {
      failures.push({
        code: 'anti_spam_invalid',
        detail:
          'anti_spam.require_proof_of_work is reserved and must be false until proof-of-work enforcement is available',
      });
    }
    if (typeof a.require_captcha !== 'boolean') {
      failures.push({
        code: 'anti_spam_invalid',
        detail: 'anti_spam.require_captcha must be boolean',
      });
    } else if (a.require_captcha) {
      failures.push({
        code: 'anti_spam_invalid',
        detail:
          'anti_spam.require_captcha is reserved and must be false until CAPTCHA enforcement is available',
      });
    }
    if (a.known_domain_allowlist !== undefined) {
      if (!Array.isArray(a.known_domain_allowlist)) {
        failures.push({
          code: 'domain_allowlist_too_many',
          detail: 'anti_spam.known_domain_allowlist must be an array when present',
        });
      } else {
        if (a.known_domain_allowlist.length > INTAKE_FORM_DOMAIN_ALLOWLIST_MAX) {
          failures.push({
            code: 'domain_allowlist_too_many',
            detail: `anti_spam.known_domain_allowlist length ${a.known_domain_allowlist.length} exceeds max ${INTAKE_FORM_DOMAIN_ALLOWLIST_MAX}`,
          });
        }
        for (const n of a.known_domain_allowlist) {
          if (
            typeof n !== 'string' ||
            n.length === 0 ||
            !isStringWithMax(n, INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX)
          ) {
            failures.push({
              code: 'domain_allowlist_entry_too_long',
              detail: `anti_spam.known_domain_allowlist entries must be non-empty strings ≤ ${INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX} chars`,
              });
            break;
          }
        }
      }
    }
  }

  // required_visitor_fields
  if (
    c.required_visitor_fields === null ||
    typeof c.required_visitor_fields !== 'object' ||
    Array.isArray(c.required_visitor_fields)
  ) {
    failures.push({
      code: 'visitor_fields_invalid',
      detail: 'required_visitor_fields must be an object',
    });
  } else {
    const v = c.required_visitor_fields as Record<string, unknown>;
    if (
      typeof v.email !== 'string' ||
      !INTAKE_FORM_VISITOR_FIELD_REQUIREMENT_SET.has(
        v.email as IntakeFormVisitorFieldRequirement,
      )
    ) {
      failures.push({
        code: 'visitor_fields_invalid',
        detail: `required_visitor_fields.email must be one of ${INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS.join(', ')}`,
      });
    }
  }

  // visitor_receipt — D-149 § A.20.3. Optional per-endpoint receipt
  // config; absent ⇒ receipts disabled. A present value delegates to
  // the shared contract validator (closed-list `via` + boolean
  // `enabled`).
  if (c.visitor_receipt !== undefined) {
    const vrFailures = validateVisitorReceiptConfig(c.visitor_receipt);
    if (vrFailures.length > 0) {
      failures.push({
        code: 'visitor_receipt_invalid',
        detail: `visitor_receipt: ${vrFailures[0]!.code} — ${vrFailures[0]!.detail}`,
      });
    }
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Submission input shape (POST /submit)
// ────────────────────────────────────────────────────────────────

/** Visitor-supplied submission input. Per-field values are the raw
 *  strings the visitor typed (no AEAD yet). The handler validates
 *  against the form_definition, encrypts via `form-pii.ts` (one ciphertext
 *  blob per field), and writes the submission_blob row. */
export interface IntakeFormSubmissionInput {
  readonly visitor_email?: string;
  /** Per-field visitor values keyed by form_definition field name.
   *  Field types convert at validation time (number → Number; boolean →
   *  Boolean; date → ISO-8601 string; enum → closed-list membership;
   *  array<text> → array of strings; file → blob reference id). */
  readonly fields: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>;
}

export type IntakeFormSubmissionValidationCode =
  | 'visitor_email_required'
  | 'visitor_email_too_long'
  | 'visitor_email_invalid'
  | 'visitor_email_domain_rejected'
  | 'field_required_missing'
  | 'field_unknown'
  | 'field_type_mismatch'
  | 'field_too_long'
  | 'field_enum_value_invalid'
  | 'field_array_too_many'
  | 'field_value_invalid'
  | 'honeypot_filled'
  | 'unknown_field';

export interface IntakeFormSubmissionValidationFailure {
  readonly code: IntakeFormSubmissionValidationCode;
  readonly detail: string;
}

/** Conservative email syntax probe. Mirrors the scheduling-link
 *  validator; precision deferred to the engine reactive path. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Extract the lower-cased domain from an email address. Returns null
 *  when the input doesn't parse as an email. */
const extractEmailDomain = (raw: string): string | null => {
  const at = raw.indexOf('@');
  if (at < 0 || at === raw.length - 1) return null;
  return raw.slice(at + 1).toLowerCase();
};

/** Validate a visitor-supplied submission against the config. Pure
 *  function — no I/O. Returns the list of failures; empty array ⇒ valid. */
export const validateIntakeFormSubmission = (
  input: IntakeFormSubmissionInput,
  config: IntakeFormConfig,
): ReadonlyArray<IntakeFormSubmissionValidationFailure> => {
  const failures: IntakeFormSubmissionValidationFailure[] = [];

  // Substrate-side email knob — independent of form_definition.fields.
  const emailReq = config.required_visitor_fields.email;
  if (emailReq !== 'omit') {
    if (typeof input.visitor_email !== 'string' || input.visitor_email.length === 0) {
      if (emailReq === 'required') {
        failures.push({
          code: 'visitor_email_required',
          detail: 'visitor_email is required',
        });
      }
    } else if (input.visitor_email.length > INTAKE_FORM_VISITOR_EMAIL_MAX) {
      failures.push({
        code: 'visitor_email_too_long',
        detail: `visitor_email must be ≤ ${INTAKE_FORM_VISITOR_EMAIL_MAX} chars`,
      });
    } else if (!EMAIL_RE.test(input.visitor_email)) {
      failures.push({
        code: 'visitor_email_invalid',
        detail: 'visitor_email must look like an email address',
      });
    } else if (config.anti_spam.known_domain_allowlist && config.anti_spam.known_domain_allowlist.length > 0) {
      const dom = extractEmailDomain(input.visitor_email);
      if (dom === null || !config.anti_spam.known_domain_allowlist.includes(dom)) {
        failures.push({
          code: 'visitor_email_domain_rejected',
          detail: 'visitor_email domain is not in the allowlist',
        });
      }
    }
  }

  // Honeypot — substrate marks a submission spam when any honeypot
  // field carries a non-empty value. Per § A.5.3 the row still persists
  // (so Mary can audit her abuse inbox); the validator just signals.
  for (const hp of config.anti_spam.honeypot_fields) {
    const v = input.fields[hp];
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      failures.push({ code: 'honeypot_filled', detail: `honeypot field '${hp}' was filled` });
      break;
    }
  }

  const visibleByName: Map<string, IntakeFormConfigField> = new Map();
  for (const f of config.form_definition.fields) {
    visibleByName.set(f.name, f);
  }

  // Unknown-field gate — visitor sent a field NOT in form_definition.
  for (const k of Object.keys(input.fields)) {
    if (!visibleByName.has(k)) {
      failures.push({
        code: 'field_unknown',
        detail: `field '${k}' is not in this form's definition`,
      });
    }
  }

  for (const f of config.form_definition.fields) {
    const v = input.fields[f.name];
    const present = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    if (f.required && !present) {
      // Honeypot fields are exempt — a required honeypot would always
      // fail; the substrate's per_field_visibility map carries the
      // user intent. But honeypot fields are not in `required` per
      // the validator above; this branch handles the form_definition
      // non-honeypot required miss.
      if (!config.anti_spam.honeypot_fields.includes(f.name)) {
        failures.push({
          code: 'field_required_missing',
          detail: `field '${f.name}' is required`,
        });
      }
      continue;
    }
    if (!present) continue;
    switch (f.type) {
      case 'text': {
        if (typeof v !== 'string') {
          failures.push({ code: 'field_type_mismatch', detail: `field '${f.name}' must be a string` });
        } else if (v.length > INTAKE_FORM_VISITOR_TEXT_MAX) {
          failures.push({
            code: 'field_too_long',
            detail: `field '${f.name}' must be ≤ ${INTAKE_FORM_VISITOR_TEXT_MAX} chars`,
          });
        }
        break;
      }
      case 'textarea': {
        if (typeof v !== 'string') {
          failures.push({ code: 'field_type_mismatch', detail: `field '${f.name}' must be a string` });
        } else if (v.length > INTAKE_FORM_VISITOR_TEXTAREA_MAX) {
          failures.push({
            code: 'field_too_long',
            detail: `field '${f.name}' must be ≤ ${INTAKE_FORM_VISITOR_TEXTAREA_MAX} chars`,
          });
        }
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n)) {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be a number`,
          });
        }
        break;
      }
      case 'boolean': {
        const isBoolLike =
          typeof v === 'boolean' ||
          (typeof v === 'string' && (v === 'true' || v === 'false' || v === 'on' || v === 'off'));
        if (!isBoolLike) {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be a boolean`,
          });
        }
        break;
      }
      case 'date': {
        if (typeof v !== 'string') {
          failures.push({ code: 'field_type_mismatch', detail: `field '${f.name}' must be a date string` });
        } else if (Number.isNaN(Date.parse(v))) {
          failures.push({
            code: 'field_value_invalid',
            detail: `field '${f.name}' must be a parseable date string`,
          });
        }
        break;
      }
      // D-210 WS3 — `datetime` needs its OWN arm, not `date`'s fall-through.
      // The renderer emits `datetime-local`, whose value is a WALL-CLOCK string
      // with no zone (`2026-07-20T19:30`); the calendar mapping's `timezone`
      // says which zone to read it in. Pinning the shape here is what lets the
      // mapping treat it as a wall clock rather than guessing: a bare `date`
      // (`2026-07-20`) reaching a `datetime` field would otherwise parse fine
      // and silently mean midnight.
      case 'datetime': {
        if (typeof v !== 'string') {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be a datetime string`,
          });
        } else if (!INTAKE_FORM_LOCAL_DATETIME_RE.test(v) || Number.isNaN(Date.parse(v))) {
          failures.push({
            code: 'field_value_invalid',
            detail: `field '${f.name}' must be a local datetime of the form YYYY-MM-DDTHH:MM (no timezone suffix)`,
          });
        }
        break;
      }
      case 'enum': {
        if (typeof v !== 'string') {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be a string from the enum set`,
          });
        } else if (!f.values || !f.values.includes(v)) {
          failures.push({
            code: 'field_enum_value_invalid',
            detail: `field '${f.name}' value '${v}' is not in the enum closed list`,
          });
        }
        break;
      }
      case 'array<text>': {
        if (!Array.isArray(v)) {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be an array of strings`,
          });
        } else if (v.length > INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX) {
          failures.push({
            code: 'field_array_too_many',
            detail: `field '${f.name}' length ${v.length} exceeds max ${INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX}`,
          });
        } else {
          for (const item of v) {
            if (typeof item !== 'string') {
              failures.push({
                code: 'field_type_mismatch',
                detail: `field '${f.name}' entries must be strings`,
              });
              break;
            }
            if (item.length > INTAKE_FORM_VISITOR_TEXT_MAX) {
              failures.push({
                code: 'field_too_long',
                detail: `field '${f.name}' entries must be ≤ ${INTAKE_FORM_VISITOR_TEXT_MAX} chars`,
              });
              break;
            }
          }
        }
        break;
      }
      case 'file': {
        // P6 ships a substrate hook only — the file field requires a
        // drop_link companion endpoint. Validator accepts the field
        // present + non-empty; the renderer in P6 stops emitting `file`
        // inputs by default (the kind is opt-in per § A.5.3 line 756).
        if (typeof v !== 'string') {
          failures.push({
            code: 'field_type_mismatch',
            detail: `field '${f.name}' must be a blob reference id`,
          });
        }
        break;
      }
    }
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Processing-outcome closed list (matches reception_form_submission)
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.3 line 736 — `processing_outcome` closed set. The
 *  substrate writes `'pending'` or `'spam'` at submit time + the
 *  engine-side reactive path flips to one of the terminal states. */
export const INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES = [
  'pending',
  'processed',
  'failed',
  'duplicate',
  'spam',
  'rejected_domain',
] as const;

export type IntakeFormSubmissionProcessingOutcome =
  (typeof INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES)[number];

export const INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOME_SET: ReadonlySet<IntakeFormSubmissionProcessingOutcome> =
  new Set(INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES);

/** Default submit-button label when the config omits one. */
export const INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL = 'Submit' as const;

/** Default success message when the config omits one. */
export const INTAKE_FORM_DEFAULT_SUCCESS_MESSAGE =
  'Submission received. Thank you.' as const;

/** Re-export the visitor field requirement strings for callers that
 *  validate `required_visitor_fields.email`. */
export type { IntakeFormVisitorField, IntakeFormVisitorFieldType };
