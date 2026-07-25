/** Parse + validate a contracted AI function's raw text response into a typed object.
 *  Returns null on any failure so the executor can retry once. The executor is responsible
 *  for mapping persistent failures to AI_OUTPUT_INVALID.
 */

import { stripCorePrefix } from '@recued/contracts';

/** Strip ```json / ``` code fences and surrounding whitespace, returning
 *  the inner candidate text. Shared by `extractJSON` + `extractJSONArray`. */
const stripFences = (raw: string): string => {
  const trimmed = raw.trim();
  const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const fenced = trimmed.match(fencePattern);
  return fenced ? fenced[1].trim() : trimmed;
};

/** Scan `candidate` for the first balanced `open`…`close` block. A bare
 *  block fast-paths; otherwise the first `open` is found and matched with
 *  string/escape awareness. The shared scanner behind `extractJSON`
 *  (objects) and `extractJSONArray` (arrays — D-162). */
const scanBalanced = (
  candidate: string,
  open: string,
  close: string,
): string | null => {
  // Fast path — already a bare open…close block
  if (candidate.startsWith(open) && candidate.endsWith(close)) return candidate;

  // Slow path — scan for the first balanced open … close block.
  const start = candidate.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
};

/** Strip common model decorations and extract the JSON object substring. */
export const extractJSON = (raw: string): string | null => {
  if (!raw) return null;
  return scanBalanced(stripFences(raw), '{', '}');
};

/** D-162 — `extractJSON`'s array sibling: extract the JSON array substring.
 *  Unlike the object scanner, this rejects an object-*wrapped* array
 *  (`{"results":[…]}`) — a batch response must be a JSON array, not an
 *  object (N.6). A `{` that opens before the first `[` means the array is
 *  nested inside an object; leading prose + code fences are still
 *  tolerated, since neither opens with `{`. */
export const extractJSONArray = (raw: string): string | null => {
  if (!raw) return null;
  const candidate = stripFences(raw);
  const firstArray = candidate.indexOf('[');
  if (firstArray === -1) return null;
  const firstObject = candidate.indexOf('{');
  if (firstObject !== -1 && firstObject < firstArray) return null;
  return scanBalanced(candidate, '[', ']');
};

