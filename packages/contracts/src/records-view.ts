/** Persistable owner browse settings. Page handles belong only to the reader. */
import { RECORDS_MAX_IN_ITEMS, RECORDS_MAX_PREDICATES, RECORDS_PREDICATES, type RecordsPredicate } from './records.js';

type Scalar = string | number | boolean | null;
export type RecordsViewFilter =
  | { op: Exclude<RecordsPredicate, 'in' | 'is_null'>; value: Exclude<Scalar, null> }
  | { op: 'in'; value: Scalar[] }
  | { op: 'is_null'; value: boolean };
export interface RecordsViewSettings {
  filters?: Record<string, RecordsViewFilter>;
  /** A friendly field, optionally prefixed with '-' for descending order. */
  sort?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && !value.includes('\0');
const fieldName = (value: unknown): value is string => string(value, 512)
  && value.trim().length > 0
  && !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
const scalar = (value: unknown): value is Scalar => value === null || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
  || string(value, 2000);

/** Validate shape without requiring the pack to remain installed. Sort keys so
 * field insertion order cannot make an unchanged saved view look modified. */
export const parseRecordsViewSettings = (value: unknown): RecordsViewSettings | null => {
  if (!object(value) || Object.keys(value).some(key => key !== 'filters' && key !== 'sort')) return null;
  const result: RecordsViewSettings = {};
  if (Object.hasOwn(value, 'filters')) {
    if (!object(value.filters) || Object.keys(value.filters).length > RECORDS_MAX_PREDICATES) return null;
    const entries: Array<[string, RecordsViewFilter]> = [];
    for (const [field, raw] of Object.entries(value.filters).sort(([a], [b]) => a.localeCompare(b))) {
      if (!fieldName(field) || field === 'id') return null;
      const filter = object(raw) ? raw : { op: 'eq', value: raw };
      const op = filter.op;
      if (Object.keys(filter).some(key => key !== 'op' && key !== 'value')
        || typeof op !== 'string' || !RECORDS_PREDICATES.some(predicate => predicate === op)) return null;
      if (op === 'is_null') {
        if (Object.hasOwn(filter, 'value') && typeof filter.value !== 'boolean') return null;
        entries.push([field, { op, value: filter.value !== false }]);
      } else if (op === 'in') {
        if (!Array.isArray(filter.value) || filter.value.length === 0
          || filter.value.length > RECORDS_MAX_IN_ITEMS || !Array.from(filter.value).every(scalar)) return null;
        entries.push([field, { op, value: [...filter.value] }]);
      } else {
        // SQL equality/inequality against NULL is not an IS [NOT] NULL test.
        // Require the explicit null predicate rather than changing membership.
        if (!scalar(filter.value) || filter.value === null) return null;
        entries.push([field, { op: op as Exclude<RecordsPredicate, 'in' | 'is_null'>, value: filter.value }]);
      }
    }
    if (entries.length) result.filters = Object.fromEntries(entries);
  }
  if (Object.hasOwn(value, 'sort')) {
    if (typeof value.sort !== 'string') return null;
    const field = value.sort.startsWith('-') ? value.sort.slice(1) : value.sort;
    if (!fieldName(field) || field.includes('-')) return null;
    if (value.sort !== 'id') result.sort = value.sort;
  }
  return result;
};
