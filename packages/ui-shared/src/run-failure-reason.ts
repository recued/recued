/** Why a run failed, in one line.
 *
 *  The run dialog and the result panel said only "Run returned errors", so the
 *  reason sat in the Logs detail, one page and one click away: a mistyped
 *  notification channel read as a failure with no cause (D-312's live drive).
 *  This is the first error's message, the step it came from, and how many more
 *  there were.
 *
 *  ⚠ The owner's own run, so the message is theirs to read, as the Logs detail
 *  already shows it. An error's `details` are never read: they can carry
 *  addresses. */

import { defaultErrorMessage } from '@recued/contracts';

/** Long enough for any refusal an adapter writes; the Logs detail keeps the rest. */
const MAX_LENGTH = 400;

const bound = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= MAX_LENGTH ? flat : `${flat.slice(0, MAX_LENGTH - 1)}…`;
};

/** The line to show under a failed run's status, or `null` when it carries no
 *  error to explain. */
export const runFailureReason = (errors: readonly unknown[] | undefined): string | null => {
  if (errors === undefined || errors.length === 0) return null;
  const first = errors.find((error) => error !== null && typeof error === 'object') as
    | { message?: unknown; code?: unknown; source?: { step_id?: unknown } }
    | undefined;
  const more = errors.length > 1 ? ` · ${errors.length - 1} more` : '';
  if (first === undefined) return `${errors.length} error${errors.length === 1 ? '' : 's'}, none readable`;
  const message = typeof first.message === 'string' && first.message.trim().length > 0
    ? first.message
    : typeof first.code === 'string' ? defaultErrorMessage(first.code) : 'The run stopped.';
  const step = typeof first.source?.step_id === 'string' && first.source.step_id.length > 0
    ? ` (step ${first.source.step_id})`
    : '';
  return bound(`${message}${step}${more}`);
};
