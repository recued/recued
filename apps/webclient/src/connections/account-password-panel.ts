import { escapeHtml as e } from '@recued/ui-shared';

export type AccountPasswordRepair = (args: { slug: string; password?: string; smtp_password?: string }) => Promise<{ ok: true; restart_needed: boolean }>;

/** Secrets live only in this mounted editor and are never used for navigation. */
export const createAccountPasswordPanel = (deps: {
  host: HTMLElement; changed(): Promise<void>; closed(slug: string): void;
}) => {
  let selected: { lane: string; slug: string; smtp: boolean; smtpOnly: boolean; call: AccountPasswordRepair } | undefined;
  let password = ''; let smtpPassword = ''; let busy = false; let error = ''; let notice = ''; let disposed = false;
  const render = () => {
    const host = deps.host.querySelector<HTMLElement>('[data-account-password-host]');
    if (!host || disposed) return;
    host.innerHTML = selected ? `<section class="accounts-password-repair" aria-label="Update credentials">
      <h3 tabindex="-1" data-account-password-heading>Update credentials for ${e(selected.slug)}</h3>
      <p>Keep this account’s server, username, selections and saved data. Recued checks the replacement login before saving it. No test email is sent.</p>
      <form data-account-password-form>
        <label>New ${selected.smtpOnly ? 'SMTP' : selected.lane === 'mail' ? 'IMAP' : 'CalDAV'} password / app password
          <input type="password" autocomplete="new-password" data-account-password-field="password" value="${e(password)}"${busy ? ' readonly' : ''}>
        </label>
        ${selected.smtp ? `<label>New SMTP password (optional)<input type="password" autocomplete="new-password" data-account-password-field="smtp" value="${e(smtpPassword)}"${busy ? ' readonly' : ''}></label>
          <p>Leave either field blank to keep its saved password. If no separate SMTP password was saved, SMTP continues using the IMAP password.</p>` : ''}
        ${error ? `<p role="alert">${e(error)}</p>` : ''}${notice ? `<p role="status">${e(notice)}</p>` : ''}
        <button class="rx-btn rx-btn-primary rx-btn-sm" type="submit" data-account-password-action="save"${!password && !smtpPassword ? ' disabled' : ''} aria-disabled="${busy}" aria-busy="${busy}">${busy ? 'Verifying credentials…' : 'Verify and save credentials'}</button>
        <button class="rx-btn rx-btn-secondary rx-btn-sm" type="button" data-account-password-action="close"${busy ? ' disabled' : ''}>Close</button>
      </form></section>` : '';
    for (const control of deps.host.querySelectorAll<HTMLButtonElement>('[data-action="accounts-back-to-list"],[data-action="accounts-manage-authentication"],[data-action="accounts-delete"],[data-action="accounts-resync"],[data-action="accounts-update-credentials"]')) {
      if (busy && !control.disabled) { control.disabled = true; control.setAttribute('data-password-repair-locked', ''); }
      else if (!busy && control.hasAttribute('data-password-repair-locked')) { control.disabled = false; control.removeAttribute('data-password-repair-locked'); }
    }
  };
  const close = () => {
    if (busy || !selected) return;
    const slug = selected.slug; selected = undefined; password = ''; smtpPassword = ''; error = ''; notice = ''; render(); deps.closed(slug);
  };
  const input = (event: Event) => {
    const field = event.target as HTMLInputElement | null;
    if (!selected || busy || !field || !deps.host.contains(field)) return;
    if (field.dataset.accountPasswordField === 'password') password = field.value;
    else if (field.dataset.accountPasswordField === 'smtp') smtpPassword = field.value;
    else return;
    const button = deps.host.querySelector<HTMLButtonElement>('[data-account-password-action="save"]');
    if (button) button.disabled = !password && !smtpPassword;
  };
  const click = (event: Event) => {
    const action = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-account-password-action]');
    if (action?.dataset.accountPasswordAction === 'close' && deps.host.contains(action)) close();
  };
  const submit = async (event: Event) => {
    if (!(event.target as HTMLElement | null)?.hasAttribute('data-account-password-form')) return;
    event.preventDefault(); if (busy || !selected || !password && !smtpPassword) return;
    const account = selected; busy = true; error = ''; notice = ''; render();
    deps.host.querySelector<HTMLElement>('[data-account-password-action="save"]')?.focus();
    try {
      const result = await account.call({ slug: account.slug, ...(password ? { password } : {}), ...(smtpPassword ? { smtp_password: smtpPassword } : {}) });
      if (disposed || selected !== account) return;
      if (result.ok !== true || typeof result.restart_needed !== 'boolean') throw new Error('Recued could not confirm the credential update. Reopen the account and check its access before retrying.');
      password = ''; smtpPassword = '';
      notice = account.smtpOnly ? 'SMTP credentials verified and saved.'
        : result.restart_needed ? 'Credentials verified and saved. Restart Recued to resume this account’s sync.' : 'Credentials verified and saved. Sync resumes with the updated login.';
      try { await deps.changed(); } catch { notice += ' Refresh this account to read its current status.'; }
    } catch (err) { if (!disposed) error = err instanceof Error ? err.message : 'Credentials could not be updated. Try again.'; }
    finally { if (!disposed) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-account-password-heading]')?.focus(); } }
  };
  deps.host.addEventListener('input', input); deps.host.addEventListener('click', click); deps.host.addEventListener('submit', submit);
  return {
    render,
    open(lane: string, slug: string, smtp: boolean, call: AccountPasswordRepair, smtpOnly = false) {
      if (busy) return; selected = { lane, slug, smtp, smtpOnly, call }; password = ''; smtpPassword = ''; error = ''; notice = ''; render();
      const heading = deps.host.querySelector<HTMLElement>('[data-account-password-heading]'); heading?.focus(); heading?.scrollIntoView?.({ block: 'start' });
    },
    context(lane: string, slug: string | null) { if (selected && (selected.lane !== lane || selected.slug !== slug)) close(); },
    busy: () => busy,
    hasDraft: () => !!password || !!smtpPassword,
    dispose() { disposed = true; password = ''; smtpPassword = ''; selected = undefined;
      deps.host.removeEventListener('input', input); deps.host.removeEventListener('click', click); deps.host.removeEventListener('submit', submit); },
  };
};
