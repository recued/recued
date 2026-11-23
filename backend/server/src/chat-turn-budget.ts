import { CHAT_MAIN_TURN_TOOL_LOOP_CAP, CHAT_MAIN_TURN_DISCOVERY_ROUND_CAP, CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE,
  type ChatPriorToolCall, type TokenUsageReport } from '@recued/contracts';

/** 2026-11-21 (the owner: "a,b,c yes", b: earned rounds) — the work rounds an owner's turn can reach when each round
 *  past the cap reached something new (`reachedSomethingNew`), and the provider tokens past which it earns none. The
 *  owner, asked whether ten is enough for research across sites: raising the cap adds as much waste on the occasions the
 *  model is on a wrong path, so a round past it has to be earned. On browser task P every run that used all its rounds
 *  was going over pages it had already reached. */
export const CHAT_TURN_EARNED_ROUND_CEILING = 20;
export const CHAT_TURN_EARNED_ROUND_TOKEN_CEILING = 1_000_000;

/** 2026-11-21 (the owner: "take on the still open items") — the tokens the turn's calls had the provider newly process,
 *  which `CHAT_TURN_EARNED_ROUND_TOKEN_CEILING` counts: everything but the input served from its cache. A turn's packet
 *  grows by what each round adds, so most of each call's input is the call before it, cached and charged at a fraction.
 *  Counted whole, a browser turn on the 14-page trail stopped earning near call 16 (974,000 prompt tokens over 14 calls,
 *  two thirds of them cached), well short of `CHAT_TURN_EARNED_ROUND_CEILING`. A provider that reports no cache counts
 *  every token, as before. */
export const freshTokens = (usage: TokenUsageReport | undefined): number =>
  usage === undefined ? 0 : Math.max(0, usage.total_tokens - (usage.cache_read_input_tokens ?? 0));

/** 2026-11-21 (the owner: "finish the followups") — told in the turn after one that stopped at its round limit
 *  (`ChatMessage.reached_round_limit`), until that turn's first work round. The earlier turn's own answer, in
 *  `chat_tail`, often says its rounds ran out ("not possible in this turn due to the tool round budget being
 *  exhausted"), and the packet carries no count to say otherwise. On the bench's long-turn suite, 3 of 8 Continues after
 *  such an answer restated it with no tool call, or with two. ⚠ Model-facing — see `chat-prompt-optimization-log.md`. */
export const CHAT_TURN_AFTER_ROUND_LIMIT = 'The turn before this one stopped at its round limit. This turn has rounds of its own.';

/** One source for the ordinary turn and native qualification packet. Repairs never buy another dispatch round.
 *  2026-11-21 (the owner: "isnt the extra round non-model specific? so recued sees the limit, stop the model, show a
 *  continue") — the model is told how rounds are counted, not how many remain: Recued alone decides when a turn's rounds
 *  end (its cap, rounds earned past it), and the call after the last one is told none remain (`BOUNDED_RUN_LAST_ROUND`).
 *  A turn that ends there is marked, and Chat offers Continue under it (`RunChatTurnResult.reached_round_limit`).
 *  Measured on the bench's long-turn suite (90 runs): no change in correctness from hiding the count. The model at a dead
 *  end past its cap (task ZD) stopped the same way with or without it, so the count was not what stopped it.
 *  ⚠ Model-facing — see `chat-prompt-optimization-log.md`. */
export const chatToolRoundBudget = (roundCap = CHAT_MAIN_TURN_TOOL_LOOP_CAP, chargedRounds = 0, discoveryRounds = 0,
  afterRoundLimit = false) => ({
  discovery_only_rounds_remaining: chargedRounds >= roundCap ? 0 : Math.max(0, CHAT_MAIN_TURN_DISCOVERY_ROUND_CAP - discoveryRounds),
  rules: 'One round is one batch of tool calls, not a model call or a browser step. Only tools.search-only batches use the separate discovery allowance; mixed batches or searches after that allowance is spent use a work round. Finish as soon as the request is satisfied.',
  ...(afterRoundLimit ? { previous_turn: CHAT_TURN_AFTER_ROUND_LIMIT } : {}),
});

/** The addresses a result names (each `url` field, without what follows `#`), at most 64. */
const resultAddresses = (value: unknown, out: Set<string>, depth = 0): void => {
  if (depth > 8 || out.size >= 64 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 200)) resultAddresses(item, out, depth + 1); return; }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'url' && typeof item === 'string' && /^https?:\/\//i.test(item) && item.length <= 2_048) out.add(item.split('#')[0]!);
    else resultAddresses(item, out, depth + 1);
  }
};
/** A call by its tool and arguments, with object keys in one order. */
const callIdentity = (tool: string, args: unknown): string => {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]))
    : v;
  return `${tool}\u0000${JSON.stringify(canonical(args))}`;
};

