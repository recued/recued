/** D-322 §44 — saved cleanup tasks outlive this view and every consent popup. */
import { GOOGLE_AUTHORIZE_URL, buildOpenerRelayRedirectUri, isOAuthAppsResponse,
  isOAuthPermissionCleanupJob, isOAuthPermissionCleanupAuthorization, type OAuthPermissionCleanupJob,
  type OAuthPermissionCleanupRequest, type OAuthPermissionCleanupPreview, type OAuthPermissionInventory } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import { defaultFoundationalOAuthEnv, openOAuthPopup, runOAuthPopup,
  type FoundationalOAuthEnv, type FoundationalOAuthPopupHandle } from '../connections/foundational-oauth-popup.js';
import { scopeListItem } from './oauth-permission-scope-view.js';
import type { OAuthAppsCaller } from './oauth-apps-panel.js';

const finished = (job: OAuthPermissionCleanupJob) => ['applied', 'restored', 'cancelled'].includes(job.status);
const labels: Record<OAuthPermissionCleanupJob['status'], string> = { prepared: 'Review affected accounts', stopping: 'Finish pausing accounts',
  awaiting_reset: 'Remove Google app access', awaiting_reconnect: 'Reconnect and verify', ready_to_apply: 'Review verified sign-in',
  applied: 'Reduced sign-in saved', restored: 'Access restored without cleanup', cancelled: 'Cleanup cancelled' };
