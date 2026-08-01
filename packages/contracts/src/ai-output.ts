/** D-145 PB6 — AIOutput shape (response + events + tool_calls).
 *
 *  Per § B.7.1. Every AI response carries two user-visible outputs
 *  (response / events) plus one non-rendered output (tool_calls). PB6
 *  ships:
 *
 *    - The closed `AIOutput` shape that AI providers conform to.
 *    - The closed `ToolCall` shape (tool name + args).
 *
 *  The composer pipeline lives in `packages/engine/src/ai-output/`. PB6
 *  contracts give the closed shapes; PB6 engine wires:
 *    - per-event dispatch (§ B.7.7)
 *    - composer ordering (§ B.7.8)
 *    - per-event undo (§ B.7.9)
 *    - multi-event noise control (§ B.7.10)
 *    - confirmation queue batching (§ B.7.11)
 *
 *  Spec: § B.7. */

import type { ExtractionEvent } from './extraction-events.js';

// ── PB6.7 — ToolCall (closed shape, § B.7.1) ─────────────────────────

/** § B.7.1 — non-rendered AI tool-call. The orchestrator dispatches
 *  via tool-use; not surfaced to the user as a parallel "output". */
export interface ToolCall {
  /** Tool / recipe slug / query primitive name. */
  readonly tool: string;
  /** Tool-specific positional payload. PB6 carries verbatim; per-tool
   *  arg validation lives in the recipe / primitive validators that
   *  consume tool calls. */
  readonly args: Readonly<Record<string, unknown>>;
}

// ── PB6.8 — AIOutput (closed shape, § B.7.1) ─────────────────────────

/** § B.7.1 — two user-visible outputs (response / events) plus non-
 *  rendered tool_calls. Concern separation:
 *
 *    - `response` — Recued voice (personality)
 *    - `events`   — durable extractions (competence)
 *    - `tool_calls` — action mechanism (engine-dispatched)
 *
 *  All three may co-occur in a single AI response. Per § B.7.1 last
 *  paragraph: "they don't duplicate, they layer." */
export interface AIOutput {
  /** ALWAYS present per § B.7.1 — primary chat bubble (Recued voice).
   *  Empty string is allowed when AI elects to render only events
   *  (rare; user-preference Quiet mode prefers terse responses but
   *  still emits something). The composer never fabricates a
   *  response — that's an AI provider concern. */
  readonly response: string;
  /** Optional — empty array when AI detected nothing extractable.
   *  PB6's composer ordering rules + per-event dispatch run over
   *  this field. */
  readonly events: ReadonlyArray<ExtractionEvent>;
  /** Optional — empty array when AI invokes no tools. The orchestrator
   *  dispatches tool calls via tool-use; results flow back through
   *  the standard tool-use return path (D-121 events / direct return). */
  readonly tool_calls: ReadonlyArray<ToolCall>;
}

/** Closed-list rejection reasons emitted by `validateAIOutput`. PB6
 *  ratchet pins membership. */
export const AI_OUTPUT_VALIDATION_KINDS = [
  /** `response` is not a string. */
  'response_not_string',
  /** `events` is not an array. */
  'events_not_array',
  /** `tool_calls` is not an array. */
  'tool_calls_not_array',
  /** `tool_calls` IS an array, but an entry is not a well-formed `ToolCall`:
   *  its `tool` is missing, not a string, or empty. Array-shape alone was not
   *  enough — measured live (qwen3.7-plus, substrate-bench task 155): the model
   *  emitted a tool_calls entry with no `tool` key, which passed this gate,
   *  reached `resolveConcurrencySafe` → `registry.getByName(undefined)`, and
   *  threw inside `topicOfEnrichmentToolName`'s `name.startsWith(...)`, taking
   *  the whole turn down ("turn failed after accept"). This gate exists so
   *  malformed model output halts CLEANLY with a closed-list reason instead of
   *  tripping an invariant downstream; a nameless call is exactly that case. */
  'tool_call_not_shaped',
] as const;
export type AIOutputValidationKind =
  (typeof AI_OUTPUT_VALIDATION_KINDS)[number];
export const AI_OUTPUT_VALIDATION_KIND_SET: ReadonlySet<AIOutputValidationKind> =
  new Set(AI_OUTPUT_VALIDATION_KINDS);

export interface AIOutputValidationIssue {
  readonly kind: AIOutputValidationKind;
  readonly detail?: string;
}

/** Substrate-shape validator. Per-event `kind` + `confidence`
 *  validation lives in `validateExtractionEvent`; this gate just
 *  asserts AIOutput's top-level field shapes. The orchestrator runs
 *  this BEFORE the composer pipeline so malformed AI output halts
 *  cleanly with a closed-list reason rather than tripping the
 *  composer's invariants.
 *
 *  Codex P2 fold (2026-05-10) — accepts `unknown` because the AI
 *  provider's parsed JSON may be `null` / a primitive / undefined
 *  (e.g. `JSON.parse('null')` or a parser surfacing failed-parse as
 *  null). Every shape problem surfaces as a closed-list issue
 *  uniformly; this gate must NEVER throw. */