/** 2026-11-21 — whether these calls reached something the turn had not: a page address one of their results names
 *  (any page a browser call reached, even one that then failed), or, for a call that names none and succeeded, the
 *  call itself. Records what they reached in `reached`.
 *  ⚠ By address, not by what a page shows: on browser task P each save stamps the note with the time, so the page
 *  reads differently after a second save of the same values, while its address stays the one already reached. */
export const reachedSomethingNew = (calls: readonly ChatPriorToolCall[], reached: Set<string>): boolean => {
  let fresh = false;
  for (const call of calls) {
    const addresses = new Set<string>();
    resultAddresses(call.result, addresses);
    const keys = addresses.size > 0 ? [...addresses].map((address) => `page ${address}`)
      : call.status === 'ok' ? [`call ${callIdentity(call.tool_name, call.args)}`] : [];
    for (const key of keys) if (!reached.has(key)) { reached.add(key); fresh = true; }
  }
  return fresh;
};

/** D-340 slice 4 — what `chat-turn-executor.ts` saves when a run ends at its
 *  cap (`max_rounds_exhausted`, its own `TOOL_BUDGET_EXHAUSTED_MESSAGE`), word
 *  for word: here, so a reader of a finished run can tell it apart without
 *  loading the executor. The orchestrator's ratchet test (`d-164-phase-6-3`)
 *  holds the two equal. 2026-11-21 — from contracts, so Chat can offer Continue under it. */
export const TOOL_BUDGET_EXHAUSTED_MESSAGE = CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE;

/** 2026-11-21 (the owner: "can it be resumed manually by user (present to user on what already has and basically user
 *  can continue maybe?)") — the pages a turn reached, with the titles its results gave them, in the order first reached:
 *  what a turn that stopped at its cap shows it already has, ahead of the stop reason. */
export const reachedPages = (calls: ReadonlyArray<{ readonly result?: unknown }>): Array<{ url: string; title?: string }> => {
  const pages = new Map<string, string | undefined>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || pages.size >= 64 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 200)) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string' && /^https?:\/\//i.test(record.url) && record.url.length <= 2_048) {
      const url = record.url.split('#')[0]!;
      const title = typeof record.title === 'string' && record.title.trim() !== '' && record.title.length <= 200 ? record.title.trim() : undefined;
      if (!pages.has(url) || (pages.get(url) === undefined && title !== undefined)) pages.set(url, title);
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  for (const call of calls) visit(call.result);
  return [...pages].map(([url, title]) => ({ url, ...(title !== undefined ? { title } : {}) }));
};

/** The answer of a turn that stopped at its cap with tools still wanted: the pages it reached (the last six, by
 *  title), then the stop reason, which stays last so Chat recognizes it (`isToolBudgetExhaustedAnswer`). */
export const toolBudgetStopAnswer = (calls: ReadonlyArray<{ readonly result?: unknown }>): string => {
  const pages = reachedPages(calls);
  if (pages.length === 0) return TOOL_BUDGET_EXHAUSTED_MESSAGE;
  const named = pages.slice(-6).map((page) => page.title !== undefined ? `“${page.title}” (${page.url})` : page.url);
  return `So far this turn reached ${pages.length > 6 ? `${String(pages.length)} pages, the last ${String(named.length)}: ` : ''}${named.join('; ')}.`
    + `\n\n${TOOL_BUDGET_EXHAUSTED_MESSAGE}`;
};

/** D-340 slice 4 — an answer that ends with the budget's stop reason: the run ran out of its rounds
 *  before it finished, so nothing carries it as an answer (the streams' AI suggestions, their notice). */
export const isToolBudgetExhaustedAnswer = (content: string): boolean => content.trimEnd().endsWith(TOOL_BUDGET_EXHAUSTED_MESSAGE);

/** D-340 slice 4 / D-378 — the last synthesis call of every turn, including ordinary chat.
 *  Also retained during existing output repairs. ⚠ Model-facing — `chat-prompt-optimization-log.md`. */
export const BOUNDED_RUN_LAST_ROUND = 'No tool rounds remain in this turn. Answer now from the results already available, with no more tool calls. State any incomplete or unverified part explicitly; do not claim success without evidence.';
