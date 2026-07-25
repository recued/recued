import {
  INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
  validateIntakeFormConfig,
  type IntakeFormConfig,
  type IntakeFormConfigField,
} from '../intake-form-config.js';
import {
  validateReceptionPageConfig,
  type ReceptionPageConfig,
  type ReceptionPageDisplayOverrides,
} from '../reception-page-config.js';
import {
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_PER_KIND_EXPIRY_MAX_MS,
  type PacketDeclaration,
  type ReceptionEndpointCreateInput,
} from '../reception-registry.js';
import {
  PACKET_FIELDS_VISIBLE,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHODS,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  type RedactedPacketKind,
  type SchedulingLinkVisitorFieldRequirements,
} from '../redacted-packets.js';
import type { ReceptionEndpointKind } from '../reception.js';
import {
  validateSchedulingLinkConfig,
  type SchedulingLinkConfig,
} from '../scheduling-link-config.js';
import {
  STATUS_LINK_EXPIRY_DAYS_DEFAULT,
  validateStatusLinkConfig,
  type StatusLinkConfig,
} from '../status-link-config.js';
import type { SourceQueryRef } from '../reception-source-query.js';
import {
  COMPOSE_CONTRACT_VERSION,
  type ComposeEndpointKind,
  type ComposeExpiryPolicy,
  type ProposedEndpointConfig,
  type ProposedFormField,
  type ProposedFormFieldType,
  type TemplateSafetyMatrix,
  type VisitorPiiClass,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const COMPOSE_PREVIEW_HASH_UNMINTED = 'compose.preview_hash.unminted' as const;

export type CompileError =
  | {
      readonly kind: 'version_mismatch';
      readonly expected: typeof COMPOSE_CONTRACT_VERSION;
      readonly got: string;
    }
  | {
      readonly kind: 'safety_matrix_violation';
      readonly template_ref: string;
      readonly violation: string;
    };

export interface CompileProposedEndpointConfigOptions {
  /** Injected wall clock used to turn rolling expiry policies into unix-ms. */
  readonly now?: number;
  /** Real value comes from reception.endpoint.preview_draft after preview. */
  readonly preview_hash?: string;
}

export const isCompileError = (result: unknown): result is CompileError => {
  if (result === null || typeof result !== 'object') return false;
  const kind = (result as { readonly kind?: unknown }).kind;
  return kind === 'version_mismatch' || kind === 'safety_matrix_violation';
};

const versionMismatch = (got: unknown): CompileError => ({
  kind: 'version_mismatch',
  expected: COMPOSE_CONTRACT_VERSION,
  got: typeof got === 'string' ? got : String(got),
});

const safetyViolation = (
  matrix: TemplateSafetyMatrix,
  violation: string,
): CompileError => ({
  kind: 'safety_matrix_violation',
  template_ref: matrix.template_ref,
  violation,
});

const normalizeName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const fieldMatchesForbiddenName = (
  field: ProposedFormField,
  forbidden: ReadonlyArray<string>,
): string | undefined => {
  const fieldName = normalizeName(field.name);
  const fieldLabel = normalizeName(field.label);
  for (const raw of forbidden) {
    const f = normalizeName(raw);
    if (
      fieldName === f ||
      fieldLabel === f ||
      fieldName.startsWith(`${f}_`) ||
      fieldName.endsWith(`_${f}`) ||
      fieldLabel.includes(f)
    ) {
      return raw;
    }
  }
  return undefined;
};

const inferVisitorPiiClass = (field: ProposedFormField): VisitorPiiClass => {
  if (field.visitor_pii_class !== undefined) return field.visitor_pii_class;
  const key = `${normalizeName(field.name)} ${normalizeName(field.label)} ${field.type}`;
  if (field.type === 'email' || key.includes('email')) return 'visitor_email';
  if (key.includes('phone') || key.includes('mobile')) return 'visitor_phone';
  if (key.includes('address') || key.includes('street') || key.includes('zip')) {
    return 'visitor_address';
  }
  if (key.includes('birth') || key.includes('birthday')) return 'visitor_birthdate';
  if (key.includes('employer')) return 'visitor_employer';
  if (key.includes('income') || key.includes('salary')) return 'visitor_income';
  if (key.includes('ssn') || key.includes('tax_id') || key.includes('government_id')) {
    return 'visitor_government_id';
  }
  if (key.includes('credit_card') || key.includes('payment')) return 'visitor_payment';
  if (key.includes('name')) return 'visitor_name';
  return 'none';
};

const DEFAULT_ALLOWED_PII_CLASSES: ReadonlySet<VisitorPiiClass> = new Set([
  'none',
  'visitor_name',
  'visitor_email',
]);

const allowedPiiClassSet = (matrix: TemplateSafetyMatrix): ReadonlySet<VisitorPiiClass> =>
  matrix.allowed_visitor_pii_classes === undefined
    ? DEFAULT_ALLOWED_PII_CLASSES
    : new Set(matrix.allowed_visitor_pii_classes);

const forbiddenFieldTypes: ReadonlySet<ProposedFormFieldType> = new Set([
  'password',
  'signature',
  'trusted_html',
]);

const isForbiddenFieldType = (type: ProposedFormFieldType): boolean =>
  forbiddenFieldTypes.has(type) || type.startsWith('ref<');

const isIntakeFieldType = (type: ProposedFormFieldType): type is IntakeFormConfigField['type'] =>
  type === 'text' ||
  type === 'textarea' ||
  type === 'number' ||
  type === 'boolean' ||
  type === 'date' ||
  type === 'enum' ||
  type === 'array<text>' ||
  type === 'file';

// D-210 Phase C — `notificationTarget` removed with the per-endpoint
// `notification_target` field it fed. A composed endpoint no longer names a
// channel: the D-158 block owns which channels are enabled, and the inbox
// fanout mode owns which surface a held item reaches. `ComposeNotificationConfig.channels`
// stays on the PROPOSAL shape (it is what the author asked for, and the visual
// editor still shows it) — it simply no longer compiles into endpoint config.

const parseExpiryDate = (date: string | undefined): number | undefined => {
  if (typeof date !== 'string' || date.length === 0) return undefined;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const expiryPolicyToMs = (
  policy: ComposeExpiryPolicy,
  now: number,
): number | null | undefined => {
  if (policy.mode === 'never') return null;
  if (policy.mode === 'until_date') return parseExpiryDate(policy.date);
  if (
    policy.mode === 'rolling' &&
    typeof policy.rolling_days === 'number' &&
    Number.isInteger(policy.rolling_days) &&
    policy.rolling_days > 0
  ) {
    return now + policy.rolling_days * DAY_MS;
  }
  return undefined;
};

const compileExpiresAt = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
  now: number,
): number | null | CompileError => {
  const expiresAt = expiryPolicyToMs(config.expiry_policy, now);
  if (expiresAt === undefined) {
    return safetyViolation(matrix, `invalid expiry_policy for kind=${config.kind}`);
  }
  if (expiresAt === null && !matrix.long_lived_permitted) {
    return safetyViolation(matrix, 'long-lived expiry is not permitted by the template safety matrix');
  }

  const matrixMax = expiryPolicyToMs(matrix.default_expiry, now);
  if (
    !matrix.long_lived_permitted &&
    expiresAt !== null &&
    matrixMax !== undefined &&
    matrixMax !== null &&
    expiresAt > matrixMax
  ) {
    return safetyViolation(matrix, 'expiry exceeds the template safety matrix default_expiry ceiling');
  }

  const ceiling = RECEPTION_PER_KIND_EXPIRY_MAX_MS[config.kind];
  if (ceiling !== null && expiresAt === null) {
    return safetyViolation(matrix, `kind=${config.kind} requires explicit expires_at`);
  }
  if (expiresAt !== null) {
    if (expiresAt <= now) {
      return safetyViolation(matrix, 'expiry must be in the future');
    }
    if (ceiling !== null && expiresAt - now > ceiling) {
      return safetyViolation(matrix, `expiry exceeds D-149 ceiling for kind=${config.kind}`);
    }
  }
  return expiresAt;
};

const validateVersion = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
): CompileError | undefined => {
  if (config.version !== COMPOSE_CONTRACT_VERSION) return versionMismatch(config.version);
  if (matrix.version !== COMPOSE_CONTRACT_VERSION) return versionMismatch(matrix.version);
  if (
    config.ai_trace_redacted !== undefined &&
    config.ai_trace_redacted.version !== COMPOSE_CONTRACT_VERSION
  ) {
    return versionMismatch(config.ai_trace_redacted.version);
  }
  return undefined;
};

