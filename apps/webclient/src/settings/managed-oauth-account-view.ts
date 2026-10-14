/** D-322 §22 — account usage and recorded API checks, without credentials or vendor payloads. */
import type { ManagedOAuthAccountUsage } from '@recued/contracts';
import { effectiveConnectionHealth } from '@recued/contracts';

const escape = (value: string): string => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const when = (value: number | undefined): string => value === undefined ? 'Not recorded' : new Date(value).toLocaleString();
const statusLabel = { ok: 'API check passed', auth_failed: 'Sign-in or permissions need attention',
  unreachable: 'API could not be reached', unknown: 'API access needs a check' } as const;
const useLabel = { pack: 'Pack', mail: 'Mail', calendar: 'Calendar', file: 'Files', recipe: 'Recipe', dish: 'Dish', schedule: 'Schedule' } as const;

export const renderManagedOAuthAccountUsage = (state: {
  usage?: ManagedOAuthAccountUsage; loading: boolean; error: string;
  canOpen: boolean; canCheck: boolean; checking?: string; disabled: boolean;
  now?: number;
}): string => {
  const { usage } = state;
  const button = (action: string, title: string, name = '', disabled = state.disabled): string =>
    `<button type="button" class="rx-btn rx-btn-secondary rx-btn-sm" data-managed-action="${action}" data-managed-name="${escape(name)}"${disabled ? ' disabled' : ''}>${escape(title)}</button>`;
  if (state.loading) return '<div class="managed-oauth-account-usage" role="status">Loading account usage…</div>';
  if (state.error) return `<div class="managed-oauth-account-usage"><p class="managed-oauth-feedback managed-oauth-feedback-error" role="alert">${escape(state.error)}</p>${button('refresh-usage', 'Retry account usage')}</div>`;
  if (!usage) return '';
  const observedAt = state.now ?? Date.now();
  const connections = usage.connections.map(connection => {
    const status = connection.health.status === 'ok' && connection.health.last_probed_at !== undefined && connection.health.last_probed_at > observedAt
      ? 'unknown' : effectiveConnectionHealth(connection.health, observedAt);
    return `<li class="managed-oauth-account-connection">
    <h5>${escape(connection.display_name)} <code>${escape(connection.name)}</code></h5>
    <p data-managed-health="${status}">${connection.health.permissions_unverified ? 'API reached; permissions remain unverified' : statusLabel[status]}${connection.health.http_status === undefined ? '' : ` (HTTP ${connection.health.http_status})`}</p>
    <dl><div><dt>Last API check</dt><dd>${escape(when(connection.health.last_probed_at))}</dd></div><div><dt>Last recorded use</dt><dd>${escape(when(connection.last_used_at))}</dd></div></dl>
    ${connection.uses.length ? `<ul aria-label="Uses this connection">${connection.uses.map(use => `<li><strong>${useLabel[use.kind]}:</strong> ${escape(use.label)}${use.may_use ? ' (can choose this account)' : ''}${use.paused ? ' (paused)' : ''}</li>`).join('')}</ul>` : `<p>${connection.usage_available ? 'No recorded pack, recipe, dish, schedule, Mail, Calendar or file bindings on this server.' : 'Local bindings could not be read.'}</p>`}
    <div class="managed-oauth-actions">${state.canOpen ? button('open-connection', 'Open connection', connection.name) : ''}${state.canCheck ? button('check-connection', state.checking === connection.name ? 'Checking API access…' : 'Check API access', connection.name, state.disabled || !!state.checking) : ''}</div>
  </li>`;
  }).join('');
  return `<div class="managed-oauth-account-usage" aria-label="Account status and usage">
    <h5>Account status and usage</h5><p>${usage.auth_error ? 'Nango reports an authorization error. Open a connection to review permissions and sign in again.' : 'Nango reports no authorization error. API checks below show what Recued has verified.'}</p>
    ${usage.connections.length ? `<p>${usage.connections.length} saved Recued ${usage.connections.length === 1 ? 'connection uses' : 'connections use'} this account.</p><ul class="managed-oauth-account-connections">${connections}</ul>` : '<p>No saved Recued API connections use this account.</p>'}
    <p class="managed-oauth-note">A probe checks the configured API endpoint. Check your task to verify its access and permissions.</p>
    ${usage.warnings.map(warning => `<p class="managed-oauth-note">${escape(warning)}</p>`).join('')}
    ${button('refresh-usage', 'Refresh status and usage', '', state.disabled || !!state.checking)}
  </div>`;
};
