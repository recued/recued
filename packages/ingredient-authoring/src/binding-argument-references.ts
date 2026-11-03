import type { OperationArgType } from '@recued/contracts';
/** Portable authoring interpretation of REST path and CLI argument references. No payload traversal. */
import { closedInputMetadata } from './closed-inputs.js';
export type BindingArgumentPath = (string | number)[];
export type BindingArgumentSyntax = 'rest' | 'cli' | 'literal';
export interface BindingArgumentField { path: BindingArgumentPath; syntax: BindingArgumentSyntax; engine?: boolean; argumentType?: OperationArgType }
export interface BindingArgumentToken { key: string; start: number; end: number }
export interface BindingArgumentReference extends BindingArgumentToken { path: BindingArgumentPath; engine: boolean; target?: 'key' }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const bindingArgumentValue = (value: unknown, path: readonly (string | number)[]): unknown => {
  for (const key of path) { if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return; value = (value as Record<string | number, unknown>)[key]; }
  return value;
};
export const bindingArgumentTokens = (value: string, syntax: BindingArgumentSyntax): BindingArgumentToken[] => {
  if (syntax === 'literal') return value ? [{ key: value, start: 0, end: value.length }] : [];
  const pattern = syntax === 'rest' ? /\{\{([^}]+)\}\}/g : /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
  const result: BindingArgumentToken[] = [];
  for (const match of value.matchAll(pattern)) {
    const raw = match[1]!, key = syntax === 'rest' ? raw.trim() : raw;
    if (key) { const start = match.index + (syntax === 'rest' ? 2 : 1) + raw.indexOf(key); result.push({ key, start, end: start + key.length }); }
    if (result.length > 5000) break;
  }
  return result;
};
export const bindingArgumentTokenAt = (value: string, syntax: BindingArgumentSyntax, offset: number) => {
  const token = bindingArgumentTokens(value, syntax).find(row => offset >= row.start && offset <= row.end);
  if (token) return { ...token, suffix: '' };
  if (syntax === 'literal') return { key: value, start: 0, end: value.length, suffix: '' };
  const open = syntax === 'rest' ? '{{' : '{', at = value.lastIndexOf(open, offset);
  if (at < 0) return;
  const tail = value.slice(at + open.length), leading = syntax === 'rest' ? tail.length - tail.trimStart().length : 0;
  const key = tail.slice(leading), start = at + open.length + leading;
  if (offset < start || offset > value.length || !/^[A-Za-z_0-9.-]*$/.test(key)) return;
  return { key, start, end: value.length, suffix: syntax === 'rest' ? '}}' : '}' };
};