const validateTemplateSafety = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
): CompileError | undefined => {
  if (config.exposure_intent !== 'public_anonymous') {
    return safetyViolation(matrix, 'contracted_bilateral exposure is reserved at v1.0');
  }
  if (config.source_path === 'template' && config.source_template_ref !== matrix.template_ref) {
    return safetyViolation(
      matrix,
      `source_template_ref must match template_ref=${matrix.template_ref}`,
    );
  }
  if (!matrix.allowed_kinds.includes(config.kind)) {
    return safetyViolation(matrix, `kind=${config.kind} is not allowed by this template`);
  }
  if (matrix.rate_limit_policy === undefined) {
    return safetyViolation(matrix, 'rate_limit_policy is required');
  }
  if (config.kind === 'intake_form') {
    if (config.form_definition === undefined) {
      return safetyViolation(matrix, 'intake_form requires form_definition');
    }
    if (
      config.form_definition.processing_target !== undefined &&
      config.form_definition.processing_target !== matrix.processing_target
    ) {
      return safetyViolation(matrix, 'processing target does not match safety matrix');
    }
    const allowedTypes = new Set(matrix.allowed_field_types);
    const allowedPii = allowedPiiClassSet(matrix);
    for (const field of config.form_definition.fields) {
      if (isForbiddenFieldType(field.type)) {
        return safetyViolation(matrix, `field '${field.name}' uses forbidden type '${field.type}'`);
      }
      if (!allowedTypes.has(field.type)) {
        return safetyViolation(matrix, `field '${field.name}' type '${field.type}' is not allowed`);
      }
      const forbidden = fieldMatchesForbiddenName(field, matrix.forbidden_field_names);
      if (forbidden !== undefined) {
        return safetyViolation(matrix, `field '${field.name}' matches forbidden name '${forbidden}'`);
      }
      const piiClass = inferVisitorPiiClass(field);
      if (!allowedPii.has(piiClass)) {
        return safetyViolation(
          matrix,
          `field '${field.name}' has visitor PII class '${piiClass}' outside the safety matrix`,
        );
      }
    }
  }
  if (config.kind === 'scheduling_link') {
    const visitorFields = config.scheduling?.required_visitor_fields;
    const allowedPii = allowedPiiClassSet(matrix);
    if (
      visitorFields?.phone !== undefined &&
      visitorFields.phone !== 'omit' &&
      !allowedPii.has('visitor_phone')
    ) {
      return safetyViolation(matrix, 'scheduling_link cannot request visitor phone for this template');
    }
  }
  return undefined;
};

