import type { TransformFn } from './types.js';
import { CANONICAL_SYSTEM_FIELDS } from '@recued/contracts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

const isPlainObj = (v: unknown): v is Record<string, unknown> => {
  if (!isObj(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
};

/** Dangerous keys that could cause prototype pollution via Object.assign. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Filter dangerous keys from a source object before merging. */
const safeCopy = (src: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (!DANGEROUS_KEYS.has(key)) out[key] = src[key];
  }
  return out;
};

export const merge: TransformFn = (p) => {
  const sources = p.sources as unknown[];
  if (!Array.isArray(sources)) return {};
  return Object.assign(Object.create(null), ...sources.filter(isObj).map(safeCopy));
};

/** Copy one object while prefixing each own key. This is intentionally a
 * shallow key transform: nested values stay values, so a downstream closed
 * consumer can reject non-scalars instead of this helper flattening or
 * reinterpreting visitor-authored data. Invalid runtime shapes fail loud; an
 * absent response map must never degrade into an apparently valid empty map. */
export const prefix_keys: TransformFn = (p) => {
  if (!isPlainObj(p.source)) {
    throw new TypeError('prefix_keys: source must be a plain object');
  }
  if (typeof p.prefix !== 'string' || p.prefix.length === 0) {
    throw new TypeError('prefix_keys: prefix must be a non-empty string');
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(p.source)) {
    const prefixed = `${p.prefix}${key}`;
    if (DANGEROUS_KEYS.has(prefixed)) continue;
    out[prefixed] = value;
  }
  return out;
};

export const pick: TransformFn = (p) => {
  const source = p.source;
  if (!isObj(source)) return source ?? null;
  if (Array.isArray(p.fields)) {
    const fields = p.fields as string[];
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (DANGEROUS_KEYS.has(f)) continue;
      if (Object.prototype.hasOwnProperty.call(source, f)) out[f] = source[f];
    }
    // D-119 Phase 12 — canonical record system fields (`_id` +
    // `_collection`) are preserved by default so the projected
    // record stays canonical-ref-addressable. Authors who want them
    // stripped use `omit` explicitly. Mongo / CouchDB convention.
    for (const sf of CANONICAL_SYSTEM_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(source, sf) &&
        !Object.prototype.hasOwnProperty.call(out, sf)
      ) {
        out[sf] = source[sf];
      }
    }
    return out;
  }
  return source;
};

export const omit: TransformFn = (p) => {
  if (!isObj(p.source)) return {};
  const fields = new Set(p.fields as string[]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.source as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (!fields.has(k)) out[k] = v;
  }
  return out;
};

export const rename: TransformFn = (p) => {
  if (!isObj(p.source)) return {};
  const mapping = p.mapping as Record<string, string>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.source as Record<string, unknown>)) {
    const target = mapping[k] ?? k;
    if (DANGEROUS_KEYS.has(target)) continue;
    out[target] = v;
  }
  return out;
};

export const set: TransformFn = (p) => {
  const source = isObj(p.source) ? safeCopy(p.source as Record<string, unknown>) : {};
  const field = p.field as string;
  if (typeof field !== 'string' || DANGEROUS_KEYS.has(field)) return source;
  source[field] = p.value;
  return source;
};
