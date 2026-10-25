import { escapeHtml as e } from '@recued/ui-shared';

export interface OAuthTroubleshootingContext {
  /** Mount-owned identity; never rendered or included in the copied summary. */
  key: string;
  route: 'direct' | 'broker';
  flow?: 'client_credentials';
  issuer?: 'google' | 'microsoft';
  callbackUrl?: string;
  savedApp?: boolean;
  pending?: boolean;
}
export type OAuthHelpIssue = 'unknown' | 'popup' | 'browser' | 'redirect' | 'blocked'
  | 'credentials' | 'secret' | 'consent' | 'scopes' | 'grant' | 'return' | 'access'
  | 'broker_key' | 'broker_unavailable' | 'broker_history' | 'locked' | 'setup';
export interface OAuthHelpObservation { issue: OAuthHelpIssue; label: string }
export interface OAuthHelpPlan { title: string; explanation: string; steps: readonly string[]; links: readonly { label: string; url: string }[] }
const google = 'https://developers.google.com/identity/protocols/oauth2/web-server';
const microsoft = 'https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes';
const nango = 'https://nango.dev/docs';
const labels: Record<OAuthHelpIssue, string> = {
  unknown: 'I am not sure where it failed', popup: 'The sign-in window did not open',
  browser: 'Google says this browser or app may not be secure', redirect: 'The callback or redirect URL does not match',
  blocked: 'The vendor says this app is blocked', credentials: 'The vendor rejected the app credentials',
  secret: 'The app secret expired or was replaced', consent: 'Consent was refused or needs an administrator',
  scopes: 'A permission scope was rejected', grant: 'A code or refresh token was rejected',
  return: 'Consent finished, but Recued did not finish connecting', access: 'Sign-in worked, but an API action was denied',
  broker_key: 'The Nango key, environment or integration was refused', broker_unavailable: 'Nango cannot be reached or is unavailable',
  broker_history: 'Nango permission history is unknown', locked: 'The Recued vault is locked', setup: 'OAuth app setup is missing',
};
const isClientCredentials = (ctx: OAuthTroubleshootingContext): boolean => ctx.route === 'direct' && ctx.flow === 'client_credentials';
const issueLabel = (ctx: OAuthTroubleshootingContext, issue: OAuthHelpIssue): string => isClientCredentials(ctx) && issue === 'access'
  ? 'A token was issued, but an API action was denied' : labels[issue];
export const oauthHelpIssues = (ctx: OAuthTroubleshootingContext): OAuthHelpIssue[] => (Object.keys(labels) as OAuthHelpIssue[])
  .filter(issue => (!issue.startsWith('broker_') || ctx.route === 'broker') && (issue !== 'browser' || ctx.issuer !== 'microsoft')
    && (!isClientCredentials(ctx) || ['unknown', 'credentials', 'secret', 'scopes', 'access', 'locked', 'setup'].includes(issue)));

/** Only the registration callback is useful here. Never accept a consent link
 * or a returned URL containing a code, state, token or arbitrary query values. */
export const oauthHelpCallback = (raw: string | undefined): string | undefined => {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
    for (const [key, value] of url.searchParams) {
      if (key === 'recued_relay' && value === 'opener') continue;
      if (key === 'opener_origin' && ['https:', 'http:'].includes(new URL(value).protocol) && new URL(value).origin === value) continue;
      return undefined;
    }
    if (!['/oauth/complete', '/oauth-callback', '/webclient/oauth-callback.html'].includes(url.pathname)) return undefined;
    return raw;
  } catch { return undefined; }
};

/** These are observations, not diagnoses. Provider prose and unknown error
 * objects never enter the guide, its local checklist or the copied summary. */
