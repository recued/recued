import type { RestRequestJsonSpec, RestResponseJsonSpec } from '@recued/contracts';

export interface RestJsonField { key: string; type: 'object' | 'array' | 'string'; description: string; required: boolean; values?: readonly string[] }
type Field = Omit<RestJsonField, 'key'>;
const unsafeIntegers: Record<RestResponseJsonSpec['unsafe_integers'], string> = {
  string: 'Preserve integer literals outside JavaScript safe-number bounds as exact decimal strings. Safe integers, floats, exponent values, booleans and existing strings keep their normal JSON types. This is an explicit response parsing opt-in; file capture is incompatible.',
};
export const restUnsafeIntegersAllowed = (value: unknown): value is RestResponseJsonSpec['unsafe_integers'] => typeof value === 'string' && Object.hasOwn(unsafeIntegers, value);
const request: Record<keyof RestRequestJsonSpec, Field> = {
  decimal_integer_fields: { type: 'array', required: true, description: 'Unique top-level field or field[] selectors. A scalar uses a declared body.field string; an array uses a declared body.field array with string items in request_schema. Values are decimal strings serialized as unquoted JSON integers. Names and provider integer semantics remain authored.' },
};
const response: Record<keyof RestResponseJsonSpec, Field> = {
  unsafe_integers: { type: 'string', required: true, description: unsafeIntegers.string, values: Object.keys(unsafeIntegers) },
};
export const restJsonFields = (section: 'binding' | 'request' | 'response'): RestJsonField[] => {
  const fields: Record<string, Field> = section === 'request' ? request : section === 'response' ? response : {
    request_json: { type: 'object', required: false, description: 'Opt in to exact integer request serialization. Requires POST/PUT/PATCH, matching string/array argument and schema declarations, and application/json when a static Content-Type is supplied. It does not choose any fields or values.' },
    response_json: { type: 'object', required: false, description: unsafeIntegers.string },
  };
  return Object.entries(fields).map(([key, field]) => ({ key, ...field }));
};
/** The same closed selector grammar and schema test used by canonical validation. */
export const restIntegerSelector = (value: unknown): { key: string; array: boolean; argument: string } | undefined => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/.test(value)) return;
  const array = value.endsWith('[]'), key = array ? value.slice(0, -2) : value;
  return { key, array, argument: 'body.' + key };
};
export const restIntegerSchemaMatches = (array: boolean, type: unknown, itemType: unknown): boolean => type === (array ? 'array' : 'string') && (!array || itemType === 'string');
/** Eligibility describes local type agreement, never the provider's integer semantics. */
export const restIntegerCandidate = (argument: unknown, type: unknown, propertyType: unknown, itemType: unknown): { selector: string; argument: string; array: boolean } | undefined => {
  if (typeof argument !== 'string' || !argument.startsWith('body.')) return;
  const expected = type === undefined ? 'string' : type;
  if (expected !== 'string' && expected !== 'array') return;
  const selector = argument.slice(5) + (expected === 'array' ? '[]' : ''), parsed = restIntegerSelector(selector);
  if (!parsed || !restIntegerSchemaMatches(parsed.array, propertyType, itemType)) return;
  return { selector, argument, array: parsed.array };
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Locate one existing shape error without changing its code, message or count. */
export const restJsonShapeTarget = (section: 'request' | 'response', value: unknown): { path: (string | number)[]; key?: string } => {
  if (!object(value)) return { path: [] };
  const expected = section === 'request' ? 'decimal_integer_fields' : 'unsafe_integers';
  const unknown = Object.keys(value).find(key => key !== expected);
  if (unknown !== undefined) return { path: [unknown], key: unknown };
  if (section === 'request' && Array.isArray(value[expected])) {
    const seen = new Set<string>(), entries = value[expected] as unknown[];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!restIntegerSelector(entry) || seen.has(entry as string)) return { path: [expected, index] };
      seen.add(entry as string);
    }
  }
  return { path: [expected] };
};
export const restJsonTargetSuffix = (path: readonly (string | number)[]) => path.map(key => typeof key === 'number' ? '[' + key + ']' : /^[A-Za-z_]\w*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']').join('');
