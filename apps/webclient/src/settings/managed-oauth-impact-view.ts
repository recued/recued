/** D-322 §25 — account identity and local impact before authorization and save. */
import type { ManagedOAuthAccountPreview, ManagedOAuthImpactPreview } from '@recued/contracts';
const escape = (value: string): string => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const labels = { pack: 'Pack', recipe: 'Recipe', dish: 'Dish', schedule: 'Schedule', mail: 'Mail', calendar: 'Calendar', file: 'Files' } as const;
const account = (value: ManagedOAuthAccountPreview, title: string): string => `<div class="managed-oauth-account-card"><h5>${escape(title)}</h5>
  <p>${value.authentication === 'broker' ? 'Managed OAuth' : value.authentication === 'direct_oauth' ? 'Your OAuth app' : 'Saved token'}</p>
  ${value.broker ? `<p><strong>${escape(value.broker.label)}</strong> <code>${escape(value.broker.base_url)}</code></p>` : ''}
  ${value.integration_id ? `<p>Integration: <code>${escape(value.integration_id)}</code></p>` : ''}
  ${value.connection_id ? `<p>Broker account: <code>${escape(value.connection_id)}</code></p>` : value.authentication === 'broker' ? '<p>New broker account. Choose it during sign-in.</p>' : ''}
  <p data-managed-vendor-email>${value.identity.email ? escape(value.identity.email) : 'Vendor email unknown'}</p>
  ${value.identity.display_name ? `<p>${escape(value.identity.display_name)}</p>` : ''}
  ${value.identity.user_name ? `<p>Sign-in name: ${escape(value.identity.user_name)}</p>` : ''}
  ${value.identity.account_id ? `<p>Vendor account ID: <code>${escape(value.identity.account_id)}</code></p>` : '<p>Vendor account identity is unknown with the current access.</p>'}
</div>`;
export const renderManagedOAuthImpact = (value?: ManagedOAuthImpactPreview, loading = false, error = ''): string => {
  if (loading) return '<section class="managed-oauth-impact" aria-label="Account and impact preview" aria-busy="true"><h4>Account and impact preview</h4><p role="status">Reading accounts and local use…</p></section>';
  if (error) return `<section class="managed-oauth-impact" aria-label="Account and impact preview"><h4>Account and impact preview</h4><p role="alert">${escape(error)}</p></section>`;
  if (!value) return '';
  const rows = value.connections.map(row => `<li><h5>${escape(row.display_name)} <code>${escape(row.name)}</code></h5>
    <p>${row.effect === 'selected_connection' ? value.mode === 'switch' ? 'Uses the selected account after the switch.' : 'Keeps this connection name and account.'
      : row.effect === 'shared_consent' ? 'Shares the selected broker account. Consent can affect its access now.' : 'Already shares this broker account. No new consent is planned.'}</p>
    ${row.uses.length ? `<ul>${row.uses.map(use => `<li><strong>${labels[use.kind]}:</strong> ${escape(use.label)}${use.may_use ? ' (can choose this account)' : ''}${use.paused ? ' (paused)' : ''}</li>`).join('')}</ul>` : `<p>${row.usage_available ? 'No recorded local uses.' : 'Local use is unknown.'}</p>`}
    ${row.uses.length && !row.usage_available ? '<p>Some local use is unknown.</p>' : ''}</li>`).join('');
  return `<section class="managed-oauth-impact" aria-label="Account and impact preview"><style>.managed-oauth-impact{min-width:0;overflow-wrap:anywhere}.managed-oauth-account-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}.managed-oauth-account-card{padding:12px;border:1px solid var(--border,#d9dfeb);border-radius:8px;min-width:0}.managed-oauth-account-card p{margin:4px 0}.managed-oauth-impact code{white-space:normal}</style><h4>Account and impact preview</h4>
    <div class="managed-oauth-account-cards">${value.current ? account(value.current, 'Current saved account') : ''}${account(value.target, value.phase === 'before_save' ? 'Authorized account to save' : 'Selected account')}</div>
    <p>Account details use existing access. Recued does not ask for extra permissions to find your email.</p>
    ${value.mode === 'switch' ? '<p>The saved connection stays active until verification and the switch finish. A different account can expose different data.</p>' : ''}
    ${value.connections.length ? `<h5>Local connections and their uses</h5><ul>${rows}</ul>` : '<p>No existing Recued connections share this account.</p>'}
    ${value.warnings.map(warning => `<p class="managed-oauth-note">${escape(warning)}</p>`).join('')}
  </section>`;
};
