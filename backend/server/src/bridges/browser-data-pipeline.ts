import { BROWSER_DATA_TRANSFORMS, browserDataExpressionError, CSV_TRANSFORM_ARGUMENT_VARIANTS, CSV_TRANSFORM_OPERATIONS, OPS, parseCsvTransformInput, isBrowserDataSchemaStep,
  type BrowserDataSchemaStep, type BrowserDataStep, type BrowserNumericReport, type CsvTransformInput, type NamespaceStores } from '@recued/contracts';
import { getTransform, getTransformSchema, applyValueParam, getField, type TransformSchema } from '@recued/transforms';
import { operateCsvTable, type CsvTable } from '@recued/transforms/csv-toolkit.js';
import { createTransformContext } from '@recued/engine';
import { browserDataHint } from './browser-data-hints.js';
import { browserDataFailureError, browserQueryIssues, type BrowserQueryIssue } from './browser-data-diagnostics.js';
import { prepareBrowserQuotedExpression } from './browser-data-expressions.js';
import { browserDataFieldParams } from './browser-data-fields.js';
import { createBrowserDataFlow } from './browser-data-flow.js';
import { browserNumericSchema, executeBrowserNumeric, validateBrowserNumeric } from './browser-data-numeric.js';
import { BROWSER_DATA_LIMITS, browserDataError, browserDataJson, browserDataSourceIssues,
  type BrowserDataStore, type BrowserDataValue } from './browser-data-store.js';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const allowed = new Set<string>(BROWSER_DATA_TRANSFORMS);
const dataRef = (v: unknown): v is { data_ref: string } => record(v) && Object.keys(v).length === 1 && typeof v.data_ref === 'string';
const tableKind = (name: string): CsvTransformInput['operation'] | undefined => {
  const kind = name.startsWith('table.') ? name.slice(6) : '';
  return CSV_TRANSFORM_OPERATIONS.find(op => op === kind);
};
const operationSchema = (name: string): TransformSchema | undefined => browserNumericSchema(name, getTransformSchema(name));
export const browserDataValidationSchema = (error: unknown): BrowserDataSchemaStep | undefined => record(error)
  && isBrowserDataSchemaStep(error.browser_data_schema_step) ? error.browser_data_schema_step : undefined;
