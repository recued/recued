import { closedRequestSchemaDefinitionIssues } from '@recued/contracts';
import type { ClosedInputSchema } from './closed-inputs.js';

export interface ClosedSchemaField { key: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description: string }
const descriptions: Record<string, Omit<ClosedSchemaField, 'key'>> = {
  type: { type: 'string', description: 'Choose a type supported by the existing closed request-schema contract.' },
  additionalProperties: { type: 'boolean', description: 'Explicit false opts into the enforced closed subset. Every nested object must also be closed. Open/descriptive schemas keep their own behavior.' },
  properties: { type: 'object', description: 'Declare accepted property names and their schemas. At the root these must align with the operation arguments.' },
  required: { type: 'array', description: 'Names of properties required in this object. Every name must exist in this object’s properties; names are unique.' },
  enum: { type: 'array', description: 'A nonempty finite list of allowed literal values matching the declared scalar type. A string needs maxLength or a finite enum.' },
  minLength: { type: 'number', description: 'Nonnegative minimum string length, no greater than maxLength.' },
  maxLength: { type: 'number', description: 'Nonnegative maximum string length. Every closed string needs maxLength or a finite enum.' },
  pattern: { type: 'string', description: 'Runtime string pattern. The editor checks schema syntax but defers input pattern matching.' },
  minimum: { type: 'number', description: 'Finite minimum numeric value, no greater than maximum.' },
  maximum: { type: 'number', description: 'Finite maximum numeric value, no less than minimum.' },
  items: { type: 'object', description: 'Schema for every array item. The closed subset supports string, number, integer, boolean or object items.' },
  minItems: { type: 'number', description: 'Nonnegative minimum array length, no greater than maxItems.' },
  maxItems: { type: 'number', description: 'Required nonnegative maximum length for arrays and file_ref lists. Choose a bound appropriate for the operation.' },
  uniqueItems: { type: 'boolean', description: 'True requires literal items to be unique. Uniqueness involving runtime references is deferred by the editor.' },
};
export const closedSchemaFields = (type: string | undefined, root = false): ClosedSchemaField[] => {
  const keys = root || type === 'object' ? ['type', 'additionalProperties', 'properties', 'required']
    : type === 'array' ? ['type', 'items', 'minItems', 'maxItems', 'uniqueItems']
      : type === 'file_ref[]' ? ['type', 'minItems', 'maxItems'] : type === 'file_ref' ? ['type']
        : type === 'string' ? ['type', 'enum', 'minLength', 'maxLength', 'pattern']
          : type === 'number' || type === 'integer' ? ['type', 'enum', 'minimum', 'maximum'] : type === 'boolean' ? ['type', 'enum'] : ['type'];
  return keys.map(key => ({ key, ...descriptions[key]! }));
};
/** Validate the candidate vocabulary against contracts, including array-item restrictions. */
export const closedSchemaTypes = (root = false, arrayItem = false): string[] => {
  if (root) return ['object'];
  const candidates = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'file_ref', 'file_ref[]'];
  return candidates.filter(type => {
    const property = { type, ...(type === 'string' ? { maxLength: 1 } : {}),
      ...(type === 'object' ? { additionalProperties: false, properties: {} } : {}),
      ...(type === 'array' ? { maxItems: 1, items: { type: 'boolean' } } : {}),
      ...(type === 'file_ref[]' ? { maxItems: 1 } : {}) };
    return !closedRequestSchemaDefinitionIssues({ type: 'object', additionalProperties: false,
      properties: { input: arrayItem ? { type: 'array', maxItems: 1, items: property } : property } }).length;
  });
};
/** Null is an array wildcard, distinct from every literal object key (including "[]" and "0"). */
export type ClosedInputPath = (string | null)[];
export interface ClosedSchemaEntry { path: ClosedInputPath; schemaPath: string[]; field: ClosedInputSchema; required: boolean }
export const closedSchemaEntries = (schema: ClosedInputSchema): ClosedSchemaEntry[] => {
  const entries: ClosedSchemaEntry[] = [];
  const visit = (field: ClosedInputSchema, path: ClosedInputPath, schemaPath: string[], required: boolean) => {
    entries.push({ field, path, schemaPath, required });
    if (field.type === 'object') for (const [key, child] of Object.entries(field.properties ?? {})) visit(child, [...path, key], [...schemaPath, 'properties', key], field.required?.includes(key) ?? false);
    if (field.type === 'array' && field.items) visit(field.items, [...path, null], [...schemaPath, 'items'], false);
  };
  visit(schema, [], [], false); return entries;
};
