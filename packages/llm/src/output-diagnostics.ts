import type { LLMFinishReason } from './types.js';

const FIELDS = ['reasoning', 'response', 'events', 'tool_calls', 'nothing_outstanding',
  'output_files', 'mail_work_plan', 'mail_work_recap', 'browser_task_progress', 'facts'] as const;
type Field = typeof FIELDS[number] | 'other';
const MAX_SCAN_CHARS = 2_000_000;

/** Counts only. Unknown property names and every value remain private. */
export interface LLMOutputDiagnostics {
  schema: 1;
  count_unit: 'utf16_code_units';
  raw_chars: number;
  scanned_chars: number;
  scan_truncated: boolean;
  json_valid: boolean | null;
  root_closed: boolean;
  fields: Partial<Record<Field, { serialized_chars: number; occurrences: number; closed: boolean }>>;
  tail_field: Field | null;
  tail_position: 'key' | 'value' | 'after_value' | null;
  tail_in_string: boolean;
  finish_reason: LLMFinishReason | 'unknown';
}

/** Inspect complete or truncated JSON without returning any generated text.
 * Field spans include serialized quoting/escaping, including repeated keys. */
export const inspectLLMOutput = (raw: string, finish?: LLMFinishReason): LLMOutputDiagnostics => {
  const text = raw.slice(0, MAX_SCAN_CHARS);
  const result: LLMOutputDiagnostics = { schema: 1, count_unit: 'utf16_code_units', raw_chars: raw.length,
    scanned_chars: text.length, scan_truncated: raw.length > text.length, json_valid: null, root_closed: false,
    fields: {}, tail_field: null, tail_position: null, tail_in_string: false,
    finish_reason: finish === 'stop' || finish === 'length' || finish === 'content_filter' ? finish : 'unknown' };
  if (!result.scan_truncated) {
    const candidate = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i, '$1');
    try { JSON.parse(candidate); result.json_valid = true; } catch { result.json_valid = false; }
  }
  let at = text.indexOf('{');
  if (at < 0) return result;
  at++;
  result.tail_position = 'key';
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const stringEnd = (from: number): number => {
    let escaped = false;
    for (let i = from + 1; i < text.length; i++) {
      const char = text[i];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return i + 1;
    }
    return -1;
  };
  while (at < text.length) {
    whitespace();
    if (text[at] === '}') { result.root_closed = true; result.tail_field = null; result.tail_position = null; return result; }
    if (text[at] !== '"') return result;
    const keyFrom = at, keyEnd = stringEnd(at);
    if (keyEnd < 0) { result.tail_in_string = true; return result; }
    let field: Field = 'other';
    if (keyEnd - keyFrom <= 80) {
      try {
        const key: unknown = JSON.parse(text.slice(keyFrom, keyEnd));
        if (typeof key === 'string' && (FIELDS as readonly string[]).includes(key)) field = key as Field;
      } catch { return result; }
    }
    at = keyEnd; whitespace();
    if (text[at++] !== ':') return result;
    whitespace();
    const from = at;
    let closed = false;
    result.tail_field = field;
    result.tail_position = 'value';
    if (text[at] === '"') {
      const end = stringEnd(at);
      closed = end >= 0; at = closed ? end : text.length;
      result.tail_in_string = !closed;
    } else if (text[at] === '{' || text[at] === '[') {
      const stack: string[] = [];
      while (at < text.length) {
        const char = text[at];
        if (char === '"') {
          const end = stringEnd(at);
          if (end < 0) { result.tail_in_string = true; at = text.length; break; }
          at = end; continue;
        }
        if (char === '{' || char === '[') {
          if (stack.length >= 128) return result;
          stack.push(char);
        } else if (char === '}' || char === ']') {
          if (stack.pop() !== (char === '}' ? '{' : '[')) return result;
          if (stack.length === 0) { at++; closed = true; break; }
        }
        at++;
      }
    } else {
      while (at < text.length && text[at] !== ',' && text[at] !== '}') at++;
      closed = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text.slice(from, at).trim());
    }
    const prior = result.fields[field];
    result.fields[field] = { serialized_chars: (prior?.serialized_chars ?? 0) + at - from,
      occurrences: (prior?.occurrences ?? 0) + 1, closed: (prior?.closed ?? true) && closed };
    if (!closed) return result;
    result.tail_position = 'after_value';
    whitespace();
    if (text[at] === '}') { result.root_closed = true; result.tail_field = null; result.tail_position = null; return result; }
    if (text[at++] !== ',') return result;
    result.tail_field = null;
    result.tail_position = 'key';
  }
  return result;
};
