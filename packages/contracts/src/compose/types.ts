import type {
  ReceptionPageCustomLink,
  ReceptionPageDisplayOverrides,
} from '../reception-page-config.js';
import type { ReceptionRateLimitConfig } from '../reception-rate-limit.js';
import type { SourceQueryRef } from '../reception-source-query.js';
import type {
  IntakeFormTargetKind,
  IntakeFormVisitorFieldRequirement,
} from '../intake-form-config.js';
import type {
  SchedulingLinkAvailableWindowDefinition,
  SchedulingLinkOnBookingConfig,
} from '../scheduling-link-config.js';
import type {
  IntakeFormVisitorFieldType,
  ReceptionPageLinkedEndpoints,
  ReceptionPageSectionConfig,
  SchedulingLinkVisitorFieldRequirements,
  StatusLinkProjectionKind,
} from '../redacted-packets.js';
import type { StatusLinkRefreshPolicy } from '../status-link-config.js';

export const COMPOSE_CONTRACT_VERSION = '1.0.0' as const;
export type ComposeContractVersion = typeof COMPOSE_CONTRACT_VERSION;

export type ComposeEndpointKind =
  | 'reception_page'
  | 'scheduling_link'
  | 'intake_form'
  | 'status_link';

export type ComposeSourcePath = 'template' | 'intent';
export type ComposeExposureIntent = 'public_anonymous' | 'contracted_bilateral';

export interface ComposeExpiryPolicy {
  readonly mode: 'never' | 'until_date' | 'rolling';
  /** ISO-8601 date/time string. Date-only values are interpreted by JS Date.parse. */
  readonly date?: string;
  readonly rolling_days?: number;
}

export type VisitorPiiClass =
  | 'none'
  | 'visitor_name'
  | 'visitor_email'
  | 'visitor_phone'
  | 'visitor_address'
  | 'visitor_birthdate'
  | 'visitor_employer'
  | 'visitor_income'
  | 'visitor_government_id'
  | 'visitor_payment'
  | 'visitor_sensitive';

export type ProposedFormFieldType =
  | IntakeFormVisitorFieldType
  | 'email'
  | 'password'
  | 'signature'
  | 'trusted_html'
  | `ref<${string}>`;

export interface ProposedFormField {
  readonly name: string;
  readonly type: ProposedFormFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly visitor_pii_class?: VisitorPiiClass;
  readonly values?: ReadonlyArray<string>;
}

export interface ProposedFormDefinition {
  readonly form_definition_id: string;
  readonly fields: ReadonlyArray<ProposedFormField>;
  readonly submit_button_label?: string;
  readonly success_message?: string;
  readonly email_requirement?: IntakeFormVisitorFieldRequirement;
  readonly processing_target?: IntakeFormTargetKind;
}

export interface ProposedSchedulingConfig {
  readonly display_name?: string;
  readonly instructions?: string;
  readonly success_message?: string;
  readonly duration_options_minutes: ReadonlyArray<number>;
  readonly available_window_definition: SchedulingLinkAvailableWindowDefinition;
  readonly required_visitor_fields?: Partial<SchedulingLinkVisitorFieldRequirements>;
  readonly min_advance_notice_hours?: number;
  readonly max_lead_time_days?: number;
  readonly max_bookings_per_day?: number;
  readonly on_booking?: Partial<SchedulingLinkOnBookingConfig>;
}

export interface ProposedPageLayoutConfig {
  readonly display_overrides?: Partial<ReceptionPageDisplayOverrides>;
  readonly sections_enabled?: ReceptionPageSectionConfig;
  readonly linked_endpoints?: ReceptionPageLinkedEndpoints;
  readonly custom_links?: ReadonlyArray<ReceptionPageCustomLink>;
  readonly trust_footer_enabled?: boolean;
}

export interface ProposedStatusProjectionConfig {
  readonly display_name?: string;
  readonly caption?: string;
  readonly projection_kind: StatusLinkProjectionKind;
  readonly source_ref: SourceQueryRef;
  readonly fields_visible_override?: ReadonlyArray<string>;
  readonly refresh_policy?: StatusLinkRefreshPolicy;
  readonly comments_enabled?: false;
  readonly shows_update_history?: boolean;
  readonly expiry_days?: number;
}

