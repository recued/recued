/** Source-aware form answer reads, including collection and foreach bindings.
 * Shapes retain only paths that still contain an unrestricted answer object.
 * A named answer is recorded at its first path segment, then leaves the graph:
 * its contents are already covered by that field's declaration. */
import { CANONICAL_SYSTEM_FIELDS } from './canonical-record.js';

type Shape =
  | { kind: 'answers' }
  | { kind: 'object'; fields: ReadonlyMap<string, Shape> }
  | { kind: 'array'; element: Shape }
  | { kind: 'union'; options: ReadonlyArray<Shape> }
  | undefined;

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
const REFS = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PRESENCE = new Set(['is_null', 'is_not_null', 'is_empty', 'is_not_empty']);
const ANSWERS: Shape = { kind: 'answers' };
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const objectShape = (entries: Iterable<readonly [string, Shape]>): Shape => {
  const fields = new Map([...entries].filter(([, shape]) => shape !== undefined));
  return fields.size === 0 ? undefined : { kind: 'object', fields };
};
const arrayShape = (element: Shape): Shape =>
  element === undefined ? undefined : { kind: 'array', element };
const unionShape = (shapes: ReadonlyArray<Shape>): Shape => {
  const options = [...new Set(shapes.flatMap((shape) =>
    shape?.kind === 'union' ? shape.options : shape === undefined ? [] : [shape]))];
  return options.length === 0 ? undefined
    : options.length === 1 ? options[0] : { kind: 'union', options };
};
const elementOf = (shape: Shape): Shape => shape?.kind === 'array' ? shape.element
  : shape?.kind === 'union' ? unionShape(shape.options.map(elementOf)) : undefined;
const atPath = (shape: Shape, path: ReadonlyArray<string>, read?: (field: string) => void): Shape => {
  if (shape === undefined || path.length === 0) return shape;
  if (shape.kind === 'union') return unionShape(shape.options.map((option) => atPath(option, path, read)));
  const [head, ...tail] = path;
  if (head === undefined || DANGEROUS_KEYS.has(head)) return undefined;
  if (shape.kind === 'answers') {
    read?.(head);
    return undefined;
  }
  if (shape.kind === 'array') {
    // getField and the template resolver both use Number(key) array lookups,
    // including spellings such as +0 / 0e0 and an empty path segment.
    const indexed = Number.isInteger(Number(head)) && Number(head) >= 0;
    return indexed ? atPath(shape.element, tail, read) : undefined;
  }
  return atPath(shape.fields.get(head), tail, read);
};
const withField = (shape: Shape, name: string, value: Shape): Shape => {
  if (shape?.kind === 'union') return unionShape(shape.options.map((option) => withField(option, name, value)));
  // Spreading the answers themselves still carries all their unknown keys.
  if (shape?.kind === 'answers') return shape;
  const fields = new Map(shape?.kind === 'object' ? shape.fields : []);
  fields.set(name, value);
  return objectShape(fields);
};

const formResult = (step: JsonObject): Shape => {
  if (step.op === 'core.data.form-response.list' || step.ingredient === 'form-response-list') {
    return objectShape([['records', arrayShape(objectShape([['values', ANSWERS]]))]]);
  }
  if (step.op === 'core.data.form-response.get' || step.op === 'core.data.form-response.set-state'
    || step.ingredient === 'form-response-get' || step.ingredient === 'form-response-set-state') {
    return objectShape([['record', objectShape([['values', ANSWERS]])]]);
  }
  return undefined;
};

/** These inputs move structured data without enumerating its answer values.
 * Their output shape is traced below; other consumers (serialization, mail,
 * AI, writes, interpolation) count as whole reads. Only pure refs can be
 * transported: interpolating a carrier into text consumes its contents. */
const TRANSPORT: Readonly<Record<string, ReadonlyArray<string>>> = {
  filter: ['array'], sort: ['array'], unique: ['array'], slice: ['array'],
  flatten: ['array'], chunk: ['array'], partition: ['array'],
  find: ['array'], min_by: ['array'], max_by: ['array'], pluck: ['array'],
  sum: ['array'], reduce: ['array'], count: ['input'],
  map: ['array'], project: ['object'], enrich_by: ['array', 'with'],
  default: ['value', 'fallback'], defaults: ['fields'], coalesce: ['values'],
  ternary: ['then', 'else'],
};

