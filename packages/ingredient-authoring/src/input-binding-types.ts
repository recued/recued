import { collectRefs } from '@recued/contracts';

/** Declaration advice only. No inference from defaults, formatting or runtime values. */
export type InputPrimitive = 'text' | 'number' | 'boolean';
export const inputPrimitive = (schemaType: string | undefined): InputPrimitive | undefined =>
  schemaType === 'string' ? 'text' : schemaType === 'number' || schemaType === 'integer' ? 'number' : schemaType === 'boolean' ? 'boolean' : undefined;
/** Bounded string choices usable by ValueHint enum inputs; larger declarations remain unknown. */
export const inputEnumOptions = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.length || value.length > 100) return;
  let size = 0;
  for (const item of value) if (typeof item !== 'string' || !item.trim().length || item.length > 256 || (size += item.length) > 16_384) return;
  return [...value];
};
export const inputHintType = (hint: unknown): { type: string; primitive?: InputPrimitive; optional: boolean } | undefined => {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return;
  const row = hint as Record<string, unknown>;
  if (!Object.hasOwn(row, 'type') || typeof row.type !== 'string' || !row.type.length
    || !Object.hasOwn(row, 'label') || typeof row.label !== 'string'
    || Object.hasOwn(row, 'optional') && typeof row.optional !== 'boolean') return;
  return { type: row.type, optional: row.optional === true,
    primitive: row.type === 'enum' && Object.hasOwn(row, 'options') && inputEnumOptions(row.options) ? 'text'
      : row.type === 'text' || row.type === 'number' || row.type === 'boolean' ? row.type : undefined };
};
/** Structural view of explicit declarations; omitted types never become guesses. */
export interface BindingInputSchema { readonly type?: string; readonly enum?: readonly unknown[]; readonly properties?: Readonly<Record<string, BindingInputSchema>>; readonly items?: BindingInputSchema }
const bindingConflict = (schema: BindingInputSchema, hint: unknown) => {
  const expected = inputPrimitive(schema.type), info = inputHintType(hint);
  if (!expected || !info?.primitive) return;
  if (expected !== info.primitive) return { declared: info.type as InputPrimitive | 'enum', expected: schema.type!, reason: 'type' as const };
  if (info.type === 'enum' && schema.enum !== undefined) {
    const allowed = inputEnumOptions(schema.enum), choices = inputEnumOptions((hint as { options: unknown }).options);
    if (!allowed || !choices) return;
    const known = new Set(allowed), outside = [...new Set(choices.filter(choice => !known.has(choice)))];
    if (outside.length) return { declared: 'enum' as const, expected: schema.type!, reason: 'enum' as const, outside };
  }
};
export const inputBindingCompatibility = (schema: string | BindingInputSchema | undefined, hint: unknown): 'compatible' | 'mismatch' | 'unknown' => {
  const field = typeof schema === 'string' ? { type: schema } : schema;
  if (!field || !inputPrimitive(field.type) || !inputHintType(hint)?.primitive) return 'unknown';
  if (bindingConflict(field, hint)) return 'mismatch';
  if (inputHintType(hint)?.type === 'enum' && field.enum !== undefined && !inputEnumOptions(field.enum)) return 'unknown';
  return 'compatible';
};
/** A deliberately small subset of canonical references: a whole, unformatted config root. */
export const plainConfigBinding = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 1024 || !/^\{\{\s*config\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(value)) return;
  const refs = collectRefs(value), ref = refs[0];
  return refs.length === 1 && ref?.ns === 'config' ? ref.path : undefined;
};
export interface InputBindingFinding { path: (string | number)[]; name: string; declared: InputPrimitive | 'enum'; expected: string; reason: 'type' | 'enum'; outside?: string[] }
export const inputBindingMessage = (finding: InputBindingFinding): string => finding.reason === 'enum'
  ? `config.${finding.name} declares enum choices outside this input's allowed choices: ${finding.outside!.slice(0, 3).map(value => JSON.stringify(value)).join(', ')}${finding.outside!.length > 3 ? ', …' : ''}.`
  : `config.${finding.name} declares ${finding.declared}, but this input expects ${finding.expected}.`;
/** Bounded advisory traversal; literal validation and dynamic-value deferrals stay separate. */
export const checkClosedInputBindings = (schema: BindingInputSchema, input: unknown, variables: unknown) => {
  const findings: InputBindingFinding[] = [];
  const hints = variables && typeof variables === 'object' && !Array.isArray(variables) ? variables as Record<string, unknown> : {};
  let complete = true, work = 0, totalFindings = 0;
  const visit = (field: BindingInputSchema, value: unknown, path: (string | number)[]) => {
    if (!complete || ++work > 5000) { complete = false; return; }
    const name = plainConfigBinding(value);
    const conflict = name && Object.hasOwn(hints, name) && bindingConflict(field, hints[name]);
    if (conflict) {
      totalFindings++;
      if (findings.length < 100) findings.push({ path, name: name!, ...conflict });
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
