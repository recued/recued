import {
  ERROR_MESSAGES,
  isRunAnchorStatus,
  runYieldIsTotalRefusal,
  type PolicyResult,
  type RunDetail,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';

export const LOGS_RUN_SUMMARY_ATTR = 'data-recued-logs-run-summary';
export const LOGS_RUN_SUMMARY_STATUS_ATTR = 'data-recued-logs-run-summary-status';
export type RunSummaryCopyState = 'idle' | 'copying' | 'copied' | 'manual';
export const RUN_SUMMARY_COPY_MESSAGES: Record<RunSummaryCopyState, string> = {
  idle: '',
  copying: 'Copying run summary…',
  copied: 'Run summary copied.',
  manual: 'Recued could not copy it. Copy the summary below.',
};

const identity = (value: unknown): string => {
  if (typeof value !== 'string') return 'Not recorded';
  const flat = value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return !flat ? 'Not recorded' : flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
};
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const tally = (value: unknown): string => count(value) ? String(value) : 'Not recorded';
const POLICIES = {
  allowed: true,
  'approval-requested': true,
  denied: true,
  'released-after-approval': true,
  blocked: true,
} satisfies Record<PolicyResult, true>;

/** Recorded metadata only. Do not traverse output, origin identities, approval
 * references, links, gateway traces, or free-form error messages/details. */
export const logsRunSummary = (detail: RunDetail): string => {
  const audit = detail.audit;
  const started = typeof audit.started_at === 'number' ? new Date(audit.started_at) : null;
  const policy = detail.gateway.policy_result;
  const lines = [
    'Recued run summary v1',
    `Recipe: ${identity(audit.recipe_id)}`,
    `Recipe hash: ${identity(audit.recipe_hash)}`,
    `Run ID: ${identity(audit.run_id)}`,
    `Recorded status: ${isRunAnchorStatus(audit.status) ? audit.status : 'Not recorded'}`,
    `Policy result: ${typeof policy === 'string' && Object.hasOwn(POLICIES, policy) ? policy : 'Not recorded'}`,
    `Started: ${started !== null && Number.isFinite(started.getTime()) ? started.toISOString() : 'Not recorded'}`,
    `Duration: ${typeof audit.duration_ms === 'number' && Number.isFinite(audit.duration_ms) && audit.duration_ms >= 0 ? `${audit.duration_ms} ms` : 'Not recorded'}`,
  ];
  const yieldInfo = audit.run_yield;
  if (yieldInfo === undefined) {
    lines.push('Yield: Not recorded');
  } else {
    const validItems = count(yieldInfo.items_total) && count(yieldInfo.items_failed)
      && yieldInfo.items_failed <= yieldInfo.items_total;
    lines.push(
      `Steps run: ${tally(yieldInfo.steps_run)}`,
      `Steps skipped: ${tally(yieldInfo.steps_skipped)}`,
      `Items attempted: ${tally(yieldInfo.items_total)}`,
      `Failed items: ${validItems ? yieldInfo.items_failed : 'Not recorded'}`,
    );
    if (validItems && runYieldIsTotalRefusal(yieldInfo)) {
      lines.push('Item outcome: All attempted items failed');
    }
    if (yieldInfo.stopped_at === null) lines.push('Ended early: No');
    else if (typeof yieldInfo.stopped_at === 'string' && yieldInfo.stopped_at.length > 0) {
      lines.push('Ended early: Yes');
    }
  }
  const codes = new Set<string>();
  let unrecognized = false;
  for (const errors of [audit.errors, detail.errors]) {
    if (!Array.isArray(errors)) continue;
    for (const error of errors) {
      const code: unknown = error?.code;
      if (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)) codes.add(code);
      else unrecognized = true;
    }
  }
  const known = [...codes].sort();
  lines.push(`Error codes: ${known.length ? known.slice(0, 20).join(', ') : 'Not reported'}`);
  if (known.length > 20) lines.push(`Additional known error codes: ${known.length - 20}`);
  if (unrecognized) lines.push('Unrecognized error codes: present');
  return lines.join('\n');
};

export const renderLogsRunSummary = (
  detail: RunDetail,
  state: RunSummaryCopyState,
  open: boolean,
): string => `<section class="logs-run-summary" ${LOGS_RUN_SUMMARY_ATTR}="${e(detail.audit.run_id)}" aria-label="Run summary">
  <button type="button" class="logs-button" data-recued-logs-action="copy-run-summary"${state === 'copying' ? ' aria-disabled="true" aria-busy="true"' : ''}>Copy run summary</button>
  <p ${LOGS_RUN_SUMMARY_STATUS_ATTR} aria-live="polite" aria-atomic="true">${e(RUN_SUMMARY_COPY_MESSAGES[state])}</p>
  <details${open ? ' open' : ''}><summary>View run summary</summary>
    <textarea readonly rows="8" aria-label="Run summary text" spellcheck="false">${e(logsRunSummary(detail))}</textarea>
  </details>
</section>`;
