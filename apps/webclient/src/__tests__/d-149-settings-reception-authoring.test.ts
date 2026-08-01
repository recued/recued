/** D-149 § A.9 + § A.5.x follow-on — Settings → Server → Reception
 *  per-kind authoring forms.
 *
 *  Covers the six per-kind authoring modules: the closed-list error +
 *  option copy registries (tsc-completeness mirrored at runtime), the
 *  `build<Kind>FormModel` projections (null ⇒ defaults, config ⇒ current
 *  values, bounds + options), the `validate<Kind>FormConfig` wrappers,
 *  the shared dispatch builders, and the cross-kind ratchets. */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_ACTION_KINDS,
  APPROVAL_LINK_ON_APPROVE_ACTIONS,
  DROP_LINK_ALLOWED_MIME_TYPES,
  DROP_LINK_SIZE_CAP_DEFAULT_BYTES,
  INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT,
  INTAKE_FORM_TARGET_KINDS,
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHODS,
  STATUS_LINK_PROJECTION_KINDS,
  APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION,
  type ApprovalLinkConfig,
  type DropLinkConfig,
  type IntakeFormConfig,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
  type StatusLinkConfig,
} from '@recued/contracts';
import {
  APPROVAL_LINK_ACTION_KIND_COPY,
  APPROVAL_LINK_CONFIG_ERROR_COPY,
  APPROVAL_LINK_ON_APPROVE_ACTION_COPY,
  DROP_LINK_CONFIG_ERROR_COPY,
  DROP_LINK_MIME_TYPE_COPY,
  INTAKE_FORM_CONFIG_ERROR_COPY,
  INTAKE_FORM_FIELD_TYPE_COPY,
  INTAKE_FORM_TARGET_KIND_COPY,
  RECEPTION_PAGE_CONFIG_ERROR_COPY,
  RECEPTION_PAGE_LINKED_ENDPOINT_KEYS,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY,
  RECEPTION_PAGE_SECTION_KEYS,
  RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY,
  SCHEDULING_LINK_CONFIG_ERROR_COPY,
  STATUS_LINK_CONFIG_ERROR_COPY,
  STATUS_LINK_PROJECTION_KIND_COPY,
  STATUS_LINK_SOURCE_KINDS,
  STATUS_LINK_SOURCE_KIND_ID_FIELD,
  buildApprovalLinkFormModel,
  buildDropLinkFormModel,
  buildEndpointCreateDispatch,
  buildEndpointPreviewDispatch,
  buildIntakeFormFormModel,
  buildPacketDeclaration,
  buildReceptionPageFormModel,
  buildReceptionPageUpsertDispatch,
  buildSchedulingLinkFormModel,
  buildStatusLinkFormModel,
  buildStatusLinkSourceRef,
  summarizeConfigValidation,
  validateApprovalLinkFormConfig,
  validateDropLinkFormConfig,
  validateIntakeFormFormConfig,
  validateReceptionPageFormConfig,
  validateSchedulingLinkFormConfig,
  validateStatusLinkFormConfig,
} from '../settings/reception-authoring.js';

// ────────────────────────────────────────────────────────────────
// Valid config fixtures — one minimal-valid blob per kind. Each is
// asserted valid by its `validate<Kind>FormConfig` test below, so the
// `build<Kind>FormModel` "edit" path projects from a known-good shape.
// ────────────────────────────────────────────────────────────────

const mkReceptionPageConfig = (
  override: Partial<ReceptionPageConfig> = {},
): ReceptionPageConfig => ({
  display_overrides: {
    display_name: 'Alice',
    tagline: 'Reach me here',
    tz_label: 'Pacific Time',
    preferred_contact_methods: ['email'],
  },
  sections_enabled: { contact_card: true, contact_methods: true },
  linked_endpoints: {},
  ...override,
});

const mkSchedulingLinkConfig = (
  override: Partial<SchedulingLinkConfig> = {},
): SchedulingLinkConfig => ({
  display_name: 'Alice — 30 min calls',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
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
  ...override,
});

const mkIntakeFormConfig = (
  override: Partial<IntakeFormConfig> = {},
): IntakeFormConfig => ({
  display_name: 'Client inquiry',
  form_definition: {
    form_definition_id: 'fd-1',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'topic', type: 'textarea', label: 'What can I help with?', required: false },
    ],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name'],
    fields_to_attach_as_metadata: ['topic'],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 10,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'optional' },
  ...override,
});

