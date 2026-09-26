/**
 * Runtime-enforced request-schema subset for curated catalog operations.
 *
 * Most catalog request schemas remain descriptive. A schema opts into this
 * closed subset with `additionalProperties: false`; once opted in, both the
 * publisher and runtime must understand every keyword so a misspelled or
 * unsupported constraint can never look enforced while being ignored.
 */

import { isPinnedCasFileRef, isTempFileRef } from './ingredient-catalog.js';
import { testDeclaredPattern } from './declared-pattern.js';

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

/** ⛔⛔ KEYWORDS THAT ARE OPENAPI, NOT JSON SCHEMA. `nullable` is OpenAPI 3.0's
 *  way of saying "may be null"; JSON Schema spells that as a type union. A
 *  strict validator (ajv in strict mode, which an MCP client may well use)
 *  REJECTS an unknown keyword rather than ignoring it, and a rejected
 *  `inputSchema` costs the model the whole tool — worse than the missing
 *  annotation. 320 properties across the corpus carry it. */
const OPENAPI_ONLY_KEYWORDS = new Set(['nullable']);

/** Rewrite a DESCRIPTIVE (non-closed) request schema into plain JSON Schema, for
 *  the same door that projects closed ones.
 *
 *  ⛔⛔ WHY A DESCRIPTIVE SCHEMA REACHES A DOOR AT ALL. `closedRequestSchemaViolation`
 *  enforces nothing unless a schema opts in with `additionalProperties: false`,
 *  and opting in requires every VALUE to be fully bounded — `maxLength` on every
 *  string, `maxItems` and an `items` schema on every array, `additionalProperties:
 *  false` on every nested object. Thousands of catalog operations wrap vendor APIs
 *  whose specs simply do not state those bounds, and 1,746 of them accept a
 *  genuinely free-form object because the vendor means "arbitrary keys". Those
 *  schemas can never opt in — and the raw-op door used to answer that by
 *  advertising `{ connection, additionalProperties: true }` and NOTHING ELSE.
 *
 *  ⇒ The operation's parameters were documented, in the pack, and the model was
 *  told none of them. It had to guess argument names for an operation whose
 *  arguments were sitting right there. That is a DOCUMENTATION loss dressed up as
 *  an enforcement decision: two separable purposes — "say what the arguments are"
 *  and "refuse the ones you did not say" — collapsed into one opt-in.
 *
 *  🔑 THIS PROJECTS THE FIRST WITHOUT CLAIMING THE SECOND. `additionalProperties`
 *  stays TRUE, which is not a concession — it is the literally accurate statement
 *  of what the runtime does. The door now describes the arguments it knows and
 *  admits the ones it does not, which is exactly the dispatcher's behaviour.
 *
 *  ⚠ NOT A GATE, AND MUST NEVER READ AS ONE. Nothing here is enforced at
 *  dispatch. A caller may still send anything. `required` is carried through
 *  because it is real vendor information that helps a model build a working call,
 *  NOT because omitting the field would be refused — it would not be. */
