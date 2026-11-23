import { BROWSER_DATA_REF, BROWSER_DATA_TRANSFORMS, parseBrowserDataStep, type BrowserDataStep, type BrowserDataTransform } from './browser-data.js';
import { isBrowserNumericReport, type BrowserNumericReport } from './browser-numeric.js';
import { isBrowserSourceIssues, type BrowserSourceIssue } from './browser-source-issue.js';

/** Input shape and optional read-only plan suggestion. Never captured values
 * or an automatically executed repair. */
export interface BrowserDataFailure {
  operation: number;
  transform: BrowserDataTransform;
  stage: 'parameters' | 'execution' | 'output';
  source_ref: string;
  input_kind: string;
  input_fields: Array<{ name: string; types: string[] }>;
  fields_complete: boolean;
  parameters: Array<{ name: string; type: string; required: boolean }>;
  parameters_complete: boolean;
  schema_step: { do: 'data'; describe: [BrowserDataTransform] };
  repair_step?: BrowserDataStep;
  output_path?: string;
  output_path_truncated?: true;
  problem?: 'undefined' | 'non_finite' | 'cycle' | 'non_json' | 'limit';
  numeric?: BrowserNumericReport;
  source_issues?: BrowserSourceIssue[];
  source_issues_truncated?: true;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isBrowserDataFailure = (v: unknown): v is BrowserDataFailure => {
  if (!object(v) || !keys(v, ['operation', 'transform', 'stage', 'source_ref', 'input_kind', 'input_fields', 'fields_complete',
    'parameters', 'parameters_complete', 'schema_step', 'repair_step', 'output_path', 'output_path_truncated', 'problem', 'numeric', 'source_issues', 'source_issues_truncated'])) return false;
  return Number.isSafeInteger(v.operation) && Number(v.operation) >= 1 && Number(v.operation) <= 20
    && typeof v.transform === 'string' && (BROWSER_DATA_TRANSFORMS as readonly string[]).includes(v.transform)
    && ['parameters', 'execution', 'output'].includes(String(v.stage)) && typeof v.source_ref === 'string' && BROWSER_DATA_REF.test(v.source_ref)
    && text(v.input_kind, 16) && typeof v.fields_complete === 'boolean' && typeof v.parameters_complete === 'boolean'
    && Array.isArray(v.input_fields) && v.input_fields.length <= 12 && v.input_fields.every(field => object(field)
      && keys(field, ['name', 'types']) && text(field.name, 160) && Array.isArray(field.types) && field.types.length <= 8
      && field.types.every(type => text(type, 16)))
    && Array.isArray(v.parameters) && v.parameters.length <= 12 && v.parameters.every(param => object(param)
      && keys(param, ['name', 'type', 'required']) && text(param.name, 80) && text(param.type, 24) && typeof param.required === 'boolean')
    && object(v.schema_step) && keys(v.schema_step, ['do', 'describe']) && v.schema_step.do === 'data'
    && Array.isArray(v.schema_step.describe) && v.schema_step.describe.length === 1 && v.schema_step.describe[0] === v.transform
    && (v.repair_step === undefined || object(v.repair_step) && keys(v.repair_step, ['do', 'source', 'pipeline', 'return', 'select'])
      && v.repair_step.do === 'data' && v.repair_step.source === v.source_ref && Array.isArray(v.repair_step.pipeline)
      && parseBrowserDataStep(v.repair_step).ok && JSON.stringify(v.repair_step).length <= 2_000)
    && (v.output_path === undefined || text(v.output_path, 256) && v.output_path.startsWith('$'))
    && (v.output_path_truncated === undefined || v.output_path_truncated === true && v.output_path !== undefined)
    && (v.problem === undefined || ['undefined', 'non_finite', 'cycle', 'non_json', 'limit'].includes(String(v.problem)))
    && (v.numeric === undefined || isBrowserNumericReport(v.numeric))
    && (v.source_issues === undefined || isBrowserSourceIssues(v.source_issues))
    && (v.source_issues_truncated === undefined || v.source_issues_truncated === true && v.source_issues !== undefined)
    && JSON.stringify(v).length <= 4_000;
};
