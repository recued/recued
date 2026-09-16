/**
 * Runtime-enforced request-schema subset for curated catalog operations.
 *
 * Most catalog request schemas remain descriptive. A schema opts into this
 * closed subset with `additionalProperties: false`; once opted in, both the
 * publisher and runtime must understand every keyword so a misspelled or
 * unsupported constraint can never look enforced while being ignored.
 */

import { isPinnedCasFileRef, isTempFileRef } from './ingredient-catalog.js';

const ROOT_KEYS = new Set(['type', 'additionalProperties', 'required', 'properties']);
const PROPERTY_KEYS = new Set([
  'type',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
]);
const ARRAY_PROPERTY_KEYS = new Set(['type', 'items', 'minItems', 'maxItems', 'uniqueItems']);
/** `file_ref` carries NO constraint keywords, and that is deliberate. Its value is
 *  a UNION — a scalar the cli passes through as a literal path/URL, a
 *  materializable record id, or one of two closed object carriers — so a
 *  `maxLength` or `pattern` here would silently bind one branch and not the
 *  others. This file's own rule ("a misspelled or unsupported constraint can
 *  never look enforced while being ignored") forbids exactly that. The shape is
 *  fixed in contracts, not restated per pack. */
const FILE_REF_PROPERTY_KEYS = new Set(['type']);
const FILE_REF_ARRAY_PROPERTY_KEYS = new Set(['type', 'minItems', 'maxItems']);
const SCALAR_PROPERTY_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const FILE_REF_TYPES = new Set(['file_ref', 'file_ref[]']);
const PROPERTY_TYPES = new Set([
  ...SCALAR_PROPERTY_TYPES, 'array', 'object', ...FILE_REF_TYPES,
]);

/** Does a value satisfy a `file_ref` argument?
 *
 *  ⛔ THIS MIRRORS THE RUNTIME ACCEPTOR AND MUST NOT BE NARROWER. `input_materialize`
 *  (`backend/server/src/cli-invocation-executor.ts`) resolves a temp ref to its path,
 *  materializes a pinned-CAS carrier or a recognized record id, and passes
 *  ANYTHING ELSE through to the tool as a literal path / URL via `scalarString`,
 *  whose `SCALAR_TYPES` are string / number / boolean / bigint. A gate narrower
 *  than its runtime rejects calls that work today, which is the failure this whole
 *  subset exists to avoid — so the scalars stay in.
 *
 *  What it DOES reject: null, undefined, arrays, and any object that is neither
 *  carrier (a half-formed `{ backing: 'temp', path }` with no mime_type/filename
 *  reaches `scalarString` today and dies with "must resolve to a scalar" deep in
 *  the executor; here it is named at the door). */
export const isFileRefArgumentValue = (value: unknown): boolean => {
  // ⛔ A LEADING DASH IS FLAG INJECTION, NOT A FILE. The passthrough lane hands
  // this value straight into argv, so `-i /etc/passwd` as a `source` would be
  // read by the tool as an option. Every pack that gave one of these args an
  // `editable_args` pattern already wrote `^(?!-)` — the rule was the authors'
  // intent everywhere and enforced nowhere, because a `pattern` on a file_ref
  // could only ever bind the string branch of the union. It belongs here, where
  // it binds the whole type.
  if (typeof value === 'string') return value.length > 0 && !value.startsWith('-');
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return isTempFileRef(value) || isPinnedCasFileRef(value);
};

/** The JSON-Schema projection of a `file_ref`, for surfaces that hand a request
 *  schema to something that speaks JSON Schema (the MCP raw-op door).
 *
 *  ⛔ `{ "type": "file_ref" }` IS NOT JSON SCHEMA. `rawOpInputSchema`
 *  (`backend/server/src/raw-op-tool-catalog.ts`) spreads a closed schema VERBATIM
 *  into a tool's `inputSchema`, so an unprojected file_ref would reach a model as
 *  a type no validator knows. Cli ops are fenced off that door, but `file_ref`
 *  args also exist in `tool_function` packs (bluesky / facebook / mastodon /
 *  x-twitter), which are not — so the projection is a requirement, not a
 *  courtesy. */