const packetDeclaration = (
  kind: ComposeEndpointKind,
  source_query_ref: SourceQueryRef,
): PacketDeclaration => {
  const packet_kind = RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind] as RedactedPacketKind;
  return {
    packet_kind,
    fields_visible_override: [...PACKET_FIELDS_VISIBLE[packet_kind]],
    source_query_ref,
  };
};

const metadataRecord = (metadata: unknown): Readonly<Record<string, unknown>> =>
  metadata as Readonly<Record<string, unknown>>;

const rateLimitPerIp = (
  matrix: TemplateSafetyMatrix,
  kind: ReceptionEndpointKind,
): number => {
  const configured = matrix.rate_limit_policy.per_endpoint_kind[kind]?.max_requests ?? 10;
  return Math.max(
    INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
    Math.min(INTAKE_FORM_RATE_LIMIT_PER_IP_MAX, configured),
  );
};

const buildIntakeFormInput = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
  expires_at: number | null,
): ReceptionEndpointCreateInput | CompileError => {
  const form = config.form_definition;
  if (form === undefined) return safetyViolation(matrix, 'intake_form requires form_definition');

  const visibleFields: IntakeFormConfigField[] = [];
  let emailRequirement = form.email_requirement ?? 'omit';

  for (const field of form.fields) {
    const piiClass = inferVisitorPiiClass(field);
    if (field.type === 'email' || piiClass === 'visitor_email') {
      emailRequirement = field.required ? 'required' : 'optional';
      continue;
    }
    if (!isIntakeFieldType(field.type)) {
      return safetyViolation(matrix, `field '${field.name}' cannot compile to D-149 intake_form`);
    }
    const compiledField: IntakeFormConfigField = {
      name: field.name,
      type: field.type,
      label: field.label,
      required: field.required,
    };
    if (field.values !== undefined) {
      (compiledField as { values?: ReadonlyArray<string> }).values = field.values;
    }
    visibleFields.push(compiledField);
  }

  const intakeConfig: IntakeFormConfig = {
    display_name: config.title,
    instructions: config.description,
    success_message: form.success_message,
    submit_button_label: form.submit_button_label,
    template_ref: config.source_template_ref,
    form_definition: {
      form_definition_id: form.form_definition_id,
      fields: visibleFields,
    },
    submission_processing_rule: {
      // D-210 A.8 slice 2b step 3 — `target_kind` is REQUIRED, so the compiled
      // config always carries one. A matrix that names no `processing_target`
      // compiles to `'form_response'`, which is what "log-only" always meant:
      // keep the answers as the record and mint nothing else.
      //
      // ⚠ This replaced a CONDITIONAL SPREAD that omitted the key. Do not
      // reinstate it — an omitted destination is no longer a shape the config
      // can hold, and the validator now refuses it (`target_kind_missing`).
      // The matrix side stays optional: a TEMPLATE may decline to constrain the
      // destination, and that is a different statement from an ENDPOINT having
      // none.
      target_kind: matrix.processing_target ?? 'form_response',
      fields_to_include_in_target: visibleFields.map((field) => field.name),
      fields_to_attach_as_metadata: [],
    },
    anti_spam: {
      honeypot_fields: [],
      rate_limit_per_ip: rateLimitPerIp(matrix, 'intake_form'),
      require_proof_of_work: false,
      require_captcha: false,
    },
    required_visitor_fields: { email: emailRequirement },
  };

  const failures = validateIntakeFormConfig(intakeConfig);
  if (failures.length > 0) {
    const first = failures[0]!;
    return safetyViolation(matrix, `intake_form metadata invalid: ${first.code}`);
  }

  return {
    kind: 'intake_form',
    packet_declaration: packetDeclaration('intake_form', {
      kind: 'reception_form_definition',
      form_definition_id: form.form_definition_id,
    }),
    expires_at,
    metadata: metadataRecord(intakeConfig),
    preview_hash: COMPOSE_PREVIEW_HASH_UNMINTED,
  };
};

