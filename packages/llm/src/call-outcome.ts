/** How a call to a provider ended, in the owner's terms: the one reading shared by Test connection
 *  (`probe.ts`) and every real call (`executor.ts`), so the two cannot disagree about one answer.
 *
 *  A real call's ending is kept per source as its last call (`QuotaTracker.recordCallOutcome`) and
 *  shown beside it in Settings → AI / Models. ⛔ Before (2026-11-16), a background call that failed
 *  (a recipe's AI step, an enrichment) left a line in a run log and nothing else: a retired model
 *  could fail every unattended call for days before the owner opened a chat. */

import { isModelMissingRejection } from './endpoint-capabilities.js';
import { LLMError, stoppedAtOutputLimit } from './types.js';

/** What went wrong, in the owner's terms rather than the provider's.
 *
 *  `unreachable` and `auth` are deliberately separate even though both mean "no answer": one is a
 *  network/URL problem and the other is a credential problem, and the fix is in a different field
 *  of the form. */
export type ProviderFailureDiagnosis =
  | 'auth'
  | 'unreachable'
  | 'model_missing'
  | 'rate_limited'
  | 'provider_error'
  | 'rejected';

const statusOf = (e: LLMError): number | undefined =>
  typeof e.details?.status === 'number' ? e.details.status : undefined;

/** Map a failure onto the field of the form the owner should look at.
 *
 *  ⚠ Reads `details.status`, never the message text. The message is truncated
 *  at 200 chars by `classifyProviderError`, so a status parsed out of it is
 *  lossy — and a provider that prefixes its body with a long preamble would
 *  push the code out of range and silently land in the wrong bucket. */
export const diagnoseProviderFailure = (e: unknown): {
  diagnosis: ProviderFailureDiagnosis;
  detail: string;
} => {
  if (!(e instanceof LLMError)) {
    return {
      diagnosis: 'unreachable',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (e.code === 'AI_TIMEOUT') {
    return { diagnosis: 'unreachable', detail: e.message };
  }
  const status = statusOf(e);
  if (status === 401 || status === 403) {
    return { diagnosis: 'auth', detail: e.message };
  }
  if (status === 429) return { diagnosis: 'rate_limited', detail: e.message };
  // ⛔ ONE RULE WITH A REAL CALL: a chat turn reads a missing model by the same
  // test (`isModelMissingRejection`), so the two cannot disagree about one
  // answer. Before, any 404 here was a missing model, and the owner who typed
  // the wrong address was told to check the model's name.
  if (isModelMissingRejection(e)) return { diagnosis: 'model_missing', detail: e.message };
  if (status !== undefined && status >= 500) {
    return { diagnosis: 'provider_error', detail: e.message };
  }
  // A network failure never reached a status at all.
  if (status === undefined && /LLM call failed/i.test(e.message)) {
    return { diagnosis: 'unreachable', detail: e.message };
  }
  return { diagnosis: 'rejected', detail: e.message };
};

/** How a source's last call ended: it answered; it stopped at its output limit before writing
 *  anything (`output_limit`, usually a model thinking past the limit); or a failure as Test
 *  connection names it. */
export type SourceCallResult = 'answered' | 'output_limit' | ProviderFailureDiagnosis;

/** A source's last call: when, for which model, and how it ended. `answered_by` is set only when the
 *  provider said ANOTHER model answered (`answeredByAnotherModel`), as when it routes a retired
 *  model's calls to its successor (Google, from 2026-12-01, `gemini-2.5-flash` to
 *  `gemini-3.5-flash-lite`). */
export interface SourceCallOutcome {
  at: number;
  model: string;
  result: SourceCallResult;
  answered_by?: string;
}

/** How a call that threw ended, as a source's last call reads it. */
export const failedCallResult = (e: unknown): SourceCallResult =>
  stoppedAtOutputLimit(e) ? 'output_limit' : diagnoseProviderFailure(e).diagnosis;

/** A dated or versioned name of the same model: `gpt-4.1-mini` → `gpt-4.1-mini-2025-04-14`,
 *  `gemini-3.8-flash` → `-001`, `llama3.2` → `:latest` or `:3b`, `claude-x` → `@20241022`. The rest
 *  begins with a separator and then a digit, or is a `latest` / `preview` tag. */
const VERSION_SUFFIX = /^(?:[-@:._]\d[\w.:@-]*|[-@:](?:latest|preview)[\w.:@-]*)$/i;
const bareModel = (name: string): string => name.trim().toLowerCase().replace(/^models\//, '');

/** Did ANOTHER model answer than the one asked for? Not when the provider names the same model by a
 *  dated or versioned name, which OpenAI does for every alias. ⚠ A prefix alone is not enough:
 *  `gemini-2.5-flash` → `gemini-2.5-flash-lite` and `gpt-4.1` → `gpt-4.1-mini` are other models. */
export const answeredByAnotherModel = (requested: string, answered: string): boolean => {
  const asked = bareModel(requested);
  const got = bareModel(answered);
  if (got === '' || got === asked) return false;
  if (got.startsWith(asked) && VERSION_SUFFIX.test(got.slice(asked.length))) return false;
  // Asked for a dated name, told the alias.
  if (asked.startsWith(got) && VERSION_SUFFIX.test(asked.slice(got.length))) return false;
  return true;
};
