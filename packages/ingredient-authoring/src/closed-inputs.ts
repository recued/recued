import { closedRequestSchemaDefinitionIssues, closedRequestSchemaViolation, isClosedRequestSchema, isRef } from '@recued/contracts';

/** Editor metadata for the existing closed subset, never a new runtime schema dialect. */
export interface ClosedInputSchema {
  type: string; properties?: Record<string, ClosedInputSchema>; required?: string[]; items?: ClosedInputSchema;
  enum?: (string | number | boolean)[]; minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  additionalProperties?: boolean;
}
export const CLOSED_INPUT_MAX_NODES = 500;
export const CLOSED_INPUT_MAX_BYTES = 65_536;
export const closedInputMetadata = (raw: unknown): { closed: boolean; complete: boolean; nodes: number; schema?: ClosedInputSchema } => {
  if (!isClosedRequestSchema(raw)) return { closed: false, complete: true, nodes: 0 };
  let nodes = 0; const pending: unknown[] = [raw];
  while (pending.length) {
    if (++nodes > CLOSED_INPUT_MAX_NODES) return { closed: true, complete: false, nodes: 0 };
    const value = pending.pop();
    if (value && typeof value === 'object') {
      const children = Object.values(value);
      if (children.length + pending.length + nodes > CLOSED_INPUT_MAX_NODES) return { closed: true, complete: false, nodes: 0 };
      for (const child of children) pending.push(child);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > CLOSED_INPUT_MAX_BYTES || closedRequestSchemaDefinitionIssues(raw).length)
    return { closed: true, complete: false, nodes: 0 };
  return { closed: true, complete: true, nodes, schema: raw as ClosedInputSchema };
};
export const closedInputAt = (schema: ClosedInputSchema, path: readonly (string | number)[]): ClosedInputSchema | undefined => {
  let field: ClosedInputSchema | undefined = schema;
  for (const key of path) {
    field = typeof key === 'number' ? field?.type === 'array' ? field.items : undefined
      : field?.type === 'object' && Object.hasOwn(field.properties ?? {}, key) ? field.properties![key] : undefined;
    if (!field) break;
  }
  return field;
};
export const closedInputHelp = (field: ClosedInputSchema) => [
  `Type: ${field.type}.`,
  field.enum && `Allowed values: ${field.enum.slice(0, 30).map(value => JSON.stringify(value)).join(', ')}${field.enum.length > 30 ? '…' : ''}.`,
  ...(['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const).map(key => field[key] === undefined ? undefined : `${key}: ${field[key]}.`),
  field.uniqueItems && 'Items must be unique.',
  field.pattern !== undefined && `Pattern: ${field.pattern.slice(0, 300)}. Pattern matching is deferred to runtime.`,
  field.type === 'object' && 'Only declared properties are accepted.',
  field.type === 'file_ref' && 'Accepts a file record id, local path or URL, scalar, or producing step file_ref carrier.',
].filter(Boolean).join(' ');
export interface ClosedInputFinding { path: (string | number)[]; reason: 'unknown' | 'missing' | 'value'; message: string }

/** Conservative literal checks shared by editor Problems and AI validation.
 * Patterns are described but NEVER executed on the editor thread. Dynamic leaves
 * defer only their own checks; known siblings and array lengths remain checkable.
 */
export const checkClosedInputs = (schema: ClosedInputSchema, input: unknown) => {
  const findings: ClosedInputFinding[] = [];
  let work = 0, totalFindings = 0, complete = true, deferredValues = 0, deferredPatterns = 0;
  const budget = () => { if (++work > 5000) { complete = false; return false; } return true; };
  const add = (path: (string | number)[], reason: ClosedInputFinding['reason'], message: string) => {
    totalFindings++;
    if (findings.length < 100) findings.push({ path, reason, message }); else complete = false;
  };
  const dynamic = (value: unknown): boolean => {
    const pending = [value];
    while (pending.length) {
      if (!budget()) return true;
      const next = pending.pop(); if (isRef(next)) return true;
      if (next && typeof next === 'object') {
        const children = Object.values(next);
        if (children.length + pending.length + work > 5000) { complete = false; return true; }
        for (const child of children) pending.push(child);
      }
    }
    return false;
  };
  const visit = (field: ClosedInputSchema, value: unknown, path: (string | number)[]) => {
    if (!complete || !budget()) return;
    if (isRef(value)) { deferredValues++; return; }
    if (field.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>, properties = field.properties!;
      for (const key of Object.keys(record)) {
        if (!complete) return;
        if (!Object.hasOwn(properties, key)) add([...path, key], 'unknown', `Undeclared property ${JSON.stringify(key)} in a closed request schema.`);
      }
      for (const key of field.required ?? []) {
        if (!complete) return;
        if (!Object.hasOwn(record, key)) add([...path, key], 'missing', `Missing required property ${JSON.stringify(key)} (${properties[key]!.type}).`);
      }
      for (const [key, child] of Object.entries(record)) if (Object.hasOwn(properties, key)) visit(properties[key]!, child, [...path, key]);
      return;
    }
    if ((field.type === 'array' || field.type === 'file_ref[]') && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems) add(path, 'value', `Expected at least ${field.minItems} items.`);
      if (field.maxItems !== undefined && value.length > field.maxItems) add(path, 'value', `Expected at most ${field.maxItems} items.`);
      if (field.uniqueItems) {
        if (dynamic(value)) deferredValues++;
        else if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) add(path, 'value', 'Items must be unique.');
      }
      const item = field.type === 'array' ? field.items! : { type: 'file_ref' };
      for (const [i, child] of value.entries()) { if (!complete) break; visit(item, child, [...path, i]); }
      return;
    }
    if (field.type === 'file_ref' && value !== null && typeof value === 'object' && !Array.isArray(value) && dynamic(value)) { deferredValues++; return; }
    // Reuse the runtime scalar/type/enum/bounds and file_ref rules, without executing patterns.
    // Containers with a wrong literal type cannot recurse inside the runtime checker.
    const { pattern, ...literal } = field;
    const violation = closedRequestSchemaViolation({ type: 'object', additionalProperties: false, properties: { input: literal } }, { input: value });
    if (violation) add(path, 'value', violation.replace("argument 'input'", () => 'Value'));
    if (pattern !== undefined && typeof value === 'string') deferredPatterns++;
  };
  visit(schema, input, []);
  return { findings, totalFindings, complete, deferredValues, deferredPatterns };
};