const buildSchedulingLinkInput = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
  expires_at: number | null,
): ReceptionEndpointCreateInput | CompileError => {
  const scheduling = config.scheduling;
  if (scheduling === undefined) {
    return safetyViolation(matrix, 'scheduling_link requires scheduling config');
  }

  const required_visitor_fields: SchedulingLinkVisitorFieldRequirements = {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
    ...scheduling.required_visitor_fields,
  };

  const schedulingConfig: SchedulingLinkConfig = {
    display_name: scheduling.display_name ?? config.title,
    instructions: scheduling.instructions ?? config.description,
    success_message: scheduling.success_message,
    duration_options_minutes: scheduling.duration_options_minutes,
    available_window_definition: scheduling.available_window_definition,
    required_visitor_fields,
    min_advance_notice_hours: scheduling.min_advance_notice_hours ?? 24,
    max_lead_time_days: scheduling.max_lead_time_days ?? 30,
    max_bookings_per_day: scheduling.max_bookings_per_day ?? 0,
    on_booking: {
      create_calendar_event: true,
      create_commitment_entity: true,
      ...scheduling.on_booking,
    },
  };

  const failures = validateSchedulingLinkConfig(schedulingConfig);
  if (failures.length > 0) {
    const first = failures[0]!;
    return safetyViolation(matrix, `scheduling_link metadata invalid: ${first.code}`);
  }

  return {
    kind: 'scheduling_link',
    packet_declaration: packetDeclaration('scheduling_link', {
      kind: 'data.calendar.combined',
    }),
    expires_at,
    metadata: metadataRecord(schedulingConfig),
    preview_hash: COMPOSE_PREVIEW_HASH_UNMINTED,
  };
};