const operationKeys = new Set(['op','ingredient','risk','approval','approval_reason','spends_per_call','args','bind','description','required_scopes','idempotency','accepts_media','produces_media','editable_args','record_id_arg','response_schema','request_schema','timeout_ms','cache_ttl_ms','tags']);
const restKeys = new Set(['kind','method','path_template','static_query','static_headers','static_body','merge_query','response_schema']);
const cliKeys = new Set(['kind','argv_template','cwd','input_materialize','output_capture','shape','storage','exit_code_handling','env','progress']);
/** Known usages remain navigable when rename coverage is incomplete; completeness is required for edits. */
export const operationBindingArgumentReferences = (operation: unknown) => {
  const fields: BindingArgumentField[] = [], references: BindingArgumentReference[] = [], schemaReferences: BindingArgumentReference[] = [], engineKeys: string[] = [];
  let complete = true, reason = '';
  const refuse = (message: string) => { complete = false; reason ||= message; };
  const field = (path: BindingArgumentPath, syntax: BindingArgumentSyntax = 'literal', engine = false, argumentType?: OperationArgType) => {
    if (argumentType || typeof bindingArgumentValue(operation, path) === 'string') fields.push({ path, syntax, engine, ...(argumentType ? { argumentType } : {}) });
  };
  const keys = (value: unknown, allowed: ReadonlySet<string>, label: string) => {
    if (!object(value)) { refuse(`Malformed ${label}.`); return; }
    const unknown = Object.keys(value).find(key => !allowed.has(key)); if (unknown) refuse(`${label} field ${unknown} needs explicit reference support before rename.`);
  };
  if (!object(operation) || !object(operation.bind)) return { fields, references, engineKeys, complete: false, reason: 'Choose an operation with a supported binding.' };
  const bind = operation.bind;
  keys(operation, operationKeys, 'Operation');
  if (operation.request_schema !== undefined) {
    const schema = closedInputMetadata(operation.request_schema);
    if (!schema.schema) refuse('Request schemas need explicit reference support unless they are valid bounded closed schemas.');
    else {
      for (const key of Object.keys(schema.schema.properties ?? {})) schemaReferences.push({ key, path: ['request_schema', 'properties', key], start: 0, end: key.length, target: 'key', engine: false });
      for (const [index, key] of (schema.schema.required ?? []).entries()) schemaReferences.push({ key, path: ['request_schema', 'required', index], start: 0, end: key.length, engine: false });
    }
  }
  field(['record_id_arg']);
  if (Array.isArray(operation.editable_args)) for (let i = 0; i < operation.editable_args.length; i++) {
    field(['editable_args', i, 'key']); keys(operation.editable_args[i], new Set(['key','type','label','required','privacy','options_source','affects_target','validation']), 'Editable argument');
  }
  else if (operation.editable_args !== undefined) refuse('Editable arguments must be an array before rename.');
  if (bind.kind === 'rest') {
    keys(bind, restKeys, 'REST binding'); field(['bind','path_template'], 'rest');
    for (const path of [['bind','upload','arg'],['bind','chunked_upload','arg']]) field(path, 'literal', false, 'file_ref');
    if (bindingArgumentValue(bind,['response_capture','filename_source','kind']) === 'arg') field(['bind','response_capture','filename_source','arg'], 'literal', false, 'string');
  } else if (bind.kind === 'cli_invocation') {
    keys(bind, cliKeys, 'CLI binding');
    if (Array.isArray(bind.argv_template)) for (let i = 0; i < bind.argv_template.length; i++) {
      if (i === 0) { if (typeof bind.argv_template[i] !== 'string' || bindingArgumentTokens(bind.argv_template[i] as string,'cli').length) refuse('The CLI executable must remain a pinned literal.'); continue; }
      if (typeof bind.argv_template[i] === 'string') field(['bind','argv_template',i], 'cli');
      else { field(['bind','argv_template',i,'expand_arg']); keys(bind.argv_template[i], new Set(['expand_arg']), 'CLI expansion'); }
    }
    else refuse('CLI argv_template must be an array.');
    for (const [name, allowed] of [['cwd',['arg']],['input_materialize',['kind','arg','min_items','max_items']],['output_capture',['dir_arg','from_input_arg','mime_type']],['progress',['contract','adapter','stall_ms','first_output_ms','watch_path']]] as const) {
      if (bind[name] !== undefined) keys(bind[name], new Set(allowed), `CLI ${name}`);
    }
    field(['bind','cwd','arg'],'cli'); field(['bind','input_materialize','arg']); field(['bind','output_capture','from_input_arg']); field(['bind','progress','watch_path'], 'cli');
    const dir = bindingArgumentValue(bind, ['output_capture','dir_arg']);
    if (typeof dir === 'string' && dir) { engineKeys.push(dir); field(['bind','output_capture','dir_arg'], 'literal', true); }
  } else refuse('Rename currently supports REST paths and CLI invocations only.');
  for (const entry of fields) {
    const value = bindingArgumentValue(operation, entry.path); if (typeof value !== 'string') continue;
    for (const token of bindingArgumentTokens(value, entry.syntax)) {
      references.push({ ...token, path: entry.path, engine: entry.engine === true || engineKeys.includes(token.key) });
      if (references.length + schemaReferences.length > 5000) { refuse('Binding reference discovery reached its 5,000-reference limit.'); return { fields, references, schemaReferences, engineKeys, complete, reason }; }
    }
  }
  return { fields, references, schemaReferences, engineKeys, complete, reason };
};

export const assertBindingArgumentRename = (operation: unknown, key: string, name: string) => {
  const usage = operationBindingArgumentReferences(operation);
  if (!usage.complete) throw new Error(usage.reason);
  if (![key,name].every(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length <= 200)) throw new Error('Rename supports simple argument identifiers; dotted paths and transport field names require explicit contract editing.');
  if (usage.engineKeys.includes(key) || usage.engineKeys.includes(name)) throw new Error('Engine-owned tokens cannot be renamed as caller arguments.');
  if (usage.references.some(row => row.key.startsWith(key+'.') || row.key.startsWith(name+'.'))) throw new Error('Nested argument paths require explicit contract editing before rename.');
  const bind = bindingArgumentValue(operation, ['bind','kind']);
  if (!usage.references.some(row => row.key === key && !row.engine && row.path[0] === 'bind' && (bind !== 'rest' || row.path[1] === 'path_template'))) throw new Error('No fully understood binding usage establishes this argument as an internal name.');
  return usage;
};