export const projectDescriptiveRequestSchemaForJsonSchema = (schema: unknown): unknown => {
  /** ⚠ A STACK GUARD, NOT A POLICY BOUND — and deliberately NOT `MAX_SCHEMA_DEPTH`.
   *  That rule is 8 and belongs to the CLOSED subset; a descriptive schema is
   *  under no such limit, and the corpus already holds one nested 9 deep. Reusing
   *  8 here meant that operation returned UNPROJECTED, carrying `nullable` past
   *  the projection that exists to remove it — the cap silently doing the
   *  opposite of the function's job. 32 is far above anything real and only ever
   *  stops runaway recursion. */
  const PROJECTION_DEPTH_CAP = 32;
  /** ⚠ EVERY PLACE A SUBSCHEMA CAN HIDE, not just the two obvious ones. The first
   *  version recursed through `properties` and `items` alone and left `nullable`
   *  in place on a schema that reached it under `oneOf` — the projection walking
   *  past the exact keyword it exists to remove. `enum` and `required` are
   *  deliberately absent: they hold VALUES and names, not schemas. */
  const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
  const SCHEMA_LIST_KEYWORDS = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);
  const SCHEMA_KEYWORDS = new Set(['items', 'not', 'contains', 'propertyNames']);
  const project = (node: unknown, depth: number): unknown => {
    if (!isRecord(node) || depth > PROJECTION_DEPTH_CAP) return node;
    const out: Record<string, unknown> = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (OPENAPI_ONLY_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value)) {
        const mapped: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) mapped[name] = project(child, depth + 1);
        out[keyword] = mapped;
        continue;
      }
      if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
        out[keyword] = value.map((child) => project(child, depth + 1));
        continue;
      }
      if (SCHEMA_KEYWORDS.has(keyword)) {
        out[keyword] = Array.isArray(value)
          ? value.map((child) => project(child, depth + 1))
          : project(value, depth + 1);
        continue;
      }
      // `additionalProperties` is a BOOLEAN here almost always, but JSON Schema
      // allows a subschema — project that shape, pass the boolean through.
      if (keyword === 'additionalProperties' && isRecord(value)) {
        out[keyword] = project(value, depth + 1);
        continue;
      }
      out[keyword] = value;
    }
    return out;
  };
  const projected = project(projectClosedRequestSchemaForJsonSchema(schema), 0);
  if (!isRecord(projected)) return projected;
  // ⛔ Never let a projection claim closure the runtime does not enforce.
  return { ...projected, additionalProperties: true };
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
    // `testDeclaredPattern` is `new RegExp(pattern).test(value)` with the head of
    // the corpus routed to linear implementations of the same languages, and the
    // tail cached instead of recompiled per dispatch. See `declared-pattern.ts`.
    if (typeof property.pattern === 'string' && !testDeclaredPattern(property.pattern, value)) {
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

// ════════════════════════════════════════════════════════════════
// Catastrophic-backtracking probe — the install-time gate
// ════════════════════════════════════════════════════════════════

/** ⛔⛔ A `pattern` IS THE ONLY UNBOUNDED COMPUTATION IN A "CLOSED" SCHEMA.
 *
 *  It is compiled and run per dispatch inside the D-165 gateway
 *  (`catalog-gateway.ts`) and the D-261 preapproval lane, against CALLER-supplied
 *  values, *"before an approval pause/session-grant match can confer authority"*.
 *  Node's loop is single-threaded and a synchronous regex is not interruptible,
 *  so a pattern with catastrophic backtracking stops the WHOLE SERVER — not one
 *  request. Measured through `closedRequestSchemaViolation` at an ordinary
 *  `maxLength: 100`: `^(a+)+$` against `'a'×32 + '!'` blocks for 43 seconds.
 *
 *  Definition time only checks that the pattern COMPILES. This is the other half.
 *
 *  ⚠ EMPIRICAL, NOT A PROOF, AND THE LIMIT IS STATED RATHER THAN IMPLIED. It
 *  drives each pattern with adversarial fuel and times it; one that blows up only
 *  on input shapes outside the table passes. The tempting static rule — reject
 *  nested quantifiers — is WORSE, because `^(a|a)*$` is star height ONE and took
 *  19 seconds in the same measurement. A rule that catches `(a+)+` and misses
 *  `(a|a)*` is assurance-shaped non-assurance.
 *
 *  ⚠ THE PROBE RUNS THE DANGEROUS REGEX, so it is bounded on both axes: each
 *  measurement stops the pattern's escalation at the first superlinear sign, and
 *  a whole-schema deadline stops the sweep. A schema that cannot be probed inside
 *  its deadline is REFUSED — being too slow to check is itself the finding.
 *
 *  See internal design notes. */

/** Single-character fuel: the classic `(a+)+` shape chews one repeated char. */
const REDOS_CHAR_FUEL: ReadonlyArray<string> =
  [' ', 'a', '0', 'x', '-', '	', '{', 'A', '9', '.', '_', '/', ':', '@'];

/** Tails that force the match to FAIL, which is when backtracking explodes. */
const REDOS_TAILS: ReadonlyArray<string> = ['!', '', 'é', '"'];

/** Structured fuel — the shapes that need STRUCTURE to blow up: an email
 *  local-part, a dotted path, a scheme. Generic single-character fuel misses
 *  these entirely, which is the difference between a scan and a scan that
 *  looked. */
const REDOS_SHAPE_FUEL: ReadonlyArray<readonly [string, (n: number) => string]> = [
  ['local.parts', (n) => 'a.'.repeat(n)],
  ['local.parts+!', (n) => `${'a.'.repeat(n)}!`],
  ['at then junk', (n) => `${'a'.repeat(n)}@${'b'.repeat(n)}!`],
  ['dots+at', (n) => `${'a.'.repeat(n)}@b`],
  ['dashes', (n) => `${'a-'.repeat(n)}!`],
  ['slashes', (n) => `${'a/'.repeat(n)}!`],
  ['colons', (n) => `${'a:'.repeat(n)}!`],
  ['spaces+brace', (n) => `${' '.repeat(n * 2)}{`],
  ['brace open only', (n) => '{'.repeat(n) + ' '.repeat(n)],
  ['digits+sign', (n) => `${'-'.repeat(n)}${'0'.repeat(n)}!`],
  ['hex-ish', (n) => `${'ab'.repeat(n)}!`],
  ['proto', (n) => `${'a'.repeat(n)}://${'b'.repeat(n)}`],
  ['iso-ish', (n) => `${'2020-02-'.repeat(n)}!`],
];

const REDOS_CHAR_LENGTHS: ReadonlyArray<number> = [10, 16, 22, 26, 30];
const REDOS_SHAPE_SIZES: ReadonlyArray<number> = [6, 10, 14, 18, 22];

/** ⛔⛔ PHASE TWO — LONG INPUT, AND IT RUNS ONLY AFTER THE SHORT LADDER IS CLEAN.
 *  The ladder above tops out near 44 characters, which is enough for an
 *  EXPONENTIAL pattern and blind to a QUADRATIC one that only bites in the
 *  thousands. A MongoDB pattern costing 3.3s at the 65,536 `maxLength` its
 *  generator handed it passed this gate and reached 21 shipped operations.
 *
 *  ⚠ THE ORDER IS LOAD-BEARING, NOT A CONVENIENCE. Small ADDITIVE rungs must run
 *  first because an exponential pattern doubles per character: a x4 jump goes
 *  from 40ms to hours in one step, and the early stop cannot help because it is
 *  only consulted AFTER a measurement returns. A draft of this escalated x4 from
 *  16 and had to be killed after ten minutes on `^(a+)+$`. Reaching here means
 *  the pattern is not exponential, so each geometric rung costs a predictable
 *  multiple and the stop lands inside one. */
const REDOS_LONG_SIZES: ReadonlyArray<number> = [64, 256, 1_024, 4_096, 16_384, 65_536];

/** ⛔ THE LAST RUNG IS THE BOUND ITSELF. The geometric rungs used to stop at the
 *  last one that fit, so a property bounded between two of them was never
 *  measured at its own length: at `maxLength: 16_383` the top rung was 4,096, and
 *  a quadratic pattern costs up to 16x more at the bound than there.
 *  `^\s*(?:a|b)*a(?:a|b)*\s*c$` was admitted that way, costing 25 ms at 4,097
 *  characters and 367 ms at 16,383 (over a second in the 2026-09-24 audit's
 *  run), on every call that carried a long value. The bound is at most 4x the
 *  rung before it, so measuring there costs what any geometric step costs.
 *  Mirrored as `phaseTwoRungs` in `scripts/lib/pattern-cost.mjs`. */
const redosLongRungs = (bound: number): number[] => [
  ...REDOS_LONG_SIZES.filter((size) => size < bound),
  bound,
];

/** The length probed when a property declares no `maxLength`: unbounded in the
 *  schema means unbounded at the gateway. */
export const REDOS_UNBOUNDED_PROBE = 65_536;

/** ⚠⚠ SHAPES DERIVED FROM THE SHIPPED CORPUS, because the thirteen above reach
 *  less of it than they look. Measured over `community/packs`: the char+shape
 *  tables reach 122 of 255 distinct patterns — 133 rejected every string at
 *  character 0, so the probe timed them failing instantly and admitted them on
 *  the strength of it. The dark set was legible once looked at: JSON arrays
 *  (there was a `{…}` shape and no `[…]`), UUID frames, `AC`+32-hex vendor ids,
 *  `#rrggbb` colours, ISO timestamps, comma/semicolon/query separators.
 *
 *  🔑 A SHAPE EARNS ITS PLACE BY EXERCISING SOMETHING. A bank of fourteen
 *  textbook "catastrophic" regexes (email, URL, path, CSV, semver, base64…) was
 *  driven against this probe: four were caught and ten are BENIGN in V8 —
 *  unambiguous per iteration, so admitting them was correct and their "misses"
 *  were not gaps. Folklore is not evidence.
 *
 *  ⛔ MIRRORED IN `scripts/lib/pattern-cost.mjs`, which a `generate-*-packs.mjs`
 *  uses because it runs under raw node and cannot import contracts — the same
 *  reason `scripts/lib/closed-schema-shape.mjs` exists. Two tables holding one
 *  rule is the shape that already went wrong here once, so
 *  `pattern-cost-parity.test.ts` drives BOTH over the shipped corpus and reds
 *  from either side. */
const REDOS_CORPUS_FUEL: ReadonlyArray<readonly [string, (n: number) => string]> = [
  ['json object', (n) => `{${' '.repeat(n)}}`],
  ['json array', (n) => `[${' '.repeat(n)}]`],
  ['bracket open only', (n) => '['.repeat(n) + ' '.repeat(n)],
  ['dashed hex runs', (n) => `${'0123abcd-'.repeat(n)}!`],
  ['uuid-ish', (n) => `${'0123abcd'.repeat(n)}-0000-0000-0000-${'0'.repeat(n)}`],
  ['vendor sid', (n) => `AC${'0a'.repeat(n)}!`],
  ['hex colour', (n) => `#${'aF0'.repeat(n)}!`],
  ['email dotted domain', (n) => `${'a'.repeat(n)}@${'b.'.repeat(n)}com`],
  ['commas', (n) => `${'a,'.repeat(n)}!`],
  ['query pairs', (n) => `${'a=b&'.repeat(n)}!`],
  ['semicolons', (n) => `${'a;'.repeat(n)}!`],
  ['snake ids', (n) => `${'a_'.repeat(n)}!`],
  ['mixed case', (n) => `${'aA'.repeat(n)}!`],
  ['word alternation', (n) => `${'majority'.repeat(n)}!`],
  ['iso timestamps', (n) => `${'2020-01-01T00:00:00Z'.repeat(n)}!`],
  ['decimals', (n) => `${'0'.repeat(n)}.${'0'.repeat(n)}!`],
  ['scheme literal', (n) => `https://${'a'.repeat(n)}`],
  ['prefixed id', (n) => `ab_${'a'.repeat(n)}!`],
  ['sort spec', (n) => `${'ab:asc,'.repeat(n)}!`],
  ['url-encoded', (n) => `%2F${'0a'.repeat(n)}!`],
];

/** ⛔ FUEL THAT CANNOT BE ENUMERATED MUST BE DERIVED. A pattern anchored on a
 *  vendor's literal token — `^ctm_[a-z0-9]+$`, `^pfl_.+$`,
 *  `^(txn_[a-z0-9]+)(,…)*$` — rejects every generic string at character 0, and
 *  the prefixes are one per vendor per resource with no end to them. Reading the
 *  leading literal OFF THE PATTERN turns an unenumerable class into a derived
 *  one; it moved corpus coverage from 138 to 198 of 255 on its own.
 *
 *  ⚠ Only the LEADING run, and only one paren in (the corpus writes comma-joined
 *  enums as `^(ctm_[a-z0-9]+)(,…)*$`). Anything deeper is parsing a regex with a
 *  regex, which is how an earlier sweep matched `hex` inside `digest('hex')` and
 *  hid 131 operations. A misread prefix costs one wasted fuel string; an
 *  invented one could mask a finding. */
const REDOS_LITERAL_PREFIX = /^\^\(?(?:\?:)?((?:[A-Za-z0-9_-]|\\[.$*+?^{}()|[\]\\/-]){2,16})/;

const redosDerivedPrefix = (source: string): string | undefined => {
  const hit = REDOS_LITERAL_PREFIX.exec(source);
  if (hit === null) return undefined;
  const literal = hit[1]!.replace(/\\(.)/g, '$1');
  return literal.length >= 2 ? literal : undefined;
};

/** The default `per_probe_ms`: a single measurement above it is a finding. Why
 *  250 and not 50 is on `per_probe_ms` below. Exported so the generator-side
 *  mirror (`scripts/lib/pattern-cost.mjs`) is held to the same bar by
 *  `pattern-cost-parity.test.ts`: when this moved from 50, the mirror stayed
 *  behind (found by the 2026-09-24 audit). */
export const REDOS_PER_PROBE_MS = 250;

export interface RedosProbeOptions {
  /** A single measurement above this is superlinear.
   *
   *  ⛔⛔ THE MARGIN WAS NOT ENORMOUS, AND THIS COMMENT USED TO SAY IT WAS. It
   *  read: "a benign pattern's ENTIRE sweep — ~345 measurements — costs 0.3–1.1
   *  ms, so one measurement is around 3 MICROSECONDS … a hundredfold slowdown
   *  under load still would not reach it", and set the bar at 50. That is true
   *  of the MEDIAN and false of the TAIL, which is the only part that decides
   *  whether a legitimate pack is refused.
   *
   *  🔑 MEASURED 2026-09-23 over every distinct (pattern, maxLength) pair in
   *  `community/packs` — 370 of them, keyed the way the verdict cache is, because
   *  the BOUND decides how deep the ladder goes and therefore what a measurement
   *  costs. Median whole sweep: 2 ms. Worst SINGLE measurement: 27 ms, against a
   *  50 ms bar — 1.9x headroom. Six more configurations sit within 6x, spread
   *  across mongodb-atlas, docker, tailscale-cli, helm and df. A 1.9x stall is
   *  not a pathology; it is an ordinary afternoon on a loaded laptop, and it
   *  refuses the pack.
   *
   *  ⚠ THE RETRY DOES NOT COVER IT. `suspect()` re-measures on the premise that
   *  "a scheduling hiccup does not repeat on demand". SUSTAINED load is not a
   *  hiccup — the second measurement is drawn from the same slow regime — so the
   *  confirmation confirms the noise. Reproduced: 1 finding in 10 runs under 20
   *  busy processes on 10 cores, 0 in 3 unloaded.
   *
   *  ⛔ RAISING THE BAR COSTS NO DETECTION, BECAUSE THE THING IT LOOKS FOR IS
   *  EXPONENTIAL, NOT 2x. `^(a+)+$` blocks for 43 SECONDS. All seven known
   *  catastrophic patterns still trip at 250 (`^(a+)+$`, `^(a|a)*$`,
   *  `^(x+x+)+y$`, `^(\s*\w+)+$`, `^([a-zA-Z]+)*$`, `(a|a?)+$`,
   *  `^(([a-z])+.)+[A-Z]([a-z])+$`); only the input length at which they trip
   *  moves, 23 characters to 27. Whole-corpus probe cost 4,273 ms -> 4,572 ms
   *  (+7%), 0 findings either way. Headroom on the worst shipped pattern:
   *  1.9x -> 9.3x. Default 250.
   *
   *  ⚠ A PATTERN THAT IS GENUINELY CATASTROPHIC NOW COSTS 1.1–5.9 s TO CONVICT,
   *  because the ladder walks four more characters of an exponential curve. Three
   *  of the seven exceed `budget_ms` and come back as `fuel: 'budget exhausted'`
   *  instead of a precise rung. That is still a FINDING and still refuses the
   *  pack — the reason is coarser, the verdict is not. */
  readonly per_probe_ms?: number;
  /** Whole-schema deadline. Default 3000.
   *
   *  ⚠ EXHAUSTING IT RETURNS A FINDING, i.e. a REFUSAL, and unlike `suspect()`
   *  there is no retry on that path. It is reachable only by a pattern expensive
   *  enough to burn 3 s on one schema — no shipped pattern comes close (worst
   *  whole sweep: 648 ms) — but a pack refused for "budget exhausted" was not
   *  proven catastrophic, only slow. */
  readonly budget_ms?: number;
  /** The property's declared `maxLength` — how far a value can actually go.
   *  Absent means unbounded, probed to {@link REDOS_UNBOUNDED_PROBE}.
   *
   *  ⛔ THIS IS THE QUESTION, NOT A TUNING KNOB. `^-?[0-9]+$` at `maxLength: 20`
   *  needs no long probing; the same pattern unbounded is worth minutes. Asking
   *  "is this slow" without the bound asks something nobody needs answered. */
  readonly max_length?: number;
  /** Injectable clock + timer for deterministic tests. */
  readonly now?: () => number;
}

export interface RedosFinding {
  /** The offending pattern source. */
  readonly pattern: string;
  /** Which fuel provoked it, for reproducing. */
  readonly fuel: string;
  /** Input length at which it blew up. */
  readonly input_length: number;
  /** Measured milliseconds (the confirming run). */
  readonly ms: number;
}

const nowMs = (): number => Date.now();

/** Probe ONE pattern. Returns the finding, or null when it stays linear.
 *
 *  ⚠ A SUSPECT IS RE-MEASURED BEFORE IT IS REPORTED. This is a timing check
 *  running at install time on a machine that may be loaded, and a false refusal
 *  of a legitimate pack is worse than a missed probe: a scheduling hiccup does
 *  not repeat on demand, a catastrophic regex does. One retry turns the flake
 *  into a retry and leaves the real signal untouched. */
/** ⚠ VERDICTS ARE CACHED, because the corpus repeats 255 distinct patterns
 *  ~70x each and install re-probes every occurrence. Measured over
 *  `community/packs`: 18.4s uncached for 24,157 schemas, with one pack at
 *  1,181ms — a cost paid on the OWNER'S machine, at install, for an answer
 *  already computed.
 *
 *  ⚠ IT DOES NOT FILTER ON PROVENANCE, AND THIS COMMENT USED TO CLAIM IT DID.
 *  It read "Only a CONFIRMED verdict is stored … caching before that would
 *  freeze a scheduling hiccup into a permanent false refusal." `cacheable` is
 *  decided from the OPTIONS — no injected clock, no overridden thresholds — and
 *  never from what came back, so a `budget exhausted` finding (which never saw
 *  `suspect()`) and a finding confirmed twice under load are both stored like
 *  any other. Within one process a single false positive is therefore frozen for
 *  every later occurrence of that pattern.
 *
 *  🔑 THE FIX WAS THE THRESHOLD, NOT THE CACHE. Raising `per_probe_ms` to 250
 *  took the worst shipped pattern from 1.9x headroom to 9.3x; a filter here would
 *  have narrowed the blast radius of a false positive while leaving its rate
 *  alone. Worth revisiting only if one is ever observed at 250.
 *
 *  The key carries the bound because the same pattern is free at 20 and ruinous
 *  unbounded. Bounded so a hostile manifest cannot grow it without limit. */
const REDOS_VERDICT_CACHE_MAX = 4_096;
const redosVerdicts = new Map<string, RedosFinding | null>();

export const probePatternForBacktracking = (
  source: string,
  options: RedosProbeOptions = {},
): RedosFinding | null => {
  // An injected clock means a deterministic test, never a real measurement —
  // such a call must not read or write the shared verdict cache.
  const cacheable = options.now === undefined
    && options.per_probe_ms === undefined
    && options.budget_ms === undefined;
  const cacheKey = `${source}\u0000${options.max_length ?? 'none'}`;
  if (cacheable) {
    const hit = redosVerdicts.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const verdict = probePatternForBacktrackingUncached(source, options);
  if (cacheable && redosVerdicts.size < REDOS_VERDICT_CACHE_MAX) {
    redosVerdicts.set(cacheKey, verdict);
  }
  return verdict;
};

const probePatternForBacktrackingUncached = (
  source: string,
  options: RedosProbeOptions,
): RedosFinding | null => {
  const perProbe = options.per_probe_ms ?? REDOS_PER_PROBE_MS;
  const budget = options.budget_ms ?? 3_000;
  const clock = options.now ?? nowMs;
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    return null; // an uncompilable pattern is the definition check's problem
  }
  const startedAt = clock();
  const measure = (input: string): number => {
    const t0 = clock();
    try {
      re.test(input);
    } catch {
      // Some engines throw on pathological input; that is not this check.
    }
    return clock() - t0;
  };
  const suspect = (input: string, fuel: string): RedosFinding | null => {
    if (measure(input) <= perProbe) return null;
    // Confirm — see the note above.
    const second = measure(input);
    if (second <= perProbe) return null;
    return { pattern: source, fuel, input_length: input.length, ms: second };
  };

  for (const fuel of REDOS_CHAR_FUEL) {
    for (const tail of REDOS_TAILS) {
      for (const length of REDOS_CHAR_LENGTHS) {
        if (clock() - startedAt > budget) {
          return { pattern: source, fuel: 'budget exhausted', input_length: length, ms: clock() - startedAt };
        }
        const hit = suspect(fuel.repeat(length) + tail, JSON.stringify(fuel + tail));
        if (hit) return hit;
      }
    }
  }
  for (const [label, make] of REDOS_SHAPE_FUEL) {
    for (const size of REDOS_SHAPE_SIZES) {
      if (clock() - startedAt > budget) {
        return { pattern: source, fuel: 'budget exhausted', input_length: size, ms: clock() - startedAt };
      }
      const hit = suspect(make(size), label);
      if (hit) return hit;
    }
  }
  // ── Phase two — long input, bounded by what the property admits ────────────
  // Reaching here means the short ladder found nothing, so the pattern is not
  // exponential and geometric escalation is safe. See REDOS_LONG_SIZES.
  const bound = Math.min(
    typeof options.max_length === 'number'
      && Number.isFinite(options.max_length)
      && options.max_length > 0
      ? options.max_length
      : REDOS_UNBOUNDED_PROBE,
    REDOS_UNBOUNDED_PROBE,
  );
  const prefix = redosDerivedPrefix(source);
  for (const size of redosLongRungs(bound)) {
    // ⛔ THE CHAR FUEL BELONGS HERE TOO, AND LEAVING IT OUT COST A KNOWN
    //   POSITIVE. `[\s\S]*\S[\s\S]*` only blows up on input with NO
    //   non-space in it — every structured shape carries one, so the match
    //   succeeds instantly and the pattern reads clean. A single repeated
    //   character is not a lesser case of a structured shape; it is the case
    //   that some patterns need. Found by `pattern-cost-parity.test.ts`.
    for (const fuel of REDOS_CHAR_FUEL) {
      for (const tail of REDOS_TAILS) {
        if (clock() - startedAt > budget) {
          return { pattern: source, fuel: 'budget exhausted', input_length: size, ms: clock() - startedAt };
        }
        const hit = suspect(fuel.repeat(size) + tail, JSON.stringify(fuel + tail));
        if (hit) return hit;
      }
    }
    for (const [label, make] of [...REDOS_SHAPE_FUEL, ...REDOS_CORPUS_FUEL]) {
      if (clock() - startedAt > budget) {
        return { pattern: source, fuel: 'budget exhausted', input_length: size, ms: clock() - startedAt };
      }
      const hit = suspect(make(Math.max(1, size >> 1)), label);
      if (hit) return hit;
    }
    if (prefix !== undefined) {
      const room = Math.max(1, size - prefix.length);
      for (const body of ['a', '0', 'aA', 'a-', 'a_']) {
        if (clock() - startedAt > budget) {
          return { pattern: source, fuel: 'budget exhausted', input_length: size, ms: clock() - startedAt };
        }
        const filled = prefix + body.repeat(Math.ceil(room / body.length)).slice(0, room);
        const hit = suspect(filled, `derived prefix ${JSON.stringify(prefix)}`)
          ?? suspect(`${filled}!`, `derived prefix ${JSON.stringify(prefix)}+!`);
        if (hit) return hit;
      }
    }
  }
  return null;
};

/** Every `pattern` in a closed request schema, in declaration order, WITH the
 *  bound its own property declares.
 *
 *  ⛔ IT USED TO WALK TOP-LEVEL `properties` ONLY, AND TO DISCARD `maxLength`.
 *  Both were holes. 322 pattern occurrences across 57 distinct patterns sit
 *  BELOW the top level in the shipped corpus — inside `items`, inside a nested
 *  object, inside a union branch — and the probe never saw one of them. And the
 *  bound was sitting in the same object it read the pattern out of, which is the
 *  one number that says how far to probe. */
const schemaPatterns = (
  schema: unknown,
): Array<{ path: string; source: string; maxLength?: number }> => {
  const out: Array<{ path: string; source: string; maxLength?: number }> = [];
  if (!isClosedRequestSchema(schema)) return out;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const pattern = record.pattern;
    if (typeof pattern === 'string' && pattern.length > 0) {
      const max = record.maxLength;
      out.push({
        path,
        source: pattern,
        ...(typeof max === 'number' ? { maxLength: max } : {}),
      });
    }
    if (record.properties !== null && typeof record.properties === 'object') {
      for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
        visit(child, path.length === 0 ? key : `${path}.${key}`, depth + 1);
      }
    }
    if (record.items !== undefined) visit(record.items, `${path}[]`, depth + 1);
    for (const branch of ['anyOf', 'oneOf', 'allOf'] as const) {
      const list = record[branch];
      if (Array.isArray(list)) {
        list.forEach((child, i) => visit(child, `${path}.${branch}[${i}]`, depth + 1));
      }
    }
  };
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const [key, raw] of Object.entries(properties)) visit(raw, key, 1);
  return out;
};

