/** Shared validation for the owner-editable `form_response` working copy.
 *
 * The frozen form definition is the authority for answer names and shapes.
 * Both edit doors use this function: the paired-admin approval surface before
 * first promotion, and the paired-client Data RPC after promotion. The sealed
 * `reception_form_submission` evidence row is never passed here or mutated.
 */

import {
  validateIntakeFormSubmission,
  type FormResponseVisitor,
  type IntakeFormConfig,
  type IntakeFormConfigField,
  type IntakeFormSubmissionInput,
} from '@recued/contracts';

export interface FormResponseWorkingContentContext {
  readonly form_definition_id: string;
  readonly definition_snapshot: Readonly<Record<string, unknown>>;
}

export interface FormResponseWorkingContentInput {
  readonly values: unknown;
  readonly visitor: unknown;
}

export interface ValidatedFormResponseWorkingContent {
  readonly values: Readonly<Record<string, unknown>>;
  readonly visitor: FormResponseVisitor;
}

export class FormResponseWorkingContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormResponseWorkingContentValidationError';
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Validate and narrow owner-authored working content against the exact
 * definition captured with the submission. This does not accept provenance,
 * ids, timestamps, lifecycle state, or arbitrary visitor properties. */
export const validateFormResponseWorkingContent = (
  context: FormResponseWorkingContentContext,
  input: FormResponseWorkingContentInput,
): ValidatedFormResponseWorkingContent => {
  const values = asObject(input.values);
  const visitor = asObject(input.visitor);
  if (values === null) {
    throw new FormResponseWorkingContentValidationError('values must be an object');
  }
  if (visitor === null) {
    throw new FormResponseWorkingContentValidationError('visitor must be an object');
  }
  for (const key of Object.keys(visitor)) {
    if (key !== 'email') {
      throw new FormResponseWorkingContentValidationError(
        `unknown visitor field '${key}'`,
      );
    }
  }
  if (
    visitor.email !== undefined
    && (typeof visitor.email !== 'string' || visitor.email.length === 0)
  ) {
    throw new FormResponseWorkingContentValidationError(
      'visitor.email must be a non-empty string when present',
    );
  }

  const snapshot = asObject(context.definition_snapshot);
  const rawFields = snapshot?.fields;
  if (!Array.isArray(rawFields)) {
    throw new FormResponseWorkingContentValidationError(
      'frozen form definition is not editable',
    );
  }
  const fields = rawFields as IntakeFormConfigField[];
  const config: IntakeFormConfig = {
    display_name: 'Owner edit',
    form_definition: {
      form_definition_id: context.form_definition_id,
      fields,
    },
    submission_processing_rule: {
      target_kind: 'form_response',
      fields_to_include_in_target: [],
      fields_to_attach_as_metadata: [],
    },
    anti_spam: {
      honeypot_fields: [],
      rate_limit_per_ip: 1,
      require_proof_of_work: false,
      require_captcha: false,
    },
    required_visitor_fields: { email: 'optional' },
  };
  const submission: IntakeFormSubmissionInput = {
    fields: values as IntakeFormSubmissionInput['fields'],
    ...(typeof visitor.email === 'string' ? { visitor_email: visitor.email } : {}),
  };
  const failures = validateIntakeFormSubmission(submission, config).filter(
    (failure) => failure.code !== 'honeypot_filled',
  );
  if (failures.length > 0) {
    throw new FormResponseWorkingContentValidationError(
      failures.map((failure) => failure.detail).join('; '),
    );
  }
  return {
    values,
    visitor: typeof visitor.email === 'string' ? { email: visitor.email } : {},
  };
};
