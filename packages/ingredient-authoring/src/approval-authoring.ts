import { META_FIELD_TYPES, ENTITY_FIELD_PRIVACY_KINDS, isMetaFieldType, isEntityFieldPrivacy, type ArgEditField } from '@recued/contracts';
import { resolveArgEditSchema } from './arg-edit-schema.js';
import { defaultReviewDetails, isSecretShapedKey, DEFAULT_REVIEW_FIELD_MAX } from './approval-review-details.js';

export interface ApprovalAuthoringField { key: string; type: 'string' | 'boolean' | 'number' | 'object' | 'array'; description: string; values?: readonly (string | boolean)[] }
type Field = Omit<ApprovalAuthoringField, 'key'>;
const fields: Record<keyof ArgEditField, Field> = {
  key: { type: 'string', description: 'The declared review/edit allowlist path. Existing argument completion and F12 use exact local names. Choose only fields safe to review and, on supported surfaces, edit. Explicit review fields may be shown in full; credentials belong in connections.' },
  type: { type: 'string', description: 'Canonical approval-field type. Recognized explicit types win over entity and schema defaults. Other legacy values are preserved; Explain Approval Fields shows local fallback and unresolved runtime facets.', values: META_FIELD_TYPES },
  label: { type: 'string', description: 'Visible field label, in the authored allowlist order. A missing label may come from the installed target or a humanized key.' },
  required: { type: 'boolean', description: 'Explicit field requiredness. Omission defers to target-field/schema defaults. This does not grant execution or editing authority.', values: [true, false] },
  privacy: { type: 'string', description: 'Explicit privacy facet from the shared contract. An omitted or unrecognized facet may come from an installed entity; it is unresolved in an offline source report.', values: ENTITY_FIELD_PRIVACY_KINDS },
  options_source: { type: 'string', description: 'Authored runtime picker-source name. The local editor does not discover installed picker options or infer their authority.' },
  affects_target: { type: 'boolean', description: 'Editing this field re-resolves the approved target. The shared resolver also forces this for known destination/connection keys. Choose explicitly; completion preserves the authored flag.', values: [true, false] },
  validation: { type: 'object', description: 'Authored numeric min/max and pattern constraints. An absent block may be lifted from the request schema. min/max are numeric bounds, not string-length limits; patterns are never evaluated by this report.' },
};
const validation: Record<keyof NonNullable<ArgEditField['validation']>, Field> = {
  min: { type: 'number', description: 'Minimum numeric value. This is not a string-length limit. The editor chooses no bound.' },
  max: { type: 'number', description: 'Maximum numeric value. This is not a string-length limit. The editor chooses no bound.' },
  pattern: { type: 'string', description: 'Authored pattern passed to runtime validation. Inspection never executes it. The existing runtime string ceiling remains separate.' },
};
export const approvalAuthoringFields = (section: 'operation' | 'field' | 'validation'): ApprovalAuthoringField[] => Object.entries(section === 'field' ? fields : section === 'validation' ? validation : {
  editable_args: { type: 'array', description: 'Explicit review/edit allowlist metadata. Labels and order are authored; schema-only display fallback does not make a field editable. Adding this changes the review surface and requires an author decision.' } satisfies Field,
}).map(([key, field]) => ({ key, ...field }));

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export interface ApprovalInspectionRow {
  index: number; path: (string | number)[]; key: string;
  mode: 'explicit_allowlist' | 'schema_display_candidate';
  local_resolution?: unknown; declared_type?: unknown;
  unresolved_target_facets?: string[]; unsupported_metadata_keys?: string[];
  ignored_duplicate?: boolean; value_visibility?: string; details_omitted?: boolean;
}
export interface ApprovalInspection {
  mode: 'explicit_allowlist' | 'schema_display_candidates' | 'no_declared_fields' | 'malformed' | 'limited';
  complete: boolean; fields: ApprovalInspectionRow[]; total_fields: number; notes: string[];
  display_limit: number; limitations: string;
}
const limitations = 'Local source metadata only; no held argument values, installed target facets, picker options, grants or actual edit permission are read. Schema display candidates are not an edit allowlist. Actual display depends on carried values and the approval surface. Run this inspection again after source changes.';
/** Reuses the runtime resolver with no installed entity lookup and synthetic presence only. */
export const inspectApprovalFields = (operation: unknown): ApprovalInspection => {
  const result: ApprovalInspection = { mode: 'no_declared_fields', complete: true, fields: [], total_fields: 0, notes: [], display_limit: DEFAULT_REVIEW_FIELD_MAX, limitations };
  if (!object(operation)) return { ...result, mode: 'malformed', complete: false, notes: ['Choose a unique operation declaration.'] };
  const entries = operation.editable_args;
  if (entries !== undefined && !Array.isArray(entries)) return { ...result, mode: 'malformed', complete: false, notes: ['editable_args is not an array; no edit or display coverage is inferred.'] };
  if (Array.isArray(entries) && entries.length > 100) return { ...result, mode: 'limited', complete: false, notes: ['Approval metadata exceeds 100 declarations.'] };
  if (Array.isArray(entries) && entries.length) {
    result.mode = 'explicit_allowlist'; const seen = new Set<string>();
    for (const [index, raw] of entries.entries()) {
      if (!object(raw) || typeof raw.key !== 'string' || !raw.key) { result.complete = false; result.notes.push('Malformed allowlist entry at index ' + index + ' is unresolved.'); continue; }
      if (seen.has(raw.key)) { result.fields.push({ index, path: ['editable_args', index], key: raw.key, mode: 'explicit_allowlist', ignored_duplicate: true }); continue; }
      seen.add(raw.key);
      const badValidation = raw.validation !== undefined && (!object(raw.validation) || Object.entries(raw.validation).some(([key, value]) =>
        ['min', 'max'].includes(key) ? typeof value !== 'number' || !Number.isFinite(value) : key === 'pattern' ? typeof value !== 'string' : false));
      if (raw.options_source !== undefined && typeof raw.options_source !== 'string' || badValidation) {
        result.complete = false; result.notes.push('Malformed picker/constraint metadata at index ' + index + ' is unresolved.');
        result.fields.push({ index, path: ['editable_args', index], key: raw.key, mode: 'explicit_allowlist', details_omitted: true }); continue;
      }
      const resolved = resolveArgEditSchema('local.inspection', {}, { lookupOperation: () => ({ editable_args: [raw as unknown as ArgEditField], request_schema: operation.request_schema }) }).fields[0];
      const unresolved = [
        ...(!isMetaFieldType(raw.type) ? ['type'] : []),
        ...(!isEntityFieldPrivacy(raw.privacy) ? ['privacy'] : []),
        ...(typeof raw.required !== 'boolean' ? ['required'] : []),
        ...(typeof raw.label !== 'string' || !raw.label ? ['label'] : []),
      ];
      // The local result intentionally omits arbitrary legacy values/defaults and malformed constraint blocks.
      const local = resolved ? { key: resolved.key, type: resolved.type, label: resolved.label, required: resolved.required, affects_target: resolved.affects_target,
        ...(resolved.privacy !== undefined ? { privacy: resolved.privacy } : {}), ...(typeof resolved.options_source === 'string' ? { options_source: resolved.options_source } : {}),
        ...(object(resolved.validation) ? { validation: {
          ...(typeof resolved.validation.min === 'number' ? { min: resolved.validation.min } : {}),
          ...(typeof resolved.validation.max === 'number' ? { max: resolved.validation.max } : {}),
          ...(typeof resolved.validation.pattern === 'string' ? { pattern: resolved.validation.pattern } : {}),
        } } : {}) } : undefined;
      result.fields.push({ index, path: ['editable_args', index], key: raw.key, mode: 'explicit_allowlist', local_resolution: local,
        ...(raw.type !== undefined ? { declared_type: typeof raw.type === 'string' ? raw.type : 'Unrecognized non-string metadata' } : {}),
        unresolved_target_facets: unresolved, unsupported_metadata_keys: [...Object.keys(raw).filter(key => !Object.hasOwn(fields, key)), ...(object(raw.validation) ? Object.keys(raw.validation).filter(key => !Object.hasOwn(validation, key)).map(key => 'validation.' + key) : [])],
        value_visibility: 'Explicit allowlist; no held value is inspected or redaction promised.' });
    }
    result.total_fields = result.fields.length; return result;
  }
  const schema = operation.request_schema, properties = object(schema) ? schema.properties : undefined;
  if (!object(properties)) return result;
  const keys = Object.keys(properties);
  if (keys.length > 100) return { ...result, mode: 'limited', complete: false, notes: ['Request schema exceeds 100 immediate display declarations.'] };
  result.mode = 'schema_display_candidates';
  for (const [index, key] of keys.entries()) {
    const projected = defaultReviewDetails(schema, { [key]: 'local presence marker' });
    const field = projected?.fields[0]; if (!field) continue;
    result.fields.push({ index, path: ['request_schema', 'properties', key], key, mode: 'schema_display_candidate', local_resolution: field,
      value_visibility: isSecretShapedKey(key) ? 'Name-based secret hiding in the schema display fallback.' : 'Display-only candidate; actual carried values are unknown.' });
  }
  result.total_fields = result.fields.length;
  result.notes.push('Only carried fields are displayed at runtime; zero or more than ' + DEFAULT_REVIEW_FIELD_MAX + ' carried review fields produces no summary block. Nothing becomes editable through this fallback.');
  return result;
};
