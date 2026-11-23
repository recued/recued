import { browserItemReferences } from './browser-item-path.js';

/** Server-side operations over retained browser data. No new Bridge command or
 * model tool: these are read-only steps in core.dom.act. */
export const BROWSER_DATA_TRANSFORMS = [
  'filter', 'sort', 'map', 'project', 'reduce', 'unique', 'flatten', 'slice', 'chunk', 'group_by', 'enrich_by', 'to_list', 'partition',
  'merge', 'prefix_keys', 'pick', 'omit', 'rename', 'set', 'json_byte_length', 'json_stringify', 'json_parse', 'csv_parse',
  'utf8_byte_length', 'sha256', 'lowercase', 'uppercase', 'trim', 'string_length', 'split', 'contains_any', 'concat', 'replace',
  'template', 'truncate', 'strip_html', 'encode_base64', 'decode_base64', 'round', 'clamp', 'to_number', 'math', 'decimal_math',
  'weighted_score', 'date_diff', 'date_format', 'date_add', 'date_parse', 'is_past', 'is_future', 'date_period', 'to_recent_date',
  'event_when', 'date_from_text', 'compare', 'coalesce', 'switch', 'all', 'any', 'count', 'default', 'defaults', 'not', 'ternary',
  'pluralize', 'to_checklist', 'to_table', 'to_summary', 'to_csv', 'starts_with', 'ends_with', 'find', 'pluck', 'sum', 'min_by',
  'max_by', 'percent', 'join',
  'table.filter', 'table.project', 'table.concat', 'table.join', 'table.diff', 'table.aggregate', 'table.map', 'table.sort', 'table.deduplicate',
] as const;
export type BrowserDataTransform = typeof BROWSER_DATA_TRANSFORMS[number];
/** Read-only discovery for a rejected plan. Carries names, never a repaired execution. */
export interface BrowserDataSchemaStep { do: 'data'; describe: BrowserDataTransform[] }
export const isBrowserDataSchemaStep = (value: unknown): value is BrowserDataSchemaStep => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return Object.keys(step).every(key => ['do', 'describe'].includes(key)) && step.do === 'data'
    && Array.isArray(step.describe) && step.describe.length <= 6 && new Set(step.describe).size === step.describe.length
    && step.describe.every(name => typeof name === 'string' && (BROWSER_DATA_TRANSFORMS as readonly string[]).includes(name));
};
export const BROWSER_DATA_MAX_OPERATIONS = 20;
export const BROWSER_DATA_MAX_PLAN_CHARS = 20_000;
export const BROWSER_DATA_REF = /^data:[a-f0-9-]{36}$/;
export interface BrowserDataOperation {
  readonly transform: BrowserDataTransform;
  readonly id?: string;
  readonly [parameter: string]: unknown;
}
export type BrowserDataStep = {
  readonly do: 'data';
  /** latest or absent: latest data-producing step in this call. A returned data_ref may
   * be reused by the same authenticated caller in a later call. */
  readonly source?: string;
  readonly pipeline?: readonly BrowserDataOperation[];
  /** Operation names whose parameter schemas should be returned, or [] for
   * the compact available-name list. Never runs a pipeline. */
  readonly describe?: readonly BrowserDataTransform[];
  /** Named pipeline outputs. Absent: last operation's value. */
  readonly return?: readonly string[];
  /** Project columns from the final object or array of objects. */
  readonly select?: readonly string[];
};

/** Browser expressions are data templates, never JavaScript. Keep this parser
 * shared with the model-call guard so accepted local references reach execution. */
