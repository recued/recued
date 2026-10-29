import { findUnstorableStrings } from './storable-encoding.js';

/** File-backed CSV operations. Field names and matching rules are supplied by the caller. */
export const CSV_TOOLKIT_LIMITS = {
  bytes: 32 * 1024 * 1024,
  rows: 250_000,
  columns: 256,
  cells: 2_000_000,
  cell_chars: 262_144,
  preview_rows: 20,
  preview_chars: 16_000,
} as const;

/** Shared runtime choices also drive offline argument help. */
export const CSV_TRANSFORM_OPERATIONS = ['filter', 'project', 'concat', 'join', 'diff', 'aggregate', 'map', 'sort', 'deduplicate'] as const;
export const CSV_PREDICATE_OPERATORS = ['eq', 'ne', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'] as const;
export const CSV_COMPARISONS = ['text', 'decimal'] as const;
export const CSV_MATCH_MODES = ['all', 'any'] as const;
export const CSV_SCHEMA_MODES = ['strict', 'union'] as const;
export const CSV_JOIN_TYPES = ['inner', 'left', 'full'] as const;
export const CSV_DUPLICATE_MODES = ['error', 'all'] as const;
export const CSV_AGGREGATION_OPERATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export const CSV_EMPTY_NUMERIC_MODES = ['error', 'skip'] as const;
export const CSV_EXPRESSION_OPERATIONS = ['trim', 'lower', 'upper', 'replace', 'concat', 'add', 'subtract', 'multiply', 'divide'] as const;
export const CSV_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const CSV_SORT_EMPTY_MODES = ['first', 'last', 'error'] as const;
export const CSV_KEEP_MODES = ['error', 'first', 'last'] as const;
export const CSV_EMPTY_KEY_MODES = ['keep', 'error', 'match'] as const;

export type CsvExpression =
  | { column: string }
  | { value: string }
  | { op: 'trim' | 'lower' | 'upper'; input: CsvExpression }
  | { op: 'replace'; input: CsvExpression; from: string; to: string }
  | { op: 'concat'; values: CsvExpression[]; separator: string }
  | { op: 'add' | 'subtract' | 'multiply'; left: CsvExpression; right: CsvExpression }
  | { op: 'divide'; left: CsvExpression; right: CsvExpression; scale: number };
export interface CsvMapping { as: string; expression: CsvExpression }
export interface CsvSortKey {
  column: string; direction: 'asc' | 'desc'; comparison: 'text' | 'decimal'; empty: 'first' | 'last' | 'error';
}

export interface CsvInspectInput {
  source: string;
  delimiter: string;
  preview_rows: number;
}
export type CsvPredicateOperator = 'eq' | 'ne' | 'contains' | 'starts_with' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty';
export interface CsvPredicate {
  column: string;
  operator: CsvPredicateOperator;
  value?: string;
  comparison: 'text' | 'decimal';
}
export interface CsvAggregation {
  op: 'count' | 'sum' | 'avg' | 'min' | 'max';
  column?: string;
  as: string;
}
interface CsvSourceInput { source: string; delimiter: string }
interface CsvPairInput { other_source: string; other_delimiter: string }
export type CsvTransformInput = CsvSourceInput & (
  | { operation: 'filter'; conditions: CsvPredicate[]; match: 'all' | 'any' }
  | { operation: 'project'; columns: string[]; names: string[] }
  | (CsvPairInput & { operation: 'concat'; schema: 'strict' | 'union' })
  | (CsvPairInput & { operation: 'join'; left_keys: string[]; right_keys: string[]; join_type: 'inner' | 'left' | 'full'; duplicates: 'error' | 'all'; right_prefix: string })
  | (CsvPairInput & { operation: 'diff'; keys: string[]; compare_columns: string[] })
  | { operation: 'aggregate'; group_by: string[]; aggregations: CsvAggregation[]; empty_numeric: 'error' | 'skip'; average_scale: number }
  | { operation: 'map'; mappings: CsvMapping[]; empty_numeric: 'error' | 'blank' }
  | { operation: 'sort'; by: CsvSortKey[]; offset: number; limit: number }
  | { operation: 'deduplicate'; keys: string[]; keep: 'error' | 'first' | 'last'; empty_keys: 'keep' | 'error' | 'match' }
);

export interface CsvSourceReceipt { file_ref: string; content_hash: string; rows: number; bytes: number }
export interface CsvTableSummary {
  columns: string[];
  rows: number;
  preview: string[][];
  /** A sample, never a claim that all rows were returned. */
  preview_truncated: boolean;
}
export interface CsvInspectResult extends CsvTableSummary {
  source: CsvSourceReceipt;
  empty_cells: number[];
}
export interface CsvTransformResult extends CsvTableSummary {
  operation: CsvTransformInput['operation'];
  file_ref: string;
  record_id: string;
  filename: string;
  mime_type: 'text/csv';
  content_hash: string;
  bytes: number;
  /** Exact-file descriptor aliases used by the existing file artifact renderer. */
  sha256: string;
  size_bytes: number;
  generated_at: number;
  sources: CsvSourceReceipt[];
  counts: Record<string, number>;
  notes: string[];
}

const bad = (message: string): never => { throw new Error(`CSV Toolkit: ${message}`); };
const object = (v: unknown, label: string): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${label} must be an object`);
const only = (o: Record<string, unknown>, keys: string[]): void => {
  const extra = Object.keys(o).find(k => !keys.includes(k));
  if (extra) bad(`unknown argument ${extra}`);
};
const text = (v: unknown, label: string, max = 512): string => {
  if (typeof v !== 'string' || !v.length || v.length > max) return bad(`${label} must be nonempty text (at most ${max} characters)`);
  if (findUnstorableStrings(v, { limit: 1 }).length) return bad(`${label} must contain valid Unicode without NUL`);
  return v;
};
const file = (v: unknown, label: string): string => {
  const value = text(v, label, 4096);
  return value.startsWith('file:') ? value : bad(`${label} must be the complete stored file_ref, including its file: prefix. Copy it exactly from the attachment or tool result. An uploaded attachment is already stored; do not search for a persistence tool.`);
};
const delimiter = (v: unknown): string => v === undefined ? ','
  : typeof v === 'string' && v.length === 1 && !['"', '\r', '\n'].includes(v) && !findUnstorableStrings(v, { limit: 1 }).length
    ? v : bad('delimiter must be one valid Unicode character other than quote, newline or NUL');
const choice = <T extends string>(v: unknown, values: readonly T[], fallback?: T): T => {
  if (v === undefined && fallback !== undefined) return fallback;
  return typeof v === 'string' && values.includes(v as T) ? v as T : bad(`expected one of ${values.join(', ')}`);
};
const integer = (v: unknown, fallback: number, min: number, max: number, label: string): number => {
  const n = v === undefined ? fallback : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max ? n : bad(`${label} must be a whole number from ${min} to ${max}`);
};
const list = (v: unknown, label: string, allowEmpty = false): string[] => {
  if (!Array.isArray(v) || v.length > CSV_TOOLKIT_LIMITS.columns || (!allowEmpty && v.length === 0)) return bad(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array of column names`);
  const values = v.map(x => text(x, label));
  if (new Set(values).size !== values.length) bad(`${label} contains duplicate names`);
  return values;
};

