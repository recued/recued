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
  /** ⛔⛔ OPTIONAL SIGNAL, OBSERVED ONLY — NOT WIRED TO ANY DECISION YET.
   *
   *  True when the model plans no further action: the ask is answered, or it
   *  has concluded it cannot be answered. NOT a success claim — a refusal
   *  ("I cannot find the night-shift differential") is also nothing-outstanding,
   *  and for the purpose this exists for — deciding whether more carrying is
   *  worth paying for — those two are the same state.
   *
   *  🔑 WHY IT HAS TO COME FROM HERE. The only closure signal today is the
   *  brief's `pending`, and `pending` is produced ONLY BY A FOLD. So between
   *  folds there is nothing to read, which is precisely the window in which you
   *  would want to stop folding. Measured over the corpus: `pending: []` appears
   *  in 7% of briefs (27/402) and is NEVER observed on a tool-free turn, because
   *  folds do not run there — the data cannot contain the signal.
   *
   *  ⚠ AND THE FREE PROXY IS TOO WEAK TO ACT ON. A tool-free turn looks like
   *  closure and clusters at session end (83% in the last 20%), but 98 of 179
   *  were NOT final — a 55% false-positive rate.
   *
   *  ⛔ SO IT IS EMITTED AND RECORDED, NOT ACTED ON. Retire claims — the closest
   *  existing model judgement of "this is finished" — measured 72-81% precision
   *  across five instruction variants, every paired contrast null. Wiring an
   *  unmeasured boolean to a decision would repeat that. Measure its precision
   *  against real session ends first, THEN choose a consumer.
   *
   *  ⚠ ABSENT MEANS "WORK CONTINUES", never "closed". A model that omits the
   *  field must not be read as signalling completion — the fail-safe direction
   *  is to keep carrying. */
  /** Follow this work only. Untrusted model-selected source excerpts; the host
   * validates their shape and exact source match before rendering any of them. */
  readonly mail_work_recap?: unknown;
  /** Follow this work source plan. Host-owned rendering validates source
   * references, quotes, bounds and permission declarations after restoration. */
  readonly mail_work_plan?: unknown;
  readonly nothing_outstanding?: boolean;
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
/** Normalize ONE tool call from whatever shape the model emitted.
 *
 *  ⛔⛔ THREE ALIASES, ALL OBSERVED LIVE, ALL PREVIOUSLY DROPPED SILENTLY. A call
 *  the coercer cannot read becomes `tool_calls: []`, the loop reads "no tool
 *  calls" as done, and the turn ends reporting success having dispatched nothing.
 *  Measured on bench 181 (qwen3.7-plus): of five slice+lean-core runs, TWO ended
 *  on a dropped call — and in both the dropped call was the NEXT STEP OF THE
 *  CHAIN (`add-customer`, `list-customers`). The model was still working.
 *
 *    { tool, args }            — the contract shape
 *    { name, input }           — the provider-native tool_use shape
 *    { tool_name, args }       — a near-miss on the contract's own field name
 *
 *  ⚠ Returns the value UNCHANGED when it matches none of them, so
 *  `validateAIOutput` still surfaces genuine garbage rather than this quietly
 *  inventing a call. ⛔ Do NOT add a fourth alias without a transcript showing
 *  it: each accepted shape is a new way for a malformed envelope to read as a
 *  confident tool call instead of an error. */
const TOOL_RESULT_ECHO_KEYS = [
  'status',
  'result',
  'started_at',
  'completed_at',
] as const;

/** Is this object a RESULT the model was shown, rather than a call it is making?
 *
 *  ⛔⛔ THE ALIASES COLLIDE WITH THE PACKET'S OWN `prior_tool_calls` SHAPE, and
 *  that collision re-dispatched real work. A result entry is
 *  `{ tool_name, args, status, result, started_at, completed_at }` — its first
 *  two fields are EXACTLY the `{tool_name, args}` alias. A model that echoes its
 *  input (they do) therefore reads as a fresh batch of calls, and the tools run
 *  a SECOND time. Measured on bench 181: an echoed 2-entry block re-ran
 *  `list-buildings` and `add-unit` 18ms apart, which is also precisely what
 *  D-219 slice 8 excludes as "a repeated tool is a retry, not a procedure" — so
 *  the echo did not merely duplicate work, it destroyed the execution case.
 *
 *  ⚠ Checked ONLY on the alias branches. A `{tool, args}` call is the contract
 *  shape and keeps its existing unconditional pass-through. */
const looksLikeToolResultEcho = (c: Record<string, unknown>): boolean =>
  TOOL_RESULT_ECHO_KEYS.some((key) => key in c);