export const FILE_REF_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  description:
    'A file reference: a data.file record id, a local path or URL, or a '
    + 'producing step\'s file_ref carrier.',
  anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['backing', 'path', 'mime_type', 'filename'],
      properties: {
        backing: { type: 'string', enum: ['temp'] },
        path: { type: 'string', minLength: 1 },
        mime_type: { type: 'string', minLength: 1 },
        filename: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['backing', 'record_id', 'content_sha256'],
      properties: {
        backing: { type: 'string', enum: ['cas'] },
        record_id: { type: 'string', pattern: '^file:[0-9a-f]{32}$' },
        content_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
    },
  ],
});
const ARRAY_ITEM_TYPES = new Set([...SCALAR_PROPERTY_TYPES, 'object']);
const MAX_SCHEMA_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const valueMatchesType = (value: unknown, type: string): boolean =>
  (type === 'string' && typeof value === 'string')
  || (type === 'number' && typeof value === 'number' && Number.isFinite(value))
  || (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))
  || (type === 'boolean' && typeof value === 'boolean')
  || (type === 'array' && Array.isArray(value))
  || (type === 'object' && isRecord(value))
  || (type === 'file_ref' && isFileRefArgumentValue(value))
  || (type === 'file_ref[]' && Array.isArray(value)
    && value.every((item) => isFileRefArgumentValue(item)));

/** True only for schemas that explicitly opt into the fail-closed subset. */
export const isClosedRequestSchema = (schema: unknown): boolean =>
  isRecord(schema) && schema.additionalProperties === false;

/**
 * Validate the definition of an opted-in schema. Non-closed schemas are
 * intentionally ignored because their legacy role is descriptive only.
 */
const validateRequired = (
  raw: unknown,
  properties: Record<string, unknown>,
  label: string,
  issues: string[],
): void => {
  if (raw !== undefined
    && (!Array.isArray(raw)
      || !raw.every((value) => typeof value === 'string' && value.length > 0))) {
    issues.push(`${label}required must be an array of non-empty property names`);
    return;
  }
  if (!Array.isArray(raw)) return;
  const seen = new Set<string>();
  for (const key of raw as string[]) {
    if (seen.has(key)) issues.push(`${label}required property '${key}' is duplicated`);
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      issues.push(`${label}required property '${key}' is not declared in properties`);
    }
  }
};

