import type { StepType } from './steps.js';

export type FormatHint = 'currency' | 'number' | 'date' | 'relative' | 'percent';

export const FORMAT_HINTS = new Set<FormatHint>([
  'currency', 'number', 'date', 'relative', 'percent',
] as const);

/** Internal, BUILD-GENERATED escape hints — NOT author-facing display hints (kept out
 *  of `FORMAT_HINTS`). The connection-agnostic SOQL search builder emits one of these
 *  on a `{{ref}}` filter value so the resolver escapes the resolved value into the SOQL
 *  query STRING injection-safely (a query-string position, unlike a JSON body value);
 *  see `soql.ts`. `soql_string` → a quoted string literal (`'…'`); `soql_like` → a
 *  `LIKE` operand (`'%…%'`). A recipe author never writes these. */
export type EscapeHint = 'soql_string' | 'soql_like';

export const ESCAPE_HINTS = new Set<EscapeHint>([
  'soql_string', 'soql_like',
] as const);

/** Any `{{ref:hint}}` token the resolver recognizes — a display `FormatHint` OR an
 *  internal `EscapeHint`. `FormatHint ⊆ RefHint`, so widening from `FormatHint` is
 *  backward-compatible everywhere a hint flows. (Distinct from the recipe-variable
 *  `ValueHint` in `value-hint.ts` — this is the ref-interpolation hint.) */
export type RefHint = FormatHint | EscapeHint;

/** True when a `:suffix` token is a recognized ref hint (display or escape) — the
 *  parse-time gate that decides whether `parseRef` treats it as a hint or as part of
 *  the path. */
export const isRefHint = (candidate: string): candidate is RefHint =>
  FORMAT_HINTS.has(candidate as FormatHint) || ESCAPE_HINTS.has(candidate as EscapeHint);

/** Input keys that must be ingredient-declared static defaults, not
 *  recipe-controlled. These are the "what external resource does this call
 *  touch" targets — a recipe cannot redirect the call to a different target.
 *
 *  Note: `llm.system_prompt` is NOT in this set. Unlike URLs and MCP tools,
 *  an LLM call returns text to the recipe with no external side effect. The
 *  `ai-prompt` escape-hatch ingredient explicitly lets recipes supply a
 *  custom system prompt at call time — that's its purpose. For the 9
 *  contracted AI functions (ai-classify, ai-score, etc.), the system prompt
 *  is written by the ingredient author in @recued/llm's buildContractedPrompt,
 *  not read from the manifest input, so attestation happens in code. */
export const TARGET_SCOPE = new Set([
  'url', 'mcp.tool', 'dom.match',
] as const);

/** True if value contains {{...}} reference syntax. */
export const isRef = (v: unknown): v is string =>
  typeof v === 'string' && v.includes('{{') && v.includes('}}');

/** True if value has text outside {{...}} — will be interpolated to string. */
export const hasInterpolation = (v: unknown): boolean =>
  isRef(v) && !/^\{\{[^}]+\}\}$/.test(v);

/** Split "{{field}} operator value" into parts. */
export const parseCondition = (cond: string) => {
  const parts = cond.split(' ');
  return {
    field: parts[0],
    operator: parts[1],
    value: parts.slice(2).join(' ') || undefined,
  };
};

/** Determine step type from which field is present. */
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const stepType = (step: Record<string, unknown>): StepType =>
  hasOwn(step, 'transform') ? 'transform'
  : hasOwn(step, 'ingredient') ? 'ingredient'
  : hasOwn(step, 'guard') ? 'guard'
  : 'unknown';