const normalizeToolCall = (call: unknown): unknown => {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) return call;
  const c = call as Record<string, unknown>;
  if ('tool' in c) return c;
  // ⛔ Every branch below is an ALIAS, and an alias must never eat a result.
  if (looksLikeToolResultEcho(c)) return c;
  if (typeof c.tool_name === 'string' && 'args' in c) {
    return { tool: c.tool_name, args: c.args };
  }
  // ⛔⛔ `recipe_slug` IS OUR OWN VOCABULARY, WHICH IS WHY THIS IS NOT A GUESS.
  // The packet advertises every tool as `{recipe_slug, args_schema}` — in
  // `available_tools` and in every `tools.search` result — so a model that names
  // a call by `recipe_slug` is being consistent with what we showed it, and the
  // decoder was the only thing that disagreed. Measured on bench 181: a run
  // emitted `{recipe_slug: 'recued-core/open-rental-contract', args: {customer_id,
  // unit_id, rent, start_date}}` — the complete third step of the chain, every
  // id correctly grounded — and it was dropped whole for the field name.
  if (typeof c.recipe_slug === 'string' && 'args' in c) {
    return { tool: c.recipe_slug, args: c.args };
  }
  if (
    typeof c.name === 'string'
    && c.input !== null
    && typeof c.input === 'object'
    // ⚠ `typeof [] === 'object'`, so without this an array `input` would become
    // `args`, which no tool accepts. Every sibling branch guards it; this one
    // predates them and did not.
    && !Array.isArray(c.input)
  ) {
    return { tool: c.name, args: c.input };
  }
  // `{kind: '<tool>', args: {…}}` — the name in the field the EVENT shape uses,
  // paired with call-shaped `args`.
  //
  // ⚠ THIS DELIBERATELY LOOSENS AN EARLIER REFUSAL, and the reasoning changed
  // rather than the appetite. That refusal covered `{kind, payload}` — genuinely
  // event-shaped — and justified itself as "a dispatch invented from an
  // unverified name is the silent-wrong-action trade". On re-reading, it is not
  // silent: an unknown name fails at the dispatcher and surfaces as an error,
  // and the name came from the model's own object, so the intent is its own.
  // What stays refused is `{kind, payload}`, where the model expressed an EVENT.
  // `{name, args}` — the provider's field for the NAME paired with OURS for the
  // arguments. ⚠ A hybrid, and the fourth shape drawn from vocabulary the packet
  // itself taught the model: observed live as
  // `[{type: 'tool_call', id: 'toolu_…', name: 'tools.search', args: {query: …}}]`.
  // Placed AFTER `{name, input}` so a native block keeps its own reading.
  if (
    typeof c.name === 'string'
    && c.args !== null
    && typeof c.args === 'object'
    && !Array.isArray(c.args)
  ) {
    return { tool: c.name, args: c.args };
  }
  if (
    typeof c.kind === 'string'
    && c.kind.length > 0
    && c.args !== null
    && typeof c.args === 'object'
    && !Array.isArray(c.args)
  ) {
    return { tool: c.kind, args: c.args };
  }
  // The OpenAI function-call shape. ⚠ `arguments` as an OBJECT only — the
  // JSON-STRING variant stays unhandled, per the standing ruling that a
  // parse-on-guess trades a visible empty round for a silent wrong one.
  // Observed live (bench 181): `{ name: 'recipe.run', arguments: { recipe_id,
  // config } }` carrying the chain's `add-customer` step, dropped entirely.
  if (
    typeof c.name === 'string'
    && c.arguments !== null
    && typeof c.arguments === 'object'
    && !Array.isArray(c.arguments)
  ) {
    return { tool: c.name, args: c.arguments };
  }
  return c;
};