/** An unresolved selector can choose any answer at runtime. Only literal key
 * lists qualify as a bounded pick; omitted/non-array fields pass through. */
const pickFields = (raw: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(raw) && raw.every((field) => typeof field === 'string' && !field.includes('{{'))
    ? raw as string[] : undefined;

interface SelectedColumn { readonly field: string; readonly location: string }
const csvColumns = (raw: unknown): ReadonlyArray<SelectedColumn> | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const columns: SelectedColumn[] = [];
  for (const [i, value] of raw.entries()) {
    const object = asObject(value);
    const field = typeof value === 'string' ? value : object?.field;
    if (field == null || (typeof value !== 'string' && field === '')) continue;
    // to_csv coerces descriptor fields to strings. Complex or templated
    // selectors are not statically bounded, even beside a literal column.
    if (!['string', 'number', 'boolean'].includes(typeof field) || String(field).includes('{{')) return undefined;
    columns.push({ field: String(field), location: `columns.${i}${typeof value === 'string' ? '' : '.field'}` });
  }
  // The runtime derives every row key when no explicit entry is usable.
  return columns.length > 0 ? columns : undefined;
};

const pickShape = (shape: Shape, selected: ReadonlyArray<string>): Shape => {
  if (shape?.kind === 'union') return unionShape(shape.options.map((option) => pickShape(option, selected)));
  // pick passes arrays through unchanged, even with explicit fields.
  if (shape?.kind === 'array') return shape;
  return objectShape([...new Set([...selected, ...CANONICAL_SYSTEM_FIELDS])]
    .map((key) => [key, atPath(shape, [key])] as const));
};
const hasArrayShape = (shape: Shape): boolean => shape?.kind === 'array'
  || (shape?.kind === 'union' && shape.options.some(hasArrayShape));

export interface RecipeFormReads {
  readonly fields: ReadonlyArray<string>;
  /** Verbatim refs, or the location of an implicit transform field read. */
  readonly wholeObjects: ReadonlyArray<string>;
}

