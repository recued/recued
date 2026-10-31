import { collectRefs } from '@recued/contracts';

/** Declaration advice only. No inference from defaults, formatting or runtime values. */
export type InputPrimitive = 'text' | 'number' | 'boolean';
export const inputPrimitive = (schemaType: string | undefined): InputPrimitive | undefined =>
  schemaType === 'string' ? 'text' : schemaType === 'number' || schemaType === 'integer' ? 'number' : schemaType === 'boolean' ? 'boolean' : undefined;
export const inputHintType = (hint: unknown): { type: string; primitive?: InputPrimitive; optional: boolean } | undefined => {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return;
  const row = hint as Record<string, unknown>;
  if (!Object.hasOwn(row, 'type') || typeof row.type !== 'string' || !row.type.length
    || !Object.hasOwn(row, 'label') || typeof row.label !== 'string'
    || Object.hasOwn(row, 'optional') && typeof row.optional !== 'boolean') return;
  return { type: row.type, optional: row.optional === true,
    primitive: row.type === 'text' || row.type === 'number' || row.type === 'boolean' ? row.type : undefined };
};
export const inputBindingCompatibility = (schemaType: string | undefined, hint: unknown): 'compatible' | 'mismatch' | 'unknown' => {
  const expected = inputPrimitive(schemaType), declared = inputHintType(hint)?.primitive;
  return !expected || !declared ? 'unknown' : expected === declared ? 'compatible' : 'mismatch';
};
/** A deliberately small subset of canonical references: a whole, unformatted config root. */
export const plainConfigBinding = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 1024 || !/^\{\{\s*config\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(value)) return;
  const refs = collectRefs(value), ref = refs[0];
  return refs.length === 1 && ref?.ns === 'config' ? ref.path : undefined;
};
export interface InputBindingFinding { path: (string | number)[]; name: string; declared: InputPrimitive; expected: string }
/** Structural view of explicit declarations; omitted types never become guesses. */
export interface BindingInputSchema { readonly type?: string; readonly properties?: Readonly<Record<string, BindingInputSchema>>; readonly items?: BindingInputSchema }
/** Bounded advisory traversal; literal validation and dynamic-value deferrals stay separate. */
export const checkClosedInputBindings = (schema: BindingInputSchema, input: unknown, variables: unknown) => {
  const findings: InputBindingFinding[] = [];
  const hints = variables && typeof variables === 'object' && !Array.isArray(variables) ? variables as Record<string, unknown> : {};
  let complete = true, work = 0, totalFindings = 0;
  const visit = (field: BindingInputSchema, value: unknown, path: (string | number)[]) => {
    if (!complete || ++work > 5000) { complete = false; return; }
    const name = plainConfigBinding(value);
    if (name && Object.hasOwn(hints, name) && inputBindingCompatibility(field.type, hints[name]) === 'mismatch') {
      totalFindings++;
      if (findings.length < 100) findings.push({ path, name, declared: inputHintType(hints[name])!.primitive!, expected: field.type! });
      else complete = false;
      return;
    }
    if (field.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (!complete) break;
        // Count unknown children too, without descending into them.
        if (Object.hasOwn(field.properties ?? {}, key)) visit(field.properties![key]!, child, [...path, key]);
        else if (++work > 5000) complete = false;
      }
    } else if (field.type === 'array' && field.items && Array.isArray(value)) {
      for (const [i, child] of value.entries()) { if (!complete) break; visit(field.items, child, [...path, i]); }
    }
  };
  visit(schema, input, []);
  return { findings, totalFindings, complete };
};
