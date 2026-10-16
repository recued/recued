import { GOOGLE_AUTHORIZE_URL, MICROSOFT_AUTHORIZE_URL, buildOpenerRelayRedirectUri,
  isCollectionOAuthAppContext, isCollectionOAuthAppAuthorization, isCollectionOAuthAppReview, isCollectionOAuthAppOutcome,
  type AuthenticationCollectionPlatform, type CollectionPermissionChoices,
  type CollectionOAuthAppContext, type CollectionOAuthAppReview, type CollectionOAuthAppOutcome, type SavedOAuthApp,
} from '@recued/contracts';
import { escapeHtml as e, renderCollectionPermissionChoices, sameCollectionPermissionChoices } from '@recued/ui-shared';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { defaultFoundationalOAuthEnv, openOAuthPopup, runOAuthPopup,
  type FoundationalOAuthEnv, type FoundationalOAuthPopupHandle } from './foundational-oauth-popup.js';

const id = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const createCollectionOAuthAppSwitchPanel = (deps: {
  host: HTMLElement; call: ManagedOAuthCaller; changed(): void; openApps(): void;
  oauth?(): { env: FoundationalOAuthEnv; openPopup(): FoundationalOAuthPopupHandle | null };
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; now?(): number; id?(): string;
  /** A bulk coordinator supplies a stable slot and pins the reviewed destination. */
  slotSelector?: string; targetApp?: SavedOAuthApp; bulk?: boolean; updated?(): void; locked?(): boolean;
}) => {
  let selected: { platform: AuthenticationCollectionPlatform; slug: string } | undefined;
  let context: CollectionOAuthAppContext | undefined; let review: CollectionOAuthAppReview | undefined;
  let appId = ''; let authorizationId: string | undefined; let attempt: string | undefined;
  let outcome: CollectionOAuthAppOutcome | undefined; let busy = false; let applying = false; let error = '';
  let disposed = false; let generation = 0; let abort: AbortController | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined; let polls = 0;
  let expectedAppId: string | undefined;
  let reauthorizing = false; let additionalScopes = ''; let reviewedAdditionalScopes = '';
  let permissionChoices: CollectionPermissionChoices[] = [];
  const permissionsReviewed = () => !permissionChoices.length || !!context && permissionChoices.length === context.collections.length
    && permissionChoices.every(choice => context!.collections.some(row => row.permissions && sameCollectionPermissionChoices(choice, row.permissions.selected)));
  const choicesFor = (ctx: CollectionOAuthAppContext) => reauthorizing ? [ctx.current_app]
    : ctx.apps.filter(app => app.id !== ctx.current_app.id && (!deps.targetApp || app.id === deps.targetApp.id));
  const slot = () => deps.host.querySelector<HTMLElement>(deps.slotSelector ?? '[data-collection-oauth-app-host]');
  const owns = (node: HTMLElement) => deps.slotSelector ? slot()?.contains(node) === true : deps.host.contains(node);
  const focus = (selector: string) => (deps.slotSelector ? slot() : deps.host)?.querySelector<HTMLElement>(selector)?.focus();
  const now = deps.now ?? Date.now;
  const storage = () => { try { return deps.storage ?? deps.host.ownerDocument.defaultView?.sessionStorage; } catch { return undefined; } };
  const key = () => 'recued:collection-oauth-app:' + selected?.platform + ':' + selected?.slug;
  const remember = () => { try { if (attempt) storage()?.setItem(key(), attempt); else storage()?.removeItem(key()); } catch { /* Current mount can still check its receipt. */ } };
  const retire = () => {
    const saved = context?.id ?? authorizationId ?? review?.id;
    context = undefined; review = undefined; authorizationId = undefined;
    if (saved) void deps.call({ action: 'collection_authentication_app_retire', id: saved }).catch(() => {});
  };
  const clearPoll = () => { if (poll !== undefined) clearTimeout(poll); poll = undefined; };
  const callback = () => {
    const env = deps.oauth?.().env ?? (typeof window === 'undefined' ? undefined : defaultFoundationalOAuthEnv());
    return env && context ? buildOpenerRelayRedirectUri(env.origin, context.issuer === 'microsoft') : '';
  };
  const button = (action: string, label: string, disabled = false) => '<button type="button" class="rx-btn rx-btn-sm '
    + (action === 'authorize' || action === 'apply' ? 'rx-btn-primary' : 'rx-btn-secondary') + '" data-oauth-app-switch-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + e(label) + '</button>';
  const render = () => {
    const host = slot();
    if (!host || disposed) return;
    if (!selected) { host.innerHTML = ''; deps.updated?.(); return; }
    const choices = context ? choicesFor(context) : [];
    host.innerHTML = '<section class="accounts-oauth-app-switch" aria-label="' + (reauthorizing ? 'Re-authorize current sign-in' : 'Switch OAuth app') + '"><style>'
      + '.accounts-oauth-app-switch{border:1px solid var(--border);border-radius:12px;padding:16px;overflow-wrap:anywhere;min-width:0}'
      + '.accounts-oauth-app-switch select{max-width:100%;width:100%;box-sizing:border-box}.accounts-oauth-app-switch button{margin:4px}'
      + '.accounts-oauth-app-switch code{white-space:normal}.accounts-oauth-app-switch h3{margin-top:0}</style>'
      + '<h3 tabindex="-1" data-oauth-app-switch-heading>' + (deps.bulk ? 'Account and app review' : (reauthorizing ? 'Re-authorize ' : 'Switch OAuth app for ') + e(selected.slug)) + '</h3>'
      + (deps.bulk ? '' : '<p>' + (reauthorizing ? 'Sign in again with the current OAuth app. Review any additional permissions before continuing.' : 'Sign in to the same vendor account with another saved app.') + ' Your collection name, saved data, selections and sync state stay in place.</p>')
      + (reauthorizing && context && !attempt ? renderCollectionPermissionChoices({ owner: 'oauth-app', disabled: busy || !!review,
        rows: context.collections.flatMap(row => row.permissions ? [{ provider: row.provider, current: row.permissions.current,
          selected: permissionChoices.find(choice => choice.platform === row.platform && choice.slug === row.slug) ?? row.permissions.selected }] : [])
          .sort((a, b) => Number(b.current.platform === selected!.platform && b.current.slug === selected!.slug)
            - Number(a.current.platform === selected!.platform && a.current.slug === selected!.slug)) }) : '')
      + (reauthorizing && !review && !attempt ? '<details data-oauth-advanced-permissions><summary>Advanced permissions</summary><label>Additional permissions (space-separated) <input type="text" data-oauth-reauthorization-scopes value="' + e(additionalScopes) + '"' + (busy ? ' disabled' : '') + '></label><p>Known vendor permissions are kept. Adding a scope here does not enable another Recued capability.</p></details><p>Select Review permissions after changing choices.</p>' : '')
      + (context ? '<p>Current app: <strong>' + e(context.current_app.label) + '</strong> · <code>' + e(context.current_app.client_id) + '</code></p>'
        + (context.collections.length > 1 ? '<p><strong>These collections share one sign-in and ' + (reauthorizing ? 'will use this renewed sign-in' : 'will switch together') + ':</strong></p>' : '<p>Account to keep:</p>')
        + '<ul>' + context.collections.map(row => '<li>' + e(row.platform + ' ' + row.slug) + ' · ' + e(row.current.email ?? 'Unknown email')
          + (row.selections.length ? '<br>Keep selection: ' + e(row.selections.join(', ')) : '') + '</li>').join('') + '</ul>'
        + '<label>' + (reauthorizing ? 'Current OAuth app' : 'New saved OAuth app') + ' <select data-oauth-app-switch-choice' + (reauthorizing || deps.bulk || busy || !!review || !!attempt ? ' disabled' : '') + '>'
        + '<option value="">Choose a saved app</option>' + choices.map(app => '<option value="' + e(app.id) + '"' + (app.id === appId ? ' selected' : '') + '>'
          + e(app.label + ' · ' + app.client_id) + '</option>').join('') + '</select></label>'
        + (!choices.length ? deps.targetApp && context.current_app.id === deps.targetApp.id
          ? '<p>Already using the destination saved app. No switch needed.</p>' : '<p>Add another Google or Microsoft app in Apps & APIs, then refresh this review.</p>' : '')
        + (context.added_scopes ? '<details open><summary>Added vendor permissions</summary>' + (context.added_scopes.length
          ? '<ul>' + context.added_scopes.map(scope => '<li><code>' + e(scope) + '</code></li>').join('') + '</ul>'
          : '<p>No additional vendor permissions are needed by this request.</p>') + '</details>' : '')
        + '<details' + (deps.bulk || reauthorizing && context.added_scopes ? '' : ' open') + '><summary>Review requested permissions' + (deps.bulk ? ' and callback' : '') + '</summary><ul>' + context.requested_scopes.map(s => '<li><code>' + e(s) + '</code></li>').join('')
        + '</ul><p>' + (reauthorizing ? 'The new sign-in must cover the selected choices. Previously recorded permissions are retained; local choices do not revoke vendor consent.'
          : 'Existing read, send and edit abilities must be covered by the new sign-in.') + '</p>'
        + (callback() ? '<p>Register this callback URL on the selected app: <code>' + e(callback()) + '</code></p>' : '') + '</details>' : '')
      + (review ? '<p>Same vendor account verified for every affected collection. Protected read checks passed.</p>'
        + '<p>Selected account: ' + e([...new Set(review.targets.map(target => target.email ?? 'Unknown email'))].join(', ')) + '</p>'
        + '<p>Selected app: <strong>' + e(review.app.label) + '</strong></p><p>Vendor-reported permissions: <code>' + e(review.granted_scopes.join(', ')) + '</code></p>'
        + '<p>Applying pauses sync briefly and then resumes it with this app.</p>' : '')
      + (outcome ? '<p role="status">' + (outcome.status === 'applied' ? (outcome.intent === 'reauthorize' ? 'Sign-in reauthorized.' : 'OAuth app switched.') + ' The collection names, selections and sync state were kept.'
        + (outcome.restart_needed?.length ? ' Sync needs a restart for: ' + e(outcome.restart_needed.map(r => r.platform + ' ' + r.slug).join(', ')) + '. Restart Recued, then check the result.' : '')
        : outcome.status === 'checking' ? 'The switch is still being checked. Check its result before starting again.'
        : 'The saved OAuth app was kept. ' + (outcome.reason === 'changed' ? 'The account or app changed; refresh and review again.' : outcome.reason === 'interrupted' ? 'The server restarted during verification; start a fresh review.' : 'Account or permission checks failed.')) + '</p>' : '')
      + (error ? '<p role="alert">' + e(error) + '</p>' : '')
      + (busy ? '<p role="status">' + (applying ? 'Applying the reviewed app switch…' : 'Checking sign-in and account access…') + '</p>' : '')
      + (attempt ? button('status', 'Check result', busy)
        : deps.bulk && outcome ? ''
        : review ? (deps.bulk ? review.expires_at <= now() ? '<p>This review expired. Refresh and authorize again before applying.</p>' + button('refresh', 'Refresh account review', busy)
          : '<p>Verified for bulk apply. Apply before this review expires. Changed apps or accounts require a new review.</p>' : button('apply', reauthorizing ? 'Apply reauthorization' : 'Apply OAuth app switch', busy || review.expires_at <= now()) + button('refresh', reauthorizing ? 'Review permissions again' : 'Choose another app', busy))
        : context ? button('authorize', 'Authorize and verify account', busy || !appId || context.expires_at <= now() || additionalScopes !== reviewedAdditionalScopes || !permissionsReviewed()) + button('refresh', reauthorizing ? 'Review permissions' : 'Refresh account and apps', busy)
        : button('refresh', 'Refresh account and apps', busy))
      + (outcome && !context ? '<p>Saved destination app: <code>' + e(outcome.app_id) + '</code></p>' : '')
      + (deps.bulk && deps.targetApp && outcome && outcome.app_id !== deps.targetApp.id
        ? '<p>This earlier switch used a different saved app. Choose accounts again to review a move to the selected bulk destination.</p>' : '')
      + (deps.bulk ? '' : button('apps', 'Manage saved apps', busy || !!attempt)
        + button('close', busy && !applying ? 'Cancel sign-in' : 'Close', applying)) + '</section>';
    deps.updated?.();
  };
  const close = () => {
    generation++; abort?.abort(); abort = undefined; clearPoll(); retire(); selected = undefined; appId = ''; attempt = undefined;
    outcome = undefined; busy = false; applying = false; error = ''; polls = 0; expectedAppId = undefined; reauthorizing = false; additionalScopes = ''; reviewedAdditionalScopes = ''; permissionChoices = []; render();
  };
  const retireLate = (value: string) => { void deps.call({ action: 'collection_authentication_app_retire', id: value }).catch(() => {}); };
  const finishOutcome = (value: CollectionOAuthAppOutcome) => {
    outcome = value;
    if (value.status !== 'checking') {
      if (value.status !== 'applied' || !value.restart_needed?.length) { attempt = undefined; remember(); }
      retire();
      if (value.status === 'applied') {
        try { deps.changed(); } catch { error = 'The switch is confirmed. Refresh the account list to see the new app.'; }
      }
    }
  };
  const refreshStatus = async () => {
    if (!selected || !attempt || busy || disposed) return;
    const gen = generation; const savedAttempt = attempt; busy = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'collection_authentication_app_status', attempt_id: savedAttempt });
      if (disposed || gen !== generation) return;
      if (response.action !== 'collection_authentication_app_status' || response.outcome !== null && (!isCollectionOAuthAppOutcome(response.outcome)
        || response.outcome.attempt_id !== savedAttempt || response.outcome.platform !== selected.platform || response.outcome.slug !== selected.slug
        || expectedAppId && response.outcome.app_id !== expectedAppId)) throw new Error('Invalid receipt');
      if (response.outcome) finishOutcome(response.outcome); else { attempt = undefined; remember(); error = 'No saved result was found. Start a fresh review.'; }
      if (outcome?.status === 'checking' && polls++ < 60) poll = setTimeout(() => { void refreshStatus(); }, 2000);
    } catch { if (!disposed && gen === generation) error = 'The result could not be read. Check again before starting another switch.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); } }
  };
  const openPanel = async (platform: AuthenticationCollectionPlatform, slug: string, choice = '', recovery?: { attempt: string; app_id?: string }, intent: 'switch_app' | 'reauthorize' = 'switch_app', scopes = '', permissions?: readonly CollectionPermissionChoices[]) => {
    close(); reauthorizing = intent === 'reauthorize'; additionalScopes = scopes; selected = { platform, slug }; const gen = generation; busy = true; render();
    expectedAppId = recovery?.app_id;
    try { const saved = recovery?.attempt ?? storage()?.getItem(key()); if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) attempt = saved; } catch { /* Current mount recovery remains available. */ }
    if (attempt) { busy = false; await refreshStatus(); return; }
    expectedAppId = deps.targetApp?.id;
    try {
      const response = await deps.call({ action: 'collection_authentication_app_context', platform, slug, ...(reauthorizing
        ? { intent: 'reauthorize' as const, scopes: additionalScopes.split(/\s+/).filter(Boolean), ...(permissions?.length ? { permissions } : {}) } : {}) });
      if (disposed || gen !== generation) { if (response.action === 'collection_authentication_app_context' && isCollectionOAuthAppContext(response.context)) retireLate(response.context.id); return; }
      if (response.action !== 'collection_authentication_app_context' || !isCollectionOAuthAppContext(response.context)
        || response.context.platform !== platform || response.context.slug !== slug || response.context.expires_at <= now()
        || reauthorizing && response.context.intent !== 'reauthorize') throw new Error('Update Recued to switch saved OAuth apps.');
      if (permissions?.some(choice => !response.context.collections.some(row => row.permissions && sameCollectionPermissionChoices(choice, row.permissions.selected)))) {
        retireLate(response.context.id); throw new Error('The server did not confirm the selected permission choices. Update Recued and review again.');
      }
      context = response.context; reviewedAdditionalScopes = additionalScopes;
      permissionChoices = context.collections.flatMap(row => row.permissions ? [structuredClone(row.permissions.selected)] : []);
      const pinned = deps.targetApp;
      if (pinned && (context.issuer !== pinned.issuer || context.current_app.id !== pinned.id
        && !context.apps.some(app => app.id === pinned.id && app.client_id === pinned.client_id && app.revision === pinned.revision))) {
        retire(); throw new Error('The selected saved app changed. Choose accounts and the app again.');
      }
      const choices = choicesFor(context);
      appId = choices.find(a => a.id === choice)?.id ?? (choices.length === 1 ? choices[0]!.id : '');
    } catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'The current account could not be verified. Repair its sign-in first.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); focus('[data-oauth-app-switch-heading]'); } }
  };
  const authorize = async () => {
    if (!selected || !context || !appId || busy || attempt || review || deps.locked?.()) return;
    const ctx = context; const app = choicesFor(ctx).find(a => a.id === appId); if (!app || additionalScopes !== reviewedAdditionalScopes || !permissionsReviewed()) return;
    if (deps.targetApp && app.id !== deps.targetApp.id) return;
    const oauth = deps.oauth?.() ?? { env: defaultFoundationalOAuthEnv(), openPopup: () => openOAuthPopup() };
    const popup = oauth.openPopup();
    if (!popup) { error = 'Allow popups for Recued, then try again.'; render(); return; }
    const gen = generation; const redirect = buildOpenerRelayRedirectUri(oauth.env.origin, ctx.issuer === 'microsoft');
    abort = new AbortController(); busy = true; error = ''; outcome = undefined; render();
    try {
      const result = await runOAuthPopup(oauth.env, { popup, expectedSenderOrigin: new URL(redirect).origin, signal: abort.signal,
        buildAuthorizeUrl: async state => {
          const response = await deps.call({ action: 'collection_authentication_app_authorize', context_id: ctx.id,
            fingerprint: ctx.fingerprint, app_id: app.id, expected_revision: app.revision });
          if (response.action !== 'collection_authentication_app_authorize' || !isCollectionOAuthAppAuthorization(response.authorization)) throw new Error('Could not prepare the selected OAuth app.');
          if (disposed || gen !== generation) { retireLate(response.authorization.id); throw new Error('Sign-in was cancelled.'); }
          const auth = response.authorization;
          if (auth.context_id !== ctx.id || auth.app.id !== app.id || auth.app.client_id !== app.client_id || auth.app.revision !== app.revision
            || auth.issuer !== ctx.issuer || auth.expires_at <= now() || JSON.stringify(auth.requested_scopes) !== JSON.stringify(ctx.requested_scopes)) throw new Error('The app or permissions changed. Refresh and try again.');
          authorizationId = auth.id;
          const url = new URL(ctx.issuer === 'google' ? GOOGLE_AUTHORIZE_URL : MICROSOFT_AUTHORIZE_URL);
          for (const [key, value] of Object.entries({ response_type: 'code', client_id: auth.app.client_id, redirect_uri: redirect, state,
            scope: auth.requested_scopes.join(' '), ...(ctx.issuer === 'google' ? { access_type: 'offline', prompt: 'consent' } : { response_mode: 'query', ...(reauthorizing ? { prompt: 'consent' } : {}) }) })) url.searchParams.set(key, value);
          return url.toString();
        } });
      if (disposed || gen !== generation) return;
      if (!result.ok) throw new Error(result.reason === 'denied' ? 'Sign-in was declined. The saved app is unchanged.'
        : result.reason === 'timeout' ? 'Sign-in timed out. Refresh and try again.' : result.detail ?? 'Sign-in was closed or cancelled. The saved app is unchanged.');
      if (!authorizationId) throw new Error('The sign-in context expired. Refresh and try again.');
      const response = await deps.call({ action: 'collection_authentication_app_review', authorization_id: authorizationId, code: result.code, redirect_uri: redirect });
      if (disposed || gen !== generation) { if (response.action === 'collection_authentication_app_review' && isCollectionOAuthAppReview(response.review)) retireLate(response.review.id); return; }
      if (response.action !== 'collection_authentication_app_review' || !isCollectionOAuthAppReview(response.review) || response.review.context.id !== ctx.id
        || response.review.context.fingerprint !== ctx.fingerprint || response.review.context.intent !== ctx.intent || response.review.app.id !== app.id || response.review.app.client_id !== app.client_id
        || response.review.app.revision !== app.revision || response.review.expires_at <= now()) throw new Error('The same vendor account and permissions could not be verified.');
      review = response.review;
    } catch (err) { if (!disposed && gen === generation) { error = err instanceof Error ? err.message : 'Sign-in could not be verified.'; retire(); } }
    finally { if (!disposed && gen === generation) { busy = false; abort = undefined; render(); } }
  };
  const apply = async () => {
    if (!selected || !review || busy || attempt) return;
    if (review.expires_at <= now()) { retire(); error = 'The review expired. Refresh the account and authorize again.'; render(); return; }
    const gen = generation; const checked = review; attempt = (deps.id ?? id)(); remember(); busy = true; applying = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'collection_authentication_app_apply', review_id: checked.id, fingerprint: checked.fingerprint, attempt_id: attempt });
      if (disposed || gen !== generation) return;
      if (response.action !== 'collection_authentication_app_apply' || !isCollectionOAuthAppOutcome(response.outcome)
        || response.outcome.attempt_id !== attempt || response.outcome.platform !== selected.platform || response.outcome.slug !== selected.slug
        || response.outcome.app_id !== checked.app.id) throw new Error('Invalid receipt');
      finishOutcome(response.outcome);
    } catch { if (!disposed && gen === generation) error = 'The reply was lost. Check the saved result before starting another switch.'; }
    finally { if (!disposed && gen === generation) { busy = false; applying = false; render(); if (outcome?.status === 'checking') void refreshStatus(); } }
  };
  const click = (event: Event) => {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-oauth-app-switch-action]');
    if (!node || !owns(node) || node.getAttribute('disabled') !== null || deps.locked?.()) return;
    const action = node.dataset.oauthAppSwitchAction; event.preventDefault();
    if (action === 'close' && !applying) close();
    if (busy || !selected) return;
    if (action === 'status') void refreshStatus();
    else if (action === 'authorize') void authorize();
    else if (action === 'apply' && !deps.bulk) void apply();
    else if (!attempt && action === 'refresh') void openPanel(selected.platform, selected.slug, appId, undefined, reauthorizing ? 'reauthorize' : 'switch_app', additionalScopes, permissionChoices);
    else if (!attempt && action === 'apps') { close(); deps.openApps(); }
  };
  const change = (event: Event) => {
    const node = event.target as HTMLSelectElement | null;
    if (node?.getAttribute?.('data-collection-permission-owner') === 'oauth-app') {
      if (event.type !== 'change' || !owns(node) || !reauthorizing || busy || attempt || review) return;
      const input = node as unknown as HTMLInputElement;
      const choice = permissionChoices.find(p => p.platform === input.dataset.permissionPlatform && p.slug === input.dataset.permissionSlug);
      const feature = input.dataset.permissionFeature;
      if (!choice || choice.platform === 'mail' && !['send', 'organize'].includes(feature ?? '') || choice.platform === 'calendar' && feature !== 'edit_events') return;
      if (choice.platform === 'mail') { if (feature === 'send') choice.send = input.checked; else choice.organize = input.checked; }
      else choice.edit_events = input.checked;
      error = ''; render(); focus('[data-permission-slug="' + choice.slug + '"][data-permission-feature="' + feature + '"]'); return;
    }
    if (node?.hasAttribute('data-oauth-reauthorization-scopes')) {
      if (!owns(node) || !reauthorizing || busy || attempt || review) return;
      additionalScopes = node.value;
      const authorizeButton = slot()?.querySelector<HTMLButtonElement>('[data-oauth-app-switch-action="authorize"]');
      if (authorizeButton) authorizeButton.disabled = additionalScopes !== reviewedAdditionalScopes || !context || context.expires_at <= now() || !permissionsReviewed();
      return;
    }
    if (!node?.hasAttribute('data-oauth-app-switch-choice') || !owns(node) || deps.bulk || busy || attempt || review || deps.locked?.()) return;
    appId = context?.apps.some(a => a.id === node.value && a.id !== context?.current_app.id) ? node.value : ''; error = ''; render();
    focus('[data-oauth-app-switch-choice]');
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', change); deps.host.addEventListener('input', change);
  return { open: openPanel, reauthorize: (platform: AuthenticationCollectionPlatform, slug: string) => openPanel(platform, slug, '', undefined, 'reauthorize'), close, render, busy: () => busy, apply, refreshStatus,
    snapshot: () => ({ context, review, outcome, attempt, busy, error }),
    context(platform: string, slug: string | null) { if (selected && (selected.platform !== platform || selected.slug !== slug)) close(); },
    dispose() { close(); disposed = true; deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', change); deps.host.removeEventListener('input', change); },
  };
};