export const coerceAIOutput = (output: unknown): unknown => {
  // A bare array → a list of tool calls with no wrapper at all. ⚠ EACH ELEMENT
  // is normalized: a model that drops the wrapper also tends to drop the
  // contract's field names, and an array of `{name, input}` blocks was reaching
  // `tool_calls` unconverted and failing validation — see `normalizeToolCall`.
  if (Array.isArray(output)) {
    // ⛔⛔ AN ALL-ECHO ARRAY BECOMES AN EMPTY ENVELOPE, NOT A FAILED ONE — and
    // the difference is the whole turn. A validation failure returns
    // `kind: 'failed'`, which ABORTS the turn with no retry; an empty envelope
    // gets the one recovery round that tells the model what it sent and asks
    // for a real call. The model echoing its `prior_tool_calls` block has
    // expressed no intent to lose, so the recoverable path is the honest one.
    // ⚠ Only when EVERY entry is an echo: a mixed array still carries a real
    // call, and silently dropping half a plan is worse than halting on it.
    // ⛔ AN ALL-ECHO ARRAY BECOMES AN EMPTY ENVELOPE, NOT A FAILED ONE — the
    // model echoed its own `prior_tool_calls` and expressed no intent to lose,
    // so it earns the recovery round rather than an abort.
    // ⚠ ANY OTHER unrecognised array is left ALONE for `validateAIOutput` to
    // flag, deliberately. Swallowing it into an empty envelope would be
    // recoverable but MUTE: the recovery feedback names the model's stray keys,
    // and a discarded array has none to name, so the model would be told only
    // "empty" and repeat the mistake. ⇒ The real defect is that a validation
    // failure earns NO retry while an empty output earns one — that asymmetry
    // belongs in the executor's retry policy, not in this parser quietly
    // dropping content to route around it. Written up in
    // internal design notes.
    if (
      output.length > 0
      && output.every((entry) =>
        entry !== null
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && looksLikeToolResultEcho(entry as Record<string, unknown>))
    ) {
      return { response: '', events: [], tool_calls: [] };
    }
    return { response: '', events: [], tool_calls: output.map(normalizeToolCall) };
  }
  if (output === null || typeof output !== 'object') return output;
  const o = output as Record<string, unknown>;
  // A BARE TOOL CALL with none of the wrapper keys, in ANY alias
  // `normalizeToolCall` knows (`{tool,args}`, `{tool_name,args}`,
  // `{name,input}`, `{name,arguments}`).
  //
  // ⛔⛔ ONE BRANCH ON PURPOSE — THIS USED TO BE THREE, AND THE THIRD ALIAS FELL
  // THROUGH ALL OF THEM. Each branch repeated the wrapper-key guard and added
  // its own shape test, so `normalizeToolCall` could understand a shape that
  // nothing ROUTED to it: a bare `{name, arguments}` matched neither the
  // `tool`/`tool_name` test nor the `name`+`input` one, reached fill-defaults,
  // and emerged as `tool_calls: []` — dispatching nothing, silently. Asking the
  // normalizer whether it produced a call cannot drift from what the normalizer
  // accepts, because it IS what the normalizer accepts.
  //
  // ⚠ THE WRAPPER-KEY GUARD IS THE LOAD-BEARING HALF: it fires only when
  // `response` / `events` / `tool_calls` are ALL absent, so a normal envelope is
  // never reinterpreted as a call.
  //
  // ⚠ `'tool' in o` is kept as a separate disjunct so a malformed `{tool: 123}`
  // still wraps and still fails `validateAIOutput` loudly with
  // `tool_call_not_shaped`, rather than becoming a silent empty envelope.
  if (
    !('response' in o)
    && !('events' in o)
    && !('tool_calls' in o)
  ) {
    const asCall = normalizeToolCall(o) as Record<string, unknown>;
    if ('tool' in o || typeof asCall.tool === 'string') {
      return { response: '', events: [], tool_calls: [asCall] };
    }
    // A SINGLE-KEY WRAPPER whose key IS the tool name: `{"request.dissection":
    // {schema_version: 1, …}}`. ⛔ Measured as the single most common unreadable
    // shape on bench 181 — 8 of 11 across six runs before the tool's description
    // was reworded, and still the largest residual class afterwards, entirely in
    // lean-core (full mode produced none).
    //
    // ⚠ NARROW BY THREE CONDITIONS, all needed: exactly ONE key (so a catalog
    // echo `{recipe_slug, args_schema}` and an event `{kind, payload}` are both
    // excluded on arity alone), a key that LOOKS like a tool name (contains `.`
    // or `/`, no whitespace), and an object value. An unknown name still fails
    // at the dispatcher, visibly.
    const keys = Object.keys(o);
    const soleKey = keys.length === 1 ? keys[0]! : undefined;
    const soleValue = soleKey === undefined ? undefined : o[soleKey];
    if (
      soleKey !== undefined
      && /^[^\s]*[./][^\s]*$/.test(soleKey)
      && soleValue !== null
      && typeof soleValue === 'object'
      && !Array.isArray(soleValue)
    ) {
      return {
        response: '',
        events: [],
        tool_calls: [{ tool: soleKey, args: soleValue }],
      };
    }
  }
  // A BARE EXTRACTION EVENT — the documented `events[]` entry shape with the
  // wrapper stripped off. ⚠ Narrow on purpose: `kind` must start with
  // `extraction.`, which is the prefix the contract reserves for extractions, so
  // this cannot swallow an arbitrary `{kind, payload}` object. A bare `kind`
  // naming a TOOL (`request.dissection` was observed) is deliberately NOT minted
  // into a call here — the coercer has no tool registry to check against, and
  // inventing a dispatch from an unverified name is exactly the silent-wrong-
  // action trade this file refuses. Those fall through to the empty envelope
  // below and earn the recovery round instead.
  if (
    typeof o.kind === 'string'
    && o.kind.startsWith('extraction.')
    && o.payload !== null
    && typeof o.payload === 'object'
    && !('response' in o)
    && !('events' in o)
    && !('tool_calls' in o)
  ) {
    return { response: '', events: [o], tool_calls: [] };
  }
  // Common case — fill only MISSING (undefined) optional wrapper fields with
  // documented defaults; a present `null` stays null so validateAIOutput flags
  // it (do NOT use `??`, which would mask a malformed null the same as absent).
  return {
    ...o,
    response: o.response === undefined ? '' : o.response,
    events: o.events === undefined ? [] : o.events,
    // ⚠ A PRESENT array is normalized too: a model that gets the wrapper right
    // can still name the fields wrong, and that call would otherwise be dropped
    // with the wrapper looking perfectly valid.
    tool_calls: o.tool_calls === undefined
      ? []
      : (Array.isArray(o.tool_calls) ? o.tool_calls.map(normalizeToolCall) : o.tool_calls),
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
