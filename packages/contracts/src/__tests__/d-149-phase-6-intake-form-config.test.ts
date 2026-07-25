/** D-149 P6 § A.5.3 — `IntakeFormConfig` + submission validator tests.
 *
 *  Covers:
 *    - Closed-shape gate on every required field.
 *    - Public-mode field-type closed list (text/textarea/number/boolean/
 *      date/enum/array<text>/file accepted; password/signature/
 *      trusted_html/ref<T> structurally absent).
 *    - Enum-field value closed list.
 *    - user_only_field_names enforcement (must NOT overlap visitor-visible).
 *    - submission_processing_rule.target_kind closed list +
 *      fields_to_include / fields_to_attach subset gates.
 *    - anti_spam.honeypot_fields ⊆ visitor-visible names.
 *    - Rate limit bounds.
 *    - Submission validator: required fields, type coercion, enum check,
 *      visitor email validation + allowlist gating, honeypot fired flag.
 *    - RECEPTION_RPC_ERROR_CODE_SET extension for `intake_form_config_invalid`. */

import { describe, expect, it } from 'vitest';
import {
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX,
  INTAKE_FORM_DOMAIN_ALLOWLIST_MAX,
  INTAKE_FORM_FIELDS_COUNT_MAX,
  INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX,
  INTAKE_FORM_FIELD_ENUM_VALUE_MAX,
  INTAKE_FORM_FIELD_LABEL_MAX,
  INTAKE_FORM_HONEYPOT_FIELDS_MAX,
  INTAKE_FORM_INSTRUCTIONS_MAX,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOME_SET,
  INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX,
  INTAKE_FORM_SUCCESS_MESSAGE_MAX,
  INTAKE_FORM_TARGET_KINDS,
  INTAKE_FORM_TARGET_KIND_SET,
  INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX,
  INTAKE_FORM_VISITOR_EMAIL_MAX,
  INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS,
  INTAKE_FORM_VISITOR_FIELD_REQUIREMENT_SET,
  INTAKE_FORM_VISITOR_TEXTAREA_MAX,
  INTAKE_FORM_VISITOR_TEXT_MAX,
  RECEPTION_RPC_ERROR_CODE_SET,
  validateIntakeFormConfig,
  validateIntakeFormSubmission,
  type IntakeFormConfig,
  type IntakeFormSubmissionInput,
} from '../index.js';

const goodConfig: IntakeFormConfig = {
  display_name: 'Mary Smith',
  instructions: 'Tell me about your project.',
  success_message: "Thanks — I'll get back to you within 48 hours.",
  submit_button_label: 'Send message',
  template_ref: 'foundation:intake/client_inquiry',
  form_definition: {
    form_definition_id: 'fd_client_inquiry_v1',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'company', type: 'text', label: 'Company', required: false },
      {
        name: 'service_interest',
        type: 'enum',
        label: 'What can I help with?',
        required: true,
        values: ['consulting', 'implementation', 'training', 'other'],
      },
      { name: 'details', type: 'textarea', label: 'Tell me more', required: true },
    ],
    user_only_field_names: ['internal_classification', 'reliability_score'],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'company', 'service_interest', 'details'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

