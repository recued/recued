/** Descriptive response declarations are never a runtime wire allowlist.
 * Inspect explicit properties/items only; do not resolve refs or merge branches. */
export const RESPONSE_SCHEMA_MAX_FIELDS = 500;
export const RESPONSE_SCHEMA_HELP = 'Informational authored response schema. It does not validate returned data, establish a recipe result envelope or grant access. Open objects remain open; references and alternative branches are not resolved.';
export interface ResponseSchemaEntry {
  path: (string | null)[];
  schemaPath: (string | number)[];
  required: boolean;
  constraints: Record<string, unknown>;
  limitations: string[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalarKeywords = ['type', 'title', 'description', 'enum', 'const', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'] as const;
export const responseSchemaEntries = (schema: unknown): { entries: ResponseSchemaEntry[]; complete: boolean; limited: boolean } => {
  const entries: ResponseSchemaEntry[] = [], seen = new Set<object>(); let limited = false;
  const walk = (value: unknown, path: ResponseSchemaEntry['path'], schemaPath: ResponseSchemaEntry['schemaPath'], required: boolean, depth: number) => {
    if (entries.length >= RESPONSE_SCHEMA_MAX_FIELDS || depth > 16) { limited = true; return; }
    const constraints: Record<string, unknown> = {}, limitations: string[] = [];
    const entry = { path, schemaPath, required, constraints, limitations }; entries.push(entry);
    if (typeof value === 'boolean') { constraints.boolean_schema = value; return; }
    if (!object(value)) { limitations.push('This declaration is not an object or boolean schema.'); return; }
    if (seen.has(value)) { limitations.push('Repeated or cyclic schema object is not expanded.'); return; } seen.add(value);
    for (const key of scalarKeywords) if (Object.hasOwn(value, key)) constraints[key] = value[key];
    const known = new Set<string>([...scalarKeywords, 'properties', 'required', 'items', 'additionalProperties', '$schema', '$id']);
    if (Object.keys(value).some(key => !known.has(key))) limitations.push('Other schema keywords are not interpreted; only explicit properties/items are walked.');
    for (const key of ['$ref', '$dynamicRef', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'prefixItems', 'unevaluatedProperties', 'unevaluatedItems']) {
      if (Object.hasOwn(value, key)) limitations.push(key + ' is not resolved; no combined field shape is inferred.');
    }
    if (Object.hasOwn(value, 'patternProperties')) limitations.push('patternProperties is not expanded into named fields.');
    if (Object.hasOwn(value, 'additionalProperties')) {
      constraints.additionalProperties = typeof value.additionalProperties === 'boolean' ? value.additionalProperties : 'schema (not expanded)';
      if (typeof value.additionalProperties !== 'boolean') limitations.push('additionalProperties is not expanded into named fields.');
    } else if (value.type === 'object' || Object.hasOwn(value, 'properties')) constraints.additionalProperties = 'unspecified (not closed by this inspector)';
    if (Object.hasOwn(value, 'required') && (!Array.isArray(value.required) || !value.required.every(item => typeof item === 'string'))) limitations.push('Malformed required metadata is not interpreted.');
    const requiredNames = Array.isArray(value.required) && value.required.every(item => typeof item === 'string') ? new Set(value.required) : new Set();
    if (object(value.properties)) {
      for (const key of Object.keys(value.properties)) {
        if (entries.length >= RESPONSE_SCHEMA_MAX_FIELDS) { limited = true; break; }
        walk(value.properties[key], [...path, key], [...schemaPath, 'properties', key], requiredNames.has(key), depth + 1);
      }
    } else if (Object.hasOwn(value, 'properties')) limitations.push('Malformed properties metadata is not expanded.');
    if (Object.hasOwn(value, 'items')) {
      if (Array.isArray(value.items)) limitations.push('Tuple items are not expanded into a single item shape.');
      else walk(value.items, [...path, null], [...schemaPath, 'items'], false, depth + 1);
    }
  };
  walk(schema, [], [], false, 0);
  return { entries, limited, complete: !limited && entries.every(entry => !entry.limitations.length) };
};