export interface AIComposeTraceRedacted {
  readonly version: ComposeContractVersion;
  readonly source_path: ComposeSourcePath;
  readonly detected_slots: Readonly<Record<string, unknown>>;
  readonly selected_kind: ComposeEndpointKind;
  readonly selection_reason_short: string;
  readonly templates_considered?: ReadonlyArray<{
    readonly ref: string;
    readonly rejected_reason: string;
  }>;
}

export interface ProposedEndpointConfig {
  readonly version: ComposeContractVersion;
  readonly kind: ComposeEndpointKind;
  readonly title: string;
  readonly description?: string;
  readonly form_definition?: ProposedFormDefinition;
  readonly scheduling?: ProposedSchedulingConfig;
  readonly status_projection?: ProposedStatusProjectionConfig;
  readonly page_layout?: ProposedPageLayoutConfig;
  readonly expiry_policy: ComposeExpiryPolicy;
  // D-210 Phase C — `notification` RETIRED (owner ruling, 2026-07-18). A
  // proposal cannot state run-time attention: whether a submission needs the
  // owner is the D-157 gate's answer, not an author-time one, and after Phase C
  // the gate holds EVERY non-spam submission unconditionally. The model was
  // being asked to decide something with no effect.
  readonly exposure_intent: ComposeExposureIntent;
  readonly source_path: ComposeSourcePath;
  readonly source_template_ref?: string;
  readonly source_intent_text?: string;
  readonly ai_trace_redacted?: AIComposeTraceRedacted;
}

export interface TemplateSafetyMatrix {
  readonly version: ComposeContractVersion;
  readonly template_ref: string;
  readonly allowed_kinds: ReadonlyArray<ComposeEndpointKind>;
  readonly allowed_field_types: ReadonlyArray<ProposedFormFieldType>;
  readonly forbidden_field_names: ReadonlyArray<string>;
  readonly allowed_visitor_pii_classes?: ReadonlyArray<VisitorPiiClass>;
  readonly default_expiry: ComposeExpiryPolicy;
  readonly long_lived_permitted: boolean;
  /** OPTIONAL — a TEMPLATE may decline to constrain the destination, and a
   *  matrix that names none compiles to `'form_response'`.
   *
   *  ⚠ The previous text said *"`form_response` is no longer a target_kind"*.
   *  That was WS2's state and is now false: A.4 made it the generic
   *  destination, and A.8 slice 2b step 3 made `target_kind` REQUIRED on the
   *  compiled config. Absent HERE (a template constraining nothing) is a
   *  different statement from absent on an ENDPOINT, which no longer exists.
   *  ⚠ This matrix is serialized to the authoring model — see
   *  `docs/chat-prompt-optimization-log.md`. */
  readonly processing_target?: IntakeFormTargetKind;
  // D-210 Phase C — `notification_defaults` RETIRED (owner ruling, 2026-07-18).
  // ⛔ IT WAS A TIER ERROR, not merely an orphan. This matrix is an AI *input* —
  // it is serialized into the model-facing `reception_endpoint_proposal` packet
  // — so the field made an author-time TEMPLATE declare run-time attention
  // ("this notifies on submit, via the webclient inbox"). Run-time attention is
  // the gate's, and Phase C made the gate hold everything, so the claim was
  // also no longer true. A stale claim told to a model on every compose call is
  // the same failure class as a stale doc told to an author.
  //
  // Nothing replaces it here: the gate answers "does this need the owner"
  // for every submission, `inbox_fanout_mode` picks the surface, and the D-158
  // block owns the channels. None of that is a per-template decision.
  readonly rate_limit_policy: ReceptionRateLimitConfig;
}

export interface ComposeTemplate {
  readonly version: ComposeContractVersion;
  readonly template_ref: string;
  readonly safety_matrix: TemplateSafetyMatrix;
}
