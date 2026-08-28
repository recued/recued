import { AI_RESULT_FIELDS, isAIBatchMode, stripCorePrefix } from '@recued/contracts';
import type { LLMMessage } from './types.js';
import { isLLMMessageRole, LLMError } from './types.js';

/** The slugs for which we have a contracted prompt template.
 *  Ingredients with these slugs MUST match the documented input/output schema. */
export const CONTRACTED_SLUGS = new Set([
  'ai-classify',
  'ai-score',
  'ai-extract',
  'ai-summarize',
  'ai-sentiment',
  'ai-compare',
  'ai-generate',
  'ai-translate',
  'ai-rewrite',
]);

// §5 — a `core-<bare>` slug is the kernel-namespace alias for the contracted
// function `<bare>`; it must route exactly like the bare slug. Strip on read.
export const isContractedSlug = (slug: string): boolean => CONTRACTED_SLUGS.has(stripCorePrefix(slug));

/** Serialize an arbitrary value to the user message. Strings pass through; everything
 *  else is JSON-stringified with indentation for readability. */
const stringify = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

/** Extract llm.* input field or throw an input error. */
const requireField = (input: Record<string, unknown>, key: string, slug: string): unknown => {
  const value = input[`llm.${key}`];
  if (value == null || value === '') {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `${slug} requires input llm.${key}`,
      { slug, missing: `llm.${key}` },
    );
  }
  return value;
};

const optionalField = (input: Record<string, unknown>, key: string): unknown =>
  input[`llm.${key}`];

/** Universal suffix appended to every contracted system prompt.
 *  Keeps the JSON-only requirement in one place so every function gets it identically. */
const JSON_ONLY =
  'Respond with ONLY a valid JSON object matching the exact schema. ' +
  'No markdown, no code fences, no preamble, no explanation outside the JSON.';

/** D-162 A.2 — `JSON_ONLY`'s batch-mode sibling. `JSON_ONLY` says
 *  "object"; a batch response is an array. Kept as a separate constant so
 *  `JSON_ONLY` is never edited (N.7 / I-1 — single mode is byte-unchanged). */
const JSON_ARRAY_ONLY =
  'Respond with ONLY a valid JSON array matching the exact schema. ' +
  'No markdown, no code fences, no preamble, no explanation outside the JSON.';

/** D-162 A.2 — the batch system-prompt tail: the JSON-array schema, the
 *  per-record-independence + completeness instruction, then
 *  `JSON_ARRAY_ONLY`. `resultSchema` is the operation's per-entry
 *  result-field fragment — the field list single mode documents, without
 *  the surrounding braces. */
const batchSchemaBlock = (idField: string, resultSchema: string): string =>
  'Schema: a JSON array, one object per input record, each ' +
  `{ "${idField}": <the record's id, copied verbatim>, ${resultSchema} }.\n` +
  'Apply the operation to each record independently. Return exactly one ' +
  'entry for every input record and no others.\n\n' +
  JSON_ARRAY_ONLY;

/** D-162 N.2 — validate a batch-mode `llm.data` array at prompt-build time,
 *  before any model call. `data` is the resolved `llm.data` (the `isBatch`
 *  guard already proved it an array); `resultFields` is the operation's
 *  contracted result-field names. Throws `AI_OUTPUT_INVALID` on any
 *  violation — a recipe bug, distinct from a malformed model response.
 *
 *  An empty `data` array is itself a valid batch input; the executor
 *  short-circuits it ahead of prompt construction (D-162 A.7), so the
 *  element loop runs only on non-empty arrays in practice. */
