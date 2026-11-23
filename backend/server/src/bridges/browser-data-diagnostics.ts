import { CSV_TRANSFORM_ARGUMENT_VARIANTS, isBrowserDataFailure, isBrowserNumericReport, type BrowserDataFailure, type BrowserDataStep, type BrowserDataTransform, type BrowserSourceIssue } from '@recued/contracts';
import { getTransformSchema } from '@recued/transforms';
import { IngredientError } from '@recued/ingredients';
import { browserDataError, browserDataShape } from './browser-data-store.js';
import { browserNumericSchema } from './browser-data-numeric.js';
import { browserDataField } from './browser-data-fields.js';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface BrowserQueryIssue {
  operation: number; transform: string; kind: 'field_not_observed' | 'array_equality'; field: string;
  input_fields: Array<{ name: string; types: string[] }>; fields_complete: boolean;
}

/** Positive facts about this operation's actual rows, never a replacement query.
 * Missing fields in sparse rows and intentional presence tests remain ordinary
 * transform semantics. No row contents or comparison values are copied. */
export const browserQueryIssues = (operation: number, transform: string, params: Record<string, unknown>): BrowserQueryIssue[] => {
  if (!['filter', 'find', 'partition'].includes(transform) || !Array.isArray(params.array)
    || !params.array.length || !params.array.every(record)) return [];
  const rows = params.array;
  const conditions = Array.isArray(params.conditions) ? params.conditions : [params];
  const shape = browserDataShape(rows), fields = shape.fields.slice(0, 8).map(field => ({ name: field.field, types: field.types.slice(0, 8) }));
  const issues: BrowserQueryIssue[] = [];
  for (const condition of conditions.slice(0, 40)) {
    if (!record(condition) || typeof condition.field !== 'string' || !condition.field || condition.field.length > 160) continue;
    if (['is_null', 'is_not_null', 'is_empty', 'is_not_empty'].includes(String(condition.operator))
      || ['equal', 'not_equal'].includes(String(condition.operator)) && condition.value == null) continue;
    const observed = rows.map(row => browserDataField(row, condition.field as string));
    const kind = observed.every(value => value === undefined) ? 'field_not_observed'
      : ['equal', 'not_equal'].includes(String(condition.operator)) && Array.isArray(condition.value)
        && observed.some(Array.isArray) ? 'array_equality' : undefined;
    if (kind) issues.push({ operation, transform, kind, field: condition.field,
      input_fields: fields, fields_complete: shape.fields_complete && fields.length === shape.fields.length });
    if (issues.length === 5) break; // The caller keeps four and marks truncation.
  }
  return issues;
};

/** Diagnose the failed operation using keys/types only. source_ref is the original capture;
 * input_fields describe this operation's input, which earlier pipeline steps may have shaped. */
export const browserDataFailureError = (error: unknown, at: {
  operation: number; transform: BrowserDataTransform; stage: BrowserDataFailure['stage']; source_ref: string; input: unknown;
  source_issues?: BrowserSourceIssue[]; source_issues_truncated?: true;
  repair_step?: BrowserDataStep;
}): IngredientError => {
  const shape = browserDataShape(at.input);
  const kind = at.transform.startsWith('table.') ? at.transform.slice(6) : '';
  const table = Object.hasOwn(CSV_TRANSFORM_ARGUMENT_VARIANTS, kind)
    ? CSV_TRANSFORM_ARGUMENT_VARIANTS[kind as keyof typeof CSV_TRANSFORM_ARGUMENT_VARIANTS] : undefined;
  const schema = browserNumericSchema(at.transform, getTransformSchema(at.transform));
  const definitions: Array<[string, { type?: unknown; required?: unknown }]> = table
    ? Object.entries(table.properties).filter(([name]) => name !== 'other_delimiter')
      .map(([name, definition]) => [name === 'other_source' ? 'other' : name,
        { type: name === 'other_source' ? 'object' : 'type' in definition ? definition.type : 'any', required: (table.required as readonly string[]).includes(name) }])
    : Object.entries(schema ?? {});
  const fields = shape.fields.filter(field => field.field.length > 0).slice(0, 12);
  const parameters = definitions.filter(([name]) => name.length <= 80).slice(0, 12);
  const failure: BrowserDataFailure = { operation: at.operation, transform: at.transform, stage: at.stage,
    source_ref: at.source_ref, input_kind: shape.kind, input_fields: fields.map(field => ({ name: field.field, types: field.types.slice(0, 8) })),
    fields_complete: shape.fields_complete && fields.length === shape.fields.length,
    parameters: parameters.map(([name, definition]) => ({ name, type: typeof definition.type === 'string' ? definition.type : 'any', required: definition.required === true })),
    parameters_complete: parameters.length === definitions.length, schema_step: { do: 'data', describe: [at.transform] },
    ...(at.repair_step ? { repair_step: at.repair_step } : {}) };
  if (record(error) && isBrowserNumericReport(error.browser_numeric_issue)) failure.numeric = error.browser_numeric_issue;
  if (at.source_issues?.length) failure.source_issues = at.source_issues;
  if (at.source_issues_truncated) failure.source_issues_truncated = true;
  const problem = record(error) && record(error.browser_data_problem) ? error.browser_data_problem : undefined;
  if (problem && ['undefined', 'non_finite', 'cycle', 'non_json', 'limit'].includes(String(problem.reason))) {
    failure.problem = problem.reason as NonNullable<BrowserDataFailure['problem']>;
    if (at.stage === 'output' && typeof problem.path === 'string' && problem.path.startsWith('$') && problem.path.length <= 256) {
      failure.output_path = problem.path;
      if (problem.path_truncated === true) failure.output_path_truncated = true;
    }
  }
  if (JSON.stringify(failure).length > 3_500) delete failure.repair_step;
  while (JSON.stringify(failure).length > 3_500 && failure.parameters.length) { failure.parameters.pop(); failure.parameters_complete = false; }
  while (JSON.stringify(failure).length > 3_500 && failure.input_fields.length) { failure.input_fields.pop(); failure.fields_complete = false; }
  const message = `operation ${at.operation} (${at.transform}, ${at.stage}): ${error instanceof Error ? error.message : 'failed'}`;
  const wrapped = error instanceof IngredientError ? new IngredientError(error.code, `Browser data ${message}`, error.details) : browserDataError(message);
  return isBrowserDataFailure(failure) ? Object.assign(wrapped, { browser_failure: { slug: 'dom-act', details: { data_failure: failure } } }) : wrapped;
};