export const oauthHelpPopupObservation = (reason: string, code?: string): OAuthHelpObservation => {
  const known: Record<string, OAuthHelpIssue> = {
    redirect_uri_mismatch: 'redirect', invalid_client: 'credentials', unauthorized_client: 'credentials',
    invalid_scope: 'scopes', invalid_grant: 'grant', access_denied: 'consent',
    admin_policy_enforced: 'consent', org_internal: 'consent', disallowed_useragent: 'browser',
    AADSTS50011: 'redirect', AADSTS7000215: 'credentials', AADSTS7000222: 'secret', AADSTS65001: 'consent',
  };
  if (code && Object.hasOwn(known, code)) return { issue: known[code]!, label: 'The vendor returned ' + code + '.' };
  if (reason === 'popup_blocked') return { issue: 'popup', label: 'The browser did not open the sign-in window.' };
  if (reason === 'timeout' || reason === 'closed') return { issue: 'return', label: reason === 'timeout'
    ? 'Recued did not receive a completed sign-in before its timeout.' : 'The sign-in window closed before Recued received completion.' };
  return { issue: reason === 'denied' ? 'consent' : 'unknown', label: 'Sign-in did not complete. Its exact cause is unknown.' };
};
export const oauthHelpFailureObservation = (error: unknown): OAuthHelpObservation => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'locked') return { issue: 'locked', label: 'The server reported that its vault is locked.' };
  if (code === 'not_configured') return { issue: 'setup', label: 'The server reported missing configuration.' };
  if (code === 'broker_unavailable') return { issue: 'broker_unavailable', label: 'A broker request was unavailable or interrupted.' };
  if (code === 'connection_lost') return { issue: 'return', label: 'The connection dropped before the server result was confirmed.' };
  if (code === 'timeout' || code === 'server_unresponsive') return { issue: 'return', label: 'Recued did not receive a confirmed server result.' };
  if (code === 'credential_verification_failed') return { issue: 'access', label: 'The replacement did not pass its access check.' };
  return { issue: 'unknown', label: 'An OAuth action failed. Recued has no precise diagnosis for this error.' };
};