const assertBatchInput = (
  slug: string,
  data: readonly unknown[],
  idField: string,
  resultFields: readonly string[],
): void => {
  if (resultFields.includes(idField)) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `${slug}: llm.id_field "${idField}" collides with a contracted result field`,
      { slug, id_field: idField },
    );
  }
  const seen = new Set<unknown>();
  for (let i = 0; i < data.length; i++) {
    const element = data[i];
    if (element == null || typeof element !== 'object' || Array.isArray(element)) {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${slug}: llm.data[${i}] must be a non-null object in batch mode`,
        { slug, index: i },
      );
    }
    const id = (element as Record<string, unknown>)[idField];
    if (id == null || id === '') {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${slug}: llm.data[${i}] is missing a non-empty "${idField}" value`,
        { slug, index: i, id_field: idField },
      );
    }
    if (seen.has(id)) {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${slug}: duplicate llm.id_field value "${String(id)}" at llm.data[${i}]`,
        { slug, index: i, id_field: idField },
      );
    }
    seen.add(id);
  }
};

/** Build the messages for a contracted AI function — single mode (one
 *  `llm.data` value) or D-162 batch mode (`llm.data` array + non-empty
 *  `llm.id_field`). Throws `AI_OUTPUT_INVALID` if the slug is not
 *  contracted, a required field is missing, or a batch input violates the
 *  N.2 contract. */
export const buildContractedPrompt = (
  slug: string,
  input: Record<string, unknown>,
): LLMMessage[] => {
  // D-162 A.1 — the batch-mode switch (N.1), computed once. `llm.id_field`
  // is the only switch; an array `llm.data` without it stays single mode.
  // Within an `isBatch` builder branch, `llm.id_field` is therefore a
  // non-empty string and `llm.data` an array — the per-branch casts rely
  // on that.
  const isBatch = isAIBatchMode(input);
  // §5 — normalize a `core-` kernel alias to its bare contracted name so
  // `core-ai-classify` builds the identical prompt to `ai-classify`. The `default`
  // error keeps the original slug for context.
  switch (stripCorePrefix(slug)) {
    case 'ai-classify':
      return classifyPrompt(input, isBatch);
    case 'ai-score':
      return scorePrompt(input, isBatch);
    case 'ai-extract':
      return extractPrompt(input, isBatch);
    case 'ai-summarize':
      return summarizePrompt(input, isBatch);
    case 'ai-sentiment':
      return sentimentPrompt(input, isBatch);
    case 'ai-compare':
      return comparePrompt(input);
    case 'ai-generate':
      return generatePrompt(input, isBatch);
    case 'ai-translate':
      return translatePrompt(input, isBatch);
    case 'ai-rewrite':
      return rewritePrompt(input, isBatch);
    default:
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${slug} is not a contracted AI function`,
        { slug },
      );
  }
};

/** D-116 — Engine-private sentinel inserted between instruction_block
 *  and data_block. Fixed, high-entropy, unlikely to appear in
 *  realistic recipe data. Documented as opaque so recipes can't
 *  depend on its exact value. Kept here so the prompt builder is the
 *  single owner — callers don't see it in the recipe input pipeline.
 *  Recipes attempting to set `llm.delimiter` error at parseRecipe via
 *  `LOCKED_INPUT_KEY` (see ENGINE_LOCKED_INPUT_KEYS). */
const D116_DELIMITER =
  '\n---BEGIN-RECUED-DATA-BOUNDARY-f7e58c6a-5b92-4e91-9c4c-b0c7ba2e0d91---\n';

const D116_DELIMITER_END =
  '\n---END-RECUED-DATA-BOUNDARY-f7e58c6a-5b92-4e91-9c4c-b0c7ba2e0d91---\n';

/** Build messages for an uncontracted ai-prompt call. Used for the escape-hatch
 *  ingredient where the recipe author supplies raw prompts.
 *
 *  D-116 — Two shapes accepted:
 *
 *    1. Preferred: `llm.instruction_block` + `llm.data_block`. Engine
 *       concatenates as SYSTEM: <instruction> [delimiter] USER: <data>
 *       [delimiter] — the sentinel is engine-private, so embedded
 *       text inside `data_block` can't reconstruct the trust boundary.
 *    2. Legacy: `llm.system_prompt` + `llm.prompt`. Zero behaviour
 *       change; validator emits `ai_prompt_legacy_shape` on new
 *       recipes so authors migrate to the safer shape. */