// map.apply deliberately excludes collection/object transforms because its
// per-item `field` would collide with their own field parameter. A whole-data
// pipeline has no such collision: use the schema's existing container slot.
const dataInputParam = (name: string): string | undefined => {
  const schema = operationSchema(name) ?? {};
  return [applyValueParam(name), 'array', 'source', 'object', 'date', 'event', 'values', 'value', 'count']
    .find(key => Object.hasOwn(schema, key));
};
const checkParams = (name: string, params: Record<string, unknown>, runtime: boolean): void => {
  const schema = operationSchema(name);
  if (!schema) throw browserDataError(`no registered schema for ${name}`);
  const apply = name === 'map' && typeof params.apply === 'string' ? operationSchema(params.apply) : undefined;
  const accepted = new Set([...Object.keys(schema), ...Object.keys(apply ?? {})]);
  for (const key of Object.keys(params)) if (!accepted.has(key)) throw browserDataError(`${name} does not take ${key}; use data.describe for its parameters`);
  for (const [key, def] of Object.entries(schema)) {
    const value = params[key];
    const injected = key === dataInputParam(name);
    if (value === undefined) {
      if (def.required && (runtime || !injected)) throw browserDataError(`${name} requires ${key}`);
      continue;
    }
    if (!runtime && (typeof value === 'string' && /^\$[a-zA-Z]/.test(value) || dataRef(value))) continue;
    const valid = def.type === 'any' || def.type === undefined || def.type === 'array' && Array.isArray(value)
      || def.type === 'object' && record(value) || def.type !== 'array' && def.type !== 'object' && typeof value === def.type;
    if (!valid || def.enum && !def.enum.includes(String(value))) throw browserDataError(`${name}.${key} has the wrong type or choice; use data.describe`);
  }
  if (name === 'filter' || name === 'find' || name === 'partition') {
    const conditions = Array.isArray(params.conditions) ? params.conditions : [params];
    if (!conditions.length || conditions.length > 40 || conditions.some(c => !record(c) || typeof c.field !== 'string'
      || !OPS.has(c.operator as never))) throw browserDataError(`${name} needs field/operator/value or valid conditions`);
  }
  if (name === 'map' && params.expression === undefined && params.apply === undefined) throw browserDataError('map needs expression or apply');
  if (name === 'map' && params.expression !== undefined && params.apply !== undefined) throw browserDataError('map chooses expression or apply, not both');
  if (name === 'map' && typeof params.apply === 'string') {
    if (typeof params.output_field !== 'string' || !params.output_field.trim()) throw browserDataError('map.apply requires output_field for each computed value');
    if (!apply || !Object.hasOwn(apply, applyValueParam(params.apply))) throw browserDataError(`map.apply cannot receive an item for ${params.apply}; use {transform:"${params.apply}",...} as a separate pipeline operation. Scalar apply targets include split, replace (literal), trim and to_number; describe returns their parameters`);
    const { array: _array, apply: _apply, output_field: _output, field: _field, ...child } = params;
    checkParams(params.apply, child, false);
  }
  validateBrowserNumeric(name, params);
  if (name === 'flatten' && params.depth !== undefined && (!Number.isSafeInteger(params.depth) || Number(params.depth) < 0 || Number(params.depth) > 16))
    throw browserDataError('flatten.depth must be 0-16');
  if ((name === 'chunk' && (Number(params.size) < 1 || !Number.isSafeInteger(params.size)))
    || name === 'slice' && [params.start, params.end].some(n => n !== undefined && !Number.isSafeInteger(n))) throw browserDataError(`${name} needs bounded integer positions`);
  if (name === 'group_by' && params.aggregate !== undefined && (!record(params.aggregate)
    || Object.values(params.aggregate).some(v => !record(v) || !['count', 'sum', 'avg', 'min', 'max', 'first', 'last'].includes(String(v.operator))
      || v.field !== undefined && typeof v.field !== 'string' || Object.keys(v).some(key => !['operator', 'field'].includes(key)))))
    throw browserDataError('group_by.aggregate names output fields with {operator:count/sum/avg/min/max/first/last,field?}; first/last preserve input order and can return a whole row');
};

/** Static validation is invoked before any browser effect in the batch. Values
 * that depend on a read are validated again after local reference resolution. */
export const validateBrowserDataStep = (step: BrowserDataStep, access?: { store: BrowserDataStore; scope: string }): void => {
  const source = step.source && step.source !== 'latest' && access ? access.store.read(access.scope, step.source) : undefined;
  const flow = createBrowserDataFlow(source?.descriptor.kind);
  const seen = new Set(['input']);
  for (const op of step.pipeline ?? []) {
    try {
      const { id, transform, ...params } = op;
      if (transform === 'map' || transform === 'project') {
        const error = browserDataExpressionError(params.expression);
        if (error) throw browserDataError(error);
        prepareBrowserQuotedExpression(params.expression);
      }
      const references = (value: unknown): void => {
        if (typeof value === 'string') {
          const ref = /^\$([a-zA-Z][a-zA-Z0-9_]*)(?:\.[a-zA-Z0-9_.]+)?$/.exec(value);
          if (ref && !seen.has(ref[1]!)) throw browserDataError('pipeline references must name input or an earlier operation id in this same pipeline. IDs do not cross data steps; use exact data_ref snapshots with table.concat.other when combining tables');
        } else if (dataRef(value) && access) access.store.read(access.scope, value.data_ref);
        else if (Array.isArray(value)) value.forEach(references);
        else if (record(value)) Object.values(value).forEach(references);
      };
      references(params);
      const kind = tableKind(transform);
      if (kind) {
        const { other: _other, ...options } = params;
        try { parseCsvTransformInput({ ...options, source: 'file:browser-data', operation: kind,
          ...(['join', 'concat', 'diff'].includes(kind) ? { other_source: 'file:browser-data-other' } : {}) }); }
        catch (error) { throw browserDataError(error instanceof Error ? error.message : 'invalid table operation'); }
        if (['join', 'concat', 'diff'].includes(kind) && params.other === undefined) throw browserDataError(`${transform} needs other: {data_ref} or an earlier pipeline reference`);
      } else checkParams(transform, params, false);
      const input = dataInputParam(transform);
      flow(op, kind ? undefined : input, kind ? 'array' : input ? operationSchema(transform)?.[input]?.type : undefined);
      if (id) seen.add(id);
    } catch (error) {
      const wrapped = error instanceof Error ? error : browserDataError('invalid operation parameters');
      throw Object.assign(wrapped, { browser_data_schema_step: { do: 'data', describe: op.transform === 'project' ? ['project', 'map']
        : op.transform === 'concat' ? ['concat', 'table.concat'] : [op.transform] } });
    }
  }
};