/** Parse raw text into an object. Returns null if not valid JSON or not an object. */
export const parseJSONObject = (raw: string): Record<string, unknown> | null => {
  const extracted = extractJSON(raw);
  if (extracted == null) return null;
  try {
    const parsed = JSON.parse(extracted);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** D-162 — `parseJSONObject`'s array sibling. Returns the parsed array, or
 *  null if the text is not valid JSON, not an array, or any element is not
 *  a plain (non-null, non-array) object. */
export const parseJSONArray = (raw: string): Record<string, unknown>[] | null => {
  const extracted = extractJSONArray(raw);
  if (extracted == null) return null;
  try {
    const parsed = JSON.parse(extracted);
    if (!Array.isArray(parsed)) return null;
    for (const element of parsed) {
      if (element == null || typeof element !== 'object' || Array.isArray(element)) {
        return null;
      }
    }
    return parsed as Record<string, unknown>[];
  } catch {
    return null;
  }
};

/** Type guards for field validation. */
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObjectArray = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.every((x) => x != null && typeof x === 'object' && !Array.isArray(x));

/** Apply a slug's per-function validator to an already-parsed object.
 *  Extracted so single-mode `parseContractedOutput` and D-162 batch-mode
 *  `parseContractedBatch` validate result fields identically (I-5 / TR-3).
 *  `ai-extract` has no fixed shape — its keys come from `llm.fields` — so
 *  it passes through unvalidated. */
const validateContractedObject = (
  slug: string,
  obj: Record<string, unknown>,
): Record<string, unknown> | null => {
  // §5 — a `core-<bare>` kernel alias validates identically to its bare slug.
  switch (stripCorePrefix(slug)) {
    case 'ai-classify':
      return validateClassify(obj);
    case 'ai-score':
      return validateScore(obj);
    case 'ai-extract':
      return obj; // any shape — fields come from input, not fixed
    case 'ai-summarize':
      return validateSummarize(obj);
    case 'ai-sentiment':
      return validateSentiment(obj);
    case 'ai-compare':
      return validateCompare(obj);
    case 'ai-generate':
      return validateGenerate(obj);
    case 'ai-translate':
      return validateTranslate(obj);
    case 'ai-rewrite':
      return validateRewrite(obj);
    default:
      return null;
  }
};

/** Top-level parser. Returns a validated object or null on any shape mismatch. */
export const parseContractedOutput = (
  slug: string,
  raw: string,
): Record<string, unknown> | null => {
  const obj = parseJSONObject(raw);
  if (!obj) return null;
  return validateContractedObject(slug, obj);
};

/** D-162 A.3 — parse a batch-mode model response into a Map keyed by each
 *  entry's `id_field` value. Each entry's remaining fields (the entry minus
 *  `id_field`) are validated by the slug's single-mode validator, reused
 *  verbatim (I-5 / TR-3).
 *
 *  Returns null on any model-response-internal failure — the parser-side
 *  half of N.6: the response is not a JSON array of objects; an entry has a
 *  missing or empty `id_field` value; an id is duplicated across the
 *  response; an entry's result fields fail the slug's validator. The other
 *  half of N.6 — a model id missing from / extra to `llm.data` — is the
 *  executor's cross-check against the input array (see `mergeBatchResult`). */
export const parseContractedBatch = (
  slug: string,
  raw: string,
  idField: string,
): Map<unknown, Record<string, unknown>> | null => {
  const entries = parseJSONArray(raw);
  if (!entries) return null;
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry[idField];
    if (id == null || id === '') return null;
    if (byId.has(id)) return null; // duplicate id within the model response
    const { [idField]: _id, ...resultFields } = entry;
    const validated = validateContractedObject(slug, resultFields);
    if (!validated) return null;
    byId.set(id, validated);
  }
  return byId;
};

// ─── Per-function validators ─────────────────────────────────────────────────

const validateClassify = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isString(o.category)) return null;
  if (!isNumber(o.confidence)) return null;
  if (!isString(o.reasoning)) return null;
  return {
    category: o.category,
    confidence: Math.max(0, Math.min(1, o.confidence)),
    reasoning: o.reasoning,
  };
};

const validateScore = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isNumber(o.score)) return null;
  if (!isObjectArray(o.breakdown)) return null;
  if (!isString(o.reasoning)) return null;
  // Each breakdown item needs at least { criterion, score }
  for (const item of o.breakdown) {
    if (!isString(item.criterion)) return null;
    if (!isNumber(item.score)) return null;
  }
  return { score: o.score, breakdown: o.breakdown, reasoning: o.reasoning };
};

const validateSummarize = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isString(o.summary)) return null;
  if (!isStringArray(o.key_points)) return null;
  return { summary: o.summary, key_points: o.key_points };
};

const validateSentiment = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (o.sentiment !== 'positive' && o.sentiment !== 'neutral' && o.sentiment !== 'negative') {
    return null;
  }
  if (!isNumber(o.score)) return null;
  if (!isStringArray(o.signals)) return null;
  return {
    sentiment: o.sentiment,
    score: Math.max(-1, Math.min(1, o.score)),
    signals: o.signals,
  };
};

const validateCompare = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isStringArray(o.differences)) return null;
  if (!isStringArray(o.similarities)) return null;
  if (!isString(o.recommendation)) return null;
  return {
    differences: o.differences,
    similarities: o.similarities,
    recommendation: o.recommendation,
  };
};

const validateGenerate = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isString(o.content)) return null;
  return { content: o.content };
};

const validateTranslate = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isString(o.translated)) return null;
  if (!isString(o.source_language)) return null;
  if (!isNumber(o.confidence)) return null;
  return {
    translated: o.translated,
    source_language: o.source_language,
    confidence: Math.max(0, Math.min(1, o.confidence)),
  };
};

const validateRewrite = (o: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isString(o.rewritten)) return null;
  return { rewritten: o.rewritten };
};