const literal = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || v.length > 4096 || findUnstorableStrings(v, { limit: 1 }).length) return bad(`${label} must be valid text of at most 4096 characters`);
  return v;
};
const expression = (raw: unknown, budget: { nodes: number }, depth = 0): CsvExpression => {
  if (++budget.nodes > 128 || depth > 8) return bad('mapping expressions exceed 128 total nodes or 8 nested levels');
  const e = object(raw, 'expression');
  const child = (v: unknown) => expression(v, budget, depth + 1);
  if (Object.hasOwn(e, 'column')) { only(e, ['column']); return { column: text(e.column, 'column') }; }
  if (Object.hasOwn(e, 'value')) { only(e, ['value']); return { value: literal(e.value, 'value') }; }
  const op = choice(e.op, CSV_EXPRESSION_OPERATIONS);
  switch (op) {
    case 'trim': case 'lower': case 'upper':
      only(e, ['op', 'input']); return { op, input: child(e.input) };
    case 'replace':
      only(e, ['op', 'input', 'from', 'to']);
      return { op, input: child(e.input), from: literal(e.from, 'from'), to: literal(e.to, 'to') };
    case 'concat':
      only(e, ['op', 'values', 'separator']);
      if (!Array.isArray(e.values) || !e.values.length || e.values.length > 16) return bad('concat expressions need 1 to 16 values');
      return { op, values: e.values.map(child), separator: literal(e.separator ?? '', 'separator') };
    case 'add': case 'subtract': case 'multiply':
      only(e, ['op', 'left', 'right']); return { op, left: child(e.left), right: child(e.right) };
    case 'divide':
      only(e, ['op', 'left', 'right', 'scale']);
      return { op, left: child(e.left), right: child(e.right), scale: integer(e.scale, 6, 0, 12, 'scale') };
  }
};

