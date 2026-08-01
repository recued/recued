import type { TransformFn } from './types.js';
import { CANONICAL_SYSTEM_FIELDS } from '@recued/contracts';
import { canonicalJSONStringifyStrict } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

const isObj = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

const isPlainObj = (v: unknown): v is Record<string, unknown> => {
  if (!isObj(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
};

/** Dangerous keys that could cause prototype pollution via Object.assign. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Exact UTF-8 byte length of the JSON value the durable stores will receive.
 * Returns null for values JSON cannot serialize (cycles, bigint, undefined)
 * so a recipe can fail closed with an explicit non-null + ceiling guard. Counting
 * the serialized form is load-bearing: a control character occupies one byte
 * in memory but six bytes (`\\u0000`) after JSON escaping. */
export const json_byte_length: TransformFn = (p) => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(p.input);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;
  return new TextEncoder().encode(serialized).byteLength;
};

/** Canonical JSON text for durable file artifacts. The shared strict
 * canonicalizer rejects non-finite and non-JSON values (while retaining its
 * documented undefined-object-field behavior), and sorted keys make the exact
 * bytes and their digest stable across retries. */
export const json_stringify: TransformFn = (p) => {
  try {
    return canonicalJSONStringifyStrict(p.input);
  } catch {
    return null;
  }
};

/** Parse one JSON text value. Invalid JSON and non-string inputs fail closed. */
export const json_parse: TransformFn = (p) => {
  if (typeof p.input !== 'string') return null;
  try {
    return JSON.parse(p.input) as unknown;
  } catch {
    return null;
  }
};

/** Parse CSV text into rows. String in, STRINGS out — this never types a value.
 *
 *  ⛔ IT DOES NOT COERCE NUMBERS, AND THAT IS THE POINT. `1,200.00` and
 *  `1.200,00` are the same amount in different locales, and a bank export is
 *  written in the bank's locale, not the server's. A parser that guessed would
 *  turn one of them into `1` silently, on a rent ledger. Every cell stays the
 *  string it was; `to_number` exists and the recipe author — who knows whose
 *  export this is — decides.
 *
 *  Why a transform rather than a CLI: a `cli_invocation` op that materializes a
 *  `file_ref` may NOT capture stdout as a value (D-185 Slice 3 content
 *  isolation — the bytes would bypass the Gateway-gated file read), so a CSV
 *  CLI can only write another FILE, which then needs the gated read anyway. The
 *  transform also works on a CSV a recipe merely HOLDS — pasted into a variable,
 *  fetched from an API, produced by an earlier step — which a file-shaped op
 *  never can. Parsing belongs where the data is, not where the file is.
 *
 *  RFC 4180 is settled internally because none of it is a judgement call:
 *  quoted fields containing the delimiter or a newline, `""` as an escaped
 *  quote, CRLF or LF line endings, and a leading BOM.
 *
 *  What genuinely cannot be resolved from the text surfaces as a parameter:
 *  `delimiter`, `quote`, `has_header`, and `ragged` — the policy for a row whose
 *  cell count disagrees with the header (`pad` | `skip` | `error`). `csvkit`'s
 *  `csv.validate` (`csvclean --length-mismatch`) exists to detect that case
 *  before parsing.
 *
 *  Returns `[]` for a non-string input or empty text. With `has_header: false`
 *  rows come back as arrays of strings; with a header they are objects keyed by
 *  the header cells.
 *
 *  ⚠ Two known behaviours rather than options, so they are not surprises:
 *  a DUPLICATE header name keeps the last column of that name (a file with two
 *  `amount` columns is malformed, and inventing a fifth parameter for it would
 *  cost more than it buys), and a header cell named `__proto__` /
 *  `constructor` / `prototype` is DROPPED — the keys come from an untrusted
 *  file and must not reach an object assignment. */
export const csv_parse: TransformFn = (p) => {
  if (typeof p.input !== 'string') return [];
  // A UTF-8 BOM survives `decode_base64` and would otherwise become part of the
  // first header key, so the first column silently never matches.
  const text = p.input.replace(/^\uFEFF/, '');
  if (text.length === 0) return [];

  const delimiter = typeof p.delimiter === 'string' && p.delimiter.length === 1
    ? p.delimiter
    : ',';
  const quote = typeof p.quote === 'string' && p.quote.length === 1 ? p.quote : '"';
  const hasHeader = p.has_header !== false;
  const ragged = p.ragged === 'skip' || p.ragged === 'error' ? p.ragged : 'pad';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let sawCell = false;

  const endCell = (): void => { row.push(cell); cell = ''; sawCell = true; };
  const endRow = (): void => {
    endCell();
    // A trailing newline must not produce a phantom row of one empty cell.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    sawCell = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch !== quote) { cell += ch; continue; }
      // `""` inside a quoted field is one literal quote.
      if (text[i + 1] === quote) { cell += quote; i += 1; continue; }
      inQuotes = false;
      continue;
    }
    if (ch === quote && cell === '') { inQuotes = true; continue; }
    if (ch === delimiter) { endCell(); continue; }
    // The `i += 1` is belt-and-braces: without it a CRLF ends the row twice and
    // the empty-row guard below swallows the second, so the output is identical.
    // Mutation-proved EQUIVALENT — kept because explicit CRLF handling reads
    // better than relying on another branch to clean up after it.
    if (ch === '\r') { if (text[i + 1] === '\n') i += 1; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  // An unterminated final line still has a cell to flush; `sawCell` keeps a
  // file ending in a newline from emitting an empty trailing row.
  if (cell !== '' || sawCell || row.length > 0) endRow();

  if (!hasHeader) return rows;
  const header = rows.shift();
  if (header === undefined) return [];

  const out: Record<string, string>[] = [];
  for (const cells of rows) {
    if (cells.length !== header.length) {
      if (ragged === 'skip') continue;
      if (ragged === 'error') {
        throw new Error(
          `csv_parse: row has ${cells.length} cells, header has ${header.length}`
          + ' — set ragged: "pad" or "skip" to admit it',
        );
      }
    }
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      // Header keys come from an untrusted file. Defence in depth, and
      // deliberately unproven: with STRING values on a plain object literal
      // `obj['__proto__'] = 'x'` sets a prototype to a non-object, which is a
      // no-op, so removing this guard is a mutation no test can observe. It
      // stays because the values being strings is an invariant of THIS
      // transform, not of whatever a later edit might make them.
      if (DANGEROUS_KEYS.has(key)) return;
      obj[key] = cells[idx] ?? '';
    });
    out.push(obj);
  }
  return out;
};

/** Exact UTF-8 byte length of a string. Unlike json_byte_length this measures
 * the string's bytes themselves rather than the JSON representation of it. */
export const utf8_byte_length: TransformFn = (p) =>
  typeof p.input === 'string'
    ? new TextEncoder().encode(p.input).byteLength
    : null;

/** Lowercase SHA-256 of one UTF-8 string. Null for non-string inputs so file
 * verification never hashes a coercion such as "[object Object]". */
export const sha256: TransformFn = (p) =>
  typeof p.input === 'string' ? sha256Hex(p.input) : null;

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