describe('D-149 P6 § A.5.3 — validateIntakeFormConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(validateIntakeFormConfig(goodConfig)).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateIntakeFormConfig(null)[0]?.code).toBe('config_shape_invalid');
    expect(validateIntakeFormConfig(undefined as unknown)[0]?.code).toBe(
      'config_shape_invalid',
    );
    expect(validateIntakeFormConfig([])[0]?.code).toBe('config_shape_invalid');
    expect(validateIntakeFormConfig('mary')[0]?.code).toBe('config_shape_invalid');
  });

  it('rejects empty display_name', () => {
    const c = { ...goodConfig, display_name: '   ' } as unknown;
    expect(validateIntakeFormConfig(c).some((f) => f.code === 'display_name_empty')).toBe(true);
  });

  it('rejects display_name over the cap', () => {
    const c = { ...goodConfig, display_name: 'A'.repeat(INTAKE_FORM_DISPLAY_NAME_MAX + 1) };
    expect(validateIntakeFormConfig(c).some((f) => f.code === 'display_name_too_long')).toBe(true);
  });

  it('rejects instructions over the cap', () => {
    const c = { ...goodConfig, instructions: 'A'.repeat(INTAKE_FORM_INSTRUCTIONS_MAX + 1) };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'instructions_too_long'),
    ).toBe(true);
  });

  it('rejects success_message over the cap', () => {
    const c = { ...goodConfig, success_message: 'A'.repeat(INTAKE_FORM_SUCCESS_MESSAGE_MAX + 1) };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'success_message_too_long'),
    ).toBe(true);
  });

  it('rejects submit_button_label over the cap', () => {
    const c = {
      ...goodConfig,
      submit_button_label: 'A'.repeat(INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX + 1),
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'submit_button_label_too_long'),
    ).toBe(true);
  });

  it('rejects template_ref of wrong shape', () => {
    const c = { ...goodConfig, template_ref: 42 as unknown as string };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'template_ref_invalid'),
    ).toBe(true);
  });
});

describe('D-149 P6 § A.5.3 — form_definition shape', () => {
  it('rejects missing form_definition', () => {
    const c = { ...goodConfig, form_definition: null as unknown };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'form_definition_invalid'),
    ).toBe(true);
  });

  it('rejects empty form_definition_id', () => {
    const c = {
      ...goodConfig,
      form_definition: { ...goodConfig.form_definition, form_definition_id: '' },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'form_definition_id_empty'),
    ).toBe(true);
  });

  it('rejects empty fields array', () => {
    const c = {
      ...goodConfig,
      form_definition: { ...goodConfig.form_definition, fields: [] },
    };
    expect(validateIntakeFormConfig(c).some((f) => f.code === 'fields_empty')).toBe(true);
  });

  it('rejects more than the max fields count', () => {
    const tooMany = Array.from({ length: INTAKE_FORM_FIELDS_COUNT_MAX + 1 }, (_, i) => ({
      name: `f${i}`,
      type: 'text' as const,
      label: `F${i}`,
      required: false,
    }));
    const c = {
      ...goodConfig,
      form_definition: { ...goodConfig.form_definition, fields: tooMany },
    };
    expect(validateIntakeFormConfig(c).some((f) => f.code === 'fields_too_many')).toBe(true);
  });

  it('rejects an invalid field name (e.g. uppercase, leading digit)', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [{ name: 'NotValid', type: 'text', label: 'X', required: false }],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_name_invalid'),
    ).toBe(true);
  });

  it('rejects an unknown field type', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [{ name: 'pw', type: 'password', label: 'X', required: false }],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_type_unknown'),
    ).toBe(true);
  });

  it('rejects field label over the cap', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          {
            name: 'name',
            type: 'text',
            label: 'A'.repeat(INTAKE_FORM_FIELD_LABEL_MAX + 1),
            required: true,
          },
        ],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_label_too_long'),
    ).toBe(true);
  });

  it('rejects substrate-reserved field names (form_nonce / visitor_email / t)', () => {
    // Codex review fold (P2 #3, 2026-05-13) — visitor field whose
    // name collides with a substrate-controlled POST key must be
    // rejected at config-validate time.
    for (const reservedName of ['form_nonce', 'visitor_email', 't']) {
      const c = {
        ...goodConfig,
        form_definition: {
          ...goodConfig.form_definition,
          fields: [
            { name: reservedName, type: 'text', label: 'X', required: true },
          ],
        },
        submission_processing_rule: {
          ...goodConfig.submission_processing_rule,
          fields_to_include_in_target: [],
        },
      } as unknown;
      expect(
        validateIntakeFormConfig(c).some((f) => f.code === 'field_name_reserved'),
      ).toBe(true);
    }
  });

  it('rejects duplicate field names', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          { name: 'name', type: 'text', label: 'A', required: true },
          { name: 'name', type: 'text', label: 'B', required: false },
        ],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_name_duplicate'),
    ).toBe(true);
  });

  it('requires enum.values', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [{ name: 'choice', type: 'enum', label: 'Choice', required: true }],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_enum_values_empty'),
    ).toBe(true);
  });

  it('rejects enum.values over the count cap', () => {
    const tooMany = Array.from({ length: INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX + 1 }, (_, i) =>
      `v${i}`,
    );
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          { name: 'choice', type: 'enum', label: 'Choice', required: true, values: tooMany },
        ],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_enum_values_too_many'),
    ).toBe(true);
  });

  it('rejects enum.values entries over the per-value cap', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          {
            name: 'choice',
            type: 'enum',
            label: 'Choice',
            required: true,
            values: ['x', 'A'.repeat(INTAKE_FORM_FIELD_ENUM_VALUE_MAX + 1)],
          },
        ],
      },
    } as unknown;
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_enum_value_too_long'),
    ).toBe(true);
  });

  it('rejects user_only_field_names overlap with visible names', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        user_only_field_names: ['your_name'], // already in fields
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'user_only_field_overlaps_visible'),
    ).toBe(true);
  });
});