export const parseCsvInspectInput = (raw: unknown): CsvInspectInput => {
  const o = object(raw, 'arguments'); only(o, ['source', 'delimiter', 'preview_rows']);
  return { source: file(o.source, 'source'), delimiter: delimiter(o.delimiter),
    preview_rows: integer(o.preview_rows, 5, 0, CSV_TOOLKIT_LIMITS.preview_rows, 'preview_rows') };
};

/** Closed runtime validation also protects direct kernel calls, not only recipe variables. */
export const parseCsvTransformInput = (raw: unknown): CsvTransformInput => {
  const o = object(raw, 'arguments');
  const operation = choice(o.operation, CSV_TRANSFORM_OPERATIONS);
  const base = { source: file(o.source, 'source'), delimiter: delimiter(o.delimiter) };
  const common = ['source', 'delimiter', 'operation'];
  const pairKeys = ['other_source', 'other_delimiter'];
  const pair = () => ({ other_source: file(o.other_source, 'other_source'), other_delimiter: delimiter(o.other_delimiter) });
  switch (operation) {
    case 'map': {
      only(o, [...common, 'mappings', 'empty_numeric']);
      if (!Array.isArray(o.mappings) || !o.mappings.length || o.mappings.length > 32) return bad('mappings must contain 1 to 32 expressions');
      const budget = { nodes: 0 };
      const mappings = o.mappings.map((raw): CsvMapping => {
        const m = object(raw, 'mapping'); only(m, ['as', 'expression']);
        return { as: text(m.as, 'as'), expression: expression(m.expression, budget) };
      });
      list(mappings.map(m => m.as), 'mapping names');
      return { ...base, operation, mappings, empty_numeric: choice(o.empty_numeric, ['error', 'blank'] as const, 'error') };
    }
    case 'sort': {
      only(o, [...common, 'by', 'offset', 'limit']);
      if (!Array.isArray(o.by) || !o.by.length || o.by.length > 16) return bad('by must contain 1 to 16 sort keys');
      const by = o.by.map((raw): CsvSortKey => {
        const k = object(raw, 'sort key'); only(k, ['column', 'direction', 'comparison', 'empty']);
        return { column: text(k.column, 'column'), direction: choice(k.direction, CSV_SORT_DIRECTIONS, 'asc'),
          comparison: choice(k.comparison, CSV_COMPARISONS, 'text'), empty: choice(k.empty, CSV_SORT_EMPTY_MODES, 'last') };
      });
      list(by.map(k => k.column), 'sort keys');
      return { ...base, operation, by, offset: integer(o.offset, 0, 0, CSV_TOOLKIT_LIMITS.rows, 'offset'),
        limit: integer(o.limit, CSV_TOOLKIT_LIMITS.rows, 0, CSV_TOOLKIT_LIMITS.rows, 'limit') };
    }
    case 'deduplicate':
      only(o, [...common, 'keys', 'keep', 'empty_keys']);
      return { ...base, operation, keys: list(o.keys ?? [], 'keys', true), keep: choice(o.keep, CSV_KEEP_MODES, 'error'),
        empty_keys: choice(o.empty_keys, CSV_EMPTY_KEY_MODES, 'keep') };
    case 'filter': {
      only(o, [...common, 'conditions', 'match']);
      if (!Array.isArray(o.conditions) || !o.conditions.length || o.conditions.length > 32) return bad('conditions must contain 1 to 32 predicates');
      const conditions = o.conditions.map((raw): CsvPredicate => {
        const c = object(raw, 'condition'); only(c, ['column', 'operator', 'value', 'comparison']);
        const operator = choice(c.operator, CSV_PREDICATE_OPERATORS);
        const comparison = choice(c.comparison, CSV_COMPARISONS, 'text');
        const unary = operator === 'empty' || operator === 'not_empty';
        if (!unary && (typeof c.value !== 'string' || c.value.length > 4096)) return bad('condition value must be text, at most 4096 characters');
        if (unary && c.value !== undefined) return bad('empty/not_empty take no value');
        if (comparison === 'decimal' && (unary || operator === 'contains' || operator === 'starts_with')) return bad('decimal comparison supports eq, ne, gt, gte, lt and lte');
        return { column: text(c.column, 'column'), operator, comparison, ...(!unary ? { value: c.value as string } : {}) };
      });
      return { ...base, operation, conditions, match: choice(o.match, CSV_MATCH_MODES, 'all') };
    }
    case 'project': {
      only(o, [...common, 'columns', 'names']);
      const columns = list(o.columns, 'columns');
      const names = o.names === undefined || (Array.isArray(o.names) && !o.names.length) ? columns : list(o.names, 'names');
      if (names.length !== columns.length) bad('names must have one output name per selected column');
      return { ...base, operation, columns, names };
    }
    case 'concat':
      only(o, [...common, ...pairKeys, 'schema']);
      return { ...base, ...pair(), operation, schema: choice(o.schema, CSV_SCHEMA_MODES, 'strict') };
    case 'join': {
      only(o, [...common, ...pairKeys, 'left_keys', 'right_keys', 'join_type', 'duplicates', 'right_prefix']);
      const left_keys = list(o.left_keys, 'left_keys'), right_keys = list(o.right_keys, 'right_keys');
      if (left_keys.length !== right_keys.length) bad('left_keys and right_keys must have equal length');
      return { ...base, ...pair(), operation, left_keys, right_keys,
        join_type: choice(o.join_type, CSV_JOIN_TYPES, 'left'),
        duplicates: choice(o.duplicates, CSV_DUPLICATE_MODES, 'error'), right_prefix: text(o.right_prefix ?? 'right_', 'right_prefix', 64) };
    }
    case 'diff':
      only(o, [...common, ...pairKeys, 'keys', 'compare_columns']);
      return { ...base, ...pair(), operation, keys: list(o.keys, 'keys'), compare_columns: list(o.compare_columns ?? [], 'compare_columns', true) };
    case 'aggregate': {
      only(o, [...common, 'group_by', 'aggregations', 'empty_numeric', 'average_scale']);
      if (!Array.isArray(o.aggregations) || !o.aggregations.length || o.aggregations.length > 32) return bad('aggregations must contain 1 to 32 measures');
      const aggregations = o.aggregations.map((raw): CsvAggregation => {
        const a = object(raw, 'aggregation'); only(a, ['op', 'column', 'as']);
        const op = choice(a.op, CSV_AGGREGATION_OPERATIONS);
        if (op === 'count' && a.column !== undefined) return bad('count counts rows and takes no column');
        return { op, as: text(a.as, 'as'), ...(op !== 'count' ? { column: text(a.column, 'column') } : {}) };
      });
      const group_by = list(o.group_by ?? [], 'group_by', true);
      list([...group_by, ...aggregations.map(a => a.as)], 'output columns');
      return { ...base, operation, group_by, aggregations,
        empty_numeric: choice(o.empty_numeric, CSV_EMPTY_NUMERIC_MODES, 'error'),
        average_scale: integer(o.average_scale, 6, 0, 12, 'average_scale') };
    }
  }
};