const validatePropertyDefinition = (
  rawProperty: unknown,
  path: string,
  issues: string[],
  depth: number,
): void => {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(`property '${path}' exceeds maximum schema depth ${MAX_SCHEMA_DEPTH}`);
    return;
  }
  if (!isRecord(rawProperty)) {
    issues.push(`property '${path}' must be an object`);
    return;
  }
  const type = rawProperty.type;
  if (typeof type !== 'string' || !PROPERTY_TYPES.has(type)) {
    issues.push(`property '${path}' type must be string, number, integer, boolean, array, object, file_ref, or file_ref[]`);
    return;
  }

  if (type === 'file_ref' || type === 'file_ref[]') {
    const allowed = type === 'file_ref' ? FILE_REF_PROPERTY_KEYS : FILE_REF_ARRAY_PROPERTY_KEYS;
    for (const keyword of Object.keys(rawProperty)) {
      if (!allowed.has(keyword)) {
        issues.push(`property '${path}' uses unsupported keyword '${keyword}' for type '${type}'`);
      }
    }
    if (type === 'file_ref[]') {
      const minItems = rawProperty.minItems;
      const maxItems = rawProperty.maxItems;
      if (minItems !== undefined
        && (!Number.isSafeInteger(minItems) || (minItems as number) < 0)) {
        issues.push(`property '${path}' minItems must be a non-negative integer`);
      }
      // Symmetric with `array`: an unbounded list is not a closed contract.
      if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 0) {
        issues.push(`property '${path}' must declare a non-negative maxItems bound`);
      }
      if (typeof minItems === 'number'
        && typeof maxItems === 'number'
        && minItems > maxItems) {
        issues.push(`property '${path}' minItems must not exceed maxItems`);
      }
    }
    return;
  }

  if (type === 'object') {
    for (const keyword of Object.keys(rawProperty)) {
      if (!ROOT_KEYS.has(keyword)) {
        issues.push(`property '${path}' uses unsupported keyword '${keyword}'`);
      }
    }
    if (rawProperty.additionalProperties !== false) {
      issues.push(`property '${path}' must declare additionalProperties: false`);
    }
    if (!isRecord(rawProperty.properties)) {
      issues.push(`property '${path}' properties must be an object`);
      return;
    }
    validateRequired(rawProperty.required, rawProperty.properties, `property '${path}' `, issues);
    for (const [key, child] of Object.entries(rawProperty.properties)) {
      if (key.length === 0) {
        issues.push(`property '${path}' property names must be non-empty`);
        continue;
      }
      validatePropertyDefinition(child, `${path}.${key}`, issues, depth + 1);
    }
    return;
  }

  if (type === 'array') {
    for (const keyword of Object.keys(rawProperty)) {
      if (!ARRAY_PROPERTY_KEYS.has(keyword)) {
        issues.push(`property '${path}' uses unsupported keyword '${keyword}'`);
      }
    }
    const minItems = rawProperty.minItems;
    const maxItems = rawProperty.maxItems;
    if (minItems !== undefined
      && (!Number.isSafeInteger(minItems) || (minItems as number) < 0)) {
      issues.push(`property '${path}' minItems must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 0) {
      issues.push(`property '${path}' must declare a non-negative maxItems bound`);
    }
    if (typeof minItems === 'number'
      && typeof maxItems === 'number'
      && minItems > maxItems) {
      issues.push(`property '${path}' minItems must not exceed maxItems`);
    }
    if (rawProperty.uniqueItems !== undefined
      && typeof rawProperty.uniqueItems !== 'boolean') {
      issues.push(`property '${path}' uniqueItems must be a boolean`);
    }
    if (!isRecord(rawProperty.items)) {
      issues.push(`property '${path}' items must be a schema object`);
    } else if (typeof rawProperty.items.type !== 'string'
      || !ARRAY_ITEM_TYPES.has(rawProperty.items.type)) {
      issues.push(`property '${path}[]' type must be string, number, integer, boolean, or object`);
    } else {
      validatePropertyDefinition(rawProperty.items, `${path}[]`, issues, depth + 1);
    }
    return;
  }

  for (const keyword of Object.keys(rawProperty)) {
    if (!PROPERTY_KEYS.has(keyword)) {
      issues.push(`property '${path}' uses unsupported keyword '${keyword}'`);
    }
  }
  if (rawProperty.enum !== undefined) {
    if (!Array.isArray(rawProperty.enum) || rawProperty.enum.length === 0) {
      issues.push(`property '${path}' enum must be a non-empty array`);
    } else if (!rawProperty.enum.every((value) => valueMatchesType(value, type))) {
      issues.push(`property '${path}' enum values must match type '${type}'`);
    }
  }

  const minLength = rawProperty.minLength;
  const maxLength = rawProperty.maxLength;
  if (minLength !== undefined
    && (!Number.isSafeInteger(minLength) || (minLength as number) < 0)) {
    issues.push(`property '${path}' minLength must be a non-negative integer`);
  }
  if (maxLength !== undefined
    && (!Number.isSafeInteger(maxLength) || (maxLength as number) < 0)) {
    issues.push(`property '${path}' maxLength must be a non-negative integer`);
  }
  if ((minLength !== undefined || maxLength !== undefined) && type !== 'string') {
    issues.push(`property '${path}' length constraints require type 'string'`);
  }
  if (type === 'string' && maxLength === undefined && rawProperty.enum === undefined) {
    issues.push(`property '${path}' must declare maxLength or a finite enum`);
  }
  if (typeof minLength === 'number'
    && typeof maxLength === 'number'
    && minLength > maxLength) {
    issues.push(`property '${path}' minLength must not exceed maxLength`);
  }

  if (rawProperty.pattern !== undefined) {
    if (type !== 'string') issues.push(`property '${path}' pattern requires type 'string'`);
    if (typeof rawProperty.pattern !== 'string') {
      issues.push(`property '${path}' pattern must be a string`);
    } else {
      try {
        new RegExp(rawProperty.pattern);
      } catch {
        issues.push(`property '${path}' pattern is invalid`);
      }
    }
  }

  const minimum = rawProperty.minimum;
  const maximum = rawProperty.maximum;
  if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) {
    issues.push(`property '${path}' minimum must be finite`);
  }
  if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) {
    issues.push(`property '${path}' maximum must be finite`);
  }
  if ((minimum !== undefined || maximum !== undefined)
    && type !== 'number'
    && type !== 'integer') {
    issues.push(`property '${path}' numeric bounds require type 'number' or 'integer'`);
  }
  if (typeof minimum === 'number'
    && typeof maximum === 'number'
    && minimum > maximum) {
    issues.push(`property '${path}' minimum must not exceed maximum`);
  }
};

/** Rewrite a closed request schema into plain JSON Schema, so a door that hands
 *  it to something speaking JSON Schema (the MCP raw-op `inputSchema`) never
 *  emits `type: 'file_ref'` — a type no validator knows.
 *
 *  ⚠ ONLY `file_ref` / `file_ref[]` need rewriting; every other type in the
 *  closed subset IS JSON Schema already. Returns the input unchanged when there
 *  is nothing to project, so the common path allocates nothing.
 *
 *  ⛔ Call this at the DOOR, not at authoring time. The stored schema stays in
 *  the closed vocabulary — that is what `closedRequestSchemaViolation` validates
 *  against, and what the alignment validator compares to `args[].type`. */
export const projectClosedRequestSchemaForJsonSchema = (schema: unknown): unknown => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return schema;
  let rewrote = false;
  const properties: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(schema.properties)) {
    const type = isRecord(raw) ? raw.type : undefined;
    if (type === 'file_ref') {
      properties[key] = FILE_REF_JSON_SCHEMA;
      rewrote = true;
    } else if (type === 'file_ref[]') {
      const prop = raw as Record<string, unknown>;
      properties[key] = {
        type: 'array',
        items: FILE_REF_JSON_SCHEMA,
        ...(typeof prop.minItems === 'number' ? { minItems: prop.minItems } : {}),
        ...(typeof prop.maxItems === 'number' ? { maxItems: prop.maxItems } : {}),
      };
      rewrote = true;
    } else {
      properties[key] = raw;
    }
  }
  return rewrote ? { ...schema, properties } : schema;
};

export const closedRequestSchemaDefinitionIssues = (schema: unknown): string[] => {
  if (!isClosedRequestSchema(schema)) return [];
  const root = schema as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) issues.push(`unsupported root keyword '${key}'`);
  }
  if (root.type !== 'object') issues.push("type must be 'object'");
  if (!isRecord(root.properties)) {
    issues.push('properties must be an object');
    return issues;
  }
  validateRequired(root.required, root.properties, '', issues);
  for (const [key, property] of Object.entries(root.properties)) {
    if (key.length === 0) {
      issues.push('property names must be non-empty');
      continue;
    }
    validatePropertyDefinition(property, key, issues, 1);
  }
  return issues;
};

type ClosedProperty = Record<string, unknown>;

const propertyViolation = (
  property: ClosedProperty,
  value: unknown,
  path: string,
): string | null => {
  const type = property.type as string;
  if (!valueMatchesType(value, type)) {
    if (type === 'file_ref' || type === 'file_ref[]') {
      // Name the union rather than echo the type — "must be file_ref" tells a
      // recipe author nothing about which shapes are accepted.
      return `argument '${path}' must be ${type === 'file_ref[]' ? 'a list of file references' : 'a file reference'}`
        + ' (a data.file record id, a local path or URL, or a producing step\'s file_ref)';
    }
    return `argument '${path}' must be ${type}`;
  }
  if (type === 'file_ref[]') {
    const values = value as unknown[];
    if (typeof property.minItems === 'number' && values.length < property.minItems) {
      return `argument '${path}' has fewer than ${property.minItems} items`;
    }
    if (typeof property.maxItems === 'number' && values.length > property.maxItems) {
      return `argument '${path}' has more than ${property.maxItems} items`;
    }
    return null;
  }
  if (type === 'file_ref') return null;
  if (type === 'array') {
    const values = value as unknown[];
    if (typeof property.minItems === 'number' && values.length < property.minItems) {
      return `argument '${path}' has fewer than ${property.minItems} items`;
    }
    if (typeof property.maxItems === 'number' && values.length > property.maxItems) {
      return `argument '${path}' has more than ${property.maxItems} items`;
    }
    if (property.uniqueItems === true) {
      const unique = new Set(values.map((item) => JSON.stringify(item)));
      if (unique.size !== values.length) return `argument '${path}' must contain unique items`;
    }
    const items = property.items as ClosedProperty;
    for (const [index, item] of values.entries()) {
      const issue = propertyViolation(items, item, `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const properties = property.properties as Record<string, ClosedProperty>;
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return `argument '${path}' has undeclared property '${key}'`;
      }
    }
    for (const key of (property.required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        return `argument '${path}' is missing required property '${key}'`;
      }
    }
    for (const [key, child] of Object.entries(record)) {
      const issue = propertyViolation(properties[key]!, child, `${path}.${key}`);
      if (issue) return issue;
    }
    return null;
  }
  if (Array.isArray(property.enum)
    && !property.enum.some((candidate) => Object.is(candidate, value))) {
    return `argument '${path}' is outside its allowed enum`;
  }
  if (typeof value === 'string') {
    if (typeof property.minLength === 'number' && value.length < property.minLength) {
      return `argument '${path}' is shorter than ${property.minLength}`;
    }
    if (typeof property.maxLength === 'number' && value.length > property.maxLength) {
      return `argument '${path}' is longer than ${property.maxLength}`;
    }
    if (typeof property.pattern === 'string' && !(new RegExp(property.pattern)).test(value)) {
      return `argument '${path}' does not match its required pattern`;
    }
  }
  if (typeof value === 'number') {
    if (typeof property.minimum === 'number' && value < property.minimum) {
      return `argument '${path}' is below ${property.minimum}`;
    }
    if (typeof property.maximum === 'number' && value > property.maximum) {
      return `argument '${path}' is above ${property.maximum}`;
    }
  }
  return null;
};

/** Return the first runtime violation, or null when the call is admitted. */
export const closedRequestSchemaViolation = (
  schema: unknown,
  args: Record<string, unknown>,
): string | null => {
  if (!isClosedRequestSchema(schema)) return null;
  const definitionIssue = closedRequestSchemaDefinitionIssues(schema)[0];
  if (definitionIssue !== undefined) return `invalid closed request schema: ${definitionIssue}`;
  const root = schema as {
    required?: string[];
    properties: Record<string, ClosedProperty>;
  };
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(root.properties, key)) {
      return `undeclared argument '${key}'`;
    }
  }
  for (const key of root.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      return `missing required argument '${key}'`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const issue = propertyViolation(root.properties[key]!, value, key);
    if (issue) return issue;
  }
  return null;
};