/** A checked alternative for provable input-shape mistakes. Preserve the
 * source, branches, predicates and expression; never choose a missing branch
 * or execute the alternative. Unknown input shapes receive no suggestion. */
export const browserDataParameterRepair = (step: BrowserDataStep): BrowserDataStep | undefined => {
  if (!step.pipeline) return;
  const flow = createBrowserDataFlow();
  let changed = false;
  const pipeline = step.pipeline.map(original => {
    let op = original;
    const expressionMap = op.transform === 'map' && op.expression !== undefined && op.apply === undefined;
    if ((op.transform === 'sort' || expressionMap || op.transform === 'project')
      && Object.hasOwn(op, 'input') && !Object.hasOwn(op, 'array') && !Object.hasOwn(op, 'object')) {
      const kind = flow.inputKindOf(op, 'input');
      if (kind === 'array' || op.transform === 'project' && kind === 'object') {
        const { input, ...rest } = op;
        op = { ...rest, ...(kind === 'array' ? { transform: op.transform === 'project' ? 'map' : op.transform, array: input } : { object: input }) };
        changed = true;
      }
    }
    if (op.transform === 'project' && !Object.hasOwn(op, 'input') && !Object.hasOwn(op, 'array')
      && flow.inputKindOf(op, 'object') === 'array') {
      const { object, ...rest } = op;
      op = { ...rest, transform: 'map', ...(object !== undefined ? { array: object } : {}) }; changed = true;
    }
    flow(op, dataInputParam(op.transform), undefined);
    return op;
  });
  if (!changed) return;
  const candidate = { ...step, pipeline };
  try { validateBrowserDataStep(candidate); return candidate; } catch { return; }
};

const toTable = (value: unknown, emptyColumns: string[] = []): CsvTable => {
  if (!Array.isArray(value) || value.some(row => !record(row))) throw browserDataError('table operations need object rows; project or parse the input first');
  const columns = value.length ? [...new Set(value.flatMap(row => Object.keys(row)))] : emptyColumns;
  if (!columns.length || columns.length > 128) throw browserDataError('table operations need 1-128 named columns');
  return { columns, rows: value.map(row => columns.map(column => {
    const cell: unknown = row[column];
    if (cell === undefined || cell === null) return '';
    if (!['string', 'number', 'boolean'].includes(typeof cell)) throw browserDataError('table cells must be scalar; use map/pluck for nested JSON');
    return String(cell);
  })) };
};
const tableOperation = (name: CsvTransformInput['operation'], value: unknown, params: Record<string, unknown>): unknown => {
  const { other, ...options } = params;
  // An empty side inherits the other side's columns for joins/diffs/concat.
  // Without any column evidence, use ordinary collection operations on [].
  const otherColumns = Array.isArray(other) ? [...new Set(other.flatMap(row => record(row) ? Object.keys(row) : []))] : [];
  const left = toTable(value, otherColumns);
  const right = other === undefined ? undefined : toTable(other, left.columns);
  const spec = parseCsvTransformInput({ ...options, source: 'file:browser-data', operation: name,
    ...(['join', 'concat', 'diff'].includes(name) ? { other_source: 'file:browser-data-other' } : {}) });
  // Refuse expansion before the canonical CSV engine allocates a cartesian join.
  if (spec.operation === 'join' && right && spec.duplicates === 'all') {
    const indexes = (table: CsvTable, keys: string[]) => keys.map(key => {
      const i = table.columns.indexOf(key); if (i < 0) throw browserDataError(`join column ${key} is absent`); return i;
    });
    const li = indexes(left, spec.left_keys), ri = indexes(right, spec.right_keys), counts = new Map<string, number>();
    for (const row of right.rows) { const key = JSON.stringify(ri.map(i => row[i])); counts.set(key, (counts.get(key) ?? 0) + 1); }
    let size = spec.join_type === 'full' ? right.rows.length : 0;
    for (const row of left.rows) {
      size += Math.max(spec.join_type === 'inner' ? 0 : 1, counts.get(JSON.stringify(li.map(i => row[i]))) ?? 0);
      if (size > BROWSER_DATA_LIMITS.rows) throw browserDataError('join would exceed the row limit');
    }
  }
  if (spec.operation === 'concat' && right && left.rows.length + right.rows.length > BROWSER_DATA_LIMITS.rows) throw browserDataError('concatenation would exceed the row limit');
  const answer = operateCsvTable(left, spec, right);
  return answer.table.rows.map(row => Object.fromEntries(answer.table.columns.map((column, i) => [column, row[i]])));
};

