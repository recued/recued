import type { AuthenticationAccessSummary, AuthenticationAccessSummaryEvidence } from '@recued/contracts';
import { appendAuthenticationAccessResult } from './authentication-access-panel.js';
import { authenticationAccessRepairLabel, type AccessRepairRenderer } from './authentication-access-repair-shortcuts.js';
import { connectionsAccessCheckAddress } from './connections-navigation.js';

/** Each target keeps the provenance and clock of one actual saved attempt. */
export const appendLatestAuthenticationAccess = (doc: Document, parent: HTMLElement, value: AuthenticationAccessSummary,
  view?: (entry: AuthenticationAccessSummaryEvidence, button: HTMLButtonElement) => void, repair?: AccessRepairRenderer): void => {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n;
  };
  const section = node('section'); section.className = 'authentication-access-latest'; section.setAttribute('data-authentication-access-latest', value.selection.kind + ':' + value.selection.id);
  section.appendChild(node('h4', 'Latest saved access'));
  section.appendChild(node('p', 'Each row uses its newest saved attempt. This summary does not run vendor checks or change incident recovery.'));
  section.appendChild(node('p', 'Summary read: ' + new Date(value.observed_at).toLocaleString() + '.'));
  if (value.targets_truncated || value.lookup_incomplete) section.appendChild(node('p', 'Some targets or saved checks could not be summarized. Review connection history for more details.'));
  if (!value.targets.length) section.appendChild(node('p', 'There are no saved resource targets in this group.'));
  for (const row of value.targets) {
    const article = node('div'); article.setAttribute('data-latest-access-target', row.id); article.appendChild(node('h5', row.label));
    const entry = row.latest;
    if (!entry) article.appendChild(node('p', row.state === 'unavailable' ? 'Saved checks could not be read. Refresh or open history.' : 'Not checked · No retained read check.'));
    else {
      const reads = entry.result.checks.filter(c => c.kind !== 'write_permissions');
      const label = entry.result.current === 'no' ? 'Superseded result · Authentication or the source changed'
        : entry.result.current === 'unknown' ? 'Authentication comparison unknown · Open the saved check or refresh'
          : entry.status === 'checking' ? 'Check still running' : reads.some(c => c.status === 'failed') ? 'Read access failed'
            : reads.length && reads.every(c => c.status === 'passed') ? 'Checked reads passed' : 'Read access unconfirmed';
      article.appendChild(node('p', label));
      if (entry.status === 'checking' && entry.result.current !== 'yes') article.appendChild(node('p', 'Check still running.'));
      article.appendChild(node('p', (entry.status === 'completed' ? 'Check finished: ' + new Date(entry.finished_at!).toLocaleString()
        : 'Check started: ' + new Date(entry.started_at).toLocaleString()) + '.'));
      const details = node('details'); details.appendChild(node('summary', 'Check details')); appendAuthenticationAccessResult(doc, details, entry.result, false); article.appendChild(details);
      if (view) {
        const button = node('button', 'View saved check'); button.type = 'button'; button.setAttribute('data-latest-access-view', row.id);
        button.setAttribute('data-latest-access-source', entry.id);
        button.addEventListener('click', () => { if (parent.contains(button) && !button.disabled) view(entry, button); }); article.appendChild(button);
      }
      const page = node('a', 'Open saved check page'); page.className = 'authentication-access-page'; page.href = connectionsAccessCheckAddress({ verification_id: entry.id, target_id: row.id, view: 'result' }).hash;
      page.setAttribute('href', page.href); page.setAttribute('data-latest-access-page', row.id); article.appendChild(page);
      repair?.(article, entry, entry.result);
    }
    section.appendChild(article);
  }
  if (repair && value.targets.some(row => row.latest && authenticationAccessRepairLabel(row.latest, row.latest.result))) {
    section.appendChild(node('p', 'Review authentication opens current settings before any sign-in or change. An unconfirmed read may need a resource choice instead.'));
  }
  section.appendChild(node('p', 'Older checks stay in history with their original times. Sending, editing, workflows and sync stay separate.'));
  parent.appendChild(section);
};
export const LATEST_AUTHENTICATION_ACCESS_STYLES = `.authentication-access-latest{padding:12px 0;overflow-wrap:anywhere}.authentication-access-latest h4{margin:8px 0}.authentication-access-latest h5{font-size:14px;margin:8px 0}.authentication-access-latest [data-latest-access-target]{border-top:1px solid var(--border);padding:10px 0}.authentication-access-latest p{margin:6px 0}.authentication-access-latest button{min-height:44px;max-width:100%;white-space:normal}.authentication-access-latest details>summary{cursor:pointer}`;
