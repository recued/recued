/** D-149 § A.10 follow-on — Settings → Server → Reception → Intake
 *  forms → Templates browser renderer.
 *
 *  Covers the projection layer over the P11 template substrate
 *  (`INTAKE_FORM_TEMPLATE_REFS` / `IntakeFormTemplate` /
 *  `intakeFormConfigFromTemplate`): the suggested-SI action copy
 *  registry (+ its ratchet against the contract), the action-detail
 *  resolver, the suggested-SI + card + full-browser projections (canonical
 *  ordering, honeypot exclusion, partial-load `missing_refs`), the
 *  display-name pre-check, the `useIntakeFormTemplate` bridge, and the
 *  re-export identity of the contract converter + the authoring
 *  `buildIntakeFormFormModel`. */

import { describe, expect, it } from 'vitest';
import {
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_TEMPLATE_REFS,
  intakeFormConfigFromTemplate as contractIntakeFormConfigFromTemplate,
  validateIntakeFormConfig,
  type IntakeFormTemplate,
  type IntakeFormTemplateRef,
} from '@recued/contracts';
import {
  TEMPLATE_DISPLAY_NAME_ERROR_COPY,
  buildIntakeFormFormModel,
  buildIntakeFormTemplateCardModel,
  buildIntakeFormTemplatesBrowserModel,
  intakeFormConfigFromTemplate,
  useIntakeFormTemplate,
  validateTemplateDisplayName,
} from '../settings/reception-templates.js';

// ════════════════════════════════════════════════════════════════
// Fixtures — a minimal valid IntakeFormTemplate (mirrors the shape of
// the real Foundation-pack JSON, e.g. client_inquiry.json). `website`
// is both a form field AND the honeypot — the real templates do this,
// and it is what exercises the card's honeypot-exclusion split.
// ════════════════════════════════════════════════════════════════

const mkTemplate = (override: Partial<IntakeFormTemplate> = {}): IntakeFormTemplate => ({
  template_ref: 'foundation:intake/client_inquiry',
  version: '1.0.0',
  name: 'Client inquiry',
  description: 'Collect initial inquiries from prospective clients.',
  default_instructions: 'Tell me a little about what you are looking for.',
  default_success_message: 'Thanks — your inquiry came through.',
  default_submit_button_label: 'Send inquiry',
  form_definition: {
    form_definition_id: 'fd_test_client_inquiry_v1',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'company', type: 'text', label: 'Company', required: false },
      { name: 'details', type: 'textarea', label: 'Tell me more', required: true },
      { name: 'website', type: 'text', label: 'Website', required: false },
    ],
  },
  required_visitor_fields: { email: 'required' },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'company', 'details'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam_defaults: {
    honeypot_fields: ['website'],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  ...override,
});

/** A template bound to a specific closed-list ref — for the
 *  browser-ordering / missing-refs tests. */
const mkTemplateForRef = (
  ref: IntakeFormTemplateRef,
  override: Partial<IntakeFormTemplate> = {},
): IntakeFormTemplate =>
  mkTemplate({
    template_ref: ref,
    name: `Template ${ref}`,
    ...override,
  });

// ════════════════════════════════════════════════════════════════
// buildIntakeFormTemplateCardModel
// ════════════════════════════════════════════════════════════════

