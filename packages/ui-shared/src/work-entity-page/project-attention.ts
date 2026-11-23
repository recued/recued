import { dueDayIso, type ProjectAttentionScope, type WorkEntityProjectAttentionRpcResponse, type ProjectAttentionIssue } from '@recued/contracts';
import { e } from '../template.js';
import { commitmentDeadlineLabel, commitmentDirectionLabel, commitmentStatusLabel } from './commitment-reader.js';
export interface ProjectAttentionView {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  snapshot?: WorkEntityProjectAttentionRpcResponse;
  scope?: ProjectAttentionScope;
  error?: string; action_error?: string; action_busy: boolean;
  copying: boolean; copy_notice?: string; fallback?: string; copy_available: boolean; can_open: boolean;
}
export const PROJECT_ATTENTION_LABELS: Record<ProjectAttentionScope, string> = {
  overdue_tasks: 'Overdue tasks', due_soon_tasks: 'Due in the next 7 days', blocking_commitments: 'Outstanding blocking commitments',
};
export const projectAttentionIssueText = (issue: ProjectAttentionIssue): string =>
  issue.reason === 'provider_only' ? issue.source_label + ': provider-only work is not included.' : issue.reason === 'incomplete'
    ? issue.source_label + ': saved coverage is incomplete.' : issue.reason === 'pending_project' ? 'Project changes are waiting for source confirmation.' : issue.source_label + ': saved work may be out of date.';
const itemKey = (scope: ProjectAttentionScope, row: WorkEntityProjectAttentionRpcResponse['items'][number]) =>
  JSON.stringify([scope === 'blocking_commitments' ? 'commitment' : 'task', row.id, row.source_id, row.source_record_id ?? null, row.created_at]);