const buildReceptionPageInput = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
  expires_at: number | null,
): ReceptionEndpointCreateInput | CompileError => {
  const layout = config.page_layout;
  const display: ReceptionPageDisplayOverrides = {
    display_name: layout?.display_overrides?.display_name ?? config.title,
    tagline: layout?.display_overrides?.tagline ?? config.description ?? '',
    tz_label: layout?.display_overrides?.tz_label ?? 'Local time',
    preferred_contact_methods:
      layout?.display_overrides?.preferred_contact_methods ??
      [RECEPTION_PAGE_PREFERRED_CONTACT_METHODS[0]!],
    avatar_url: layout?.display_overrides?.avatar_url,
    response_time_estimate: layout?.display_overrides?.response_time_estimate,
  };

  const pageConfig: ReceptionPageConfig = {
    display_overrides: display,
    sections_enabled: layout?.sections_enabled ?? {
      contact_card: true,
      contact_methods: true,
      custom_links: (layout?.custom_links?.length ?? 0) > 0,
    },
    linked_endpoints: layout?.linked_endpoints ?? {},
    custom_links: layout?.custom_links,
    trust_footer_enabled: layout?.trust_footer_enabled,
  };

  const failures = validateReceptionPageConfig(pageConfig);
  if (failures.length > 0) {
    const first = failures[0]!;
    return safetyViolation(matrix, `reception_page metadata invalid: ${first.code}`);
  }

  return {
    kind: 'reception_page',
    packet_declaration: packetDeclaration('reception_page', {
      kind: 'reception_page_config',
    }),
    expires_at,
    metadata: metadataRecord(pageConfig),
    preview_hash: COMPOSE_PREVIEW_HASH_UNMINTED,
  };
};

const sourceIdField = (sourceRef: SourceQueryRef): string | undefined => {
  switch (sourceRef.kind) {
    case 'data.task':
      return sourceRef.task_id;
    case 'data.note':
      return sourceRef.note_id;
    case 'data.commitment':
      return sourceRef.commitment_id;
    case 'data.project':
      return sourceRef.project_id;
    case 'data.event':
      return sourceRef.event_id;
    case 'data.packing_list':
      return sourceRef.list_id;
    case 'data.itinerary':
      return sourceRef.itinerary_id;
    default:
      return undefined;
  }
};

const statusExpiryDays = (
  config: ProposedEndpointConfig,
  now: number,
): number => {
  if (
    config.expiry_policy.mode === 'rolling' &&
    typeof config.expiry_policy.rolling_days === 'number'
  ) {
    return config.expiry_policy.rolling_days;
  }
  if (config.expiry_policy.mode === 'until_date') {
    const date = parseExpiryDate(config.expiry_policy.date);
    if (date !== undefined) return Math.max(1, Math.ceil((date - now) / DAY_MS));
  }
  return config.status_projection?.expiry_days ?? STATUS_LINK_EXPIRY_DAYS_DEFAULT;
};

