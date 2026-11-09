/** D-340 slice 4 — what `chat-turn-executor.ts` saves when a run ends at its
 *  cap (`max_rounds_exhausted`, its own `TOOL_BUDGET_EXHAUSTED_MESSAGE`), word
 *  for word: here, so a reader of a finished run can tell it apart without
 *  loading the executor. The orchestrator's ratchet test (`d-164-phase-6-3`)
 *  holds the two equal. */
export const TOOL_BUDGET_EXHAUSTED_MESSAGE =
  'The AI used all of this turn\'s tool budget before finishing an answer. Ask it to continue — or narrow the request if this keeps happening.';

/** D-340 slice 4 — an answer that ends with the budget's stop reason: the run ran out of its rounds
 *  before it finished, so nothing carries it as an answer (the streams' AI suggestions, their notice). */
export const isToolBudgetExhaustedAnswer = (content: string): boolean => content.trimEnd().endsWith(TOOL_BUDGET_EXHAUSTED_MESSAGE);

/** D-340 slice 4 (§3.3) — what a bounded run's last round is told with its tool results, so it ends
 *  with an answer rather than another lookup. ⚠ Model-facing — `chat-prompt-optimization-log.md`. */
export const BOUNDED_RUN_LAST_ROUND = 'This run has used its lookups: answer now from what you have read, with no more tool calls.';