const mkDropLinkConfig = (override: Partial<DropLinkConfig> = {}): DropLinkConfig => ({
  display_name: 'Send me a file',
  link_kind: 'repeated',
  size_cap_bytes: 100 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: { name: 'required', email: 'required', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
  ...override,
});

const mkApprovalLinkConfig = (
  override: Partial<ApprovalLinkConfig> = {},
): ApprovalLinkConfig => ({
  display_name: 'Approve the wording',
  action_kind: 'approve_wording',
  prompt: 'Does this wording look right?',
  context_raw: { summary: 'Draft email to the vendor.' },
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  on_action: {
    target_id: 'proposal-1',
    // The VALID baseline every approval_link test here builds on. It moved to
    // `create_commitment` when `mark_resolved` stopped being an acceptable
    // WRITE (its effect seam is unwired, so the visitor's answer reaches
    // nobody). These tests are about form validity and model shape, not about
    // which action is supported — so the FIXTURE moves and the expectations
    // stay. Same correction as the backend fixtures in f79683d5b; this one was
    // missed because that sweep did not reach the webclient.
    on_approve_action: 'create_commitment',
  },
  ...override,
});

const mkStatusLinkConfig = (
  override: Partial<StatusLinkConfig> = {},
): StatusLinkConfig => ({
  display_name: 'Project status',
  projection_kind: 'project',
  source_ref: { kind: 'data.project', project_id: 'proj-1' },
  refresh_policy: { auto_refresh_enabled: false },
  comments_enabled: false,
  shows_update_history: true,
  expiry_days: 30,
  ...override,
});

// ════════════════════════════════════════════════════════════════
// Shared closed-list copy registries
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — shared copy registries', () => {
  // D-210 Phase C — two tests lived here that are now moot: the
  // notification-target copy-registry coverage, and a RATCHET asserting "the
  // four per-kind notification-target lists are identical". That ratchet
  // existed precisely BECAUSE the D-158 channel vocabulary had been copied four
  // times; retiring `notification_target` retires the duplication and its guard
  // together.
  it('RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY covers required/optional/omit', () => {
    for (const r of ['required', 'optional', 'omit'] as const) {
      expect(RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY[r].label).toBeTruthy();
      expect(RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY[r].help).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY)).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════════
// summarizeConfigValidation
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — summarizeConfigValidation', () => {
  it('zero failures ⇒ valid, empty failures', () => {
    const summary = summarizeConfigValidation([], { a: 'copy-a' });
    expect(summary.valid).toBe(true);
    expect(summary.failures).toEqual([]);
  });

  it('resolves each failure code through the copy registry', () => {
    const summary = summarizeConfigValidation(
      [
        { code: 'a' as const, detail: 'detail-a' },
        { code: 'b' as const, detail: 'detail-b' },
      ],
      { a: 'copy-a', b: 'copy-b' },
    );
    expect(summary.valid).toBe(false);
    expect(summary.failures).toEqual([
      { code: 'a', message: 'copy-a', detail: 'detail-a' },
      { code: 'b', message: 'copy-b', detail: 'detail-b' },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════
// Shared dispatch builders
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — shared dispatch builders', () => {
  const srcRef = { kind: 'data.project', project_id: 'p-1' } as never;

  it('buildPacketDeclaration maps the endpoint kind to its packet kind', () => {
    const decl = buildPacketDeclaration({ kind: 'scheduling_link', source_query_ref: srcRef });
    expect(decl.packet_kind).toBe('scheduling_link_packet');
    expect(decl.source_query_ref).toBe(srcRef);
    expect(decl.fields_visible_override).toBeUndefined();
    expect(decl.transformations).toBeUndefined();
    expect(decl.allowed_actions).toBeUndefined();
  });

  it('buildPacketDeclaration threads optional fields when present', () => {
    const decl = buildPacketDeclaration({
      kind: 'status_link',
      source_query_ref: srcRef,
      fields_visible_override: ['title'],
      transformations: ['redact'],
      allowed_actions: ['view'],
    });
    expect(decl.packet_kind).toBe('status_link_packet');
    expect(decl.fields_visible_override).toEqual(['title']);
    expect(decl.transformations).toEqual(['redact']);
    expect(decl.allowed_actions).toEqual(['view']);
  });

  it('buildEndpointPreviewDispatch shapes the preview_draft payload', () => {
    const decl = buildPacketDeclaration({ kind: 'drop_link', source_query_ref: srcRef });
    const dispatch = buildEndpointPreviewDispatch({
      kind: 'drop_link',
      packet_declaration: decl,
      metadata: { display_name: 'x' },
    });
    expect(dispatch).toEqual({
      op: 'reception.endpoint.preview_draft',
      kind: 'drop_link',
      packet_declaration: decl,
      metadata: { display_name: 'x' },
    });
    expect('expires_at' in dispatch).toBe(false);
  });

  it('buildEndpointPreviewDispatch includes expires_at when supplied', () => {
    const decl = buildPacketDeclaration({ kind: 'drop_link', source_query_ref: srcRef });
    const dispatch = buildEndpointPreviewDispatch({
      kind: 'drop_link',
      packet_declaration: decl,
      metadata: {},
      expires_at: 123,
    });
    expect(dispatch.expires_at).toBe(123);
  });

  it('buildEndpointCreateDispatch carries the preview_hash + omits expires_at when undefined', () => {
    const decl = buildPacketDeclaration({ kind: 'intake_form', source_query_ref: srcRef });
    const dispatch = buildEndpointCreateDispatch({
      kind: 'intake_form',
      packet_declaration: decl,
      metadata: { display_name: 'x' },
      preview_hash: 'hash-abc',
    });
    expect(dispatch.op).toBe('reception.endpoint.create');
    expect(dispatch.preview_hash).toBe('hash-abc');
    expect('expires_at' in dispatch).toBe(false);
  });

  it('buildEndpointCreateDispatch normalizes a null expires_at to omitted (preview-hash parity)', () => {
    const decl = buildPacketDeclaration({ kind: 'intake_form', source_query_ref: srcRef });
    // `null` (long-lived intent) must serialize identically to the
    // preview step — whose `expires_at` is `number`-only and therefore
    // always omitted for the long-lived case — or the rpc's preview-hash
    // check fails with preview_hash_mismatch.
    const longLived = buildEndpointCreateDispatch({
      kind: 'intake_form',
      packet_declaration: decl,
      metadata: {},
      preview_hash: 'h',
      expires_at: null,
    });
    expect('expires_at' in longLived).toBe(false);
    // An omitted expires_at is likewise absent.
    const omitted = buildEndpointCreateDispatch({
      kind: 'intake_form',
      packet_declaration: decl,
      metadata: {},
      preview_hash: 'h',
    });
    expect('expires_at' in omitted).toBe(false);
    // A bounded numeric expires_at is carried through verbatim.
    const bounded = buildEndpointCreateDispatch({
      kind: 'drop_link',
      packet_declaration: decl,
      metadata: {},
      preview_hash: 'h',
      expires_at: 999,
    });
    expect(bounded.expires_at).toBe(999);
  });

  it('buildReceptionPageUpsertDispatch wraps the config in the upsert op', () => {
    const config = mkReceptionPageConfig();
    expect(buildReceptionPageUpsertDispatch(config)).toEqual({
      op: 'reception.page.upsert',
      config,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// reception_page
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — reception_page', () => {
  it('RECEPTION_PAGE_CONFIG_ERROR_COPY resolves the contract failure codes', () => {
    const summary = validateReceptionPageFormConfig({
      display_overrides: {
        display_name: '',
        tagline: 'x',
        tz_label: 'PT',
        preferred_contact_methods: ['email'],
      },
      sections_enabled: {},
      linked_endpoints: {},
    });
    expect(summary.valid).toBe(false);
    const codes = summary.failures.map((f) => f.code);
    expect(codes).toContain('display_name_empty');
    const failure = summary.failures.find((f) => f.code === 'display_name_empty');
    expect(failure?.message).toBe(RECEPTION_PAGE_CONFIG_ERROR_COPY.display_name_empty);
  });

  it('RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY covers every method', () => {
    for (const m of RECEPTION_PAGE_PREFERRED_CONTACT_METHODS) {
      expect(RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY[m].label).toBeTruthy();
    }
    expect(Object.keys(RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_COPY)).toHaveLength(
      RECEPTION_PAGE_PREFERRED_CONTACT_METHODS.length,
    );
  });

  it('validateReceptionPageFormConfig accepts a known-good config', () => {
    expect(validateReceptionPageFormConfig(mkReceptionPageConfig()).valid).toBe(true);
  });

  it('buildReceptionPageFormModel(null) ⇒ is_new + empty defaults + footer on', () => {
    const model = buildReceptionPageFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.display_name.value).toBe('');
    expect(model.display_name.required).toBe(true);
    expect(model.preferred_contact_methods.value).toEqual([]);
    // Default-on per § A.20.7.
    expect(model.trust_footer_enabled.value).toBe(true);
    // D-173 P4.2 un-hid scheduling, so the scheduling affordances
    // (availability_cta section + the two scheduling linked-endpoint
    // fields) are back in the renderable model — full lengths, no
    // filtering (the reception page links only scheduling/intake/drop,
    // none of which are unavailable now).
    expect(model.sections_enabled).toHaveLength(RECEPTION_PAGE_SECTION_KEYS.length);
    expect(model.linked_endpoints).toHaveLength(
      RECEPTION_PAGE_LINKED_ENDPOINT_KEYS.length,
    );
    expect(model.sections_enabled.map((f) => f.key)).toContain(
      'sections_enabled.availability_cta',
    );
    expect(model.linked_endpoints.map((f) => f.key)).toContain(
      'linked_endpoints.scheduling_link_share_url',
    );
    expect(model.linked_endpoints.map((f) => f.key)).toContain(
      'linked_endpoints.scheduling_link_endpoint_id',
    );
    // Fresh sections all default off.
    for (const toggle of model.sections_enabled) expect(toggle.value).toBe(false);
  });

  it('buildReceptionPageFormModel projects an existing config', () => {
    const config = mkReceptionPageConfig({
      link_buttons: [{
        label: 'Subscribe',
        url: 'https://buy.stripe.com/example',
        description: 'Choose a plan.',
      }],
      trust_footer_enabled: false,
    });
    const model = buildReceptionPageFormModel(config);
    expect(model.is_new).toBe(false);
    expect(model.display_name.value).toBe('Alice');
    expect(model.preferred_contact_methods.value).toEqual(['email']);
    expect(model.link_buttons.rows).toEqual([
      {
        label: 'Subscribe',
        url: 'https://buy.stripe.com/example',
        description: 'Choose a plan.',
      },
    ]);
    expect(model.trust_footer_enabled.value).toBe(false);
    // contact_card toggle reflects the config.
    const contactCard = model.sections_enabled.find(
      (t) => t.key === 'sections_enabled.contact_card',
    );
    expect(contactCard?.value).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// scheduling_link
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — scheduling_link', () => {
  it('SCHEDULING_LINK_CONFIG_ERROR_COPY resolves a contract failure code', () => {
    const summary = validateSchedulingLinkFormConfig(
      mkSchedulingLinkConfig({ display_name: '' }),
    );
    expect(summary.valid).toBe(false);
    const failure = summary.failures.find((f) => f.code === 'display_name_empty');
    expect(failure?.message).toBe(SCHEDULING_LINK_CONFIG_ERROR_COPY.display_name_empty);
  });

  it('validateSchedulingLinkFormConfig accepts a known-good config', () => {
    expect(validateSchedulingLinkFormConfig(mkSchedulingLinkConfig()).valid).toBe(true);
  });

  it('buildSchedulingLinkFormModel(null) ⇒ is_new + sensible defaults', () => {
    const model = buildSchedulingLinkFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.duration_options_minutes.value).toEqual([30]);
    expect(model.min_advance_notice_hours.value).toBe(24);
    expect(model.notify_visitor_sender.value).toBe('');
    // Five per-field requirement selects; name is locked to Required-only.
    expect(model.required_visitor_fields).toHaveLength(5);
    const nameField = model.required_visitor_fields.find(
      (f) => f.key === 'required_visitor_fields.name',
    );
    expect(nameField?.options.map((o) => o.value)).toEqual(['required']);
    expect(nameField?.value).toBe('required');
    // phone is Optional-or-Hidden only.
    const phoneField = model.required_visitor_fields.find(
      (f) => f.key === 'required_visitor_fields.phone',
    );
    expect(phoneField?.options.map((o) => o.value)).toEqual(['optional', 'omit']);
  });

  it('buildSchedulingLinkFormModel projects an existing config', () => {
    const model = buildSchedulingLinkFormModel(
      mkSchedulingLinkConfig({
        min_advance_notice_hours: 48,
        max_bookings_per_day: 5,
        on_booking: { notify_visitor_sender: 'mail.owner' },
      }),
    );
    expect(model.is_new).toBe(false);
    expect(model.display_name.value).toBe('Alice — 30 min calls');
    expect(model.tz.value).toBe('America/New_York');
    expect(model.min_advance_notice_hours.value).toBe(48);
    expect(model.max_bookings_per_day.value).toBe(5);
    expect(model.notify_visitor_sender.value).toBe('mail.owner');
    expect(model.explicit_windows.rows).toEqual([
      { day_of_week: 1, start_minute: 540, end_minute: 1020 },
    ]);
    const phoneField = model.required_visitor_fields.find(
      (f) => f.key === 'required_visitor_fields.phone',
    );
    expect(phoneField?.value).toBe('omit');
  });

  it('scheduling duration options are the closed allowed list', () => {
    const model = buildSchedulingLinkFormModel(null);
    expect(model.duration_options_minutes.options.map((o) => o.value)).toEqual([
      15, 30, 45, 60, 90, 120,
    ]);
  });
});

// ════════════════════════════════════════════════════════════════
// intake_form
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — intake_form', () => {
  it('INTAKE_FORM_TARGET_KIND_COPY + FIELD_TYPE_COPY cover their closed lists', () => {
    for (const k of INTAKE_FORM_TARGET_KINDS) {
      expect(INTAKE_FORM_TARGET_KIND_COPY[k].label).toBeTruthy();
    }
    expect(Object.keys(INTAKE_FORM_TARGET_KIND_COPY)).toHaveLength(
      INTAKE_FORM_TARGET_KINDS.length,
    );
    for (const t of INTAKE_FORM_VISITOR_FIELD_TYPES) {
      expect(INTAKE_FORM_FIELD_TYPE_COPY[t].label).toBeTruthy();
    }
    expect(Object.keys(INTAKE_FORM_FIELD_TYPE_COPY)).toHaveLength(
      INTAKE_FORM_VISITOR_FIELD_TYPES.length,
    );
  });

  it('INTAKE_FORM_CONFIG_ERROR_COPY resolves a contract failure code', () => {
    const summary = validateIntakeFormFormConfig(mkIntakeFormConfig({ display_name: '' }));
    expect(summary.valid).toBe(false);
    const failure = summary.failures.find((f) => f.code === 'display_name_empty');
    expect(failure?.message).toBe(INTAKE_FORM_CONFIG_ERROR_COPY.display_name_empty);
  });

  it('validateIntakeFormFormConfig accepts a known-good config', () => {
    expect(validateIntakeFormFormConfig(mkIntakeFormConfig()).valid).toBe(true);
  });

  it('buildIntakeFormFormModel(null) ⇒ is_new + default rate limit + empty field repeater', () => {
    const model = buildIntakeFormFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.rate_limit_per_ip.value).toBe(INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT);
    // D-210 A.8 s2b.3 — INVERTED. This asserted the OPPOSITE under WS2: that a
    // fresh intake is born LOG-ONLY, that `''` is the sentinel for an absent
    // `target_kind`, and that `form_response` is not in the vocabulary at all.
    // A.4 made `form_response` a real destination and s2b.3 made `target_kind`
    // REQUIRED, so every clause of that reversed at once.
    //
    // A fresh intake now defaults to `form_response` — the destination that
    // needs no mapping decisions, which is what makes it the safe default.
    expect(model.target_kind.value).toBe('form_response');
    // ⛔ The empty sentinel must be GONE, not merely unselected: it authors a
    // config the validator refuses (`target_kind_missing`), so offering it at
    // all hands the owner a control that cannot produce a valid endpoint.
    expect(model.target_kind.options.map((o) => o.value)).not.toContain('');
    expect(model.target_kind.options.map((o) => o.value)).toContain('form_response');
    expect(model.fields.rows).toEqual([]);
    expect(model.fields.min_rows).toBe(1);
    // Field-name-derived multiselects start with no options when no fields.
    expect(model.fields_to_include_in_target.options).toEqual([]);
    expect(model.honeypot_fields.options).toEqual([]);
  });

  /** D-210 WS3 — a field-name select that may hold NOTHING carries an explicit
   *  empty option.
   *
   *  ⚠ Found by a browser verify: `renderSelectField` marks an option selected
   *  only when it MATCHES, so a `''` value with no empty option renders the
   *  browser's fallback — the first real field — and the control reads as if
   *  that field were mapped. The config said nothing; the form said
   *  `arrives_at`. A control must not claim a choice nobody made. */
  it('gives every unsettable field-name select an explicit empty option', () => {
    const calendarish = (target: 'calendar' | 'contact') => buildIntakeFormFormModel({
      display_name: 'Book a table',
      form_definition: {
        form_definition_id: 'fd_t',
        fields: [
          { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
          { name: 'hours', type: 'number', label: 'Hours', required: false },
        ],
      },
      submission_processing_rule: {
        target_kind: target,
        ...(target === 'calendar'
          ? { calendar_mapping: { start_field: '', default_duration_minutes: 60 } }
          : {}),
        fields_to_include_in_target: [],
        fields_to_attach_as_metadata: [],
      },
      anti_spam: {
        honeypot_fields: [], rate_limit_per_ip: 5,
        require_proof_of_work: false, require_captcha: false,
      },
      required_visitor_fields: { email: 'required' },
    } as never);

    const cal = calendarish('calendar');
    expect(cal.calendar_start_field?.options[0]).toMatchObject({ value: '' });
    expect(cal.calendar_duration_field?.options[0]).toMatchObject({ value: '' });
    // …and the model's own value stays empty, so the empty option is the one
    // that matches rather than the first real field.
    expect(cal.calendar_start_field?.value).toBe('');

    const con = calendarish('contact');
    expect(con.contact_name_field?.options[0]).toMatchObject({ value: '' });
    expect(con.contact_name_field?.value).toBe('');
  });

  it('buildIntakeFormFormModel derives field-name multiselect options from the config fields', () => {
    const model = buildIntakeFormFormModel(mkIntakeFormConfig());
    expect(model.is_new).toBe(false);
    expect(model.fields.rows.map((r) => r.name)).toEqual(['your_name', 'topic']);
    // Each field row carries a `values` array (empty for non-enum types).
    expect(model.fields.rows[0]).toEqual({
      name: 'your_name',
      type: 'text',
      label: 'Your name',
      required: true,
      values: [],
    });
    expect(model.fields_to_include_in_target.options.map((o) => o.value)).toEqual([
      'your_name',
      'topic',
    ]);
    expect(model.fields_to_include_in_target.value).toEqual(['your_name']);
    expect(model.fields_to_attach_as_metadata.value).toEqual(['topic']);
  });
});

// ════════════════════════════════════════════════════════════════
// drop_link
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — drop_link', () => {
  it('DROP_LINK_MIME_TYPE_COPY covers the closed allowlist', () => {
    for (const m of DROP_LINK_ALLOWED_MIME_TYPES) {
      expect(DROP_LINK_MIME_TYPE_COPY[m].label).toBeTruthy();
    }
    expect(Object.keys(DROP_LINK_MIME_TYPE_COPY)).toHaveLength(
      DROP_LINK_ALLOWED_MIME_TYPES.length,
    );
  });

  it('DROP_LINK_CONFIG_ERROR_COPY resolves a contract failure code', () => {
    const summary = validateDropLinkFormConfig(mkDropLinkConfig({ display_name: '' }));
    expect(summary.valid).toBe(false);
    const failure = summary.failures.find((f) => f.code === 'display_name_empty');
    expect(failure?.message).toBe(DROP_LINK_CONFIG_ERROR_COPY.display_name_empty);
  });

  it('validateDropLinkFormConfig accepts a known-good config', () => {
    expect(validateDropLinkFormConfig(mkDropLinkConfig()).valid).toBe(true);
  });

  it('buildDropLinkFormModel(null) ⇒ is_new + size/expiry defaults', () => {
    const model = buildDropLinkFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.size_cap_bytes.value).toBe(DROP_LINK_SIZE_CAP_DEFAULT_BYTES);
    expect(model.expiry_days.value).toBe(7);
    expect(model.link_kind.value).toBe('repeated');
    expect(model.allowed_mime_types.value).toEqual(['application/pdf']);
    expect(model.allowed_mime_types.options.map((o) => o.value)).toEqual([
      ...DROP_LINK_ALLOWED_MIME_TYPES,
    ]);
    // Three visitor-field requirement selects — drop_link's contract
    // validator restricts each to required/optional only (NO Hidden/omit,
    // unlike intake_form / scheduling_link phone+notes).
    expect(model.required_visitor_fields).toHaveLength(3);
    for (const field of model.required_visitor_fields) {
      expect(field.options.map((o) => o.value)).toEqual(['required', 'optional']);
    }
  });

  it('buildDropLinkFormModel projects an existing config', () => {
    const model = buildDropLinkFormModel(
      mkDropLinkConfig({ link_kind: 'one_time', expiry_days: 14 }),
    );
    expect(model.is_new).toBe(false);
    expect(model.link_kind.value).toBe('one_time');
    expect(model.expiry_days.value).toBe(14);
    expect(model.create_data_file_entity.value).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// approval_link
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — approval_link', () => {
  it('APPROVAL_LINK action-kind + on-approve copy cover their closed lists', () => {
    for (const k of APPROVAL_LINK_ACTION_KINDS) {
      expect(APPROVAL_LINK_ACTION_KIND_COPY[k].label).toBeTruthy();
      expect(typeof APPROVAL_LINK_ACTION_KIND_COPY[k].requires_options).toBe('boolean');
    }
    expect(Object.keys(APPROVAL_LINK_ACTION_KIND_COPY)).toHaveLength(
      APPROVAL_LINK_ACTION_KINDS.length,
    );
    for (const a of APPROVAL_LINK_ON_APPROVE_ACTIONS) {
      expect(APPROVAL_LINK_ON_APPROVE_ACTION_COPY[a].label).toBeTruthy();
    }
    expect(Object.keys(APPROVAL_LINK_ON_APPROVE_ACTION_COPY)).toHaveLength(
      APPROVAL_LINK_ON_APPROVE_ACTIONS.length,
    );
  });

  it('only pick_time + confirm_attendance require an options list', () => {
    expect(APPROVAL_LINK_ACTION_KIND_COPY.pick_time.requires_options).toBe(true);
    expect(APPROVAL_LINK_ACTION_KIND_COPY.confirm_attendance.requires_options).toBe(true);
    expect(APPROVAL_LINK_ACTION_KIND_COPY.approve_wording.requires_options).toBe(false);
    expect(APPROVAL_LINK_ACTION_KIND_COPY.answer_question.requires_options).toBe(false);
    expect(APPROVAL_LINK_ACTION_KIND_COPY.upload_doc.requires_options).toBe(false);
  });

  it('APPROVAL_LINK_CONFIG_ERROR_COPY resolves a contract failure code', () => {
    const summary = validateApprovalLinkFormConfig(
      mkApprovalLinkConfig({ prompt: '' }),
    );
    expect(summary.valid).toBe(false);
    const failure = summary.failures.find((f) => f.code === 'prompt_empty');
    expect(failure?.message).toBe(APPROVAL_LINK_CONFIG_ERROR_COPY.prompt_empty);
  });

  it('validateApprovalLinkFormConfig accepts a known-good config', () => {
    expect(validateApprovalLinkFormConfig(mkApprovalLinkConfig()).valid).toBe(true);
  });

  it('buildApprovalLinkFormModel(null) ⇒ is_new + action-kind requires_options mirror', () => {
    const model = buildApprovalLinkFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.action_kind.value).toBe('approve_wording');
    // approve_wording does not need options.
    expect(model.action_kind_requires_options).toBe(false);
    // Derived, not hardcoded: the picker's default IS
    // `APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION`, which is itself derived from
    // the supported list — so a future change to what is supported cannot leave
    // this asserting a default the form no longer offers.
    expect(model.on_approve_action.value).toBe(APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION);
    expect(model.visitor_name_constraint.value).toBe('required');
  });

  it('buildApprovalLinkFormModel surfaces requires_options for a pick_time config', () => {
    const model = buildApprovalLinkFormModel(
      mkApprovalLinkConfig({
        action_kind: 'pick_time',
        options: [{ id: 'a', label: 'Monday 9am' }],
      }),
    );
    expect(model.action_kind.value).toBe('pick_time');
    expect(model.action_kind_requires_options).toBe(true);
    expect(model.options.rows).toEqual([
      { id: 'a', label: 'Monday 9am', description: '' },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════
// status_link
// ════════════════════════════════════════════════════════════════

describe('D-149 authoring — status_link', () => {
  it('STATUS_LINK_PROJECTION_KIND_COPY covers the closed list', () => {
    for (const k of STATUS_LINK_PROJECTION_KINDS) {
      expect(STATUS_LINK_PROJECTION_KIND_COPY[k].label).toBeTruthy();
    }
    expect(Object.keys(STATUS_LINK_PROJECTION_KIND_COPY)).toHaveLength(
      STATUS_LINK_PROJECTION_KINDS.length,
    );
  });

  it('STATUS_LINK_SOURCE_KINDS has an id-field entry for every kind', () => {
    expect([...STATUS_LINK_SOURCE_KINDS].sort()).toEqual(
      [
        'data.commitment',
        'data.event',
        'data.itinerary',
        'data.note',
        'data.packing_list',
        'data.project',
        'data.task',
      ],
    );
    for (const k of STATUS_LINK_SOURCE_KINDS) {
      expect(STATUS_LINK_SOURCE_KIND_ID_FIELD[k]).toBeTruthy();
    }
  });

  it('buildStatusLinkSourceRef assembles the discriminated source ref', () => {
    expect(buildStatusLinkSourceRef('data.task', 't-1')).toEqual({
      kind: 'data.task',
      task_id: 't-1',
    });
    expect(buildStatusLinkSourceRef('data.itinerary', 'it-9')).toEqual({
      kind: 'data.itinerary',
      itinerary_id: 'it-9',
    });
  });

  it('STATUS_LINK_CONFIG_ERROR_COPY resolves a contract failure code', () => {
    const summary = validateStatusLinkFormConfig(
      mkStatusLinkConfig({ display_name: '' }),
    );
    expect(summary.valid).toBe(false);
    const failure = summary.failures.find((f) => f.code === 'display_name_empty');
    expect(failure?.message).toBe(STATUS_LINK_CONFIG_ERROR_COPY.display_name_empty);
  });

  it('validateStatusLinkFormConfig accepts a known-good config', () => {
    expect(validateStatusLinkFormConfig(mkStatusLinkConfig()).valid).toBe(true);
  });

  it('buildStatusLinkFormModel(null) ⇒ is_new + custom projection + task source default', () => {
    const model = buildStatusLinkFormModel(null);
    expect(model.is_new).toBe(true);
    expect(model.projection_kind.value).toBe('custom');
    expect(model.source_ref_kind.value).toBe('data.task');
    expect(model.source_ref_id.value).toBe('');
    expect(model.comments_enabled.value).toBe(false);
    expect(model.shows_update_history.value).toBe(true);
    expect(model.expiry_days.value).toBe(30);
    // fields_visible_override options are the `custom` ceiling.
    expect(model.fields_visible_override.options.map((o) => o.value)).toEqual([
      'title',
      'summary',
      'updated_at_relative',
      'tags',
    ]);
  });

  it('buildStatusLinkFormModel reads the source id off the discriminated ref', () => {
    const model = buildStatusLinkFormModel(mkStatusLinkConfig());
    expect(model.is_new).toBe(false);
    expect(model.projection_kind.value).toBe('project');
    expect(model.source_ref_kind.value).toBe('data.project');
    expect(model.source_ref_id.value).toBe('proj-1');
    // project-ceiling field options.
    expect(model.fields_visible_override.options.map((o) => o.value)).toContain('state');
  });

  it('buildStatusLinkFormModel + buildStatusLinkSourceRef round-trip the source ref', () => {
    const ref = buildStatusLinkSourceRef('data.event', 'ev-42');
    const model = buildStatusLinkFormModel(mkStatusLinkConfig({ source_ref: ref }));
    expect(model.source_ref_kind.value).toBe('data.event');
    expect(model.source_ref_id.value).toBe('ev-42');
  });
});
