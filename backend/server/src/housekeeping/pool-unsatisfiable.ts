/** D-262 — the ONE list of "the AI could not run, and that is a state to wait
 *  on rather than a failure to punish".
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE RULE LIVED AT TWO ENDS AND ONLY ONE WAS WIDENED.
 *  The scheduler classifies an error thrown OUT of a task step; the enrichment
 *  producer classifies the same error caught INSIDE its per-record loop, and
 *  the producer's catch runs first — so the scheduler's copy never sees a
 *  per-record error at all. `AI_NO_TRANSCRIPTION_SOURCE` was added to the
 *  scheduler's set and not the producer's, which fixed the task-level
 *  auto-disable while leaving the per-record path punishing every row:
 *  `producer_failure` -> backoff -> `permanently_failed` at attempt 5, with no
 *  auto-retry. An owner who configured the slot on day four would find the
 *  rows dead, and the thing that would have cleared them is the call the
 *  missing configuration was refusing.
 *
 *  ⇒ Two ends, one constant. Adding a code here reaches both.
 *
 *  ⚠ THE CODE IS THE DISCRIMINATOR, never the message text — matching a
 *  rendered string breaks the moment it is reworded and catches unrelated
 *  errors that happen to mention a model. */
export const POOL_UNSATISFIABLE_CODES: ReadonlySet<string> = new Set([
  /** No pool entry / slot matches the requirements at the forced layer. */
  'AI_LLM_UNAVAILABLE',
  /** D-262 — `transcription_slot` is not configured yet. Unconfigured is a
   *  state an owner resolves in Settings, not a defect in the row. */
  'AI_NO_TRANSCRIPTION_SOURCE',
  /** D-262 — a daily cap is spent. Retrying the row now cannot succeed, and
   *  burning its attempt budget on a condition that clears at 00:00 UTC turns
   *  a one-day pause into a permanent skip. */
  'AI_TOKEN_BUDGET_EXCEEDED',
]);

export const isPoolUnsatisfiable = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && POOL_UNSATISFIABLE_CODES.has(code);
};
