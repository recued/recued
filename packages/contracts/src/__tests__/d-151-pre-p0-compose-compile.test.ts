/** D-151 Pre-P0 — compose compile contract substrate.
 *
 *  Golden fixtures cover the four named endpoint-authoring scenarios and
 *  assert compile emits D-149 create inputs with closed packet fields and no
 *  generic over-collection of visitor PII.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPOSE_CONTRACT_VERSION,
  COMPOSE_PREVIEW_HASH_UNMINTED,
  BOOKING_TEMPLATE_SAFETY_MATRIX,
  CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
  PACKET_FIELDS_VISIBLE,
  PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX,
  RECEPTION_RATE_LIMIT_DEFAULTS,
  RSVP_TEMPLATE_SAFETY_MATRIX,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  compileProposedEndpointConfig,
  isCompileError,
  validateIntakeFormConfig,
  type CompileError,
  type ProposedEndpointConfig,
  type ReceptionEndpointCreateInput,
  type TemplateSafetyMatrix,
} from '../index.js';

const FIXED_NOW = Date.UTC(2026, 5, 2, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const matrix = (
  overrides: Partial<TemplateSafetyMatrix> & Pick<TemplateSafetyMatrix, 'template_ref'>,
): TemplateSafetyMatrix => ({
  version: COMPOSE_CONTRACT_VERSION,
  allowed_kinds: ['intake_form'],
  allowed_field_types: ['text', 'email', 'textarea', 'enum', 'number', 'date'],
  forbidden_field_names: [
    'ssn',
    'tax_id',
    'income',
    'mother_maiden_name',
    'credit_card',
    'phone',
    'address',
    'birthday',
    'employer',
  ],
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: { mode: 'rolling', rolling_days: 30 },
  long_lived_permitted: false,
  processing_target: 'task',
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
  ...overrides,
});

const baseConfig = (
  overrides: Partial<ProposedEndpointConfig> & Pick<ProposedEndpointConfig, 'kind' | 'title'>,
): ProposedEndpointConfig => ({
  version: COMPOSE_CONTRACT_VERSION,
  description: 'Visitor-facing draft',
  expiry_policy: { mode: 'rolling', rolling_days: 30 },
  exposure_intent: 'public_anonymous',
  source_path: 'template',
  source_template_ref: `app/recued-core/${overrides.kind}`,
  ...overrides,
});

const expectCreateInput = (
  result: ReceptionEndpointCreateInput | CompileError,
): ReceptionEndpointCreateInput => {
  expect(isCompileError(result)).toBe(false);
  return result as ReceptionEndpointCreateInput;
};

const expectCompileError = (
  result: ReceptionEndpointCreateInput | CompileError,
): CompileError => {
  expect(isCompileError(result)).toBe(true);
  return result as CompileError;
};

const noExcessivePii = (input: ReceptionEndpointCreateInput): void => {
  const text = JSON.stringify(input.metadata ?? {}).toLowerCase();
  for (const forbidden of [
    'ssn',
    'tax_id',
    'mother_maiden_name',
    'credit_card',
    'address',
    'birthday',
    'employer',
    'income',
  ]) {
    expect(text.includes(forbidden)).toBe(false);
  }
  expect(text).not.toMatch(/"phone"\s*:\s*"(required|optional)"/);
};

describe('D-151 Pre-P0 — golden compile fixtures', () => {
  it('book-a-meeting compiles to scheduling_link with closed packet fields', () => {
    const safety = BOOKING_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'scheduling_link',
      title: 'Book a meeting',
      source_template_ref: safety.template_ref,
      expiry_policy: { mode: 'rolling', rolling_days: 90 },
      scheduling: {
        duration_options_minutes: [30, 60],
        available_window_definition: {
          tz: 'America/Los_Angeles',
          explicit_windows: [
            { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
          ],
        },
      },
    });

    const compiled = expectCreateInput(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(compiled.kind).toBe('scheduling_link');
    expect(compiled.preview_hash).toBe(COMPOSE_PREVIEW_HASH_UNMINTED);
    expect(compiled.packet_declaration).toEqual({
      packet_kind: 'scheduling_link_packet',
      fields_visible_override: PACKET_FIELDS_VISIBLE.scheduling_link_packet,
      source_query_ref: { kind: 'data.calendar.combined' },
    });
    expect(compiled.metadata?.required_visitor_fields).toEqual({
      name: 'required',
      email: 'required',
      topic: 'optional',
      phone: 'omit',
      notes: 'optional',
    });
    noExcessivePii(compiled);
  });

  it('baby-shower-rsvp compiles to intake_form without phone/address/birthday/employer fields', () => {
    const safety = RSVP_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Baby shower RSVP',
      source_template_ref: safety.template_ref,
      expiry_policy: { mode: 'until_date', date: new Date(FIXED_NOW + 8 * DAY_MS).toISOString() },
      form_definition: {
        form_definition_id: 'fd_baby_shower_rsvp',
        fields: [
          {
            name: 'guest_name',
            type: 'text',
            label: 'Guest name',
            required: true,
            visitor_pii_class: 'visitor_name',
          },
          {
            name: 'email',
            type: 'email',
            label: 'Email',
            required: true,
            visitor_pii_class: 'visitor_email',
          },
          {
            name: 'rsvp',
            type: 'enum',
            label: 'RSVP',
            required: true,
            values: ['yes', 'no', 'maybe'],
          },
          {
            name: 'dietary_notes',
            type: 'textarea',
            label: 'Dietary notes',
            required: false,
          },
        ],
      },
    });

    const compiled = expectCreateInput(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(compiled.kind).toBe('intake_form');
    expect(compiled.packet_declaration).toEqual({
      packet_kind: 'intake_form_packet',
      fields_visible_override: PACKET_FIELDS_VISIBLE.intake_form_packet,
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: 'fd_baby_shower_rsvp',
      },
    });
    expect(compiled.metadata?.required_visitor_fields).toEqual({ email: 'required' });
    expect(
      (compiled.metadata?.form_definition as { fields: ReadonlyArray<{ name: string }> }).fields.map(
        (field) => field.name,
      ),
    ).toEqual(['guest_name', 'rsvp', 'dietary_notes']);
    noExcessivePii(compiled);
  });

  it('photo-share compiles to reception_page without collecting visitor PII fields', () => {
    const safety = PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'reception_page',
      title: 'Share photos',
      description: 'Album links and viewing details.',
      source_template_ref: safety.template_ref,
      page_layout: {
        display_overrides: {
          tagline: 'Album links and viewing details.',
          tz_label: 'Pacific time',
          preferred_contact_methods: ['email'],
        },
        sections_enabled: {
          contact_card: true,
          contact_methods: true,
          custom_links: true,
        },
        custom_links: [
          { label: 'Photo album', url: 'https://photos.example.test/album' },
        ],
      },
    });

    const compiled = expectCreateInput(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(compiled.kind).toBe('reception_page');
    expect(compiled.packet_declaration).toEqual({
      packet_kind: 'reception_page_packet',
      fields_visible_override: PACKET_FIELDS_VISIBLE.reception_page_packet,
      source_query_ref: { kind: 'reception_page_config' },
    });
    expect(compiled.metadata?.display_overrides).toMatchObject({
      display_name: 'Share photos',
      preferred_contact_methods: ['email'],
    });
    noExcessivePii(compiled);
  });

  it('contact-form compiles to intake_form without phone/address/birthday/employer fields', () => {
    const safety = CONTACT_FORM_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Contact me',
      source_template_ref: safety.template_ref,
      form_definition: {
        form_definition_id: 'fd_contact_form',
        fields: [
          {
            name: 'full_name',
            type: 'text',
            label: 'Full name',
            required: true,
            visitor_pii_class: 'visitor_name',
          },
          {
            name: 'email',
            type: 'email',
            label: 'Email',
            required: true,
            visitor_pii_class: 'visitor_email',
          },
          {
            name: 'topic',
            type: 'enum',
            label: 'Topic',
            required: true,
            values: ['question', 'project', 'other'],
          },
          {
            name: 'message',
            type: 'textarea',
            label: 'Message',
            required: true,
          },
        ],
      },
    });

    const compiled = expectCreateInput(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(compiled.kind).toBe('intake_form');
    expect(compiled.packet_declaration).toEqual({
      packet_kind: 'intake_form_packet',
      fields_visible_override: PACKET_FIELDS_VISIBLE.intake_form_packet,
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: 'fd_contact_form',
      },
    });
    expect(compiled.metadata?.required_visitor_fields).toEqual({ email: 'required' });
    // D-210 WS3 — a contact form's destination IS a contact: the template's
    // safety matrix names `processing_target: 'contact'`, so the compiled rule
    // carries it. (WS2 parked it log-only because `contact` was not yet a
    // destination.) The submission is logged at submit either way — the target
    // says what ELSE happens.
    expect(compiled.metadata?.submission_processing_rule).toMatchObject({
      target_kind: 'contact',
    });
    // …and the compiled config must still be a VALID one. A destination the
    // compiler can emit but the validator rejects would be unauthorable.
    expect(validateIntakeFormConfig(compiled.metadata as object)).toEqual([]);
    expect(
      (compiled.metadata?.form_definition as { fields: ReadonlyArray<{ name: string }> }).fields.map(
        (field) => field.name,
      ),
    ).toEqual(['full_name', 'topic', 'message']);
    noExcessivePii(compiled);
  });

  it('share-project-status compiles to status_link with projection field ceiling', () => {
    const safety = matrix({
      template_ref: 'app/recued-core/project-status',
      allowed_kinds: ['status_link'],
      allowed_field_types: [],
      forbidden_field_names: ['phone', 'address', 'birthday', 'employer', 'income', 'ssn'],
      default_expiry: { mode: 'rolling', rolling_days: 30 },
      long_lived_permitted: true,
    });
    const proposed = baseConfig({
      kind: 'status_link',
      title: 'Project status',
      description: 'Current public project status.',
      source_template_ref: safety.template_ref,
      status_projection: {
        projection_kind: 'project',
        source_ref: { kind: 'data.project', project_id: 'proj_public_status' },
      },
    });

    const compiled = expectCreateInput(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(compiled.kind).toBe('status_link');
    expect(compiled.packet_declaration).toEqual({
      packet_kind: 'status_link_packet',
      fields_visible_override: PACKET_FIELDS_VISIBLE.status_link_packet,
      source_query_ref: { kind: 'data.project', project_id: 'proj_public_status' },
    });
    expect(compiled.metadata?.fields_visible_override).toEqual(
      STATUS_PROJECTION_FIELDS_VISIBLE.project,
    );
    expect(JSON.stringify(compiled.metadata)).not.toMatch(/internal|booking|confirmation|phone/i);
  });
});

describe('D-151 Pre-P0 — compile errors', () => {
  it('returns safety_matrix_violation when booking proposes visitor phone collection', () => {
    const safety = BOOKING_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'scheduling_link',
      title: 'Book a meeting',
      source_template_ref: safety.template_ref,
      scheduling: {
        duration_options_minutes: [30],
        available_window_definition: {
          tz: 'America/Los_Angeles',
          explicit_windows: [
            { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
          ],
        },
        required_visitor_fields: {
          phone: 'required',
        },
      },
    });

    const error = expectCompileError(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(error.kind).toBe('safety_matrix_violation');
    if (error.kind !== 'safety_matrix_violation') throw new Error('expected safety_matrix_violation');
    expect(error.template_ref).toBe('app/recued-core/booking');
    expect(error.violation).toContain('visitor phone');
  });

  it('returns safety_matrix_violation when a generic RSVP proposes phone collection', () => {
    const safety = RSVP_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Baby shower RSVP',
      source_template_ref: safety.template_ref,
      form_definition: {
        form_definition_id: 'fd_bad_rsvp',
        fields: [
          { name: 'guest_name', type: 'text', label: 'Guest name', required: true },
          {
            name: 'phone',
            type: 'text',
            label: 'Phone',
            required: true,
            visitor_pii_class: 'visitor_phone',
          },
        ],
      },
    });

    const error = expectCompileError(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(error.kind).toBe('safety_matrix_violation');
    if (error.kind !== 'safety_matrix_violation') throw new Error('expected safety_matrix_violation');
    expect(error.template_ref).toBe('app/recued-core/rsvp');
    expect(error.violation).toContain('phone');
  });

  it('returns safety_matrix_violation when photo-share proposes a collecting form', () => {
    const safety = PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Share photos',
      source_template_ref: safety.template_ref,
      form_definition: {
        form_definition_id: 'fd_bad_photo_share',
        fields: [
          {
            name: 'viewer_email',
            type: 'email',
            label: 'Viewer email',
            required: true,
            visitor_pii_class: 'visitor_email',
          },
        ],
      },
    });

    const error = expectCompileError(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(error.kind).toBe('safety_matrix_violation');
    if (error.kind !== 'safety_matrix_violation') throw new Error('expected safety_matrix_violation');
    expect(error.template_ref).toBe('app/recued-core/photo-share');
    expect(error.violation).toContain('kind=intake_form');
  });

  it('returns safety_matrix_violation when contact-form proposes address collection', () => {
    const safety = CONTACT_FORM_TEMPLATE_SAFETY_MATRIX;
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Contact me',
      source_template_ref: safety.template_ref,
      form_definition: {
        form_definition_id: 'fd_bad_contact_form',
        fields: [
          { name: 'full_name', type: 'text', label: 'Full name', required: true },
          { name: 'email', type: 'email', label: 'Email', required: true },
          {
            name: 'address',
            type: 'textarea',
            label: 'Address',
            required: true,
            visitor_pii_class: 'visitor_address',
          },
        ],
      },
    });

    const error = expectCompileError(
      compileProposedEndpointConfig(proposed, safety, { now: FIXED_NOW }),
    );

    expect(error.kind).toBe('safety_matrix_violation');
    if (error.kind !== 'safety_matrix_violation') throw new Error('expected safety_matrix_violation');
    expect(error.template_ref).toBe('app/recued-core/contact-form');
    expect(error.violation).toContain('address');
  });

  it('returns version_mismatch before compiling the D-149 create input', () => {
    const safety = matrix({
      template_ref: 'app/recued-core/booking',
      allowed_kinds: ['scheduling_link'],
      default_expiry: { mode: 'rolling', rolling_days: 90 },
      long_lived_permitted: true,
      processing_target: 'booking',
    });
    const proposed = baseConfig({
      kind: 'scheduling_link',
      title: 'Book a meeting',
      source_template_ref: safety.template_ref,
      scheduling: {
        duration_options_minutes: [30],
        available_window_definition: {
          tz: 'America/Los_Angeles',
          explicit_windows: [
            { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
          ],
        },
      },
    });
    const stale = { ...proposed, version: '0.9.0' } as unknown as ProposedEndpointConfig;

    const error = expectCompileError(
      compileProposedEndpointConfig(stale, safety, { now: FIXED_NOW }),
    );

    expect(error).toEqual({
      kind: 'version_mismatch',
      expected: COMPOSE_CONTRACT_VERSION,
      got: '0.9.0',
    });
  });
});