export const renderProjectAttention = (view: ProjectAttentionView | undefined, blocked = false): string => {
  if (!view) return '';
  const data = view.snapshot, busy = blocked || view.phase === 'loading' || view.action_busy || view.copying;
  const disabled = busy ? ' aria-disabled="true"' : '';
  const selected = view.scope;
  const date = (value: number) => dueDayIso(value) ?? new Date(value).toLocaleString(undefined, { timeZone: data!.time_zone });
  return `<section class="project-work-section project-attention" aria-label="Project attention" aria-busy="${view.phase === 'loading'}" data-project-attention>
    <header class="project-work-head"><h3>Needs attention</h3>
      <div class="project-work-actions">${view.phase !== 'unsupported' ? `<button type="button" data-action="project-attention-refresh" data-project-focus="attention-refresh"${disabled}>${view.phase === 'loading' ? 'Checking attention…' : 'Refresh attention'}</button>` : ''}
        ${data ? `<button type="button" data-action="project-attention-copy" data-project-focus="attention-copy"${!view.copy_available || busy ? ' aria-disabled="true"' : ''}${view.copying ? ' aria-busy="true"' : ''}>Copy status update</button>` : ''}</div>
    </header>
    <p class="project-work-hint">All explicitly linked work saved on this server. Project search and list filters do not change these totals.</p>
    ${view.phase === 'unsupported' ? '<p class="project-work-hint">Update your Recued server to check project attention.</p>' : ''}
    ${view.error && view.phase !== 'unsupported' ? `<p role="alert" tabindex="-1" data-project-focus="attention-error">${e(view.error)}${data ? ' Counts below are from the last successful read.' : ''}</p>` : ''}
    ${view.phase === 'loading' ? '<p role="status">Checking saved project work…</p>' : ''}
    ${data ? `<div class="project-attention-counts" role="group" aria-label="Attention scopes">${(['overdue_tasks', 'due_soon_tasks', 'blocking_commitments'] as const).map(scope =>
      `<button type="button" data-action="project-attention-scope" data-attention-scope="${scope}" data-project-focus="attention-${scope}" aria-pressed="${selected === scope}"${disabled}><strong>${data.counts[scope]}</strong> ${PROJECT_ATTENTION_LABELS[scope]}</button>`).join('')}</div>
      <p class="project-work-hint">Upcoming dates include today and use ${e(data.time_zone)}. Dates as of ${e(new Date(data.as_of).toLocaleString(undefined, { timeZone: data.time_zone }))}.</p>
      ${data.coverage.issues.length || data.coverage.omitted ? `<div role="status" class="project-work-hint" data-project-attention-coverage><ul>${data.coverage.issues.map(issue => `<li>${e(projectAttentionIssueText(issue))}</li>`).join('')}</ul>${data.coverage.omitted ? `<p>${data.coverage.omitted} additional source warnings.</p>` : ''}</div>` : ''}` : ''}
    ${view.copy_notice ? `<p role="status" data-project-attention-copy-notice>${e(view.copy_notice)}</p>` : ''}
    ${view.fallback ? `<section class="work-reader-copy-fallback" aria-label="Copy project update manually"><label for="project-attention-copy-value">Project update to copy</label>
      <textarea id="project-attention-copy-value" data-work-copy-value data-project-focus="attention-copy-value" readonly rows="7" spellcheck="false">${e(view.fallback)}</textarea>
      <button type="button" data-action="project-attention-copy-select" data-project-focus="attention-copy-select">Select project update</button></section>` : ''}
    ${view.action_error ? `<p role="alert" data-project-attention-action-error>${e(view.action_error)}</p>` : ''}
    ${selected ? `<section aria-label="${e(PROJECT_ATTENTION_LABELS[selected])}" data-project-attention-list>
      <header class="project-work-head"><h4 tabindex="-1" data-project-focus="attention-list">${e(PROJECT_ATTENTION_LABELS[selected])}</h4><button type="button" data-action="project-attention-close" data-project-focus="attention-close"${view.action_busy || view.copying ? ' aria-disabled="true"' : ''}>Close attention list</button></header>
      ${data && data.scope === selected ? `<p class="project-work-hint" role="status">Showing ${data.items.length} of ${data.total} saved ${selected === 'blocking_commitments' ? 'commitments' : 'tasks'}${view.phase === 'error' ? ' from the last successful read' : ''}.</p>
        ${!data.total && view.phase === 'ready' ? '<p>No saved work matches this attention scope.</p>' : ''}
        <ul class="project-work-items">${data.items.map(item => `<li><button type="button" class="project-work-item" data-action="project-attention-open" data-attention-key="${e(itemKey(selected, item))}" data-project-focus="attention-item:${e(itemKey(selected, item))}"${busy || !view.can_open ? ' aria-disabled="true"' : ''}>
          <span class="project-work-item-title">${e(item.title)}</span>
          ${item.commitment ? `<span class="project-work-meta">${e(commitmentDirectionLabel(item.commitment.direction))} · ${e(item.commitment.counterparty_label ?? 'No contact linked')} · ${e(commitmentDeadlineLabel(item.commitment))} · ${e(commitmentStatusLabel(item.commitment))}</span>`
            : item.due_at !== undefined ? `<span class="project-work-meta">Due ${e(date(item.due_at))}</span>` : ''}
          <span class="project-work-meta">${e(item.source_label)}</span>${item.excerpt ? `<span class="project-work-excerpt">${e(item.excerpt)}</span>` : ''}
          ${item.stale || item.source_incomplete || item.pending_write ? `<span class="project-work-badges">${item.stale ? '<span>May be out of date</span>' : ''}${item.source_incomplete ? '<span>Source partly synced</span>' : ''}${item.pending_write ? '<span>Waiting for source confirmation</span>' : ''}</span>` : ''}
        </button></li>`).join('')}</ul>${data.more || view.phase === 'error' ? `<button type="button" data-action="project-attention-${view.phase === 'error' ? 'refresh' : 'more'}" data-project-focus="attention-more"${disabled}>${view.phase === 'error' ? 'Retry attention' : 'More attention items'}</button>` : ''}` : ''}
    </section>` : ''}
  </section>`;
};
export const PROJECT_ATTENTION_STYLES = `
.project-attention-counts { display:flex; flex-wrap:wrap; gap:.625rem; }
.project-attention-counts > button { flex:1 1 12rem; text-align:left; }
.project-attention-counts > button[aria-pressed="true"] { border-color:var(--accent); background:var(--surface-sunk); }
.project-attention [data-project-attention-list] { display:grid; gap:.625rem; }
.project-attention h4 { margin:0; }
`;
