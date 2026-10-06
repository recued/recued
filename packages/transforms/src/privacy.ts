import type { TransformFn } from './types.js';

let counter = 0;
const makeToken = () => `HASH_${(++counter).toString(16).padStart(8, '0')}`;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reset counter (for testing determinism). */
export const _resetHashCounter = () => { counter = 0; };

export const hash_replace: TransformFn = (p) => {
  const fields = p.fields as string[];
  if (!Array.isArray(fields)) return { data: p.data, mapping: {} };
  const mapping: Record<string, string> = {};
  const data = deepReplace(p.data, fields, mapping, makeToken);
  return { data, mapping };
};

export const hash_restore: TransformFn = (p) => {
  const mapping = p.mapping as Record<string, string> | undefined;
  if (!mapping || typeof mapping !== 'object') return p.data;
  return restoreHashTokens(p.data, mapping);
};

/**
 * A step's legacy `pii_fields` at dispatch (`createIngredientExecutor`, and the
 * pre-approval describers that must match it): `hash_replace`'s walk over the call's
 * RESOLVED input — everything under a named key (bare names, any depth) swapped for
 * tokens, a list's items and an object's values included. Two differences from the
 * transform, both load-bearing:
 *   - tokens are numbered PER CALL in walk order, so the same input always hashes to
 *     the same request — a pre-approval review and the run it reviewed must build the
 *     identical model request (`beforeAiProvider` compares hashes);
 *   - a distinct prefix (`HASH_STEP_`), so a per-call token can never be read as a
 *     `hash_replace` token sitting in the same data, whose numbering is process-wide.
 * Returns the hashed data and the token → value mapping for {@link restoreHashTokens}.
 */
export const hashStepPiiFields = (
  data: unknown,
  fields: readonly string[],
): { data: unknown; mapping: Record<string, string> } => {
  let n = 0;
  const mapping: Record<string, string> = {};
  const hashed = deepReplace(
    data,
    [...fields],
    mapping,
    () => `HASH_STEP_${(++n).toString(16).padStart(8, '0')}`,
  );
  return { data: hashed, mapping };
};

/**
 * Put real values back for every token in `mapping`, walking the value's STRUCTURE —
 * every string leaf and every object key, in `mapping` order. ⛔ Not by rewriting the
 * value's JSON text: a restored value carrying a quote, a backslash or a newline made
 * that text unparseable, and the whole result came back as one raw string instead of
 * the object the next step reads. Prototype-sensitive keys are dropped, as `walk`s
 * elsewhere do. One pass per string, longest token first: a restored value that
 * itself contains token text is never rewritten by a later token.
 */
export const restoreHashTokens = (value: unknown, mapping: Readonly<Record<string, string>>): unknown => {
  const tokens = Object.keys(mapping).filter((token) => token.length > 0);
  if (tokens.length === 0) return value;
  const pattern = new RegExp(
    tokens.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
    'g',
  );
  const restoreText = (text: string): string =>
    text.replace(pattern, (token) => String(mapping[token]));
  const walkValue = (node: unknown): unknown => {
    if (typeof node === 'string') return restoreText(node);
    if (Array.isArray(node)) return node.map(walkValue);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const key = restoreText(k);
        if (DANGEROUS_KEYS.has(k) || DANGEROUS_KEYS.has(key)) continue;
        out[key] = walkValue(v);
      }
      return out;
    }
    return node;
  };
  return walkValue(value);
};

export const redact: TransformFn = (p) => {
  const fields = p.fields as string[];
  const marker = String(p.marker ?? '[REDACTED]');
  if (!Array.isArray(fields)) return p.data;
  return deepRedact(p.data, fields, marker);
};

/** Find the named keys at any depth; everything under one is hashed ({@link hashAll}).
 *  ⛔ A named key used to hash only a single value and walk a list or object like
 *  any other, so `fields: ["to"]` sent every address of a mail's `to` list in clear —
 *  while the PII trace, which cannot tell a list from a value, counted it covered and
 *  auto-PII left it alone. */
function deepReplace(
  data: unknown,
  fields: string[],
  mapping: Record<string, string>,
  mint: () => string,
): unknown {
  if (data == null) return data;
  if (Array.isArray(data)) return data.map(item => deepReplace(item, fields, mapping, mint));
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = fields.includes(k) ? hashAll(v, mapping, mint) : deepReplace(v, fields, mapping, mint);
    }
    return out;
  }
  return data;
}

/** Everything under a named key: a value becomes a token, and so does every value in a
 *  list or object under it, at any depth. Keys and `null`s stay as they are. */
function hashAll(value: unknown, mapping: Record<string, string>, mint: () => string): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(item => hashAll(item, mapping, mint));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = hashAll(v, mapping, mint);
    }
    return out;
  }
  const token = mint();
  mapping[token] = String(value);
  return token;
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