describe('D-149 P6 § A.5.3 — submission_processing_rule', () => {
  // D-210 WS2 — `target_kind` is the DESTINATION and is now optional. Absent =
  // log-only: the canonical `form_response` record is written at submit for
  // every accepted submission regardless, so "keep only the response" is the
  // absence of a destination rather than a destination named `form_response`.
  // ⚠ INVERTED by D-210 A.8 slice 2b step 3. This asserted that a rule naming
  // NO destination was valid — the "log-only" shape. Absent is no longer a
  // value: it was a second spelling of `'form_response'`, and two spellings of
  // one meaning is how a vocabulary drifts. A TypeScript required field guards
  // nothing at runtime, so this is the check that actually refuses it.
  it('REJECTS a rule that names no destination — absent is no longer a spelling', () => {
    const { target_kind: _dropped, ...logOnlyRule } = goodConfig.submission_processing_rule;
    const c = {
      ...goodConfig,
      submission_processing_rule: { ...logOnlyRule },
    };
    const failures = validateIntakeFormConfig(c);
    expect(failures.some((f) => f.code === 'target_kind_missing')).toBe(true);
    // Its own code, not `target_kind_unknown`: "you did not choose" and "you
    // chose something that is not real" are different mistakes.
    expect(failures.some((f) => f.code === 'target_kind_unknown')).toBe(false);
    // …and it names the replacement, so the author is not left guessing.
    expect(failures.find((f) => f.code === 'target_kind_missing')!.detail)
      .toContain('form_response');
  });

  // ⚠ D-210 Phase C RE-AIMED. This used to pin "a log-only form MAY
  // auto-accept" — the gap WS2 closed by writing the canonical record at
  // submit instead of at approval. `auto_accept` is now retired on all three
  // reception kinds (owner ruling, 2026-07-18), so the claim inverts: the key
  // is REFUSED outright. WS2's actual guarantee — a log-only form is valid and
  // its submissions are logged either way — is pinned by the test above.
  it('REFUSES auto_accept outright — it is retired, not merely defaulted', () => {
    const { target_kind: _dropped, ...logOnlyRule } = goodConfig.submission_processing_rule;
    const c = {
      ...goodConfig,
      submission_processing_rule: { ...logOnlyRule, auto_accept: true },
    };
    const failures = validateIntakeFormConfig(c);
    expect(failures).toContainEqual(expect.objectContaining({ code: 'auto_accept_invalid' }));
    // The message has to tell the author what replaced it — silently reviewing
    // an endpoint that asked to skip review is a behaviour change they never see.
    expect(failures.find((f) => f.code === 'auto_accept_invalid')!.detail)
      .toContain('retired');
  });

  it('REFUSES a stale triggered_recipe_id — retired with the auto-accept path', () => {
    // It was documented as the "legacy recipe hook for the entity auto-accept
    // path", and its named replacement (`form_response.accepted`) fires at
    // SUBMIT, not on approval. The approve-time hook that survives is the
    // destination entity's own `created` event, so the message points there.
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        triggered_recipe_id: 'acme/follow-up',
      },
    };
    const failures = validateIntakeFormConfig(c);
    expect(failures).toContainEqual(
      expect.objectContaining({ code: 'triggered_recipe_id_invalid' }),
    );
    expect(failures.find((f) => f.code === 'triggered_recipe_id_invalid')!.detail)
      .toContain('retired');
  });

  it('REFUSES auto_accept: false too — a stale key is still a stale expectation', () => {
    // `false` already meant review, so this one changes nothing behaviourally.
    // It is still refused, because leaving it accepted would let a config keep
    // a field the substrate no longer honours, and the next author would read
    // it as a live switch.
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        auto_accept: false,
      },
    };
    expect(validateIntakeFormConfig(c)).toContainEqual(
      expect.objectContaining({ code: 'auto_accept_invalid' }),
    );
  });

  // ⚠ INVERTED by D-210 A.8 slice 2a. This test used to assert the WS2 ruling
  // that `form_response` is NOT a destination — correct for its premise, which
  // was that nothing else universally recorded a submission. It does now:
  // `reception_form_submission` is written first for every submission and kept
  // even for spam. With the evidence held there, `form_response` became the
  // generic MUTABLE destination (A.4). Owner-ruled 2026-07-19, on the changed
  // premise — not a changed judgement.
  it('ACCEPTS `form_response` as a destination — A.4 made it the generic one', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'form_response' as unknown as 'task',
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'target_kind_unknown'),
    ).toBe(false);
  });

  it('rejects a non-boolean auto_accept value (any presence is refused now)', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        auto_accept: 'yes',
      },
    };
    expect(validateIntakeFormConfig(c)).toContainEqual(expect.objectContaining({
      code: 'auto_accept_invalid',
    }));
  });

  it('rejects unknown target_kind', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'event' as unknown as 'task',
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'target_kind_unknown'),
    ).toBe(true);
  });

  it('rejects unknown fields_to_include_in_target entry', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        fields_to_include_in_target: ['your_name', 'mystery'],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'fields_to_include_unknown'),
    ).toBe(true);
  });

  it('rejects unknown fields_to_attach_as_metadata entry', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        fields_to_attach_as_metadata: ['mystery'],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'fields_to_attach_unknown'),
    ).toBe(true);
  });

  it('rejects overlap between include + attach sets', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        fields_to_include_in_target: ['your_name'],
        fields_to_attach_as_metadata: ['your_name'],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'fields_include_attach_overlap'),
    ).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════
  // D-210 A.8 slice 2b — COVERAGE (the ⊇ direction).
  // ══════════════════════════════════════════════════════════════

  it('rejects a field placed in NEITHER list for a real destination', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'task',
        fields_to_include_in_target: ['your_name', 'details'],
        fields_to_attach_as_metadata: ['company'],
        // `service_interest` is placed NOWHERE — a task destination would
        // discard it, and after 2b nothing else holds it in plaintext.
      },
    };
    const failures = validateIntakeFormConfig(c);
    expect(failures.some((f) => f.code === 'field_not_placed')).toBe(true);
    // The message must NAME the field — "a field is missing" sends the owner
    // hunting through their own form.
    expect(failures.find((f) => f.code === 'field_not_placed')!.detail)
      .toContain('service_interest');
  });

  it('ACCEPTS a config that places every field', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'task',
        fields_to_include_in_target: ['your_name', 'details'],
        fields_to_attach_as_metadata: ['company', 'service_interest'],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_not_placed'),
    ).toBe(false);
  });

  it('treats a HONEYPOT as placed — a spam trap is not owner content', () => {
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, honeypot_fields: ['company'] },
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'task',
        fields_to_include_in_target: ['your_name', 'details'],
        fields_to_attach_as_metadata: ['service_interest'],
        // `company` is unplaced but IS the honeypot.
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_not_placed'),
    ).toBe(false);
  });

  it('does NOT demand coverage when target_kind is ABSENT (log-only projects everything)', () => {
    const rule = { ...goodConfig.submission_processing_rule } as Record<string, unknown>;
    delete rule.target_kind;
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...rule,
        fields_to_include_in_target: [],
        fields_to_attach_as_metadata: [],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_not_placed'),
    ).toBe(false);
  });

  it('does NOT demand coverage for form_response — its record retains every value', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'form_response',
        fields_to_include_in_target: [],
        fields_to_attach_as_metadata: [],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_not_placed'),
    ).toBe(false);
  });

  it('does NOT pile coverage failures onto an ALREADY-INVALID target_kind', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'commitment', // retired in A.7
        fields_to_include_in_target: [],
        fields_to_attach_as_metadata: [],
      },
    };
    const failures = validateIntakeFormConfig(c);
    expect(failures.some((f) => f.code === 'target_kind_unknown')).toBe(true);
    // One clear reason, not a cascade the owner has to read past.
    expect(failures.some((f) => f.code === 'field_not_placed')).toBe(false);
  });

  it('counts a CALENDAR mapping field as placed — it becomes the event time', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        form_definition_id: 'fd_cal',
        fields: [
          { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
          { name: 'guest_name', type: 'text', label: 'Name', required: true },
        ],
      },
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        target_kind: 'calendar',
        calendar_mapping: { start_field: 'arrives_at', default_duration_minutes: 60 },
        fields_to_include_in_target: ['guest_name'],
        fields_to_attach_as_metadata: [],
        // `arrives_at` is in NEITHER list, but the mapping consumes it into the
        // event's actual start. Counting only the two lists rejected every
        // valid calendar config -- six WS3 tests caught it.
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'field_not_placed'),
    ).toBe(false);
  });

  it('rejects empty triggered_recipe_id when present', () => {
    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        triggered_recipe_id: '',
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'triggered_recipe_id_invalid'),
    ).toBe(true);
  });

  it('REFUSES submission_processing_rule.notification_target — retired, not merely closed-list-gated', () => {
    // ⚠ D-210 Phase C RE-AIMED. This pinned "reject a value outside the closed
    // list". The list is gone: it was a per-endpoint copy of the D-158 channel
    // vocabulary that never dispatched. Channels are chosen in Settings and the
    // inbox fanout mode picks the surface, so ANY value here is now refused.

    const c = {
      ...goodConfig,
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        notification_target: 'webclient' as unknown as string,
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'notification_target_unknown'),
    ).toBe(true);
  });

});