export const collectRecipeFormReads = (recipe: unknown): RecipeFormReads => {
  const empty: RecipeFormReads = { fields: [], wholeObjects: [] };
  let source: JsonObject | undefined;
  try { source = asObject(JSON.parse(JSON.stringify(recipe) ?? 'null')); }
  catch { return empty; }
  if (source === undefined) return empty;

  const steps = new Map<string, JsonObject>();
  const triggerIds = new Set<string>();
  for (const phase of ['trigger_steps', 'prefetch_steps', 'steps']) {
    const phaseSteps = source[phase];
    if (!Array.isArray(phaseSteps)) continue;
    for (const value of phaseSteps) {
      const step = asObject(value);
      if (step === undefined || typeof step.id !== 'string') continue;
      steps.set(step.id, step);
      if (phase === 'trigger_steps') triggerIds.add(step.id);
    }
  }
  if (![...steps.values()].some((step) => formResult(step) !== undefined)) return empty;

  const fields = new Set<string>();
  const wholeObjects = new Set<string>();
  const shapes = new Map<string, Shape>();
  const visiting = new Set<string>();
  const readField = (field: string): void => { fields.add(field); };

  const refShape = (body: string, item: Shape, read?: (field: string) => void): Shape => {
    // Map expressions support coercion pipes; the resolver also strips hints.
    const path = (body.split('|')[0] ?? '').trim().replace(/:[a-z_]+$/, '').trim().split('.');
    const namespace = path.shift();
    if (namespace === 'item') return atPath(item, path, read);
    if (namespace !== 'step' && namespace !== 'trigger') return undefined;
    const id = path.shift();
    if (id === undefined || (namespace === 'trigger' && !triggerIds.has(id))) return undefined;
    return atPath(stepShape(id), path, read);
  };

  const valueShape = (value: unknown, item: Shape): Shape => {
    if (typeof value === 'string') {
      const matches = [...value.matchAll(REFS)];
      const match = matches[0];
      return matches.length === 1 && match?.[0] === value
        ? refShape(match[1] ?? '', item) : undefined;
    }
    if (Array.isArray(value)) return arrayShape(unionShape(value.map((entry) => valueShape(entry, item))));
    const object = asObject(value);
    if (object === undefined) return undefined;
    const ternary = asObject(object.$ternary);
    if (ternary !== undefined) return unionShape([valueShape(ternary.then, item), valueShape(ternary.else, item)]);
    return objectShape(Object.entries(object).map(([key, entry]) => [key, valueShape(entry, item)] as const));
  };

  const transformShape = (step: JsonObject, item: Shape): Shape => {
    const input = valueShape(step.array, item);
    const row = elementOf(input);
    switch (step.transform) {
      case 'filter': case 'sort': case 'unique': case 'slice': return input;
      case 'flatten': {
        let flat = input;
        const depth = step.depth === undefined ? 1
          : typeof step.depth === 'number' || (typeof step.depth === 'string' && !step.depth.includes('{{'))
            ? Math.max(0, Math.floor(Number(step.depth)) || 0) : undefined;
        const possibilities = [flat];
        for (let i = 0; (depth === undefined || i < depth) && elementOf(elementOf(flat)) !== undefined; i++) {
          flat = arrayShape(elementOf(elementOf(flat)));
          possibilities.push(flat);
        }
        // A configurable depth can expose any nested array level. Keep those
        // possibilities rather than guessing one and losing its form source.
        return depth === undefined ? unionShape(possibilities) : flat;
      }
      case 'chunk': return arrayShape(input);
      case 'partition': return objectShape([['matched', input], ['unmatched', input]]);
      case 'find': case 'min_by': case 'max_by': return row;
      case 'pluck': return typeof step.field === 'string' ? arrayShape(atPath(row, step.field.split('.'))) : undefined;
      case 'map': {
        const expression = valueShape(step.expression, row);
        if (step.expression !== undefined) return arrayShape(typeof step.output_field === 'string' && step.output_field !== ''
          ? withField(row, step.output_field, expression) : expression);
        // Apply mode spreads the original row; no projection happens.
        return input;
      }
      case 'project': return valueShape(step.expression, valueShape(step.object, item));
      case 'pick': {
        const source = valueShape(step.source, item);
        const selected = pickFields(step.fields);
        return selected === undefined ? source : pickShape(source, selected);
      }
      case 'enrich_by': {
        const right = elementOf(valueShape(step.with, item));
        let enriched = row;
        for (const [key, path] of Object.entries(asObject(step.fields) ?? {})) {
          enriched = withField(enriched, key, typeof path === 'string' ? atPath(right, path.split('.')) : undefined);
        }
        return arrayShape(enriched);
      }
      case 'default': return unionShape([valueShape(step.value, item), valueShape(step.fallback, item)]);
      case 'defaults': return objectShape(Object.entries(asObject(step.fields) ?? {}).map(([key, spec]) => {
        const entry = asObject(spec);
        return [key, entry === undefined ? valueShape(spec, item)
          : unionShape([valueShape(entry.value, item), valueShape(entry.fallback, item)])] as const;
      }));
      case 'coalesce': return elementOf(valueShape(step.values, item));
      case 'ternary': return unionShape([valueShape(step.then, item), valueShape(step.else, item)]);
      default: return undefined;
    }
  };

  const stepShape = (id: string): Shape => {
    if (shapes.has(id)) return shapes.get(id);
    if (visiting.has(id)) return undefined; // Cycles are rejected by recipe validation.
    const step = steps.get(id);
    if (step === undefined) return undefined;
    visiting.add(id);
    const item = elementOf(valueShape(step.foreach, undefined));
    const result = formResult(step) ?? transformShape(step, item);
    // Foreach retains both the result and original input, including failures.
    const shape = step.foreach === undefined ? result
      : arrayShape(objectShape([['result', result], ['item', item]]));
    visiting.delete(id);
    shapes.set(id, shape);
    return shape;
  };

  const scan = (value: unknown, item: Shape, transport = false): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(REFS)) {
        const shape = refShape(match[1] ?? '', item, readField);
        if (shape !== undefined && !(transport && match[0] === value)) wholeObjects.add(match[0]);
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) scan(entry, item, transport);
    } else {
      for (const entry of Object.values(asObject(value) ?? {})) scan(entry, item, transport);
    }
  };

  const scanStep = (step: JsonObject): void => {
    const item = elementOf(valueShape(step.foreach, undefined));
    const transform = typeof step.transform === 'string' ? step.transform : '';
    const selectedKeys = transform === 'pick' ? pickFields(step.fields) : undefined;
    const selectedColumns = transform === 'to_csv' ? csvColumns(step.columns) : undefined;
    const pickSource = transform === 'pick' ? valueShape(step.source, item) : undefined;
    const transported = transform === 'compare' && PRESENCE.has(String(step.operator))
      ? ['left'] : selectedKeys !== undefined && !hasArrayShape(pickSource) ? ['source']
        : selectedColumns !== undefined ? ['array'] : TRANSPORT[transform] ?? [];
    const row = elementOf(valueShape(step.array, item));
    for (const [key, value] of Object.entries(step)) {
      const expressionItem = key === 'expression' && (transform === 'map' || transform === 'project')
        ? transform === 'map' ? row : valueShape(step.object, item) : item;
      scan(value, expressionItem, key === 'foreach' || transported.includes(key));
    }
    // Field parameters are implicit item lookups, without template braces.
    const fieldRead = (path: unknown, shape: Shape, location: string, presence = false): void => {
      if (shape === undefined || typeof path !== 'string' || path === '') return;
      if (path.includes('{{')) {
        wholeObjects.add(`${String(step.id)}.${location} (${path})`);
      } else if (atPath(shape, path.split('.'), readField) !== undefined && !presence) {
        wholeObjects.add(`${String(step.id)}.${location} (${path})`);
      }
    };
    if (transform === 'to_csv' && selectedColumns !== undefined) {
      for (const column of selectedColumns) fieldRead(column.field, row, column.location);
    } else if (transform === 'pick' && selectedKeys !== undefined) {
      for (const [i, key] of selectedKeys.entries()) {
        // pick is shallow: a dotted key is one own property, not a path.
        if (atPath(pickSource, [key], readField) !== undefined) wholeObjects.add(`${String(step.id)}.fields.${i} (${key})`);
      }
      // Canonical keys cannot be visitor field names, but authored wrappers
      // can store unrestricted answers under them. pick preserves those too.
      for (const key of CANONICAL_SYSTEM_FIELDS) {
        if (!selectedKeys.includes(key) && atPath(pickSource, [key]) !== undefined) {
          wholeObjects.add(`${String(step.id)}.source.${key} (preserved field)`);
        }
      }
    } else if (['filter', 'partition', 'find'].includes(transform)) {
      if (Array.isArray(step.conditions)) {
        for (const [i, value] of step.conditions.entries()) {
          const condition = asObject(value);
          fieldRead(condition?.field, row, `conditions.${i}.field`, PRESENCE.has(String(condition?.operator)));
        }
      } else fieldRead(step.field, row, 'field', PRESENCE.has(String(step.operator)));
    } else if (transform === 'sort' && Array.isArray(step.fields)) {
      for (const [i, field] of step.fields.entries()) fieldRead(asObject(field)?.field, row, `fields.${i}.field`);
    } else if (['sort', 'unique', 'pluck', 'sum', 'reduce', 'min_by', 'max_by'].includes(transform)) {
      if (transform !== 'reduce' || step.operator !== 'count') fieldRead(step.field, row, 'field');
    } else if (transform === 'map' && step.expression === undefined && step.apply !== undefined) {
      if (step.field === undefined && row !== undefined) wholeObjects.add(`${String(step.id)}.apply (whole item)`);
      else fieldRead(step.field, row, 'field');
    } else if (transform === 'enrich_by') {
      const right = elementOf(valueShape(step.with, item));
      fieldRead(step.key, row, 'key');
      fieldRead(step.with_key ?? step.key, right, 'with_key');
      for (const [key, path] of Object.entries(asObject(step.fields) ?? {})) fieldRead(path, right, `fields.${key}`);
    }
  };

  for (const [key, value] of Object.entries(source)) {
    if (['trigger_steps', 'prefetch_steps', 'steps'].includes(key) && Array.isArray(value)) {
      for (const entry of value) {
        const step = asObject(entry);
        if (step !== undefined) scanStep(step);
      }
    } else {
      // Prose refs remain checked when an executable producer exists.
      scan(value, undefined);
      if (key === 'output') {
        const render = asObject(value)?.render;
        if (!Array.isArray(render)) continue;
        for (const entry of render) {
          const path = asObject(entry)?.source;
          if (typeof path === 'string' && /^(step|trigger)\./.test(path)
            && refShape(path, undefined, readField) !== undefined) wholeObjects.add(path);
        }
      }
    }
  }
  return { fields: [...fields], wholeObjects: [...wholeObjects] };
};