export const describeBrowserData = (names: readonly string[]): Record<string, unknown> => {
  if (!names.length) return { transforms: BROWSER_DATA_TRANSFORMS, note: 'Use data.describe with up to six names for parameters. Pure transforms use their existing recipe parameters. Input is injected automatically; $input and named earlier outputs support branches. table.* uses scalar-cell table operations; other takes {data_ref} or a prior output.' };
  const schemas = Object.fromEntries(names.map(name => {
    const kind = tableKind(name);
    const tableSchema = kind ? JSON.parse(JSON.stringify(CSV_TRANSFORM_ARGUMENT_VARIANTS[kind])) as { required: string[]; properties: Record<string, unknown> } : undefined;
    if (tableSchema) {
      delete tableSchema.properties.other_source; delete tableSchema.properties.other_delimiter;
      tableSchema.required = tableSchema.required.map(key => key === 'other_source' ? 'other' : key);
      if (['join', 'concat', 'diff'].includes(kind!)) tableSchema.properties.other = { description:
        'A retained dataset as {data_ref:"data:…"}, or $input / an earlier named output.' };
    }
    return [name, kind ? { parameters: tableSchema, note: 'Input is automatic. Cells are processed as text; decimal comparison is explicit.' }
      : { parameters: operationSchema(name), automatic_input: dataInputParam(name) ?? null,
        ...(name === 'map' ? { note: 'map takes array rows; expression reshapes each row. project takes one object, never an array. Put templates in expression. apply requires output_field. Quoted item["Column Name"] accesses an exact key. With apply:"to_number" declare format for currency/percent; invalid values fail unless on_invalid:"null" is explicit.' }
          : name === 'project' ? { note: 'project takes one object. For an array of rows use map with the same expression; input is automatic. Put templates in expression, not object. For sufficient returned values, format the final response yourself.' }
          : name === 'to_number' || ['sort', 'min_by', 'max_by', 'sum'].includes(name) ? { note: 'Numeric comparisons require value_type:"number". Declare format:{style:"number"/"currency"/"percent",unit?,decimal?,group?}; currency needs an exact unit. Conversion fails on invalid values by default; to_number permits on_invalid:"null" and typed comparison permits on_invalid:"exclude", both with reported counts. Raw source values are preserved.' } : {}) }];
  }));
  return { schemas };
};

interface BrowserDataComputation extends BrowserDataValue {
  numeric_operations?: BrowserNumericReport[];
  query_diagnostics?: { issues: BrowserQueryIssue[]; truncated: boolean; note: string };
  input_source: { data_ref: string; kind: string; selection: 'explicit' | 'latest_in_batch'; source_complete: boolean;
    latest_in_batch?: string; note?: string };
}