export const buildUncontractedPrompt = (
  input: Record<string, unknown>,
): LLMMessage[] => {
  const instruction = input['llm.instruction_block'];
  const dataBlock = input['llm.data_block'];
  const hasInstruction = instruction != null && instruction !== '';
  const hasData = dataBlock != null && dataBlock !== '';

  if (hasInstruction || hasData) {
    if (!hasInstruction || !hasData) {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        'ai-prompt: llm.instruction_block and llm.data_block must both be set (or both omitted to use legacy fields)',
      );
    }
    const system = `${String(instruction)}${D116_DELIMITER}`;
    const user = `${D116_DELIMITER}${stringify(dataBlock)}${D116_DELIMITER_END}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  // `stringify`, not `String()` — a pure-ref payload ("llm.prompt":
  // "{{step.context}}") arrives TYPE-PRESERVED as an object/array; String()
  // collapsed it to "[object Object]" and the model got no data at all. The
  // pretty-JSON form matches what `llm.data_block` (above) and the contracted
  // functions' data payloads already do.
  const system = stringify(input['llm.system_prompt']);
  const user = stringify(input['llm.prompt']);
  if (!user) {
    throw new LLMError('AI_OUTPUT_INVALID', 'ai-prompt requires llm.prompt');
  }
  const messages: LLMMessage[] = [];
  // `llm.system_role` — the owner's Settings → AI/Models role knob, threaded
  // PER CALL by the chat / gateway turn composer. Absent (every recipe
  // `ai-prompt` step, every contracted function) resolves to `'system'`, so
  // this is byte-identical to the hardcoded role it replaces.
  //
  // ⚠ It is deliberately an INPUT rather than a read of the global LLM config:
  // `buildUncontractedPrompt` is shared with every recipe `ai-prompt` step, and
  // a config read here would silently re-role a hundred community recipes the
  // owner was not thinking about when they set a chat preference.
  //
  // The D-116 instruction/data shape above keeps its hardcoded `'system'` — its
  // delimiter sentinel IS the trust boundary, and re-roling the instruction
  // half would dismantle the construction it exists to make.
  const systemRole = isLLMMessageRole(input['llm.system_role'])
    ? input['llm.system_role']
    : 'system';
  if (system) messages.push({ role: systemRole, content: system });
  messages.push(buildUserTurn(user, input['llm.cache_prefix']));
  return messages;
};

/** D-164 prompt-cache restructure — build the user turn, optionally split into a
 *  cached-prefix block + a per-turn block.
 *
 *  When `llm.cache_prefix` is a non-empty string AND a strict literal prefix of
 *  `user` (the byte-identity invariant from the chat main-turn composer's
 *  `cacheable_prefix`), the message carries `content_parts`:
 *    [ { text: prefix, cache_breakpoint: true }, { text: rest } ]
 *  so the Anthropic adapter places ONE `cache_control` breakpoint after the
 *  (stable) prefix. `content` stays the FULL `user` string, so every other
 *  provider — and the text-only collapse in the OpenAI/Gemini adapters — sends
 *  the byte-identical single string. The split is therefore a no-op everywhere
 *  explicit caching isn't supported; the model reads the exact same bytes.
 *
 *  Fail-open: a missing / non-string / non-prefix / whole-string marker yields
 *  the plain single-string turn (today's behaviour) — so a silent prefix drift
 *  (e.g. a PII pre-scan that rewrote a `pii.` literal inside the catalog) just
 *  loses caching for that turn rather than corrupting the prompt. */
const buildUserTurn = (user: string, cachePrefixRaw: unknown): LLMMessage => {
  const cachePrefix = typeof cachePrefixRaw === 'string' ? cachePrefixRaw : '';
  if (
    cachePrefix.length === 0
    || cachePrefix.length >= user.length
    || !user.startsWith(cachePrefix)
  ) {
    return { role: 'user', content: user };
  }
  return {
    role: 'user',
    content: user,
    content_parts: [
      { type: 'text', text: cachePrefix, cache_breakpoint: true },
      { type: 'text', text: user.slice(cachePrefix.length) },
    ],
  };
};

/** Exposed for tests — lets them assert the delimiter sentinel is
 *  present without hard-coding the raw string. Not re-exported by the
 *  package entry; tests import from `./prompts.js` directly. */
export const __D116_DELIMITER_SENTINEL = D116_DELIMITER;

// ─── Contracted prompt templates ─────────────────────────────────────────────

const classifyPrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-classify');
  const categories = requireField(input, 'categories', 'ai-classify') as string[];
  const context = optionalField(input, 'context');
  const contextLine = context ? `\n\nContext:\n${stringify(context)}` : '';

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-classify', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-classify'],
    );
    const system =
      'You are a classifier. For each input record, choose exactly one category ' +
      'from the provided list that best fits that record, with a confidence ' +
      'between 0 and 1 and a one-sentence reasoning.\n\n' +
      batchSchemaBlock(
        idField,
        '"category": "<one of the provided categories>", "confidence": <0-1>, "reasoning": "<one sentence>"',
      );
    const user = `Categories: ${JSON.stringify(categories)}${contextLine}\n\nRecords:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    'You are a classifier. Choose exactly one category from the provided list that best fits the data. ' +
    'Output a confidence between 0 and 1 and a one-sentence reasoning.\n\n' +
    // ⛔ `reasoning` STAYS LAST HERE — MEASURED, NOT OVERLOOKED, and the contrast
    // with `ai-score` (below) and with chat's shape is the point.
    //
    // Both run under the same constrained decoding, so the same worry applies:
    // does answering into the FIRST key cost accuracy? For a classifier it does
    // not. `category` is a one-of-N LABEL, so the model can work internally and
    // emit a short token; it does not have to compose anything before it knows
    // the answer. Measured on a deliberately derivation-heavy classification —
    // the agreed unit price is 6% off an ask stated four messages earlier, and a
    // shallow read anchors on the counter-offer instead — the SHIPPED schema was
    // 16/16 correct, with the working visible in the trailing `reasoning`.
    //
    // ⛔ AND THE "FIX" MEASURED WORSE: a reasoning-first variant went 13/16 with
    // three outputs carrying no `category` at all, and grew the response from
    // ~150 to 350-1900 characters. These calls also run in BATCH mode over N
    // records against a `max_tokens` of 4000-8000, where a long per-record
    // preamble truncates the ARRAY — losing every record, not one. A change that
    // buys nothing and risks the whole batch is not a safe default.
    //
    // ⇒ The rule is not "put reasoning first in JSON mode". It is: a field the
    // model must COMPOSE (chat's prose `response`) or COMPUTE FROM SIBLINGS
    // (`ai-score`'s average) must not precede what it depends on. A label
    // depends on nothing in the object.
    'Schema: { "category": "<one of the provided categories>", "confidence": <0-1>, "reasoning": "<one sentence>" }\n\n' +
    JSON_ONLY;

  const user = `Categories: ${JSON.stringify(categories)}${contextLine}\n\nData:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const scorePrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-score');
  const criteria = requireField(input, 'criteria', 'ai-score') as string[];
  const scale = (optionalField(input, 'scale') as string | undefined) ?? '0-10';

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-score', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-score'],
    );
    const system =
      'You are a scoring engine. For each input record, score it against each ' +
      'criterion on the provided scale, with a per-criterion breakdown, an ' +
      'overall score (average, rounded to one decimal), and a brief reasoning.\n\n' +
      batchSchemaBlock(
        idField,
        '"breakdown": [{ "criterion": "<name>", "score": <number>, "notes": "<short>" }], "score": <number>, "reasoning": "<2-3 sentences>"',
      );
    const user =
      `Scale: ${scale}\nCriteria: ${JSON.stringify(criteria)}\n\nRecords:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    'You are a scoring engine. Score the data against each criterion on the provided scale. ' +
    'Produce a per-criterion breakdown, an overall score (average, rounded to one decimal), ' +
    'and a brief reasoning.\n\n' +
    // ⛔⛔ `breakdown` BEFORE `score`, AND THE ORDER IS THE WHOLE FIX. `score` is
    // documented — one line above, in this same prompt — as the AVERAGE of the
    // breakdown, and the schema used to ask for it FIRST: the average of terms
    // the model had not written yet. Every contracted ai-* call runs under
    // `response_format:{type:'json_object'}` (`executor.ts` — `contracted ||
    // llm.output_format==='json'`), so this is constrained decoding, not a
    // suggestion; the model emits the number in key order and then has to make
    // the breakdown agree with it.
    //
    // Measured, one 7-criterion opportunity, 14 runs each, only the key order
    // varying: the stated overall matched the average of its OWN breakdown
    // 5/14 with `score` first and 14/14 with `breakdown` first (Fisher
    // p = 0.0006). Median drift 0.13 → 0.04, worst 0.61 → 0.04. Output length
    // is unchanged (1503 → 1530 chars) — this costs nothing.
    //
    // ⚠ NOT the same fix as chat's `reasoning`-first key, and deliberately not
    // that fix. Chat's `response` is COMPOSED PROSE that IS the deliverable, so
    // it needed a scratch field ahead of it. Here the answer is a NUMBER whose
    // inputs are already a field in the same object — reordering two existing
    // keys is enough, and adding a verbose reasoning-first field would only
    // lengthen a batch that is already near its `max_tokens`.
    'Schema: { "breakdown": [{ "criterion": "<name>", "score": <number>, "notes": "<short>" }], "score": <number>, "reasoning": "<2-3 sentences>" }\n\n' +
    JSON_ONLY;

  const user =
    `Scale: ${scale}\nCriteria: ${JSON.stringify(criteria)}\n\nData:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const extractPrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-extract');
  const fields = requireField(input, 'fields', 'ai-extract') as string[];

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    // ai-extract's result fields are recipe-defined by llm.fields (N.4
    // note); the N.2 collision check runs against them, not a static
    // AI_RESULT_FIELDS entry.
    assertBatchInput('ai-extract', data as readonly unknown[], idField, fields);
    const system =
      'You are a field extractor. For each input record, extract the requested ' +
      'fields. If a field is not present in a record, set its value to null. ' +
      'Do not invent values.\n\n' +
      batchSchemaBlock(
        idField,
        `the requested keys ${JSON.stringify(fields)} (each value the extracted content — string, number, array, or null)`,
      );
    const user = `Fields: ${JSON.stringify(fields)}\n\nRecords:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    'You are a field extractor. Extract the requested fields from the data. ' +
    'If a field is not present, set its value to null. Do not invent values.\n\n' +
    `Schema: an object with exactly these keys: ${JSON.stringify(fields)}. ` +
    'Each value is the extracted content (string, number, array, or null).\n\n' +
    JSON_ONLY;

  const user = `Fields: ${JSON.stringify(fields)}\n\nData:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const summarizePrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-summarize');
  const max_length = (optionalField(input, 'max_length') as number | undefined) ?? 200;
  const focus = optionalField(input, 'focus') as string | undefined;
  const focusLine = focus ? `\nFocus area: ${focus}` : '';

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-summarize', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-summarize'],
    );
    const system =
      `You are a summarizer. For each input record, produce a summary of at most ${max_length} words and extract 3-5 key points.${focusLine}\n\n` +
      batchSchemaBlock(
        idField,
        '"summary": "<<=' + max_length + ' words>", "key_points": ["<point>", ...]',
      );
    const user = `Records:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    `You are a summarizer. Produce a summary of at most ${max_length} words and extract 3-5 key points.${focusLine}\n\n` +
    'Schema: { "summary": "<<=' + max_length + ' words>", "key_points": ["<point>", ...] }\n\n' +
    JSON_ONLY;

  const user = `Data:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const sentimentPrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-sentiment');

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-sentiment', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-sentiment'],
    );
    const system =
      'You are a sentiment analyzer. For each input record, classify its overall ' +
      'sentiment and list the signals that led to the classification.\n\n' +
      batchSchemaBlock(
        idField,
        '"sentiment": "positive" | "neutral" | "negative", "score": <-1 to 1>, "signals": ["<short phrase>", ...]',
      );
    const user = `Records:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    'You are a sentiment analyzer. Classify the overall sentiment of the data and list the ' +
    'signals that led to the classification.\n\n' +
    'Schema: { "sentiment": "positive" | "neutral" | "negative", "score": <-1 to 1>, "signals": ["<short phrase>", ...] }\n\n' +
    JSON_ONLY;

  const user = `Data:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const comparePrompt = (input: Record<string, unknown>): LLMMessage[] => {
  // D-162 I-6 — ai-compare is pairwise (llm.data_a / llm.data_b); it has no
  // single llm.data to batch over. Reject a batch opt-in at the builder as
  // defense-in-depth alongside the P2 manifest-validator gate (N.5).
  const idField = input['llm.id_field'];
  if (typeof idField === 'string' && idField !== '') {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      'ai-compare does not support batch mode — llm.id_field is not accepted',
      { slug: 'ai-compare', id_field: idField },
    );
  }
  const data_a = requireField(input, 'data_a', 'ai-compare');
  const data_b = requireField(input, 'data_b', 'ai-compare');
  const dimensions = optionalField(input, 'dimensions') as string[] | undefined;

  const dimLine = dimensions?.length
    ? `Compare specifically along these dimensions: ${JSON.stringify(dimensions)}. `
    : '';
  const system =
    `You are a comparator. ${dimLine}List concrete differences and similarities between data A and data B, ` +
    'then give a recommendation that answers "which one and why" in one sentence.\n\n' +
    'Schema: { "differences": ["<statement>", ...], "similarities": ["<statement>", ...], "recommendation": "<one sentence>" }\n\n' +
    JSON_ONLY;

  const user = `Data A:\n${stringify(data_a)}\n\nData B:\n${stringify(data_b)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const generatePrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-generate');
  const template_type = requireField(input, 'template_type', 'ai-generate') as string;
  const tone = (optionalField(input, 'tone') as string | undefined) ?? 'neutral';

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-generate', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-generate'],
    );
    const system =
      `You are a content generator. For each input record, produce a ${template_type} using that record's data, in a ${tone} tone. ` +
      'Keep each one concise and ready to use.\n\n' +
      batchSchemaBlock(idField, '"content": "<the generated text>"');
    const user = `Records:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    `You are a content generator. Produce a ${template_type} using the provided data, in a ${tone} tone. ` +
    'Keep it concise and ready to use.\n\n' +
    'Schema: { "content": "<the generated text>" }\n\n' +
    JSON_ONLY;

  const user = `Data:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const translatePrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-translate');
  const target_language = requireField(input, 'target_language', 'ai-translate') as string;

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-translate', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-translate'],
    );
    const system =
      `You are a translator. For each input record, translate its data into ${target_language}, preserving meaning and tone. ` +
      'Identify the source language (ISO 639-1 code) and report a confidence between 0 and 1.\n\n' +
      batchSchemaBlock(
        idField,
        '"translated": "<translated text>", "source_language": "<iso-639-1>", "confidence": <0-1>',
      );
    const user = `Records:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    `You are a translator. Translate the data into ${target_language}, preserving meaning and tone. ` +
    'Identify the source language (ISO 639-1 code). Report a confidence between 0 and 1.\n\n' +
    'Schema: { "translated": "<translated text>", "source_language": "<iso-639-1>", "confidence": <0-1> }\n\n' +
    JSON_ONLY;

  const user = `Data:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

const rewritePrompt = (
  input: Record<string, unknown>,
  isBatch: boolean,
): LLMMessage[] => {
  const data = requireField(input, 'data', 'ai-rewrite');
  const style = requireField(input, 'style', 'ai-rewrite') as string;
  const instructions = optionalField(input, 'instructions') as string | undefined;
  const instructionLine = instructions ? `\nAdditional instructions: ${instructions}` : '';

  if (isBatch) {
    const idField = input['llm.id_field'] as string;
    assertBatchInput(
      'ai-rewrite', data as readonly unknown[], idField,
      AI_RESULT_FIELDS['ai-rewrite'],
    );
    const system =
      `You are a rewriter. For each input record, rewrite its data in the ${style} style.${instructionLine}\n` +
      'Preserve the original meaning. Do not add or remove information.\n\n' +
      batchSchemaBlock(idField, '"rewritten": "<rewritten text>"');
    const user = `Records:\n${stringify(data)}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  const system =
    `You are a rewriter. Rewrite the data in the ${style} style.${instructionLine}\n` +
    'Preserve the original meaning. Do not add or remove information.\n\n' +
    'Schema: { "rewritten": "<rewritten text>" }\n\n' +
    JSON_ONLY;

  const user = `Data:\n${stringify(data)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};