export type OAuthPermissionCleanupPopupFactory = () => { env: FoundationalOAuthEnv; openPopup(): FoundationalOAuthPopupHandle | null };
export const createOAuthPermissionCleanupPanel = (deps: {
  host: HTMLElement; call: OAuthAppsCaller; prepared?(): void; changed?(): void; stateChanged?(): void; now?(): number;
  oauth?: OAuthPermissionCleanupPopupFactory;
}) => {
  let jobs: OAuthPermissionCleanupJob[] = []; let job: OAuthPermissionCleanupJob | undefined;
  let available = false; let busy = false; let disposed = false; let generation = 0; let error = '';
  let pauseAcknowledged = false; let resetAcknowledged = false; let abort: AbortController | undefined;
  const apiUrls = new Map<string, string>();
  let pending = Promise.resolve(); const now = deps.now ?? Date.now;
  const slot = () => deps.host.querySelector<HTMLElement>('[data-oauth-permission-cleanup-host]');
  const button = (action: string, label: string, disabled = false, id = '') => '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-cleanup-action="'
    + action + '"' + (id ? ' data-cleanup-id="' + e(id) + '"' : '') + (disabled ? ' disabled' : '') + '>' + e(label) + '</button>';
  const accept = (value: unknown, id?: string) => {
    if (!isOAuthPermissionCleanupJob(value) || id && value.id !== id) throw Error('The saved cleanup could not be confirmed. Refresh its status.');
    if (job?.id !== value.id) { pauseAcknowledged = false; apiUrls.clear(); }
    for (const target of value.targets) if (target.platform === 'api') apiUrls.set(target.slug, target.verification_url);
    job = value; jobs = [value, ...jobs.filter(j => j.id !== value.id)]; resetAcknowledged = value.reset_confirmation === 'owner_confirmed';
  };
  const jobHtml = (value: OAuthPermissionCleanupJob) => {
    const active = !finished(value); const expired = value.review_expires_at !== undefined && value.review_expires_at <= now();
    return '<section data-permission-cleanup-task aria-label="Guided permission cleanup"><h4 tabindex="-1" data-cleanup-task-heading>' + e(labels[value.status]) + '</h4>'
      + '<p><strong>' + e(value.app.label) + '</strong> · ' + e(value.targets[0]?.account.email ?? 'Unknown account') + '</p>'
      + '<p>These accounts and connections keep their names, bindings and saved data:</p><ul>' + value.targets.map(t => '<li>'
        + e(t.platform === 'api' ? 'API: ' + t.display_name + ' (' + t.slug + ')' : t.platform + ': ' + t.slug)
        + (t.platform === 'api' ? '<br>Access check: ' + e(t.verification_url) : '') + '</li>').join('') + '</ul>'
      + (active && value.status !== 'prepared' && value.targets.some(t => t.platform === 'api')
        ? '<details><summary>Change API access checks</summary><p>If a test file moved or was deleted, choose another protected read URL. Use Refresh cleanup review to save these URLs and clear the old sign-in checks.</p>'
          + value.targets.filter(t => t.platform === 'api').map(t => '<label class="oauth-cleanup-api-field">Protected read URL for ' + e(t.slug)
            + '<input type="url" data-cleanup-api-url="' + e(t.slug) + '" value="' + e(apiUrls.get(t.slug) ?? t.verification_url)
            + '"' + (busy ? ' disabled' : '') + '></label>').join('') + '</details>' : '')
      + (active ? '<p>Accounts verified: ' + (value.verified_targets?.length ?? 0) + ' of ' + value.targets.length
        + '. Separate grants keep separate sign-ins. Verify each affected sign-in before saving them together.</p>' : '')
      + '<details><summary>' + (value.mode === 'restore' ? 'Permissions to restore' : 'Permissions to keep') + '</summary><ul>' + value.requested_scopes.map(scopeListItem).join('') + '</ul></details>'
      + '<details><summary>Permissions chosen for cleanup</summary><ul>' + value.selected_scopes.map(scopeListItem).join('') + '</ul></details>'
      + (value.mode === 'restore' ? '<p>Cleanup is stopped. Reconnect the same account with its retained permissions to restore access.</p>' : '')
      + (value.status === 'prepared' ? '<p>Google app access may be shared by Mail, Calendar, API connections and other tools. This flow pauses the listed accounts and connections first. Packs and recipes using them cannot access Google until recovery finishes. You will remove app access yourself on Google, then reconnect.</p>'
        + '<label><input type="checkbox" data-cleanup-confirm="pause"' + (pauseAcknowledged ? ' checked' : '') + (busy ? ' disabled' : '') + '> I reviewed the affected accounts and understand that their access will pause.</label>'
        + button('pause', 'Pause accounts and continue', busy || !pauseAcknowledged) + button('cancel', 'Cancel cleanup', busy) : '')
      + (value.status === 'stopping' ? '<p>Account access is paused. Finish stopping their running adapters before reconnecting.</p>' + button('pause', 'Retry pausing accounts', busy) : '')
      + (['awaiting_reset', 'awaiting_reconnect'].includes(value.status) ? (value.mode === 'cleanup' && value.reset_confirmation !== 'owner_confirmed' ? '<p>On Google, choose this app for this account and remove its access. This can also disconnect other tools that use the same Google project.</p>'
        + '<p><a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Open Google account access</a></p>'
        + '<p>Recued cannot inspect that page. Your confirmation records this step; Recued then checks fresh sign-ins, their reported permissions and protected access to the saved collections and API resources.</p>'
        + '<label><input type="checkbox" data-cleanup-confirm="reset"' + (resetAcknowledged ? ' checked' : '') + (busy ? ' disabled' : '') + '> I removed this app’s access for the Google account shown above.</label>'
        : value.mode === 'cleanup' ? '<p>Your Google reset confirmation is saved. Continue the remaining sign-ins. Keep the app access in place between them.</p>' : '')
        + button('authorize', 'Reconnect and verify Google account', busy || value.mode === 'cleanup' && !resetAcknowledged) : '')
      + (value.status === 'ready_to_apply' ? '<p>The fresh sign-in matches the saved account and passed its permission and read checks. It has not been saved yet.</p>'
        + '<details><summary>Reported Google permissions</summary><ul>' + (value.granted_scopes ?? []).map(scopeListItem).join('') + '</ul></details>'
        + (expired ? '<p role="alert">This sign-in review expired. Reconnect and verify again before saving.</p>' + button('authorize', 'Reconnect and verify again', busy)
          : button('apply', value.mode === 'restore' ? 'Save restored access' : 'Save reduced sign-in', busy)) : '')
      + (value.status === 'applied' ? '<p role="status">The reduced sign-in was saved. Future reconnects use its new permission baseline. Earlier scope records remain in the server’s cleanup history.</p>'
        + '<p>Google app access removal was confirmed by you. Recued verified the fresh grants and protected access checks.</p>' : '')
      + (value.status === 'restored' ? '<p role="status">The same account was reconnected with retained permissions. This does not claim that permissions were removed.</p>' : '')
      + (value.restart_needed?.length ? '<p role="alert">Some accounts still need to restart: ' + e(value.restart_needed.map(t => t.platform + ': ' + t.slug).join(', ')) + '.</p>' + button('retry-restart', 'Retry account restart', busy) : '')
      + (value.last_error ? '<p role="alert">' + e(value.last_error) + '</p>' : '')
      + (active && value.status !== 'prepared' ? button('refresh-review', 'Refresh cleanup review', busy)
        + (value.mode === 'cleanup' && value.reset_confirmation === 'owner_confirmed' ? button('reset-again', 'Repeat Google access reset', busy) : '')
        + (value.mode === 'cleanup' ? button('restore', 'Stop cleanup and restore access', busy) : '') : '')
      + button('status', 'Refresh saved status', busy) + button('worklist', 'Back to cleanup worklist', busy) + '</section>';
  };
  const render = () => {
    if (disposed || !available) return; const host = slot(); if (!host) return;
    host.innerHTML = '<section class="oauth-cleanup-worklist" aria-label="Saved permission cleanups"><h4>Saved permission cleanups</h4>'
      + '<p>Paused cleanups stay on this server. Return here to finish, even after closing the browser.</p>'
      + (jobs.length ? '<ul>' + jobs.map(j => '<li>' + e(j.app.label + ' · ' + (j.targets[0]?.account.email ?? 'Unknown account') + ' · ' + labels[j.status])
        + button('resume', finished(j) ? 'View cleanup result' : 'Resume cleanup', busy, j.id) + '</li>').join('') + '</ul>' : '<p>No saved cleanup tasks.</p>')
      + (busy ? '<p role="status">' + (abort ? 'Complete the Google sign-in, then return here…' : 'Checking the saved cleanup…') + '</p>' : '')
      + (job ? jobHtml(job) : '') + (error ? '<p role="alert">' + e(error) + '</p>' : '') + '</section>';
  };
  const reconcile = async (id: string, gen: number) => {
    try {
      const status = await deps.call({ action: 'permission_cleanup_status', id });
      if (!disposed && gen === generation && isOAuthAppsResponse(status) && status.action === 'permission_cleanup_status') {
        accept(status.permission_cleanup_job, id);
        if (job && ['applied', 'restored'].includes(job.status)) { error = ''; deps.changed?.(); }
      }
    } catch { /* A lost status reply leaves the durable task available on reopen. */ }
  };
  const run = (request: OAuthPermissionCleanupRequest, prepared = false): Promise<void> => {
    if (busy || disposed) return pending; const gen = generation; busy = true; error = ''; deps.stateChanged?.(); render();
    pending = (async () => {
      try {
        const result = await deps.call(request); if (disposed || gen !== generation) return;
        if (!isOAuthAppsResponse(result) || result.action !== request.action) throw Error('The cleanup reply could not be confirmed. Refresh its saved status.');
        accept(result.permission_cleanup_job, 'id' in request ? request.id : undefined);
        if (prepared) { pauseAcknowledged = false; deps.prepared?.(); }
        if (job && ['applied', 'restored'].includes(job.status)) deps.changed?.();
      } catch (err) {
        if (disposed || gen !== generation) return;
        error = err instanceof Error ? err.message : 'The cleanup step did not finish. Refresh its saved status.';
        if ('id' in request && request.id) await reconcile(request.id, gen);
      } finally { if (!disposed && gen === generation) { busy = false; deps.stateChanged?.(); render(); slot()?.querySelector<HTMLElement>('[data-cleanup-task-heading]')?.focus(); } }
    })(); return pending;
  };
  const authorize = async () => {
    if (!job || busy || disposed || job.mode === 'cleanup' && !resetAcknowledged) return;
    const source = job; const oauth = deps.oauth?.() ?? { env: defaultFoundationalOAuthEnv(), openPopup: () => openOAuthPopup() };
    const popup = oauth.openPopup(); if (!popup) { error = 'Allow popups for Recued, then try again.'; render(); return; }
    const redirect = buildOpenerRelayRedirectUri(oauth.env.origin); const gen = generation; abort = new AbortController(); busy = true; error = ''; deps.stateChanged?.(); render();
    let authorizationId = '';
    try {
      const result = await runOAuthPopup(oauth.env, { popup, expectedSenderOrigin: new URL(redirect).origin, signal: abort.signal,
        buildAuthorizeUrl: async state => {
          const response = await deps.call({ action: 'authorize_permission_cleanup', id: source.id, expected_revision: source.revision, reset_confirmed: resetAcknowledged });
          if (disposed || gen !== generation) throw Error('Sign-in was closed. Resume the saved cleanup to continue.');
          if (!isOAuthAppsResponse(response) || response.action !== 'authorize_permission_cleanup' || !isOAuthPermissionCleanupAuthorization(response.permission_cleanup_authorization)) throw Error('The Google sign-in could not be prepared. Refresh saved status.');
          accept(response.permission_cleanup_job, source.id); const auth = response.permission_cleanup_authorization;
          if (auth.job_id !== source.id || auth.revision !== job!.revision || auth.app.client_id !== source.app.client_id || auth.app.id !== source.app.id
            || !job!.targets.some(target => target.platform === auth.target.platform && target.slug === auth.target.slug && target.provider === auth.target.provider)
            || auth.expires_at <= now() || JSON.stringify(auth.requested_scopes) !== JSON.stringify(job!.requested_scopes)) throw Error('The app or permissions changed. Refresh the cleanup review.');
          authorizationId = auth.id; const url = new URL(GOOGLE_AUTHORIZE_URL);
          for (const [key, value] of Object.entries({ response_type: 'code', client_id: auth.app.client_id, redirect_uri: redirect, state,
            scope: auth.requested_scopes.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
            login_hint: source.targets[0]?.account.email ?? '' })) url.searchParams.set(key, value);
          return url.toString();
        } });
      if (disposed || gen !== generation) return;
      if (!result.ok || !authorizationId || !job) throw Error('The sign-in did not finish. Resume this cleanup and try again. The accounts remain paused.');
      const response = await deps.call({ action: 'review_permission_cleanup', id: source.id, expected_revision: job.revision,
        authorization_id: authorizationId, code: result.code, redirect_uri: redirect });
      if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(response) || response.action !== 'review_permission_cleanup') throw Error('The fresh sign-in could not be confirmed. Refresh saved status.');
      accept(response.permission_cleanup_job, source.id);
    } catch (err) { if (!disposed && gen === generation) {
      error = err instanceof Error ? err.message : 'The Google sign-in could not be verified. Refresh saved status.'; await reconcile(source.id, gen);
    } }
    finally { if (!disposed && gen === generation) { busy = false; abort = undefined; deps.stateChanged?.(); render(); slot()?.querySelector<HTMLElement>('[data-cleanup-task-heading]')?.focus(); } }
  };
  const click = (event: Event) => {
    const node = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-cleanup-action]');
    if (!node || !deps.host.contains(node) || node.hasAttribute('disabled') || busy || disposed) return;
    event.preventDefault(); const action = node.dataset.cleanupAction;
    if (action === 'resume' && node.dataset.cleanupId) { pending = run({ action: 'permission_cleanup_status', id: node.dataset.cleanupId }); return; }
    if (action === 'worklist') { job = undefined; error = ''; render(); return; }
    if (!job) return;
    if (['authorize', 'apply'].includes(action ?? '') && job.targets.some(t => t.platform === 'api' && apiUrls.get(t.slug) !== t.verification_url)) {
      error = 'Use Refresh cleanup review to save the changed API access checks before reconnecting or saving.'; render(); return;
    }
    const revision = { id: job.id, expected_revision: job.revision };
    if (action === 'pause' && (pauseAcknowledged || job.status === 'stopping')) pending = run({ action: 'pause_permission_cleanup', ...revision, confirm_shared_access: true });
    else if (action === 'authorize') pending = authorize();
    else if (action === 'apply') pending = run({ action: 'apply_permission_cleanup', ...revision });
    else if (action === 'restore') pending = run({ action: 'restore_permission_cleanup', ...revision });
    else if (action === 'refresh-review') pending = run({ action: 'refresh_permission_cleanup', ...revision,
      ...(job.targets.some(t => t.platform === 'api') ? { api_verification_urls: job.targets.filter(t => t.platform === 'api')
        .map(t => ({ name: t.slug, url: apiUrls.get(t.slug) ?? t.verification_url })) } : {}) });
    else if (action === 'reset-again') pending = run({ action: 'reset_permission_cleanup', ...revision });
    else if (action === 'cancel') pending = run({ action: 'cancel_permission_cleanup', ...revision });
    else if (action === 'retry-restart') pending = run({ action: 'restart_permission_cleanup', ...revision });
    else if (action === 'status') pending = run({ action: 'permission_cleanup_status', id: job.id });
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input || !deps.host.contains(input) || busy) return;
    if (input.dataset.cleanupApiUrl) { apiUrls.set(input.dataset.cleanupApiUrl, input.value); return; }
    if (input.dataset.cleanupConfirm === 'pause') pauseAcknowledged = input.checked;
    else if (input.dataset.cleanupConfirm === 'reset') resetAcknowledged = input.checked; else return;
    const focused = deps.host.ownerDocument?.activeElement === input; const name = input.dataset.cleanupConfirm; render();
    if (focused) slot()?.querySelector<HTMLInputElement>('[data-cleanup-confirm="' + name + '"]')?.focus();
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', change);
  return { render, busy: () => busy, whenLoaded: () => pending,
    receive(values: readonly OAuthPermissionCleanupJob[], supported: boolean) {
      available = supported; jobs = [...values]; if (job) job = jobs.find(j => j.id === job!.id); render();
    },
    prepare(preview: OAuthPermissionCleanupPreview, filter?: OAuthPermissionInventory['filter'], apiUrls?: readonly { name: string; url: string }[]) {
      return run({ action: 'prepare_permission_cleanup', inventory_fingerprint: preview.inventory_fingerprint, group_id: preview.group_id,
        selected_scopes: preview.selected_scopes, ...(filter ? { filter } : {}), ...(apiUrls?.length ? { api_verification_urls: apiUrls } : {}) }, true);
    },
    hide() { generation++; abort?.abort(); abort = undefined; busy = false; job = undefined; error = ''; pauseAcknowledged = false; resetAcknowledged = false; apiUrls.clear(); pending = Promise.resolve(); },
    dispose() { disposed = true; generation++; abort?.abort(); deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', change); },
  };
};