export const browserDataExpressionError = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const references = browserItemReferences(value);
    const hasItem = (references?.length ?? 0) > 0;
    if (/\bitem(?:\.[A-Za-z0-9_]+)+\s*\(|=>/.test(value)
      || hasItem && (/\}\}\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(value)
        || /\b(?:parseInt|parseFloat|Number|String|Boolean)\s*\(|\b(?:Math|JSON)\s*\.\s*\w+\s*\(/.test(value)))
      return 'JavaScript methods/functions are not supported; use map.apply:"replace", "split" or "to_number" with field and output_field. Return an existing count/last aggregate directly when it already answers the question';
    if (!references) return 'expression templates use bounded item paths only: {{item.field}} or {{item["Student Name"]}} for an exact key. Array indexes use dots: {{item.parts.0}}, never {{item.parts[0]}}. Function calls and prototype keys are forbidden. Arithmetic goes outside braces. Use field/select for column names; data.describe returns schemas';
    if (hasItem && /^\s*\{\s*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z_$][\w$]*)\s*:/.test(value))
      return 'expression is quoted object text and would return a string. Use an actual JSON object, e.g. expression:{"name":"{{item.name}}","count":"{{item.count}}"}, to preserve value types. Use select for columns, or return the existing aggregate directly; json_stringify explicitly produces JSON text';
  } else if (Array.isArray(value)) {
    for (const child of value) { const error = browserDataExpressionError(child); if (error) return error; }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) { const error = browserDataExpressionError(child); if (error) return error; }
  }
  return;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const operation = (value: unknown): value is BrowserDataTransform => typeof value === 'string'
  && (BROWSER_DATA_TRANSFORMS as readonly string[]).includes(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(value)
  && !['input', '__proto__', 'constructor', 'prototype'].includes(value);
const safeValue = (value: unknown, depth = 0): boolean => depth <= 20 && (value === null || typeof value === 'boolean'
  || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
  || Array.isArray(value) && value.every(child => safeValue(child, depth + 1))
  || record(value) && Object.entries(value).every(([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key)
    && safeValue(child, depth + 1)));

export const parseBrowserDataStep = (value: Record<string, unknown>): { ok: true; step: BrowserDataStep } | { ok: false; error: string } => {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!safeValue(value) || JSON.stringify(value).length > BROWSER_DATA_MAX_PLAN_CHARS) return fail('data: plan exceeds its JSON, depth or character bound');
  if (value.describe !== undefined) {
    if (value.source !== undefined || value.pipeline !== undefined || value.return !== undefined || value.select !== undefined) return fail('data: describe cannot be combined with source, pipeline, return or select');
    if (!Array.isArray(value.describe) || value.describe.length > 6 || !value.describe.every(operation)) return fail('data: describe is a list of up to six available transform names; [] lists names');
    return { ok: true, step: { do: 'data', describe: value.describe } };
  }
  if (value.source !== undefined && value.source !== 'latest' && (typeof value.source !== 'string' || !BROWSER_DATA_REF.test(value.source))) return fail('data: source must be an exact returned data_ref or latest for the newest data in this call');
  if (!Array.isArray(value.pipeline) || !value.pipeline.length || value.pipeline.length > BROWSER_DATA_MAX_OPERATIONS) return fail(`data: pipeline needs 1-${BROWSER_DATA_MAX_OPERATIONS} transform objects`);
  const named = new Set<string>();
  const pipeline: BrowserDataOperation[] = [];
  for (const [n, item] of value.pipeline.entries()) {
    if (!record(item) || !operation(item.transform)) return fail(`data: operation ${n + 1} needs an available transform name; use {"do":"data","describe":[]} for names`);
    if (item.id !== undefined && (!id(item.id) || named.has(item.id))) return fail(`data: operation ${n + 1} has an invalid or duplicate id`);
    if (typeof item.id === 'string') named.add(item.id);
    if (item.apply !== undefined && !operation(item.apply)) return fail(`data: operation ${n + 1} apply must name an available pure transform`);
    if (item.transform === 'map' || item.transform === 'project') {
      const error = browserDataExpressionError(item.expression);
      if (error) return fail(`data: operation ${n + 1}: ${error}`);
    }
    pipeline.push({ ...item, transform: item.transform, ...(typeof item.id === 'string' ? { id: item.id } : {}) });
  }
  if (value.return !== undefined && (!Array.isArray(value.return) || !value.return.length || value.return.length > 10
    || !value.return.every(name => typeof name === 'string' && named.has(name)))) return fail('data: return selects named operation IDs, not columns. Omit return for the final result; use select:["title","price"] for columns, or add id to operations and return those IDs');
  if (value.select !== undefined && (value.return !== undefined || !Array.isArray(value.select) || !value.select.length || value.select.length > 32
    || new Set(value.select).size !== value.select.length || !value.select.every(field => typeof field === 'string' && field.length > 0 && field.length <= 160
      && !['__proto__', 'constructor', 'prototype'].includes(field)))) return fail('data: select names 1-32 unique final-result columns; it cannot be combined with return');
  return { ok: true, step: { do: 'data', pipeline,
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(Array.isArray(value.return) ? { return: value.return as string[] } : {}),
    ...(Array.isArray(value.select) ? { select: value.select as string[] } : {}) } };
};