export const oauthHelpPlan = (ctx: OAuthTroubleshootingContext, issue: OAuthHelpIssue): OAuthHelpPlan => {
  const broker = ctx.route === 'broker';
  const app = broker ? 'the vendor app configured in the Nango integration' : ctx.savedApp ? 'the selected saved OAuth app' : 'this connection’s vendor OAuth app';
  const credentials = broker
    ? 'Review the integration’s vendor Client ID and secret in Nango. Its environment API key is a separate credential in Recued’s broker profile.'
    : ctx.savedApp ? 'Open Apps & APIs → Manage saved apps. Select the same app and use Usage and rotate secret to review its copies before changing a secret.'
      : 'Review this connection’s Client ID and vendor secret. For a saved connection, use the reviewed credential replacement flow before applying changes.';
  const links = isClientCredentials(ctx) ? [{ label: ctx.issuer === 'microsoft' ? 'Microsoft app-only OAuth help' : 'OAuth client credentials flow',
    url: ctx.issuer === 'microsoft' ? 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow'
      : 'https://www.rfc-editor.org/rfc/rfc6749#section-4.4' }]
    : ctx.issuer ? [{ label: ctx.issuer === 'microsoft' ? 'Microsoft sign-in errors' : 'Google OAuth help',
      url: ctx.issuer === 'microsoft' ? microsoft : google }] : [];
  if (broker) links.push({ label: 'Nango documentation', url: nango });
  const plan = (explanation: string, steps: string[]): OAuthHelpPlan => ({ title: issueLabel(ctx, issue), explanation, steps, links });
  if (isClientCredentials(ctx) && issue !== 'locked') {
    switch (issue) {
      case 'credentials': case 'secret': return plan('This connection requests tokens with app credentials, without browser sign-in.', [
        ctx.issuer === 'microsoft' ? 'Check Application (client) ID and the secret Value, not Secret ID. Confirm the token endpoint uses the intended tenant.'
          : 'Confirm the Client ID, secret and token endpoint belong to the same vendor app.',
        credentials,
        'Use the normal credential replacement review, then test a fresh token request and a protected API read. A cached token does not prove the new secret works.',
      ]);
      case 'scopes': return plan('The vendor may reject a scope or app permission in a token request.', [
        'Compare the requested scopes with those supported by the vendor’s client credentials flow.',
        'Ask the app owner to review app permissions and any required administrator approval.',
        'Keep the permissions required by your packs. A successful token request alone does not confirm resource access.',
      ]);
      case 'access': return plan('A token can be valid while the app lacks access to a resource.', [
        'Use the connection’s normal access test or the pack’s protected API read when one is available.',
        'Review app permissions, the selected tenant, resource access and vendor policy. A 403 alone does not prove that more scopes will fix it.',
        'Review credential or permission changes before applying them. Use a new token request after a repair.',
      ]);
      case 'setup': return plan('This connection needs vendor app credentials and a token endpoint.', [
        'Review the Client ID, secret and token endpoint in the connection’s normal credential editor.',
        'Confirm the vendor supports client credentials for this service and app.',
        'Save through the normal review, then test a token request and protected API access.',
      ]);
      default: return plan('This connection requests tokens without opening a browser or using a registration callback.', [
        'Check whether the failure happened when requesting a token or when making an API request.',
        'Choose the matching credential, scope, setup or API access symptom above.',
        'Use the connection’s normal test after repair. Share only the help summary; keep app secrets and tokens private.',
      ]);
    }
  }
  switch (issue) {
    case 'popup': return plan('The sign-in window did not open; this does not test the vendor app.', [
      'Allow popups for the Recued address you are using, then return to the existing Connect or Authorize button.',
      'Finish or cancel any pending sign-in before starting another one.',
      'Open Recued in a normal supported browser if you are using an embedded browser.',
    ]);
    case 'browser': return { ...plan('A browser restriction is separate from an OAuth app or account policy block.', [
      'Open Recued in an up-to-date supported browser and start sign-in there.',
      'Allow JavaScript and check browser extensions or privacy settings that interfere with sign-in.',
      'If Google instead says the app is blocked, choose that symptom. Ask the app owner to review it.',
    ]), links: [{ label: 'Google supported browsers', url: 'https://support.google.com/accounts/answer/7675428?hl=en' }] };
    case 'redirect': return plan('The redirect used by this flow must match the vendor app registration.', [
      broker ? 'Use the OAuth callback shown by your Nango server’s integration settings. The Recued direct-OAuth callback belongs to a different flow.'
        : oauthHelpCallback(ctx.callbackUrl) ? 'Use the exact callback URL shown in this Recued connection form. Compare its scheme, host, port, path and any query string.'
          : 'Open the account or connection authorization form and copy the callback shown for that specific flow. One saved app can be used by several flows.',
      'Check that you are editing the app whose Client ID this sign-in uses. Add the callback under redirect URIs, not JavaScript origins.',
      'Keep the original Recued tab open and start a fresh sign-in after saving the registration change.',
    ]);
    case 'blocked': return plan('A blocked app can reflect verification, requested permissions or account policy. Recued cannot determine the cause from the screen alone.', [
      'Ask the owner of ' + app + ' to review its consent configuration, verification and eligible users.',
      broker ? 'For a shared app, the broker or app owner controls its verification. Changing Recued’s broker API key will not fix a vendor consent block.'
        : 'For a Google app in testing, check its test users and requested permissions. For work or school accounts, ask the account administrator about policy.',
      'Keep the permissions required by your packs and collections. A broker does not bypass vendor policy; a different app or account needs its normal review.',
    ]);
    case 'credentials': case 'secret': return plan(issue === 'secret' ? 'A changed app secret may need updating in every tool or credential copy using it.'
      : 'App authentication was refused. This alone does not prove which field or account setting is wrong.', [
      ctx.issuer === 'microsoft'
        ? 'Check Application (client) ID and the secret Value, not Secret ID. Review Supported account types for the work, school or personal Microsoft account you intend to use.'
        : 'Confirm the Client ID and secret belong to ' + app + '.',
      credentials,
      broker ? 'Check access through the same Nango account after repair. Reuse its existing connection instead of creating another account for each retry.'
        : 'Review affected credential copies before applying. Then verify a protected API read; a cached access token does not prove the new secret works.',
    ]);
    case 'consent': return plan('Consent can fail because it was declined, the app does not accept the account, or an administrator restricts access.', [
      'Check the account and the app shown on the vendor consent page. Do not assume access_denied means you clicked Decline.',
      'Ask the app owner to check supported account types and eligible users. Work or school policies may require administrator consent.',
      'Retry through the existing sign-in flow after the owner or administrator resolves the restriction. Keep the reviewed permission needs.',
    ]);
    case 'scopes': return plan('A rejected scope request differs from an API access denial after sign-in.', [
      'Compare the permission preview with the vendor’s supported scope names and the service your connection uses.',
      broker ? 'Review the integration’s configured scopes in Nango. Shared apps can have fixed scopes; Recued must also preserve recorded needs from other uses.'
        : 'Ask the app owner to review the app’s permissions and API setup. Enabling an API alone does not correct an invalid scope name.',
      'Return to the normal permission review before authorizing. Request history is not proof of the permissions the vendor granted.',
    ]);
    case 'grant': return plan('A rejected code or refresh token can have several causes, including expiry, revocation or reuse.', [
      'Check any pending result before retrying; do not paste a returned callback URL, code or token into the guide.',
      'Review the same app and vendor account. Start a new authorization only through the normal reconnect or reauthorization flow.',
      'Verify access after authorization. Keep the existing connection name and review required permissions and affected uses before applying.',
    ]);
    case 'return': return plan('Successful vendor consent does not confirm that Recued received and saved the result.', [
      'Use the current flow’s Check result, Refresh or recovery control before starting new consent. Keep the original Recued tab open.',
      broker ? 'Refresh accounts in the same Nango integration and environment. A lost socket can leave an account created in Nango; review and reuse it if present.'
        : 'Check whether the account or connection is already saved. The callback must return to the expected browser origin and tab.',
      'If no completed result exists, finish or cancel the old flow, then start again through Recued. Do not replay a callback URL or authorization code.',
    ]);
    case 'access': return plan('A denied API action does not by itself identify a missing permission or a bad secret.', [
      'Use the pack’s Check access control with a resource this account owns or can read, when the pack offers one.',
      'Review the selected account, resource sharing, required permissions and vendor policy. A 403 alone does not prove that more scopes will fix it.',
      'Use the normal permission repair or authentication review before applying changes. Leave unknown permission reminders until you review them.',
    ]);
    case 'broker_key': return plan('Nango’s environment API key and the vendor app credentials serve different purposes.', [
      'In Manage OAuth brokers, check the saved server URL and the API key from that same Nango environment.',
      'Check that the key can read integrations and connections, create Connect sessions and proxy requests. Other actions may need additional permissions.',
      'Use Test and save broker after an explicit edit. For another environment, add a new profile and review its accounts; do not replace the old profile’s environment silently.',
    ]);
    case 'broker_unavailable': return plan('A broker request failed or was interrupted; this does not prove the API key is wrong.', [
      'Check that your Recued server can reach the saved Nango server URL. For self-hosting, check the API service and reverse proxy.',
      'If consent completed, check the existing account and result before another authorization. The Connect UI and its socket must reach the same broker API.',
      'Wait and retry the existing refresh or status control after a temporary outage or rate limit. Keep saved accounts and scope history in place.',
    ]);
    case 'broker_history': return plan('Unknown requested-scope history cannot safely be treated as an empty grant.', [
      'Refresh the account and integration in the same broker environment. Check whether the environment key can read the metadata Recued needs.',
      'If history stays unknown, review consent in Nango using the existing scope profile. Recued may refuse a scope change to preserve other uses.',
      'Return to Recued’s permission preview and access check after repair. Requested scopes still do not confirm granted permissions.',
    ]);
    case 'locked': return plan('The paired Recued server needs its vault unlocked before it can use encrypted credentials.', [
      'Unlock the paired server, then refresh the connection or saved-app view.',
      'Keep the saved app, broker profile and vendor account in place while you unlock.',
      'Return to the existing review or status control. A secret change is not a workaround for a locked vault.',
    ]);
    case 'setup': return plan('Some required setup is unavailable. The guide cannot determine which setting from a generic configuration error.', [
      broker ? 'Check the broker profile, selected integration and saved account in Manage OAuth brokers.' : 'Check the selected saved app in Apps & APIs. Direct OAuth needs your vendor app credentials.',
      broker ? 'A shared app is available only when the selected broker offers it. Use the integration’s vendor callback for a custom app.' : 'Confirm the app accepts your account and has the callback shown by the connection form.',
      'Refresh the setup view, then use the normal authorization and access review.',
    ]);
    default: return plan('Choose the symptom closest to what you saw. Recued cannot read a vendor’s sign-in page or infer its policy decision.', [
      'Identify whether the problem happened before the window opened, on the vendor consent page, after returning, or during an API action.',
      'Choose that symptom above to see checks for this authentication route.',
      'Check pending results before retrying. Share only the help summary with support; keep passwords, secrets, tokens and callback results private.',
    ]);
  }
};