describe('D-149 P6 § A.5.3 — anti_spam', () => {
  it('rejects honeypot field name that is not in form_definition', () => {
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, honeypot_fields: ['website'] },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'honeypot_unknown_field'),
    ).toBe(true);
  });

  it('accepts honeypot field names that ARE in form_definition', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          ...goodConfig.form_definition.fields,
          { name: 'website', type: 'text', label: 'Website', required: false },
        ],
      },
      anti_spam: { ...goodConfig.anti_spam, honeypot_fields: ['website'] },
    };
    expect(validateIntakeFormConfig(c)).toEqual([]);
  });

  it('rejects honeypot count over the cap', () => {
    const extra = Array.from({ length: INTAKE_FORM_HONEYPOT_FIELDS_MAX + 1 }, (_, i) => ({
      name: `hp${i}`,
      type: 'text' as const,
      label: `H${i}`,
      required: false,
    }));
    const c = {
      ...goodConfig,
      form_definition: { ...goodConfig.form_definition, fields: extra },
      anti_spam: {
        ...goodConfig.anti_spam,
        honeypot_fields: extra.map((f) => f.name),
      },
      // Adjust the processing rule to reference at least one valid field
      // — the include array is otherwise empty + visible-field set is
      // already enforced above.
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        fields_to_include_in_target: [],
      },
    };
    expect(validateIntakeFormConfig(c).some((f) => f.code === 'honeypot_too_many')).toBe(true);
  });

  it('rejects rate_limit_per_ip out of range (too low)', () => {
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, rate_limit_per_ip: INTAKE_FORM_RATE_LIMIT_PER_IP_MIN - 1 },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'rate_limit_out_of_range'),
    ).toBe(true);
  });

  it('rejects rate_limit_per_ip out of range (too high)', () => {
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, rate_limit_per_ip: INTAKE_FORM_RATE_LIMIT_PER_IP_MAX + 1 },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'rate_limit_out_of_range'),
    ).toBe(true);
  });

  it('rejects non-boolean require_proof_of_work / require_captcha', () => {
    const c1 = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, require_proof_of_work: 'yes' as unknown as boolean },
    };
    expect(
      validateIntakeFormConfig(c1).some((f) => f.code === 'anti_spam_invalid'),
    ).toBe(true);
    const c2 = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, require_captcha: 'no' as unknown as boolean },
    };
    expect(
      validateIntakeFormConfig(c2).some((f) => f.code === 'anti_spam_invalid'),
    ).toBe(true);
  });

  it('rejects known_domain_allowlist over the entry-count cap', () => {
    const entries = Array.from(
      { length: INTAKE_FORM_DOMAIN_ALLOWLIST_MAX + 1 },
      (_, i) => `d${i}.example.com`,
    );
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, known_domain_allowlist: entries },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'domain_allowlist_too_many'),
    ).toBe(true);
  });

  it('rejects known_domain_allowlist entries over the length cap', () => {
    const c = {
      ...goodConfig,
      anti_spam: {
        ...goodConfig.anti_spam,
        known_domain_allowlist: ['x'.repeat(INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX + 1)],
      },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'domain_allowlist_entry_too_long'),
    ).toBe(true);
  });
});

