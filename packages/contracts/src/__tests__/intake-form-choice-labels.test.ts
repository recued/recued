/** Choice labels on an intake form's `enum` fields (`value_labels`): the text a
 *  visitor sees for a stored value, and what the config validator accepts.
 *
 *  The form stores the value (`under_10k`) so a recipe that routes on it keeps
 *  working; a person sees the label ("Under 10k"). */

import { describe, expect, it } from 'vitest';
import {
  INTAKE_FORM_FIELD_ENUM_VALUE_MAX,
  intakeFormChoiceText,
  validateIntakeFormConfig,
  type IntakeFormConfig,
} from '../intake-form-config.js';

const budget = {
  name: 'budget_range',
  type: 'enum',
  label: 'Budget range',
  required: false,
  values: ['under_10k', '10k_50k', 'prefer_not_to_say'],
  value_labels: { under_10k: 'Under 10k', '10k_50k': '10k–50k' },
} as const;

const configWith = (field: Record<string, unknown>): unknown => {
  const config: IntakeFormConfig = {
    display_name: 'Mary Smith',
    form_definition: {
      form_definition_id: 'fd_choice_labels_v1',
      fields: [{ name: 'your_name', type: 'text', label: 'Your name', required: true }],
    },
    submission_processing_rule: {
      target_kind: 'task',
      fields_to_include_in_target: ['your_name'],
      fields_to_attach_as_metadata: ['budget_range'],
    },
    anti_spam: {
      honeypot_fields: [],
      rate_limit_per_ip: 5,
      require_proof_of_work: false,
      require_captcha: false,
    },
    required_visitor_fields: { email: 'required' },
  };
  return {
    ...config,
    form_definition: {
      ...config.form_definition,
      fields: [...config.form_definition.fields, field],
    },
  };
};

const codes = (field: Record<string, unknown>): ReadonlyArray<string> =>
  validateIntakeFormConfig(configWith(field)).map((failure) => failure.code);

describe('intakeFormChoiceText', () => {
  it('shows a value\'s label, and a value with none as itself', () => {
    expect(intakeFormChoiceText(budget, 'under_10k')).toBe('Under 10k');
    expect(intakeFormChoiceText(budget, 'prefer_not_to_say')).toBe('prefer_not_to_say');
    expect(intakeFormChoiceText({}, 'asap')).toBe('asap');
  });

  it('never shows text inherited from Object.prototype', () => {
    expect(intakeFormChoiceText(budget, 'constructor')).toBe('constructor');
    expect(intakeFormChoiceText(budget, '__proto__')).toBe('__proto__');
    expect(intakeFormChoiceText(budget, 'toString')).toBe('toString');
  });

  it('reads only the map\'s own keys, even where a prototype carries text', () => {
    const inherited = Object.create({ asap: 'From a prototype' }) as Record<string, string>;
    expect(intakeFormChoiceText({ value_labels: inherited }, 'asap')).toBe('asap');
  });

  it('falls back to the value for a label that is not usable text', () => {
    expect(intakeFormChoiceText({ value_labels: { a: '  ' } }, 'a')).toBe('a');
    expect(intakeFormChoiceText({ value_labels: { a: 7 } }, 'a')).toBe('a');
    expect(intakeFormChoiceText({ value_labels: ['A'] }, '0')).toBe('0');
    expect(intakeFormChoiceText({ value_labels: null }, 'a')).toBe('a');
    expect(intakeFormChoiceText({ value_labels: { a: ' As soon as possible ' } }, 'a')).toBe('As soon as possible');
  });
});

describe('validateIntakeFormConfig — value_labels', () => {
  it('accepts labels for some or all of a field\'s values', () => {
    expect(codes(budget)).toEqual([]);
    expect(codes({ ...budget, value_labels: {} })).toEqual([]);
  });

  it('ignores labels on a field that is not a choice box, as it ignores `values` there', () => {
    expect(codes({ name: 'budget_range', type: 'text', label: 'Budget', required: false, value_labels: { x: 'X' } }))
      .toEqual([]);
  });

  it('refuses labels that are not a map of the field\'s own values to text', () => {
    expect(codes({ ...budget, value_labels: ['Under 10k'] })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: null })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { over_200k: 'Over 200k' } })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { under_10k: '' } })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { under_10k: '   ' } })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { under_10k: 10 } })).toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { under_10k: 'U'.repeat(INTAKE_FORM_FIELD_ENUM_VALUE_MAX + 1) } }))
      .toEqual(['field_enum_value_labels_invalid']);
    expect(codes({ ...budget, value_labels: { under_10k: 'U'.repeat(INTAKE_FORM_FIELD_ENUM_VALUE_MAX) } }))
      .toEqual([]);
  });

  it('refuses a label with a comma, which the form editor would split into two choices', () => {
    expect(codes({ ...budget, value_labels: { under_10k: 'Under 10,000' } })).toEqual(['field_enum_value_labels_invalid']);
  });

  it('refuses two choices that would read the same to the visitor', () => {
    expect(codes({ ...budget, value_labels: { under_10k: 'Small', '10k_50k': 'Small' } }))
      .toEqual(['field_enum_choice_text_duplicate']);
    // A label may not read as another choice's unlabelled value either.
    expect(codes({ ...budget, value_labels: { under_10k: 'prefer_not_to_say' } }))
      .toEqual(['field_enum_choice_text_duplicate']);
    // Distinct text that differs only in case is still distinct.
    expect(codes({ ...budget, value_labels: { under_10k: 'Small', '10k_50k': 'small' } })).toEqual([]);
  });

  it('leaves a field without labels exactly as before, repeated values included', () => {
    expect(codes({ ...budget, value_labels: undefined, values: ['a', 'a'] })).toEqual([]);
  });
});