export const oauthHelpSummary = (ctx: OAuthTroubleshootingContext, issue: OAuthHelpIssue,
  observation: OAuthHelpObservation | undefined, checked: ReadonlySet<number>, reported = false): string => {
  const plan = oauthHelpPlan(ctx, issue);
  return ['Recued OAuth troubleshooting v1', 'Authentication: ' + (ctx.route === 'broker' ? 'Nango broker' : isClientCredentials(ctx) ? 'Recued direct OAuth (client credentials)' : 'Recued direct OAuth'),
    'Vendor: ' + (ctx.issuer ?? 'unknown'), 'Observed: ' + (observation?.label ?? 'No diagnostic evidence recorded.'),
    (reported ? 'Selected symptom (user reported): ' : observation ? 'Suggested checks from observed failure: ' : 'Symptom (not yet selected): ') + plan.title,
    ...plan.steps.map((step, i) => (checked.has(i) ? '[reviewed locally] ' : '[ ] ') + step),
    'Checklist completion does not verify authorization or vendor access.'].join('\n');
};

let sequence = 0;
export const createOAuthTroubleshooting = (deps: { copy?(text: string): Promise<void> } = {}) => {
  const id = 'oauth-help-' + ++sequence;
  let host: HTMLElement | null = null; let context: OAuthTroubleshootingContext | null = null;
  let key = ''; let expanded = false; let issue: OAuthHelpIssue = 'unknown'; let selected = false;
  let observation: OAuthHelpObservation | undefined; const checked = new Set<number>(); let notice = ''; let generation = 0; let disposed = false;
  const render = () => {
    if (!host || !context || disposed) { if (host) host.innerHTML = ''; return; }
    const active = host.ownerDocument?.activeElement as HTMLElement | null | undefined;
    let focusSelector: string | undefined;
    if (active && host.contains(active)) {
      if (active.hasAttribute('data-oauth-help-issue')) focusSelector = '[data-oauth-help-issue]';
      else if (['toggle', 'copy', 'reset'].includes(active.dataset.oauthHelpAction ?? '')) focusSelector = '[data-oauth-help-action="' + active.dataset.oauthHelpAction + '"]';
      else if (/^[0-2]$/.test(active.dataset.oauthHelpCheck ?? '')) focusSelector = '[data-oauth-help-check="' + active.dataset.oauthHelpCheck + '"]';
    }
    const plan = oauthHelpPlan(context, issue);
    const callback = context.route === 'direct' && !isClientCredentials(context) ? oauthHelpCallback(context.callbackUrl) : undefined;
    host.innerHTML = '<section class="oauth-help" aria-label="Guided OAuth troubleshooting">'
      + '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-oauth-help-action="toggle" aria-expanded="' + expanded + '" aria-controls="' + id + '">'
      + (expanded ? 'Close OAuth troubleshooting' : 'Troubleshoot OAuth') + '</button>'
      + (observation ? '<p class="oauth-help-observation">Last observed: ' + e(observation.label) + '</p>' : '')
      + (expanded ? '<div id="' + id + '"><h3 tabindex="-1" data-oauth-help-heading>Guided OAuth troubleshooting</h3>'
        + '<p>' + (context.route === 'broker' ? 'Using a Nango broker. Vendor app settings belong to its integration.' : isClientCredentials(context)
          ? 'Using Recued direct OAuth with app credentials, without browser sign-in.' : 'Using Recued direct OAuth with your vendor app.') + '</p>'
        + (context.pending ? '<p role="note">An authentication action or result is still pending. Resolve its existing status before starting another sign-in.</p>' : '')
        + '<label for="' + id + '-issue">What happened?</label><select id="' + id + '-issue" data-oauth-help-issue>'
        + oauthHelpIssues(context).map(value => '<option value="' + value + '"' + (issue === value ? ' selected' : '') + '>' + e(issueLabel(context!, value)) + '</option>').join('') + '</select>'
        + '<p>' + e(plan.explanation) + '</p>'
        + (issue === 'redirect' && callback ? '<p>Expected registration callback for this flow:</p><code class="oauth-help-callback">' + e(callback) + '</code>' : '')
        + '<ol>' + plan.steps.map((step, i) => '<li><label><input type="checkbox" data-oauth-help-check="' + i + '"' + (checked.has(i) ? ' checked' : '') + '> ' + e(step) + '</label></li>').join('') + '</ol>'
        + '<p>' + checked.size + ' of ' + plan.steps.length + ' checks reviewed locally. This does not verify vendor access.</p>'
        + '<p>' + plan.links.map(link => '<a href="' + e(link.url) + '" target="_blank" rel="noopener noreferrer">' + e(link.label) + '</a>').join(' · ') + '</p>'
        + '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-oauth-help-action="copy">Copy help summary</button> '
        + '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-oauth-help-action="reset">Start over</button>'
        + '<p>The copied summary includes the selected symptom and local checklist. It omits account identifiers, credentials, raw errors and callback URLs.</p>'
        + (notice ? '<p role="status">' + e(notice) + '</p>' : '') + '</div>' : '') + '</section>';
    if (focusSelector) host.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-oauth-help-action]');
    if (!target || !host?.contains(target) || !context || disposed) return;
    event.preventDefault(); const action = target.dataset.oauthHelpAction; notice = '';
    if (action === 'toggle') { generation++; expanded = !expanded; render(); if (expanded) host.querySelector<HTMLElement>('[data-oauth-help-heading]')?.focus(); }
    else if (action === 'reset') { generation++; issue = 'unknown'; selected = false; checked.clear(); render(); host.querySelector<HTMLElement>('[data-oauth-help-issue]')?.focus(); }
    else if (action === 'copy') {
      const gen = ++generation;
      const summary = oauthHelpSummary(context, issue, observation, checked, selected);
      let copy = deps.copy;
      try {
        const clipboard = host.ownerDocument?.defaultView?.navigator.clipboard;
        copy ??= clipboard?.writeText?.bind(clipboard);
      } catch { /* Browser policy can deny access to the clipboard itself. */ }
      if (!copy) { notice = 'Clipboard is unavailable in this browser. Follow the checks shown here.'; render(); return; }
      void Promise.resolve().then(() => copy(summary)).then(() => {
        if (!disposed && gen === generation) { notice = 'Help summary copied.'; render(); }
      }, () => { if (!disposed && gen === generation) { notice = 'The summary could not be copied. Follow the checks shown here.'; render(); } });
    }
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target || !host?.contains(target) || !context || disposed) return;
    if (target.hasAttribute('data-oauth-help-issue') && oauthHelpIssues(context).includes(target.value as OAuthHelpIssue)) {
      generation++; issue = target.value as OAuthHelpIssue; selected = true; checked.clear(); notice = ''; render(); host.querySelector<HTMLElement>('[data-oauth-help-issue]')?.focus({ preventScroll: true });
    } else if ('checked' in target && target.dataset.oauthHelpCheck !== undefined) {
      const index = Number(target.dataset.oauthHelpCheck);
      if (!Number.isInteger(index) || index < 0 || index >= oauthHelpPlan(context, issue).steps.length) return;
      if (target.checked) checked.add(index); else checked.delete(index);
      generation++; notice = ''; render(); host.querySelector<HTMLElement>('[data-oauth-help-check="' + index + '"]')?.focus({ preventScroll: true });
    }
  };
  const detach = () => { host?.removeEventListener('click', click); host?.removeEventListener('change', change); };
  const observe = (value: OAuthHelpObservation) => {
    if (!context || disposed) return;
    generation++; notice = '';
    observation = value;
    if (!selected && oauthHelpIssues(context).includes(value.issue)) { issue = value.issue; checked.clear(); }
    render();
  };
  return {
    mount(element: HTMLElement | null, next: OAuthTroubleshootingContext | null) {
      if (disposed) return;
      detach(); host = element;
      const nextKey = next ? JSON.stringify([next.key, next.route, next.flow, next.issuer, next.callbackUrl, next.savedApp]) : '';
      if (key !== nextKey) { key = nextKey; generation++; expanded = false; issue = 'unknown'; selected = false; observation = undefined; checked.clear(); notice = ''; }
      context = next; render(); host?.addEventListener('click', click); host?.addEventListener('change', change);
    },
    observeFailure(error: unknown) { observe(oauthHelpFailureObservation(error)); },
    observePopup(reason: string, code?: string) { observe(oauthHelpPopupObservation(reason, code)); },
    open() { if (!context || disposed) return; expanded = true; render(); host?.querySelector<HTMLElement>('[data-oauth-help-heading]')?.focus(); },
    dispose() { generation++; disposed = true; detach(); if (host) host.innerHTML = ''; host = null; context = null; checked.clear(); observation = undefined; },
  };
};

// Closed, the help is one button; the box appears with the guide it holds.
export const OAUTH_TROUBLESHOOTING_STYLES = '.oauth-help{margin:12px 0;overflow-wrap:anywhere;font-size:13px;line-height:1.5}.oauth-help:has(> div){border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--surface)}.oauth-help-observation{margin:6px 0 0;color:var(--fg-muted);font-size:12px}.oauth-help select{display:block;font:inherit;max-width:100%;width:100%;padding:8px;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:6px}.oauth-help ol{padding-left:24px}.oauth-help li{margin:12px 0}.oauth-help li label{display:flex;align-items:flex-start;gap:8px}.oauth-help input[type=checkbox]{width:18px;height:18px;min-width:18px;flex:none;margin-top:2px}.oauth-help-callback{display:block;white-space:normal}.oauth-help h3{margin-top:12px}';
