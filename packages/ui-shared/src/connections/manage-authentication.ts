import { e } from '../template.js';
import { button } from '../primitives/button.js';

export type AuthenticationManagementAction = 'reauthorize' | 'app' | 'method';

/** One entry point; each choice retains its own authorization and apply checks. */
export const renderAuthenticationManagement = (props: {
  prefix: 'accounts' | 'connections'; action: AuthenticationManagementAction;
  current: string; account?: string; canChangeApp: boolean; canChangeMethod: boolean; canReauthorize?: boolean; busy?: boolean;
}): string => {
  const choices: Array<readonly [AuthenticationManagementAction, string, string]> = [
    ...(props.canReauthorize === false ? [] : [['reauthorize', 'Re-authorize current sign-in', 'Keep this app and authentication method. Renew consent or request additional permissions.'] as const]),
    ...(props.canChangeApp ? [['app', 'Change OAuth app', 'Use another saved OAuth app for the same vendor account.'] as const] : []),
    ...(props.canChangeMethod ? [['method', 'Change authentication method', 'Choose Recued direct OAuth or an optional broker connection.'] as const] : []),
  ];
  return `<section data-manage-authentication aria-label="Manage authentication" style="min-width:0;overflow-wrap:anywhere;border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0;font-size:13px;line-height:1.5">
    <h3 tabindex="-1" data-manage-authentication-heading style="font-size:16px;margin:0 0 8px">Manage authentication</h3>
    <p>Current: ${e(props.current)}${props.account ? ' · ' + e(props.account) : ''}.</p>
    <p>Connection names, linked Packs, saved data and sync state are kept. Review permissions and affected connections before applying.</p>
    <div role="group" aria-label="Authentication change" style="display:flex;flex-wrap:wrap;gap:8px">
      ${choices.map(([choice, label]) => button({ label, action: props.prefix + '-authentication-choice',
        variant: choice === props.action ? 'primary' : 'secondary', size: 'sm', data: { choice }, ariaPressed: choice === props.action, disabled: props.busy })).join('')}
    </div>
    <p role="status">${e(choices.find(([choice]) => choice === props.action)?.[2] ?? '')}</p>
  </section>`;
};
