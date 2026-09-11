import { RECEPTION_RATE_LIMIT_DEFAULTS } from '../reception-rate-limit.js';
import { COMPOSE_CONTRACT_VERSION, type ComposeTemplate, type TemplateSafetyMatrix } from './types.js';

const COMMON_FORBIDDEN_FIELD_NAMES = [
  'ssn',
  'social_security_number',
  'tax_id',
  'government_id',
  'driver_license',
  'passport',
  'income',
  'salary',
  'mother_maiden_name',
  'credit_card',
  'payment_card',
] as const;

/** Exported for D-220 Slice B — the pack-template safety matrix reuses this
 *  list as its forbidden-field-name vocabulary rather than copying it. */
export const CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES = [
  ...COMMON_FORBIDDEN_FIELD_NAMES,
  'phone',
  'mobile',
  'address',
  'street_address',
  'zip',
  'birthday',
  'birthdate',
  'employer',
] as const;

export const BOOKING_TEMPLATE_SAFETY_MATRIX = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: 'app/recued-core/booking',
  allowed_kinds: ['scheduling_link'],
  allowed_field_types: ['text', 'email', 'date'],
  forbidden_field_names: COMMON_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: { mode: 'rolling', rolling_days: 90 },
  long_lived_permitted: true,
  // D-210 A.7 — was `'commitment'`, which is the destination model A.5 struck.
  // This matrix is serialized into the model-facing `reception_endpoint_proposal`
  // packet, so that value was TELLING the authoring model that a booking mints a
  // commitment. It named `commitment` only because `booking` was not yet in
  // `INTAKE_FORM_TARGET_KINDS` — the vocabulary gap, not a judgement.
  //
  // ⚠ Behaviourally this field is unreachable for THIS template: both consumers
  // gate on `config.kind === 'intake_form'` (compile.ts), and `allowed_kinds` is
  // `['scheduling_link']`, which compile.ts rejects otherwise. It is corrected
  // rather than DELETED because absence is not neutral here — an omitted
  // `processing_target` means LOG-ONLY, and a scheduling link is emphatically
  // not that. The honest declaration is the destination it actually mints.
  processing_target: 'booking',
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
} as const satisfies TemplateSafetyMatrix;

export const RSVP_TEMPLATE_SAFETY_MATRIX = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: 'app/recued-core/rsvp',
  allowed_kinds: ['intake_form'],
  allowed_field_types: ['text', 'email', 'enum', 'textarea', 'number'],
  forbidden_field_names: CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: { mode: 'rolling', rolling_days: 30 },
  long_lived_permitted: false,
  processing_target: 'task',
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
} as const satisfies TemplateSafetyMatrix;

export const PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: 'app/recued-core/photo-share',
  allowed_kinds: ['reception_page', 'status_link'],
  allowed_field_types: [],
  forbidden_field_names: CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none'],
  default_expiry: { mode: 'rolling', rolling_days: 30 },
  long_lived_permitted: true,
  processing_target: 'task',
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
} as const satisfies TemplateSafetyMatrix;

export const CONTACT_FORM_TEMPLATE_SAFETY_MATRIX = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: 'app/recued-core/contact-form',
  allowed_kinds: ['intake_form'],
  allowed_field_types: ['text', 'email', 'enum', 'textarea'],
  forbidden_field_names: CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: { mode: 'rolling', rolling_days: 30 },
  long_lived_permitted: false,
  // D-210 WS3 — a contact form's point IS the contact: an approved submission
  // adds or updates one, keyed on the visitor email the substrate already
  // sealed. (WS2 parked this as log-only because `contact` was not yet a
  // destination; it is now.) The sealed submission remains the evidence row;
  // approval materializes the contact destination.
  processing_target: 'contact',
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
} as const satisfies TemplateSafetyMatrix;

export const FEEDBACK_COLLECT_TEMPLATE_SAFETY_MATRIX = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: 'app/recued-core/feedback-collect',
  allowed_kinds: ['intake_form'],
  allowed_field_types: ['text', 'email', 'enum', 'textarea', 'number'],
  forbidden_field_names: CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: { mode: 'rolling', rolling_days: 30 },
  long_lived_permitted: false,
  // Feedback's answers are the record, so compilation selects the mutable
  // `form_response` destination and approval creates it.
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
} as const satisfies TemplateSafetyMatrix;

export const BOOKING_COMPOSE_TEMPLATE = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: BOOKING_TEMPLATE_SAFETY_MATRIX.template_ref,
  safety_matrix: BOOKING_TEMPLATE_SAFETY_MATRIX,
} as const satisfies ComposeTemplate;

export const RSVP_COMPOSE_TEMPLATE = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: RSVP_TEMPLATE_SAFETY_MATRIX.template_ref,
  safety_matrix: RSVP_TEMPLATE_SAFETY_MATRIX,
} as const satisfies ComposeTemplate;

export const PHOTO_SHARE_COMPOSE_TEMPLATE = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX.template_ref,
  safety_matrix: PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX,
} as const satisfies ComposeTemplate;

export const CONTACT_FORM_COMPOSE_TEMPLATE = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: CONTACT_FORM_TEMPLATE_SAFETY_MATRIX.template_ref,
  safety_matrix: CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
} as const satisfies ComposeTemplate;

export const FEEDBACK_COLLECT_COMPOSE_TEMPLATE = {
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: FEEDBACK_COLLECT_TEMPLATE_SAFETY_MATRIX.template_ref,
  safety_matrix: FEEDBACK_COLLECT_TEMPLATE_SAFETY_MATRIX,
} as const satisfies ComposeTemplate;

export const COMPOSE_TEMPLATE_CATALOG = [
  BOOKING_COMPOSE_TEMPLATE,
  RSVP_COMPOSE_TEMPLATE,
  PHOTO_SHARE_COMPOSE_TEMPLATE,
  FEEDBACK_COLLECT_COMPOSE_TEMPLATE,
  CONTACT_FORM_COMPOSE_TEMPLATE,
] as const satisfies ReadonlyArray<ComposeTemplate>;

export const COMPOSE_TEMPLATE_REFS = COMPOSE_TEMPLATE_CATALOG.map(
  (template) => template.template_ref,
);

export const COMPOSE_TEMPLATE_BY_REF: ReadonlyMap<string, ComposeTemplate> = new Map(
  COMPOSE_TEMPLATE_CATALOG.map((template) => [template.template_ref, template]),
);