describe('buildIntakeFormTemplateCardModel', () => {
  it('passes through ref, version, name, description, and default instructions', () => {
    const card = buildIntakeFormTemplateCardModel(mkTemplate());
    expect(card.template_ref).toBe('foundation:intake/client_inquiry');
    expect(card.version).toBe('1.0.0');
    expect(card.name).toBe('Client inquiry');
    expect(card.description).toBe('Collect initial inquiries from prospective clients.');
    expect(card.default_instructions).toBe(
      'Tell me a little about what you are looking for.',
    );
  });

  it('projects default_instructions as null when the template omits it', () => {
    const card = buildIntakeFormTemplateCardModel(
      mkTemplate({ default_instructions: undefined }),
    );
    expect(card.default_instructions).toBeNull();
  });

  it('resolves the target-kind copy from the authoring registry', () => {
    const card = buildIntakeFormTemplateCardModel(mkTemplate());
    expect(card.target_kind).toBe('task');
    expect(card.target_kind_label).toBe('Task');
    expect(card.target_kind_description.length).toBeGreaterThan(0);
  });

  it('excludes honeypot fields from the visitor-meaningful collected set', () => {
    // mkTemplate: 4 fields (your_name*, company, details*, website), honeypot = [website]
    const card = buildIntakeFormTemplateCardModel(mkTemplate());
    expect(card.collected.total_field_count).toBe(4);
    expect(card.collected.visitor_field_count).toBe(3);
    expect(card.collected.honeypot_field_count).toBe(1);
    expect(card.collected.required_field_count).toBe(2);
    expect(card.collected.optional_field_count).toBe(1);
    expect(card.collected.field_labels.map((f) => f.label)).toEqual([
      'Your name',
      'Company',
      'Tell me more',
    ]);
    expect(card.collected.field_labels.map((f) => f.required)).toEqual([true, false, true]);
  });

  it('resolves the visitor-email posture copy from the authoring registry', () => {
    const required = buildIntakeFormTemplateCardModel(mkTemplate());
    expect(required.collects_email).toBe('required');
    expect(required.collects_email_label).toBe('Required');
    expect(required.collects_email_description.length).toBeGreaterThan(0);

    const optional = buildIntakeFormTemplateCardModel(
      mkTemplate({ required_visitor_fields: { email: 'optional' } }),
    );
    expect(optional.collects_email).toBe('optional');
    expect(optional.collects_email_label).toBe('Optional');
  });

  it('one-lines the anti-spam defaults (plural rate + honeypot count)', () => {
    const card = buildIntakeFormTemplateCardModel(mkTemplate());
    expect(card.anti_spam.rate_limit_per_ip).toBe(5);
    expect(card.anti_spam.honeypot_field_count).toBe(1);
    expect(card.anti_spam.require_proof_of_work).toBe(false);
    expect(card.anti_spam.require_captcha).toBe(false);
    expect(card.anti_spam.summary_label).toBe(
      '5 submissions per IP per hour · 1 honeypot field',
    );
  });

  it('uses the singular form for a rate limit of 1', () => {
    const card = buildIntakeFormTemplateCardModel(
      mkTemplate({
        anti_spam_defaults: {
          honeypot_fields: ['website'],
          rate_limit_per_ip: 1,
          require_proof_of_work: false,
          require_captcha: false,
        },
      }),
    );
    expect(card.anti_spam.summary_label).toBe('1 submission per IP per hour · 1 honeypot field');
  });

  it('does not advertise unimplemented proof-of-work or CAPTCHA flags', () => {
    const card = buildIntakeFormTemplateCardModel(
      mkTemplate({
        anti_spam_defaults: {
          honeypot_fields: ['website'],
          rate_limit_per_ip: 5,
          require_proof_of_work: true,
          require_captcha: true,
        },
      }),
    );
    expect(card.anti_spam.summary_label).toBe(
      '5 submissions per IP per hour · 1 honeypot field',
    );
  });

  it('omits the honeypot clause from the anti-spam summary when there are none', () => {
    const card = buildIntakeFormTemplateCardModel(
      mkTemplate({
        anti_spam_defaults: {
          honeypot_fields: [],
          rate_limit_per_ip: 10,
          require_proof_of_work: false,
          require_captcha: false,
        },
      }),
    );
    expect(card.anti_spam.honeypot_field_count).toBe(0);
    expect(card.anti_spam.summary_label).toBe('10 submissions per IP per hour');
    // With no honeypot, `website` is a plain visitor field again.
    expect(card.collected.visitor_field_count).toBe(4);
    expect(card.collected.honeypot_field_count).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// buildIntakeFormTemplatesBrowserModel
// ════════════════════════════════════════════════════════════════

describe('buildIntakeFormTemplatesBrowserModel', () => {
  it('orders cards by the closed-list canonical order regardless of input order', () => {
    const reversed = [...INTAKE_FORM_TEMPLATE_REFS]
      .reverse()
      .map((ref) => mkTemplateForRef(ref));
    const model = buildIntakeFormTemplatesBrowserModel({ templates: reversed });
    expect(model.cards.map((c) => c.template_ref)).toEqual([...INTAKE_FORM_TEMPLATE_REFS]);
  });

  it('reports a complete set when all six refs are supplied', () => {
    const all = INTAKE_FORM_TEMPLATE_REFS.map((ref) => mkTemplateForRef(ref));
    const model = buildIntakeFormTemplatesBrowserModel({ templates: all });
    expect(model.total).toBe(6);
    expect(model.is_empty).toBe(false);
    expect(model.missing_refs).toEqual([]);
    expect(model.is_complete).toBe(true);
  });

  it('surfaces missing refs for a partial set', () => {
    const subset = [
      mkTemplateForRef('foundation:intake/client_inquiry'),
      mkTemplateForRef('foundation:intake/vendor_quote'),
    ];
    const model = buildIntakeFormTemplatesBrowserModel({ templates: subset });
    expect(model.total).toBe(2);
    expect(model.is_complete).toBe(false);
    expect(model.missing_refs).toEqual([
      'foundation:intake/event_planning',
      'foundation:intake/travel_request',
      'foundation:intake/doctor_appointment_prep',
      'foundation:intake/house_project',
    ]);
  });

  it('is_empty + every ref missing for an empty input', () => {
    const model = buildIntakeFormTemplatesBrowserModel({ templates: [] });
    expect(model.total).toBe(0);
    expect(model.is_empty).toBe(true);
    expect(model.is_complete).toBe(false);
    expect(model.missing_refs).toEqual([...INTAKE_FORM_TEMPLATE_REFS]);
  });

  it('last-wins on a duplicate ref', () => {
    const model = buildIntakeFormTemplatesBrowserModel({
      templates: [
        mkTemplateForRef('foundation:intake/client_inquiry', { name: 'First' }),
        mkTemplateForRef('foundation:intake/client_inquiry', { name: 'Second' }),
      ],
    });
    expect(model.total).toBe(1);
    expect(model.cards[0]!.name).toBe('Second');
  });
});

// ════════════════════════════════════════════════════════════════
// validateTemplateDisplayName + TEMPLATE_DISPLAY_NAME_ERROR_COPY
// ════════════════════════════════════════════════════════════════

describe('validateTemplateDisplayName', () => {
  it('rejects an empty / whitespace-only display name', () => {
    expect(validateTemplateDisplayName('')).toBe('display_name_empty');
    expect(validateTemplateDisplayName('   ')).toBe('display_name_empty');
  });

  it('rejects a display name over the contract length cap', () => {
    expect(validateTemplateDisplayName('x'.repeat(INTAKE_FORM_DISPLAY_NAME_MAX + 1))).toBe(
      'display_name_too_long',
    );
  });

  it('accepts a non-empty display name at or under the cap', () => {
    expect(validateTemplateDisplayName('Mary Chen')).toBeNull();
    expect(validateTemplateDisplayName('x'.repeat(INTAKE_FORM_DISPLAY_NAME_MAX))).toBeNull();
  });

  it('has remediation copy for every validation code', () => {
    for (const code of ['display_name_empty', 'display_name_too_long'] as const) {
      expect(TEMPLATE_DISPLAY_NAME_ERROR_COPY[code].length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// useIntakeFormTemplate — the "Use template" bridge
// ════════════════════════════════════════════════════════════════

describe('useIntakeFormTemplate', () => {
  it('mints a valid IntakeFormConfig for a valid display name', () => {
    const result = useIntakeFormTemplate(mkTemplate(), { display_name: 'Mary Chen' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // The generated config must pass the SAME validator the
    // reception.endpoint.create rpc runs.
    expect(validateIntakeFormConfig(result.config)).toEqual([]);
    expect(result.config.display_name).toBe('Mary Chen');
  });

  it('stamps the template ref + version onto the generated config', () => {
    const result = useIntakeFormTemplate(mkTemplate(), { display_name: 'Mary Chen' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.template_ref).toBe('foundation:intake/client_inquiry');
    expect(result.config.template_version).toBe('1.0.0');
  });

  it('threads a per-endpoint form_definition_id override through the conversion', () => {
    const result = useIntakeFormTemplate(mkTemplate(), {
      display_name: 'Mary Chen',
      form_definition_id: 'fd_endpoint_specific_abc',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.form_definition.form_definition_id).toBe('fd_endpoint_specific_abc');
  });

  it('rejects an empty display name before conversion', () => {
    const result = useIntakeFormTemplate(mkTemplate(), { display_name: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not-ok');
    expect(result.code).toBe('display_name_empty');
    expect(result.detail).toBe(TEMPLATE_DISPLAY_NAME_ERROR_COPY.display_name_empty);
  });

  it('rejects an over-long display name before conversion', () => {
    const result = useIntakeFormTemplate(mkTemplate(), {
      display_name: 'x'.repeat(INTAKE_FORM_DISPLAY_NAME_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not-ok');
    expect(result.code).toBe('display_name_too_long');
  });
});

// ════════════════════════════════════════════════════════════════
// Re-exports — the contract converter + the authoring form-model builder
// ════════════════════════════════════════════════════════════════

describe('re-exports', () => {
  it('re-exports the contract intakeFormConfigFromTemplate verbatim', () => {
    expect(intakeFormConfigFromTemplate).toBe(contractIntakeFormConfigFromTemplate);
  });

  it('composes useIntakeFormTemplate → buildIntakeFormFormModel into an editable form', () => {
    const result = useIntakeFormTemplate(mkTemplate(), { display_name: 'Mary Chen' });
    if (!result.ok) throw new Error('expected ok');
    const formModel = buildIntakeFormFormModel(result.config);
    // A config (not null) ⇒ the "edit" form, pre-populated from the template.
    expect(formModel.is_new).toBe(false);
    expect(formModel.display_name.value).toBe('Mary Chen');
    // Reads the fixture's own `target_kind`, not a constant — A.8 slice 1 moved
    // `mkTemplate` off the struck `commitment` and updated the two `card.*`
    // assertions but not this one, which is how it went red unnoticed.
    expect(formModel.target_kind.value).toBe(mkTemplate().submission_processing_rule.target_kind);
  });
});