const buildStatusLinkInput = (
  config: ProposedEndpointConfig,
  matrix: TemplateSafetyMatrix,
  expires_at: number | null,
  now: number,
): ReceptionEndpointCreateInput | CompileError => {
  const status = config.status_projection;
  if (status === undefined) {
    return safetyViolation(matrix, 'status_link requires status_projection');
  }
  const id = sourceIdField(status.source_ref);
  if (id === undefined || id.length === 0) {
    return safetyViolation(matrix, 'status_link source_ref must carry a supported entity id');
  }

  const fieldsVisible =
    status.fields_visible_override ?? STATUS_PROJECTION_FIELDS_VISIBLE[status.projection_kind];
  const statusConfig: StatusLinkConfig = {
    display_name: status.display_name ?? config.title,
    caption: status.caption ?? config.description,
    projection_kind: status.projection_kind,
    source_ref: status.source_ref,
    fields_visible_override: [...fieldsVisible],
    refresh_policy: status.refresh_policy ?? {
      auto_refresh_enabled: true,
      refresh_interval_seconds: 60,
    },
    comments_enabled: false,
    shows_update_history: status.shows_update_history ?? true,
    expiry_days: statusExpiryDays(config, now),
    template_ref: config.source_template_ref,
  };

  const failures = validateStatusLinkConfig(statusConfig);
  if (failures.length > 0) {
    const first = failures[0]!;
    return safetyViolation(matrix, `status_link metadata invalid: ${first.code}`);
  }

  if (expires_at === null) {
    return safetyViolation(matrix, 'status_link cannot compile with long-lived expiry');
  }

  return {
    kind: 'status_link',
    packet_declaration: packetDeclaration('status_link', status.source_ref),
    expires_at,
    metadata: metadataRecord(statusConfig),
    preview_hash: COMPOSE_PREVIEW_HASH_UNMINTED,
  };
};

const withPreviewHash = (
  input: ReceptionEndpointCreateInput,
  preview_hash: string | undefined,
): ReceptionEndpointCreateInput => ({
  ...input,
  preview_hash: preview_hash ?? COMPOSE_PREVIEW_HASH_UNMINTED,
});

export function compileProposedEndpointConfig(
  config: ProposedEndpointConfig,
  template_safety_matrix: TemplateSafetyMatrix,
  options: CompileProposedEndpointConfigOptions = {},
): ReceptionEndpointCreateInput | CompileError {
  const versionError = validateVersion(config, template_safety_matrix);
  if (versionError !== undefined) return versionError;

  const safetyError = validateTemplateSafety(config, template_safety_matrix);
  if (safetyError !== undefined) return safetyError;

  if (
    options.now === undefined &&
    (config.expiry_policy.mode === 'rolling' ||
      template_safety_matrix.default_expiry.mode === 'rolling')
  ) {
    return safetyViolation(
      template_safety_matrix,
      'options.now is required when compiling a rolling expiry policy',
    );
  }
  const now = options.now ?? 0;
  const expires_at = compileExpiresAt(config, template_safety_matrix, now);
  if (isCompileError(expires_at)) return expires_at;

  let compiled: ReceptionEndpointCreateInput | CompileError;
  switch (config.kind satisfies ComposeEndpointKind) {
    case 'intake_form':
      compiled = buildIntakeFormInput(config, template_safety_matrix, expires_at);
      break;
    case 'scheduling_link':
      compiled = buildSchedulingLinkInput(config, template_safety_matrix, expires_at);
      break;
    case 'reception_page':
      compiled = buildReceptionPageInput(config, template_safety_matrix, expires_at);
      break;
    case 'status_link':
      compiled = buildStatusLinkInput(config, template_safety_matrix, expires_at, now);
      break;
  }

  if (isCompileError(compiled)) return compiled;
  return withPreviewHash(compiled, options.preview_hash);
}
