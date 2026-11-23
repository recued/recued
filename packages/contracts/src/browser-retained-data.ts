import { BROWSER_DATA_REF } from './browser-data.js';
import { isBrowserSourceIssues, type BrowserSourceIssue } from './browser-source-issue.js';

/** Shape of an immutable retained snapshot, without its values or action inputs.
 * Completeness describes that dataset, which may be an element or partial capture. */
export interface BrowserRetainedData {
  data_ref: string;
  kind: 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null';
  row_count?: number;
  fields: Array<{ field: string; types: string[] }>;
  fields_complete: boolean;
  source_complete: boolean;
  value_omitted: true;
  source_issues?: BrowserSourceIssue[];
  source_issues_truncated?: true;
}
/** A completed read-only step can include its whole small value. This does not
 * change source coverage; large values remain references, never clipped rows. */
export interface BrowserCompletedData extends Omit<BrowserRetainedData, 'value_omitted'> {
  step: number;
  from: 'read' | 'table' | 'collection' | 'data';
  value_omitted: boolean;
  value?: unknown;
}
export const BROWSER_RETAINED_DATA_CHARS = 1_800;
export const BROWSER_COMPLETED_DATA_CHARS = 3_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['array', 'object', 'string', 'number', 'boolean', 'null'];
const jsonValue = (value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0 }): boolean => {
  if (depth > 24 || ++budget.nodes > 1_000) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.entries(value).every(([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && jsonValue(child, ancestors, depth + 1, budget));
  ancestors.delete(value);
  return valid;
};
const kind = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const valid = (value: unknown, completed: boolean): boolean => object(value)
  && Object.keys(value).every(key => ['data_ref', 'kind', 'row_count', 'fields', 'fields_complete', 'source_complete', 'value_omitted', 'source_issues', 'source_issues_truncated',
    ...(completed ? ['step', 'from', 'value'] : [])].includes(key))
  && typeof value.data_ref === 'string' && BROWSER_DATA_REF.test(value.data_ref) && typeof value.kind === 'string' && kinds.includes(value.kind)
  && (value.kind === 'array' ? Number.isSafeInteger(value.row_count) && Number(value.row_count) >= 0 && Number(value.row_count) <= 5_000 : value.row_count === undefined)
  && Array.isArray(value.fields) && value.fields.length <= 12 && value.fields.every(field => object(field)
    && Object.keys(field).every(key => ['field', 'types'].includes(key)) && typeof field.field === 'string' && field.field.length > 0 && field.field.length <= 160
    && Array.isArray(field.types) && field.types.length > 0 && field.types.length <= 6 && field.types.every(type => typeof type === 'string' && kinds.includes(type)))
  && typeof value.fields_complete === 'boolean' && typeof value.source_complete === 'boolean'
  && (value.value_omitted === true && !Object.hasOwn(value, 'value')
    || completed && value.value_omitted === false && Object.hasOwn(value, 'value') && jsonValue(value.value)
      && kind(value.value) === value.kind && (!Array.isArray(value.value) || value.value.length === value.row_count))
  && (value.source_issues === undefined || value.source_complete === false && isBrowserSourceIssues(value.source_issues))
  && (value.source_issues_truncated === undefined || value.source_issues_truncated === true && value.source_complete === false)
  && (!completed || Number.isSafeInteger(value.step) && Number(value.step) >= 1 && Number(value.step) <= 20
    && typeof value.from === 'string' && ['read', 'table', 'collection', 'data'].includes(value.from))
  && JSON.stringify(value).length <= BROWSER_RETAINED_DATA_CHARS;
export const isBrowserRetainedData = (value: unknown): value is BrowserRetainedData => valid(value, false);
export const isBrowserCompletedData = (value: unknown): value is BrowserCompletedData => valid(value, true);
