/** Argument help for the CSV contract. Runtime parsing owns cross-field validation. */
import { CSV_TOOLKIT_LIMITS, CSV_TRANSFORM_OPERATIONS, CSV_PREDICATE_OPERATORS, CSV_COMPARISONS, CSV_MATCH_MODES,
  CSV_SCHEMA_MODES, CSV_JOIN_TYPES, CSV_DUPLICATE_MODES, CSV_AGGREGATION_OPERATIONS, CSV_EMPTY_NUMERIC_MODES,
  CSV_EXPRESSION_OPERATIONS, CSV_SORT_DIRECTIONS, CSV_SORT_EMPTY_MODES, CSV_KEEP_MODES, CSV_EMPTY_KEY_MODES, type CsvTransformInput } from './csv-toolkit.js';
const source = { type: 'string', description: 'Complete stored file_ref, including file:. Uploaded attachments are already stored; copy their reference exactly.' } as const;
const delimiter = { type: 'string', default: ',', description: 'One delimiter character; quote, newline and NUL are excluded.' } as const;
const column = { type: 'string', description: 'Exact CSV column name.' } as const;
const columns = { type: 'array', items: column, description: 'Exact CSV column names, without duplicates.' } as const;
export const CSV_INSPECT_ARGUMENTS = { type: 'object', additionalProperties: false, required: ['source'], properties: {
  source, delimiter, preview_rows: { type: 'integer', default: 5, minimum: 0, maximum: CSV_TOOLKIT_LIMITS.preview_rows, description: 'Maximum number of preview rows. Zero returns headers and counts only.' },
} } as const;
export const CSV_TRANSFORM_ARGUMENTS = { type: 'object', additionalProperties: false, required: ['source', 'operation'], properties: {
  source, delimiter, operation: { type: 'string', enum: CSV_TRANSFORM_OPERATIONS, description: 'Operation to perform. Its selection determines the remaining arguments.' },
} } as const;
const pair = { other_source: source, other_delimiter: delimiter };
const predicate = { type: 'object', required: ['column', 'operator'], properties: {
  column, operator: { type: 'string', enum: CSV_PREDICATE_OPERATORS },
  comparison: { type: 'string', enum: CSV_COMPARISONS, default: 'text' },
  value: { type: 'string', description: 'Required except for empty/not_empty, which take no value. Decimal comparison excludes contains, starts_with and empty predicates.' },
} };
const aggregation = { type: 'object', required: ['op', 'as'], properties: {
  op: { type: 'string', enum: CSV_AGGREGATION_OPERATIONS }, as: { type: 'string', description: 'Unique output column name.' },
  column: { ...column, description: 'Required for sum/avg/min/max. Count takes no column.' },
} };
const expression = { type: 'object', description: 'A column reference {column}, text literal {value}, or bounded expression. trim/lower/upper/replace take input; replace matches the complete cell using from/to. concat takes values and separator. Arithmetic takes left/right expressions; divide also takes scale (0..12, default 6). All references read the original row.', properties: {
  column, value: { type: 'string' }, op: { type: 'string', enum: CSV_EXPRESSION_OPERATIONS },
  input: { type: 'object' }, left: { type: 'object' }, right: { type: 'object' },
  values: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 16 },
  separator: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  scale: { type: 'integer', minimum: 0, maximum: 12, default: 6 },
} };
export const CSV_TRANSFORM_ARGUMENT_VARIANTS = {
  map: { required: ['mappings'], properties: {
    mappings: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['as', 'expression'], properties: {
      as: { type: 'string', description: 'Output column to replace or append. Each target must be unique.' }, expression,
    } } }, empty_numeric: { type: 'string', enum: ['error', 'blank'], default: 'error' },
  } },
  sort: { required: ['by'], properties: {
    by: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', required: ['column'], properties: {
      column, direction: { type: 'string', enum: CSV_SORT_DIRECTIONS, default: 'asc' },
      comparison: { type: 'string', enum: CSV_COMPARISONS, default: 'text' },
      empty: { type: 'string', enum: CSV_SORT_EMPTY_MODES, default: 'last' },
    } } }, offset: { type: 'integer', minimum: 0, maximum: CSV_TOOLKIT_LIMITS.rows, default: 0 },
    limit: { type: 'integer', minimum: 0, maximum: CSV_TOOLKIT_LIMITS.rows, default: CSV_TOOLKIT_LIMITS.rows },
  } },
  deduplicate: { required: [], properties: {
    keys: { ...columns, default: [], description: 'Omit or use [] to remove identical complete rows. Otherwise match these exact text keys.' },
    keep: { type: 'string', enum: CSV_KEEP_MODES, default: 'error', description: 'Identical duplicates collapse. Conflicting rows sharing a key fail unless first/last is explicit; order the input first to choose newest or highest.' },
    empty_keys: { type: 'string', enum: CSV_EMPTY_KEY_MODES, default: 'keep', description: 'For supplied keys: keep blank-key rows independently, reject them, or explicitly match them. Does not affect whole-row deduplication.' },
  } },
  filter: { required: ['conditions'], properties: { conditions: { type: 'array', items: predicate, minItems: 1, maxItems: 32 }, match: { type: 'string', enum: CSV_MATCH_MODES, default: 'all' } } },
  project: { required: ['columns'], properties: { columns, names: { ...columns, description: 'Optional output names, one per selected column. Omit or use an empty list to retain the source names.' } } },
  concat: { required: ['other_source'], properties: { ...pair, schema: { type: 'string', enum: CSV_SCHEMA_MODES, default: 'strict' } } },
  join: { required: ['other_source', 'left_keys', 'right_keys'], properties: { ...pair, left_keys: columns, right_keys: columns,
    join_type: { type: 'string', enum: CSV_JOIN_TYPES, default: 'left' }, duplicates: { type: 'string', enum: CSV_DUPLICATE_MODES, default: 'error' },
    right_prefix: { type: 'string', default: 'right_', description: 'Prefix for conflicting right-hand column names.' } } },
  diff: { required: ['other_source', 'keys'], properties: { ...pair, keys: columns, compare_columns: { ...columns, default: [] } } },
  aggregate: { required: ['aggregations'], properties: { group_by: { ...columns, default: [] }, aggregations: { type: 'array', items: aggregation, minItems: 1, maxItems: 32 },
    empty_numeric: { type: 'string', enum: CSV_EMPTY_NUMERIC_MODES, default: 'error' }, average_scale: { type: 'integer', minimum: 0, maximum: 12, default: 6 } } },
} as const satisfies Record<CsvTransformInput['operation'], { required: readonly string[]; properties: object }>;