/** Human-readable issues for a schema whose patterns backtrack catastrophically.
 *
 *  Shaped to sit beside `closedRequestSchemaDefinitionIssues` at the same call
 *  site — one returns "this schema is malformed", the other "this schema is a
 *  denial of service". */
export const closedRequestSchemaBacktrackingIssues = (
  schema: unknown,
  options: RedosProbeOptions = {},
): string[] => {
  const issues: string[] = [];
  const clock = options.now ?? nowMs;
  const budget = options.budget_ms ?? 3_000;
  const startedAt = clock();
  for (const { path, source, maxLength } of schemaPatterns(schema)) {
    const remaining = budget - (clock() - startedAt);
    if (remaining <= 0) {
      issues.push(
        `property '${path}' pattern could not be checked within the ${budget}ms budget `
        + '— the schema has too many patterns, or an earlier one is already pathological',
      );
      break;
    }
    const finding = probePatternForBacktracking(source, {
      ...options,
      budget_ms: remaining,
      ...(maxLength === undefined ? {} : { max_length: maxLength }),
    });
    if (finding === null) continue;
    issues.push(
      `property '${path}' pattern backtracks catastrophically `
      + `(${Math.round(finding.ms)}ms on ${finding.input_length} characters of ${finding.fuel}) — `
      + 'it runs inside the gateway against caller-supplied values, on a thread that cannot be '
      + 'interrupted. Rewrite without ambiguous alternation or nested quantifiers.',
    );
  }
  return issues;
};
