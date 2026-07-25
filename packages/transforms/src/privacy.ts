import type { TransformFn } from './types.js';

let counter = 0;
const makeToken = () => `HASH_${(++counter).toString(16).padStart(8, '0')}`;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reset counter (for testing determinism). */
export const _resetHashCounter = () => { counter = 0; };

export const hash_replace: TransformFn = (p) => {
  const fields = p.fields as string[];
  if (!Array.isArray(fields)) return { data: p.data, mapping: {} };
  const mapping: Record<string, string> = {};
  const data = deepReplace(p.data, fields, mapping);
  return { data, mapping };
};

export const hash_restore: TransformFn = (p) => {
  const mapping = p.mapping as Record<string, string> | undefined;
  if (!mapping || typeof mapping !== 'object') return p.data;
  const json = JSON.stringify(p.data);
  const restored = Object.entries(mapping).reduce(
    (acc, [token, original]) => acc.replaceAll(token, String(original)),
    json,
  );
  try { return JSON.parse(restored); } catch { return restored; }
};

export const redact: TransformFn = (p) => {
  const fields = p.fields as string[];
  const marker = String(p.marker ?? '[REDACTED]');
  if (!Array.isArray(fields)) return p.data;
  return deepRedact(p.data, fields, marker);
};

function deepReplace(data: unknown, fields: string[], mapping: Record<string, string>): unknown {
  if (data == null) return data;
  if (Array.isArray(data)) return data.map(item => deepReplace(item, fields, mapping));
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      if (fields.includes(k) && v != null && typeof v !== 'object') {
        const token = makeToken();
        mapping[token] = String(v);
        out[k] = token;
      } else {
        out[k] = deepReplace(v, fields, mapping);
      }
    }
    return out;
  }
  return data;
}

function deepRedact(data: unknown, fields: string[], marker: string): unknown {
  if (data == null) return data;
  if (Array.isArray(data)) return data.map(item => deepRedact(item, fields, marker));
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = fields.includes(k) ? marker : deepRedact(v, fields, marker);
    }
    return out;
  }
  return data;
}
