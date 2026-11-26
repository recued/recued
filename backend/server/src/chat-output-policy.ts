/** ⛔⛔ `reasoning` COMES FIRST, AND THE ORDER IS THE WHOLE POINT — a field
 *  appended after `response` buys nothing, because the answer is already
 *  written by then.
 *
 *  🔑 WHY IT IS HERE AT ALL: this door calls with `output_format: 'json'`, which
 *  the OpenAI adapter turns into `response_format: {type:'json_object'}` —
 *  CONSTRAINED DECODING, not a prompt instruction. Under that constraint the
 *  model answers straight into the first key it is given, and with `response`
 *  first that key IS the final answer, so a derivation has nowhere to happen.
 *  Measured on the bench-276 packet, one captured turn replayed with only the
 *  SHAPE varying: 11/16 correct with `response` first, 16/16 with `reasoning`
 *  first (Fisher two-tailed p = 0.043). The same packet sent WITHOUT json mode
 *  is 31/31 — so the constraint was costing ~26 points and this recovers them.
 *
 *  ⛔ NOT THE SAME AS A PROMPT INSTRUCTION TO EMIT JSON, and that distinction is
 *  why this was missed for so long. Shipping this very text as a system message
 *  WITHOUT `response_format` measured 11/11 — the envelope reads as innocent
 *  every way except the one the door actually uses.
 *
 *  🔑 THE SYMPTOM, IN HINDSIGHT: answers that STATED a figure and then computed a
 *  different one. Two baseline runs headlined $12,337.50 and $12,600, worked
 *  through the arithmetic inside the reply, and landed on $11,397.50 — the model
 *  was reasoning in the `response` string after committing to a number.
 *
 *  ⚠ THE "never shown to the user" CLAUSE IS A PROMISE THE SUBSTRATE KEEPS, not
 *  a hope. The user-visible reply is `currentAiOutput.response` (this file) and
 *  the streamed `final_text` is that same text (`middleware/pipeline.ts`); no
 *  surface renders the envelope. Break that and this line becomes a lie told to
 *  the model about its own privacy.
 *
 *  ⚠ COSTS OUTPUT TOKENS ON EVERY TURN, including the trivial ones that need no
 *  derivation. That is the open trade — see the optimization log entry. */
import { BROWSER_TOOLKIT_RECIPE_SLUGS } from '@recued/contracts';

/** The baseline remains unchanged for on/default. Off is selected after routing. */
export const CHAT_OUTPUT_SHAPE = `AIOutput shape:
{
  "reasoning": "<work the answer out here FIRST, in full, before writing \"response\". Show any arithmetic step by step. This field is internal and is never shown to the user.>",
  "response": "<short, calm reply>",
  "events": [ {"kind": "extraction.<class>", "payload": {...}}, ... ],
  "tool_calls": [{ "tool": "<recipe_slug>", "args": {...} }],
  "nothing_outstanding": <true only when you plan no further action — the ask is answered, or you have concluded it cannot be answered. Omit it otherwise.>
}`;


export const CHAT_THINKING_OFF_GUIDANCE =
  'Internal reasoning output is disabled for this call. Omit the "reasoning" field and return only the declared result fields.';

export const BROWSER_NEXT_ACTION_GUIDANCE =
  'Browser control: emit one next action batch using only controls grounded in the current read. '
  + 'Use table for existing tables/grids, read.data_format:"entries" for list records and form:"text" for prose. Batch table/click/wait/table on '
  + 'an observed repeated layout; verify changed rows even when the URL stays the same. End the batch with a read, table '
  + 'or then_read after navigation or form submission. Return that observation before planning '
  + 'actions that depend on an unknown page. Correct reported argument errors; use data.describe for unfamiliar transforms '
  + 'and do not repeat an unchanged rejected call. Keep response empty while requesting tools; do not narrate a future plan, '
  + 'copy page contents or repeat tool definitions in the output.';

/** Replaces only host-owned envelopes; evidence and owner text stay untouched. */
export const chatThinkingOffPrompt = (prompt: string, additionalShape: string, browserAction = false): string => {
  let changed = false;
  for (const shape of [CHAT_OUTPUT_SHAPE, additionalShape]) {
    if (!shape || !prompt.includes(shape)) continue;
    const compact = shape.replace(/^  "reasoning":[^\n]*\n/m, '');
    prompt = prompt.replace(shape, () => `${compact}\n${CHAT_THINKING_OFF_GUIDANCE}`);
    changed = true;
  }
  return changed && browserAction ? `${prompt}\n\n${BROWSER_NEXT_ACTION_GUIDANCE}` : prompt;
};

export const browserActionContext = (namedPages: readonly unknown[] | undefined,
  calls: readonly { readonly tool_name: string }[] | undefined): boolean => Boolean(namedPages?.length)
  || Boolean(calls?.some(call => BROWSER_TOOLKIT_RECIPE_SLUGS.has(call.tool_name.slice(call.tool_name.lastIndexOf('/') + 1))));