describe('D-149 P6 § A.5.3 — required_visitor_fields', () => {
  it('accepts each closed-list email requirement', () => {
    for (const v of INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS) {
      const c = { ...goodConfig, required_visitor_fields: { email: v } };
      expect(validateIntakeFormConfig(c)).toEqual([]);
    }
  });

  it('rejects unknown email requirement', () => {
    const c = {
      ...goodConfig,
      required_visitor_fields: { email: 'optional_strict' as unknown as 'optional' },
    };
    expect(
      validateIntakeFormConfig(c).some((f) => f.code === 'visitor_fields_invalid'),
    ).toBe(true);
  });
});

describe('D-149 P6 § A.5.3 — validateIntakeFormSubmission', () => {
  it('accepts a clean submission', () => {
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'visitor@example.com',
      fields: {
        your_name: 'Visitor',
        service_interest: 'consulting',
        details: 'Tell me about your services.',
      },
    };
    expect(validateIntakeFormSubmission(input, goodConfig)).toEqual([]);
  });

  it('rejects missing required field', () => {
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'visitor@example.com',
      fields: { service_interest: 'consulting', details: 'detail' },
    };
    const failures = validateIntakeFormSubmission(input, goodConfig);
    expect(failures.some((f) => f.code === 'field_required_missing')).toBe(true);
  });

  it('rejects unknown field', () => {
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'visitor@example.com',
      fields: { your_name: 'V', service_interest: 'consulting', details: 'x', surprise: 'extra' },
    };
    expect(validateIntakeFormSubmission(input, goodConfig).some((f) => f.code === 'field_unknown')).toBe(
      true,
    );
  });

  it('rejects enum value outside the closed list', () => {
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'visitor@example.com',
      fields: { your_name: 'V', service_interest: 'mystery', details: 'x' },
    };
    expect(
      validateIntakeFormSubmission(input, goodConfig).some(
        (f) => f.code === 'field_enum_value_invalid',
      ),
    ).toBe(true);
  });

  it('rejects email missing when required', () => {
    const c = { ...goodConfig, required_visitor_fields: { email: 'required' as const } };
    const input: IntakeFormSubmissionInput = {
      fields: { your_name: 'V', service_interest: 'consulting', details: 'x' },
    };
    expect(validateIntakeFormSubmission(input, c).some((f) => f.code === 'visitor_email_required')).toBe(
      true,
    );
  });

  it('rejects email outside the allowlist when configured', () => {
    const c = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, known_domain_allowlist: ['client.com'] },
    };
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'spam@bad.com',
      fields: { your_name: 'V', service_interest: 'consulting', details: 'x' },
    };
    expect(
      validateIntakeFormSubmission(input, c).some((f) => f.code === 'visitor_email_domain_rejected'),
    ).toBe(true);
  });

  it('rejects textarea field over the textarea cap', () => {
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'v@example.com',
      fields: {
        your_name: 'V',
        service_interest: 'consulting',
        details: 'A'.repeat(INTAKE_FORM_VISITOR_TEXTAREA_MAX + 1),
      },
    };
    expect(validateIntakeFormSubmission(input, goodConfig).some((f) => f.code === 'field_too_long')).toBe(
      true,
    );
  });

  it('signals honeypot tripped via dedicated code', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          ...goodConfig.form_definition.fields,
          { name: 'website', type: 'text' as const, label: 'Website', required: false },
        ],
      },
      anti_spam: { ...goodConfig.anti_spam, honeypot_fields: ['website'] },
    };
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'v@example.com',
      fields: {
        your_name: 'V',
        service_interest: 'consulting',
        details: 'x',
        website: 'http://spam',
      },
    };
    const failures = validateIntakeFormSubmission(input, c);
    expect(failures.some((f) => f.code === 'honeypot_filled')).toBe(true);
  });

  it('coerces number-typed fields from strings', () => {
    const c = {
      ...goodConfig,
      form_definition: {
        ...goodConfig.form_definition,
        fields: [
          ...goodConfig.form_definition.fields,
          { name: 'budget', type: 'number' as const, label: 'Budget', required: false },
        ],
      },
      submission_processing_rule: {
        ...goodConfig.submission_processing_rule,
        fields_to_include_in_target: [
          ...goodConfig.submission_processing_rule.fields_to_include_in_target,
          'budget',
        ],
      },
    };
    const input: IntakeFormSubmissionInput = {
      visitor_email: 'v@example.com',
      fields: {
        your_name: 'V',
        service_interest: 'consulting',
        details: 'x',
        budget: '5000',
      },
    };
    expect(validateIntakeFormSubmission(input, c)).toEqual([]);
  });
});