export const runBrowserDataPipeline = (options: { step: BrowserDataStep; store: BrowserDataStore; scope: string;
  latest?: string; assertActive: () => void }): BrowserDataComputation => {
  const { step, store, scope, assertActive } = options;
  validateBrowserDataStep(step, { store, scope });
  const ref = step.source === 'latest' ? options.latest : step.source ?? options.latest;
  if (!ref) throw browserDataError('no input dataset; read, table or collect first, or supply a returned data_ref');
  const original = store.read(scope, ref);
  const values: Record<string, unknown> = Object.create(null);
  values.input = original.value;
  const parents = new Set([ref]);
  const sources = [...original.descriptor.sources];
  const resolve = (value: unknown): unknown => {
    if (dataRef(value)) {
      const other = store.read(scope, value.data_ref); parents.add(value.data_ref); sources.push(...other.descriptor.sources);
      return other.value;
    }
    if (typeof value === 'string') {
      const match = /^\$([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)$/.exec(value);
      if (match) {
        const found = getField(values, match[1]!);
        if (found === undefined) throw browserDataError('pipeline reference names no value');
        return found;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
    return value;
  };
  const stores: NamespaceStores = { vault: {}, config: {}, context: {}, meta: {}, step: values };
  const context = createTransformContext(stores);
  context.numericExpressionValue = value => {
    assertActive();
    const result = executeBrowserNumeric('to_number', { input: value });
    if (!result || typeof result.value !== 'number') throw browserDataError('arithmetic needs finite numeric values');
    return result.value;
  };
  let current: unknown = original.value;
  const started = Date.now();
  let nestedBytes = 0;
  const numericOperations: BrowserNumericReport[] = [];
  const queryIssues: BrowserQueryIssue[] = [];
  let queryIssuesTruncated = false, operation = 0;
  const diagnose = (name: string, params: Record<string, unknown>) => {
    for (const issue of browserQueryIssues(operation, name, params)) {
      if (queryIssues.length === 4 || JSON.stringify([...queryIssues, issue]).length > 2_400) queryIssuesTruncated = true;
      else queryIssues.push(issue);
    }
  };
  context.getTransform = name => {
    const fn = allowed.has(name) ? getTransform(name) : undefined;
    return fn ? (params, ctx) => {
      assertActive();
      if (Date.now() - started > 2_000) throw browserDataError('pipeline exceeded its time budget');
      const schema = operationSchema(name)!;
      const { field, ...withoutField } = params;
      checkParams(name, Object.hasOwn(schema, 'field') ? params : withoutField, true);
      diagnose(name, params);
      const numeric = executeBrowserNumeric(name, params);
      const answer = numeric ? numeric.value : fn(browserDataFieldParams(name, params), ctx);
      if (numeric) numericOperations.push(numeric.report);
      nestedBytes += Buffer.byteLength(browserDataJson(answer));
      if (nestedBytes > BROWSER_DATA_LIMITS.bytes) throw browserDataError('nested transform output exceeds the snapshot limit');
      return answer;
    } : undefined;
  };
  for (const [index, op] of (step.pipeline ?? []).entries()) {
    operation = index + 1;
    assertActive();
    if (Date.now() - started > 2_000) throw browserDataError('pipeline exceeded its time budget');
    const { id, transform, ...authored } = op;
    let inputValue = current;
    let stage: 'parameters' | 'execution' | 'output' = 'parameters';
    try {
      const resolved = resolve(authored);
      if (!record(resolved)) throw browserDataError('operation parameters must be an object');
      const kind = tableKind(transform);
      if (kind) { stage = 'execution'; current = tableOperation(kind, current, resolved); }
      else {
        const input = dataInputParam(transform);
        inputValue = input && Object.hasOwn(resolved, input) ? resolved[input] : current;
        const params = JSON.parse(browserDataJson({ ...(input ? { [input]: current } : {}), ...resolved })) as Record<string, unknown>;
        checkParams(transform, params, true);
        diagnose(transform, params);
        const fn = getTransform(transform);
        if (!fn) throw browserDataError('registered transform is unavailable');
        stage = 'execution';
        const numeric = executeBrowserNumeric(transform, params);
        if (numeric) { current = numeric.value; numericOperations.push(numeric.report); }
        else {
          const quoted = (transform === 'map' || transform === 'project') ? prepareBrowserQuotedExpression(params.expression) : undefined;
          const adapted = quoted && input ? quoted(params[input], assertActive) : undefined;
          current = fn(adapted && input ? { ...params, [input]: adapted.input, expression: adapted.expression }
            : browserDataFieldParams(transform, params), context);
        }
        if (current && typeof current === 'object' && 'then' in current && typeof current.then === 'function') throw browserDataError('asynchronous transforms are unavailable');
      }
      // Clone each output before a later operation can mutate it or a named branch.
      stage = 'output';
      current = JSON.parse(browserDataJson(current));
      if (id) values[id] = current;
    } catch (error) {
      assertActive();
      let repair: BrowserDataStep | undefined;
      if (stage === 'parameters' && transform === 'project' && Array.isArray(inputValue)) {
        // Both transforms use the same bounded expression language. Suggest the
        // array analogue, preserving the original source and every other op.
        // This plan is checked, never executed on the model's behalf.
        const { object: projectInput, ...projection } = op;
        const candidate: BrowserDataStep = { ...step, source: ref,
          pipeline: step.pipeline!.map((item, n) => n === index
            ? { ...projection, transform: 'map', ...(projectInput !== undefined ? { array: projectInput } : {}) } : item) };
        if (JSON.stringify(candidate).length <= 2_000) {
          try { validateBrowserDataStep(candidate, { store, scope }); repair = candidate; } catch { /* Keep schema discovery when no checked plan fits. */ }
        }
      }
      throw browserDataFailureError(error, { operation: index + 1, transform, stage, source_ref: ref, input: inputValue,
        ...browserDataSourceIssues(sources), ...(repair ? { repair_step: repair } : {}) });
    }
  }
  assertActive();
  if (Date.now() - started > 2_000) throw browserDataError('pipeline exceeded its time budget');
  let value = step.return ? Object.fromEntries(step.return.map(name => [name, values[name]])) : current;
  if (step.select) {
    const fields = step.select;
    const project = (row: unknown): unknown => {
      if (!record(row)) throw browserDataError('select needs an object or object rows');
      for (const field of fields) if (!Object.hasOwn(row, field)) throw browserDataError(`select column ${field} is absent; use returned data_fields`);
      return Object.fromEntries(fields.map(field => [field, row[field]]));
    };
    value = Array.isArray(value) ? value.map(project) : project(value);
  }
  return { ...store.keep(scope, value, sources, [...parents]),
    ...(queryIssues.length || queryIssuesTruncated ? { query_diagnostics: { issues: queryIssues, truncated: queryIssuesTruncated,
      note: 'Check these query facts before answering. field_not_observed means the selected field was absent from every input row; use the observed fields and selected representation. array_equality does not compare array contents structurally; use membership or an observed scalar field when that matches the request. An empty result and source_complete do not establish that the query selected the intended records. Values and source coverage are unchanged; no replacement query was executed.' } } : {}),
    ...(numericOperations.length ? { numeric_operations: numericOperations } : {}),
    input_source: { data_ref: ref, kind: original.descriptor.kind, selection: step.source && step.source !== 'latest' ? 'explicit' : 'latest_in_batch', source_complete: original.descriptor.source_complete,
      ...(step.source && step.source !== 'latest' && options.latest && ref !== options.latest ? { latest_in_batch: options.latest,
        note: 'The explicit source selected a different retained snapshot from the latest capture/result in this batch. Omit source after a fresh capture to use it; for retained data alone, use a data-only call.' } : {}) } };
};

export const browserDataResult = (result: BrowserDataValue & Partial<Pick<BrowserDataComputation, 'input_source' | 'numeric_operations' | 'query_diagnostics'>>): Record<string, unknown> => {
  const json = browserDataJson(result.value);
  return { ...result.descriptor, ...(result.input_source ? { input_source: result.input_source } : {}),
    ...(result.query_diagnostics ? { query_diagnostics: result.query_diagnostics } : {}),
    ...(result.numeric_operations ? { numeric_operations: result.numeric_operations.slice(0, 20) } : {}), ...(json.length <= BROWSER_DATA_LIMITS.result_chars ? { value: result.value }
    : { value_omitted: true, data_hint: browserDataHint(result), note: 'Result retained on the server. Query its data_ref with slice/pluck operations or the data step select property. select is not a pipeline transform. map reshapes array rows; project reshapes one object.' }) };
};
