import { ERROR_MESSAGES, type ServerExecuteResponse } from '@recued/contracts';
import { e } from '@recued/ui-shared';

export const RUN_SUMMARY_ATTR = 'data-recued-run-summary';
export const RUN_SUMMARY_COPY_ATTR = 'data-recued-run-summary-copy';
const STATUS_ATTR = 'data-recued-run-summary-status';

const identity = (value: unknown, fallback = 'Unavailable'): string => {
  if (typeof value !== 'string') return fallback;
  const flat = value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return flat.length === 0 ? fallback : flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
};
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The execute RPC reports this marker even on client contracts that predate
 * its declaration. A successful trigger check can decline the actual run. */
type RunSummaryResponse = ServerExecuteResponse & { trigger_skipped?: boolean };

/** Explicit metadata projection. Never traverse output, input, error messages,
 * details, approval refs, stop conditions, or per-step values. */
export const recipeRunSummary = (result: RunSummaryResponse): string => {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const codes = new Set<string>();
  let unrecognized = false;
  const collectCode = (error: unknown): void => {
    if (error === null || error === undefined) return;
    const code = typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)) codes.add(code);
    else unrecognized = true;
  };
  for (const error of errors) collectCode(error);
  for (const step of steps) collectCode(step.error);
  const facts = result.run_facts;
  const elapsed = duration(facts?.duration_ms) ? facts.duration_ms : result.duration_ms;
  const outcome = result.run_terminated !== undefined ? 'Terminated'
    : result.awaiting_peer === true ? 'Awaiting peer response'
    : result.awaiting_approval === true ? 'Awaiting approval'
    : result.trigger_skipped === true ? 'Skipped (trigger did not match)'
    : result.success ? (result.stopped !== undefined || facts?.stopped_at ? 'Completed early' : 'Completed')
    : 'Failed';
  const lines = [
    'Recued recipe run summary v1',
    `Recipe: ${identity(result.recipe_id)}`,
    `Recipe hash: ${identity(result.recipe_hash)}`,
    `Run ID: ${identity(result.run_id, 'Not provided')}`,
    `Outcome: ${outcome}`,
    `Duration: ${duration(elapsed) ? `${elapsed} ms` : 'Unavailable'}`,
    `Steps run: ${count(facts?.steps_run) ? facts.steps_run : steps.filter(step => !step.skipped).length}`,
  ];
  if (count(facts?.items_total)) lines.push(`Items attempted: ${facts.items_total}`);
  const itemFailures = steps.reduce((total, step) => total + (count(step.foreach?.failed) ? step.foreach.failed : 0), 0);
  if (itemFailures > 0) lines.push(`Failed items: ${itemFailures}`);
  if (Array.isArray(result.runnability_warnings) && result.runnability_warnings.length > 0) {
    lines.push(`Run warnings: ${result.runnability_warnings.length}`);
  }
  const sortedCodes = [...codes].sort();
  lines.push(`Error codes: ${sortedCodes.length ? sortedCodes.slice(0, 20).join(', ') : 'Not reported'}`);
  if (sortedCodes.length > 20) lines.push(`Additional known error codes: ${sortedCodes.length - 20}`);
  if (unrecognized) lines.push('Unrecognized error codes: present');
  return lines.join('\n');
};

export const renderRecipeRunSummary = (result: ServerExecuteResponse): string => {
  const summary = e(recipeRunSummary(result));
  return `<section class="recipes-run-summary" ${RUN_SUMMARY_ATTR} aria-label="Run summary">
    <button type="button" class="recipes-button" data-action="copy" ${RUN_SUMMARY_COPY_ATTR} data-value="${summary}">Copy run summary</button>
    <p ${STATUS_ATTR} aria-live="polite" aria-atomic="true"></p>
    <details><summary>View run summary</summary>
      <textarea readonly rows="8" aria-label="Run summary text" spellcheck="false">${summary}</textarea>
    </details>
  </section>`;
};

/** Feedback belongs to the exact clicked result DOM, never to a later run. */
export const copyRecipeRunSummary = async (button: HTMLElement, doc: Document): Promise<void> => {
  const host = button.closest<HTMLElement>(`[${RUN_SUMMARY_ATTR}]`);
  const text = button.getAttribute('data-value');
  if (!host || text === null || button.getAttribute('aria-busy') === 'true') return;
  const current = (): boolean => button.isConnected && host.contains(button)
    && button.getAttribute('data-value') === text;
  if (!current()) return;
  const status = host.querySelector<HTMLElement>(`[${STATUS_ATTR}]`);
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  if (status) status.textContent = 'Copying run summary…';
  try {
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
    await clipboard.writeText(text);
    if (current() && status) status.textContent = 'Run summary copied.';
  } catch {
    if (!current()) return;
    const details = host.querySelector('details');
    const field = host.querySelector('textarea');
    if (details) details.open = true;
    if (status) status.textContent = 'Recued could not copy it. Copy the summary below.';
    // A late denial must not pull focus away from another control.
    if (field && doc.activeElement === button) { field.focus(); field.select(); }
  } finally {
    if (current()) { button.removeAttribute('aria-busy'); button.removeAttribute('aria-disabled'); }
  }
};