describe('D-149 P6 § A.5.3 — closed-list ratchets', () => {
  it('extends RECEPTION_RPC_ERROR_CODE_SET with intake_form_config_invalid', () => {
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('intake_form_config_invalid')).toBe(true);
  });

  it('exports the target-kind closed list', () => {
    for (const k of INTAKE_FORM_TARGET_KINDS) {
      expect(INTAKE_FORM_TARGET_KIND_SET.has(k)).toBe(true);
    }
  });

  it('exports the visitor-field-requirement closed list', () => {
    for (const k of INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS) {
      expect(INTAKE_FORM_VISITOR_FIELD_REQUIREMENT_SET.has(k)).toBe(true);
    }
  });

  it('exports the processing-outcome closed list', () => {
    for (const k of INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES) {
      expect(INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOME_SET.has(k)).toBe(true);
    }
    expect(
      Array.from(INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES).sort().join(','),
    ).toBe('auto:placeholder'.replace('auto:placeholder', 'duplicate,failed,pending,processed,rejected_domain,spam'));
  });

  it('caps the visitor field per-text + per-array entries', () => {
    expect(INTAKE_FORM_VISITOR_TEXT_MAX).toBeGreaterThan(0);
    expect(INTAKE_FORM_VISITOR_TEXTAREA_MAX).toBeGreaterThan(INTAKE_FORM_VISITOR_TEXT_MAX);
    expect(INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX).toBeGreaterThan(0);
    expect(INTAKE_FORM_VISITOR_EMAIL_MAX).toBeGreaterThan(0);
  });
});
