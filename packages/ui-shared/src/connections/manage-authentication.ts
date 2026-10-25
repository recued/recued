import { e } from '../template.js';
import { button } from '../primitives/button.js';
import type { AuthenticationIncidentScope } from '@recued/contracts';
import { authenticationIncidentHistoryHref } from './incident-history.js';

export type AuthenticationManagementAction = 'reauthorize' | 'app' | 'method';

/** One entry point; each choice retains its own authorization and apply checks. */
export const renderAuthenticationManagement = (props: {
  prefix: 'accounts' | 'connections'; action: AuthenticationManagementAction;
  current: string; account?: string; canChangeApp: boolean; canChangeMethod: boolean; canReauthorize?: boolean; busy?: boolean;
  historyScope?: AuthenticationIncidentScope;
  /** False inside a form whose own title already says "Manage authentication",
   *  and whose intro already says what is kept. */
  heading?: boolean; note?: boolean;
}): string => {
  const choices: Array<readonly [AuthenticationManagementAction, string, string]> = [
    ...(props.canReauthorize === false ? [] : [['reauthorize', 'Re-authorize current sign-in', 'Keep this app and authentication method. Renew consent or request additional permissions.'] as const]),
    ...(props.canChangeApp ? [['app', 'Change OAuth app', 'Use another saved OAuth app for the same vendor account.'] as const] : []),
    ...(props.canChangeMethod ? [['method', 'Change authentication method', 'Choose Recued direct OAuth or an OAuth broker (Nango).'] as const] : []),
  ];
  const history = props.historyScope === undefined ? ''
    : props.busy ? '<span class="auth-management-history" aria-disabled="true">Incident history</span>'
      : `<a class="auth-management-history" data-authentication-incident-history href="${e(authenticationIncidentHistoryHref(props.historyScope))}">Incident history</a>`;
  const current = `<p class="auth-management-current">Current: <strong>${e(props.current)}</strong>${props.account ? ' · ' + e(props.account) : ''}</p>`;
  return `<section class="auth-management" data-manage-authentication aria-label="Manage authentication">
    ${props.heading === false
      ? `<div class="auth-management-head">${current}${history}</div>`
      : `<div class="auth-management-head">
      <h3 tabindex="-1" data-manage-authentication-heading>Manage authentication</h3>
      ${history}
    </div>
    ${current}`}
    <div role="group" aria-label="Authentication change" class="auth-management-choices">
      ${choices.map(([choice, label]) => button({ label, action: props.prefix + '-authentication-choice',
        variant: choice === props.action ? 'primary' : 'secondary', size: 'sm', data: { choice }, ariaPressed: choice === props.action, disabled: props.busy })).join('')}
    </div>
    <p role="status" class="auth-management-status">${e(choices.find(([choice]) => choice === props.action)?.[2] ?? '')}</p>
    ${props.note === false ? '' : '<p class="auth-management-note">Connection names, linked Packs, saved data and sync state are kept. Review permissions and affected connections before applying.</p>'}
  </section>`;
};

export const AUTHENTICATION_MANAGEMENT_STYLES = `
.auth-management {
  display: grid; gap: 8px; min-width: 0; margin: 12px 0; padding: 14px 16px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
  font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
}
.auth-management p { margin: 0; }
.auth-management-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.auth-management-head h3 { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 14px; font-weight: 650; }
.auth-management-history { color: var(--accent); font-size: 12.5px; font-weight: 600; text-decoration: none; }
a.auth-management-history:hover { text-decoration: underline; }
span.auth-management-history { color: var(--fg-muted); }
.auth-management-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.auth-management-status, .auth-management-note { color: var(--fg-muted); font-size: 12.5px; }
`;
