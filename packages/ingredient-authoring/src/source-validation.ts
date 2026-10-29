import { KITCHEN_DRAFT_SOURCE_MAX_BYTES } from '@recued/contracts';
import { validateComposition, validatePack, type CompositionValidationIssue } from './validators.js';

export type AuthoringSourceKind = 'recipe' | 'pack';
export interface AuthoringSourceValidation {
  valid: boolean;
  total_issues: number;
  issues: CompositionValidationIssue[];
}
export type AuthoringRecipeValidator = (input: unknown) => {
  valid: boolean;
  issues: readonly CompositionValidationIssue[];
};

/** Shared by Kitchen intake and offline editors. No dependency resolution or I/O. */
export const validateAuthoringSource = (
  kind: AuthoringSourceKind,
  source: string,
  recipeValidator: AuthoringRecipeValidator,
): AuthoringSourceValidation => {
  const refuse = (code: string, message: string): AuthoringSourceValidation => ({ valid: false, total_issues: 1,
    issues: [{ severity: 'error', code, path: '', message }] });
  if (new TextEncoder().encode(source).byteLength > KITCHEN_DRAFT_SOURCE_MAX_BYTES) {
    return refuse('source_too_large', `Source exceeds the ${KITCHEN_DRAFT_SOURCE_MAX_BYTES.toLocaleString('en-US')} byte authoring limit.`);
  }
  let body: unknown;
  try { body = JSON.parse(source); }
  catch { return refuse('invalid_json', 'Source must be valid JSON.'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return refuse('invalid_source', 'A recipe or pack source must be a JSON object.');
  }
  try {
    const result = kind === 'recipe' ? recipeValidator(body)
      : 'manifest_version' in body ? validatePack(body, { recipeValidator })
        : validateComposition(body, { recipeValidator });
    return { valid: result.valid, total_issues: result.issues.length, issues: result.issues.slice(0, 100).map(issue => {
      const bounded = { ...issue, code: issue.code.slice(0, 128), path: issue.path.slice(0, 512), message: issue.message.slice(0, 2048) };
      if (issue.path.length > 512) delete bounded.reference_span;
      return bounded;
    }) };
  } catch {
    return refuse('validation_failed', 'Source could not be validated. Simplify its structure and validate again.');
  }
};
