import { DECISION_WATCH_ENTITY, DECISION_WATCH_OWNER, type CustomerDecisionReview } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { renderCustomerDecisionEvidence, type CustomerDecisionWatchCallers } from '../data/customer-decision-watch.js';
import { recordsRecordAddress } from '../data/records-navigation.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export const createTodayCustomerDecisionReviews = (opts: {
  callers?: Pick<CustomerDecisionWatchCallers, 'reviews' | 'change'>;
  changed: () => void;
}) => {
  let rows: CustomerDecisionReview[] = [], busy = false, disposed = false, generation = 0;
  let error: string | undefined;
  const load = async () => {
    if (!opts.callers || disposed || busy) return;
    const token = ++generation;
    try {
      const response = await opts.callers.reviews();
      if (disposed || token !== generation) return;
      if (error || JSON.stringify(rows) !== JSON.stringify(response.reviews)) {
        rows = response.reviews; error = undefined; opts.changed();
      }
    } catch (err) {
      if (disposed || token !== generation) return;
      const code = classifyRpcError(err).code;
      if (code === 'unknown_method' || code === 'not_configured') return;
      const message = humanizeRpcError(err);
      if (message !== error) { error = message; opts.changed(); }
    }
  };
  const reviewed = async (id: string) => {
    const item = rows.find(row => row.id === id);
    if (!opts.callers || !item || disposed || busy) return;
    generation += 1; busy = true; error = undefined; opts.changed();
    try {
      await opts.callers.change({ action: 'reviewed', watch_id: item.watch_id, review_id: item.id });
      if (!disposed) rows = rows.filter(row => row.id !== id);
    } catch (err) { error = humanizeRpcError(err); }
    finally { busy = false; if (!disposed) opts.changed(); }
    await load();
  };
  return {
    load, reviewed, busy: () => busy, canClaimEmpty: () => !error && rows.length === 0,
    render(actionAttr: string, expanded: ReadonlySet<string>): string {
      if (!rows.length && !error) return '';
      return `<section class="today-reminders" aria-label="Customer decisions to review">
        <header class="today-reminders-header"><h2 tabindex="-1" data-today-customer-heading>Customer decisions to review</h2></header>
        ${error ? `<p role="alert">${e(error)} <button type="button" ${actionAttr}="today-customer-reviews-refresh">Refresh</button></p>` : ''}
        ${rows.map(row => `<details data-today-customer-review="${e(row.id)}"${expanded.has(row.id) ? ' open' : ''}>
          <summary>${e(row.title)} · ${e(row.account.label)} reengaged</summary>
          ${renderCustomerDecisionEvidence(row)}
          <div class="today-task-actions">
            <a href="${e(recordsRecordAddress({ owner: DECISION_WATCH_OWNER, entity: DECISION_WATCH_ENTITY, id: row.decision_id }))}">Open decision</a>
            <button type="button" ${actionAttr}="today-customer-review-done" data-review-id="${e(row.id)}"${busy ? ' disabled' : ''}>Mark reviewed</button>
          </div>
        </details>`).join('')}
      </section>`;
    },
    dispose() { disposed = true; generation += 1; },
  };
};