export const validateAIOutput = (
  output: unknown,
): ReadonlyArray<AIOutputValidationIssue> => {
  const issues: AIOutputValidationIssue[] = [];
  // Untrusted-input guard — null / non-object inputs emit all three
  // structural issues at once so the composer can halt cleanly with
  // every reason known up-front (consistent with the PB5 contract
  // that gates surface every problem in one pass).
  if (output === null || typeof output !== 'object') {
    issues.push({ kind: 'response_not_string', detail: String(output) });
    issues.push({ kind: 'events_not_array', detail: String(output) });
    issues.push({ kind: 'tool_calls_not_array', detail: String(output) });
    return issues;
  }
  const o = output as {
    response?: unknown;
    events?: unknown;
    tool_calls?: unknown;
  };
  if (typeof o.response !== 'string') {
    issues.push({
      kind: 'response_not_string',
      detail: typeof o.response,
    });
  }
  if (!Array.isArray(o.events)) {
    issues.push({
      kind: 'events_not_array',
      detail: typeof o.events,
    });
  }
  if (!Array.isArray(o.tool_calls)) {
    issues.push({
      kind: 'tool_calls_not_array',
      detail: typeof o.tool_calls,
    });
  } else {
    // Entry shape, not just array shape. A nameless entry cannot be repaired
    // here — `coerceAIOutput` cannot invent the missing tool name — so the
    // output is REJECTED rather than partially executed. Dropping the bad
    // entry and dispatching the rest would silently run half of a plan the
    // model meant as a whole, which is a worse failure than halting.
    o.tool_calls.forEach((call, index) => {
      const name = (call as { tool?: unknown } | null)?.tool;
      if (typeof name !== 'string' || name.trim().length === 0) {
        issues.push({
          // Index + type only. Never the args: everything the model sees is
          // alias-space at the PII boundary, and echoing tool args into a
          // validation detail would route them past the egress scan.
          kind: 'tool_call_not_shaped',
          detail: `tool_calls[${index}].tool: ${
            name === undefined ? 'missing' : typeof name
          }`,
        });
      }
    });
  }
  return issues;
};

/** Coerce a provider's parsed JSON into a well-formed `AIOutput` shape before
 *  `validateAIOutput`. Real models routinely deviate from the documented
 *  envelope despite the JSON-only instruction: they drop the empty optional
 *  fields (`events` / `tool_calls`), omit `response` when they only call a
 *  tool, or emit a BARE tool call (`{tool, args}`) / an array of tool calls
 *  instead of the `{response, events, tool_calls}` wrapper. Each deviation is
 *  unambiguous, so normalize it into the envelope rather than failing the whole
 *  turn (the documented contract already calls `events` / `tool_calls`
 *  "Optional — empty array when …").
 *
 *  Safety: only a MISSING key (`undefined`) is defaulted — a present `null` or
 *  wrong-typed `events` / `tool_calls` / `response` is left untouched so
 *  `validateAIOutput` still flags it (this never silently rewrites a malformed
 *  field; a model that drops an empty optional omits the KEY, it does not send
 *  `null`). Non-object, non-array input is returned unchanged (validateAIOutput
 *  surfaces it as the all-issues case). The bare-tool-call branch fires only
 *  when a `tool` key is present AND none of the three wrapper keys are, so a
 *  normal envelope is never reinterpreted. */
export const coerceAIOutput = (output: unknown): unknown => {
  // A bare array → a list of tool calls with no wrapper at all.
  if (Array.isArray(output)) {
    return { response: '', events: [], tool_calls: output };
  }
  if (output === null || typeof output !== 'object') return output;
  const o = output as Record<string, unknown>;
  // A bare single tool call (`{ tool, args }`) with none of the wrapper keys.
  if (
    'tool' in o &&
    !('response' in o) &&
    !('events' in o) &&
    !('tool_calls' in o)
  ) {
    return { response: '', events: [], tool_calls: [o] };
  }
  // Common case — fill only MISSING (undefined) optional wrapper fields with
  // documented defaults; a present `null` stays null so validateAIOutput flags
  // it (do NOT use `??`, which would mask a malformed null the same as absent).
  return {
    ...o,
    response: o.response === undefined ? '' : o.response,
    events: o.events === undefined ? [] : o.events,
    tool_calls: o.tool_calls === undefined ? [] : o.tool_calls,
  };
};

// ── PB6.9 — Substrate self-check ─────────────────────────────────────

/** Defensive runtime check — closed-list constants are non-empty +
 *  frozen + unique. The orchestrator can call this at boot; PB6
 *  ratchet asserts on the same invariants. */
export const assertAIOutputInvariants = (): void => {
  const length = AI_OUTPUT_VALIDATION_KINDS.length as number;
  if (length === 0) {
    throw new Error('AI_OUTPUT_VALIDATION_KINDS must be non-empty');
  }
  if (AI_OUTPUT_VALIDATION_KIND_SET.size !== length) {
    throw new Error('AI_OUTPUT_VALIDATION_KINDS contains duplicates');
  }
};
