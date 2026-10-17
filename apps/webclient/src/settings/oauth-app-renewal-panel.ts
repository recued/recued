import { isOAuthAppsResponse, isOAuthAppRenewalReview, isOAuthAppRenewalVerification,
  type OAuthAppRenewalReview, type OAuthAppRenewalVerification, type SavedOAuthApp } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import type { OAuthAppsCaller } from './oauth-apps-panel.js';
import { OAUTH_APP_RENEWAL_REASONS as reasons, oauthAppRenewalResultText, oauthAppRenewalCurrentText } from './oauth-app-renewal-summary.js';
import { oauthAppRenewalShortcuts, resolveOAuthAppRenewalShortcut } from './oauth-app-renewal-shortcuts.js';
import { connectionsVerifyAccessAddress } from '../connections/connections-navigation.js';
const storageKey = 'recued:oauth-app-renewal';
const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const createOAuthAppRenewalPanel = (deps: {
  host: HTMLElement; call: OAuthAppsCaller; now?(): number; id?(): string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  navigate?(hash: string): void; canNavigate?(): boolean;
}) => {
  let app: SavedOAuthApp | undefined; let review: OAuthAppRenewalReview | undefined; let result: OAuthAppRenewalVerification | undefined;
  let selected = new Set<string>(); let lookup: string | undefined; let visible = false; let busy = false; let error = ''; let generation = 0; let disposed = false;
  let pending = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | undefined; let returnFocus: (() => void) | undefined;
  let openingShortcut = false;
  const now = deps.now ?? Date.now;
  const storage = () => { try { return deps.storage ?? deps.host.ownerDocument?.defaultView?.sessionStorage; } catch { return undefined; } };
  const remember = () => { try { if (lookup) storage()?.setItem(storageKey, lookup); else storage()?.removeItem(storageKey); } catch { /* Mounted status recovery remains available. */ } };
  const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const retire = (id = review?.id) => { if (id) { try { void deps.call({ action: 'renewal_retire', review_id: id }).catch(() => {}); } catch { /* Closing is local. */ } } if (review?.id === id) review = undefined; };
  const button = (action: string, label: string, disabled = false) => '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-app-renewal-action="' + action + '"'
    + (disabled || busy && action !== 'close' ? ' disabled' : '') + '>' + e(label) + '</button>';
  const summary = (v: OAuthAppRenewalVerification) => '<div data-app-renewal-result="' + e(v.id) + '"><h4>' + (v.status === 'checking' ? 'Renewal checks are running in the background' : 'Saved renewal results') + '</h4>'
    + '<p>' + e(v.app_label) + ' · ' + (v.status === 'checking' ? 'Started ' : 'Finished ') + e(new Date(v.finished_at ?? v.started_at).toLocaleString()) + '</p><ul>'
    + v.results.map(r => '<li><strong>' + e(r.label) + '</strong><p>' + e(oauthAppRenewalResultText(r)) + '</p>'
      + (oauthAppRenewalCurrentText(r) ? '<p>' + e(oauthAppRenewalCurrentText(r)) + '</p>' : '')
      + (deps.navigate ? oauthAppRenewalShortcuts(v, r).map((a, i) => button('shortcut:' + r.id + ':' + i, a.label)).join('') : '')
      + '</li>').join('') + '</ul>' + (v.incomplete ? '<p>Some local authorizations could not be listed. These results cover only the listed checks.</p>' : '')
    + (deps.navigate && v.status === 'completed' ? '<p>Repair shortcuts open a fresh review. Consent and changes still need your approval. After repairing, review and run new renewal checks.</p>'
      + button('verify-again', 'Review token renewal again') + button('verify-access', 'Verify access')
      + '<p>Verify access opens a separate review of the current saved accounts and resources. Only Run checks starts those reads.</p>' : '') + '</div>';
  const render = () => {
    const host = deps.host.querySelector<HTMLElement>('[data-oauth-app-renewal-host]'); if (!host || disposed) return;
    const active = deps.host.ownerDocument?.activeElement; const within = active && host.contains?.(active);
    const focus = within ? active.getAttribute('data-app-renewal-action') : null; const grantFocus = within ? active.getAttribute('data-app-renewal-grant') : null;
    if (!visible) { host.innerHTML = ''; return; }
    host.innerHTML = '<section class="oauth-app-renewal" aria-label="Verify token renewal"><h3 tabindex="-1" data-app-renewal-heading>Verify token renewal</h3>'
      + (app ? '<p><strong>' + e(app.label) + '</strong> · ' + (app.issuer === 'google' ? 'Google' : 'Microsoft') + '</p>' : '')
      + '<p>This check asks the vendor for a new token using the saved app secret and each selected authorization. A cached access token cannot pass it.</p>'
      + '<p>New tokens are saved for normal use. No new permissions are requested. Mail, Calendar, files and workflows are not read or run by this check.</p>'
      + (busy ? '<p role="status">' + (openingShortcut ? 'Comparing current authentication before opening the review…' : lookup ? 'Reading the saved renewal result…' : 'Preparing the local renewal review…') + '</p>' : '')
      + (error ? '<p role="alert">' + e(error) + '</p>' : '')
      + (result ? summary(result) : '')
      + (review ? '<h4>Authorizations to check</h4><p>Copies sharing one authorization stay together. All eligible authorizations are selected by default.</p><ul>'
        + review.grants.map(g => '<li><label><input type="checkbox" data-app-renewal-grant="' + e(g.id) + '"' + (selected.has(g.id) ? ' checked' : '') + (busy || !g.eligible ? ' disabled' : '') + '> <strong>' + e(g.label) + '</strong></label>'
          + '<p>' + e([...g.connections.map(n => 'API: ' + n), ...g.native_accounts.map(n => n.platform + ': ' + n.slug)].join(', ')) + '</p>'
          + (g.reason ? '<p>' + e(reasons[g.reason]) + '</p>' : '') + '</li>').join('') + '</ul>'
        + (!review.grants.length ? '<p>No saved authorizations were found for this app. Connect an account before checking renewal.</p>' : '')
        + (review.incomplete ? '<p>Some API credentials could not be read or the list is too large. Unlock Recued or check the other uses separately. This check covers only this list.</p>' : '')
        + button('run', 'Run renewal checks', !selected.size || review.expires_at <= now() || !!lookup) : '')
      + (lookup ? button('status', 'Refresh renewal status') : app ? button('review', review ? 'Review again' : 'Review new checks') : '')
      + '<p>A passed renewal does not prove vendor data access, sending, editing, sync or incident recovery. Verify access separately for the resources you use.</p>'
      + button('close', 'Close renewal check') + '</section>';
    if (focus) host.querySelector<HTMLElement>('[data-app-renewal-action="' + focus + '"]')?.focus({ preventScroll: true });
    else if (grantFocus) host.querySelector<HTMLElement>('[data-app-renewal-grant="' + grantFocus + '"]')?.focus({ preventScroll: true });
  };
  const schedule = () => { stop(); if (visible && !disposed && result?.status === 'checking') timer = setTimeout(() => { pending = status(); }, 1500); };
  const accept = (v: OAuthAppRenewalVerification) => {
    result = structuredClone(v);
    lookup = v.status === 'checking' ? v.id : undefined; remember();
  };
  const status = async () => {
    if (!lookup || busy || disposed) return; stop(); const gen = generation; const requested = lookup; busy = true; error = ''; render();
    try {
      const reply = await deps.call(requested.startsWith('renewal-') ? { action: 'renewal_status', id: requested } : { action: 'renewal_status', attempt_id: requested });
      if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(reply) || reply.action !== 'renewal_status' || reply.renewal_verification !== null && !isOAuthAppRenewalVerification(reply.renewal_verification)) throw Error('Invalid renewal receipt');
      if (reply.renewal_verification) {
        const v = reply.renewal_verification;
        if (requested.startsWith('renewal-') && v.id !== requested || app && (v.issuer !== app.issuer || v.app_id !== app.id)) throw Error('Wrong renewal receipt');
        app = reply.apps.find(a => a.issuer === v.issuer && a.id === v.app_id); accept(v);
      } else { lookup = undefined; remember(); error = 'No reserved check was found. Review a new check; no renewal was replayed.'; }
    } catch { if (!disposed && gen === generation) error = 'The saved renewal result could not be read. Refresh its status before starting another check.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); if (!error) schedule(); } }
  };
  const open = (selectedApp: SavedOAuthApp, onClose?: () => void): Promise<void> => {
    if (disposed || busy) return pending;
    if (lookup) { visible = true; returnFocus = onClose ?? returnFocus; pending = status(); return pending; }
    stop(); retire(); const gen = ++generation; visible = true; app = selectedApp; returnFocus = onClose; result = undefined; selected.clear(); error = ''; busy = true; openingShortcut = false;
    const focus = deps.host.ownerDocument?.activeElement; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'renewal_preview', issuer: selectedApp.issuer, id: selectedApp.id, expected_revision: selectedApp.revision });
        if (disposed || gen !== generation || !visible) { if (isOAuthAppRenewalReview(reply.renewal_review)) retire(reply.renewal_review.id); return; }
        if (!isOAuthAppsResponse(reply) || reply.action !== 'renewal_preview' || !isOAuthAppRenewalReview(reply.renewal_review)
          || reply.renewal_review.app.issuer !== selectedApp.issuer || reply.renewal_review.app.id !== selectedApp.id || reply.renewal_review.app.revision !== selectedApp.revision || reply.renewal_review.expires_at <= now()) throw Error('Invalid renewal review');
        review = structuredClone(reply.renewal_review); selected = new Set(review.grants.filter(g => g.eligible).map(g => g.id)); result = review.latest;
        if (result?.status === 'checking') { accept(result); retire(); }
      } catch { if (!disposed && gen === generation) error = 'Renewal could not be prepared. Unlock Recued, refresh the saved apps or update the server, then review again.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); schedule(); if (deps.host.ownerDocument?.activeElement === focus) deps.host.querySelector<HTMLElement>('[data-app-renewal-heading]')?.focus({ preventScroll: true }); } }
    })(); return pending;
  };
  const run = async () => {
    if (!review || busy || lookup || !selected.size || review.expires_at <= now()) return;
    const plan = review; const ids = [...selected].sort(); const gen = generation; lookup = (deps.id ?? nonce)(); remember(); busy = true; error = ''; render();
    try {
      const reply = await deps.call({ action: 'renewal_run', review_id: plan.id, fingerprint: plan.fingerprint, attempt_id: lookup, selected_ids: ids });
      if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(reply) || reply.action !== 'renewal_run' || !isOAuthAppRenewalVerification(reply.renewal_verification)
        || reply.renewal_verification.issuer !== plan.app.issuer || reply.renewal_verification.app_id !== plan.app.id || reply.renewal_verification.app_revision !== plan.app.revision) throw Error('Invalid renewal result');
      accept(reply.renewal_verification); retire();
    } catch { if (!disposed && gen === generation) error = 'The start reply was not received. Refresh renewal status to read any saved result before trying again.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); if (!error) schedule(); } }
  };
  const shortcut = async (selection: { grantId: string; index: number } | 'verify') => {
    if (!result || busy || !deps.navigate) return;
    if (deps.canNavigate?.() === false) { error = 'Save or cancel the other app review before opening this repair.'; render(); return; }
    const doc = deps.host.ownerDocument; const focusAction = doc?.activeElement?.getAttribute('data-app-renewal-action');
    const gen = generation; const saved = result; busy = true; openingShortcut = true; error = ''; render();
    try {
      const href = await resolveOAuthAppRenewalShortcut(deps.call, saved, selection);
      if (disposed || gen !== generation || !visible) return;
      if (deps.canNavigate?.() === false) throw Error('Save or cancel the other app review before opening this repair.');
      stop(); retire(); visible = false; busy = false; openingShortcut = false; render(); deps.navigate(href);
    } catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'This repair review could not be opened. Refresh the result and try again.'; }
    finally { if (!disposed && gen === generation) {
      const restore = visible && focusAction && (doc?.activeElement === doc?.body || !doc?.activeElement?.isConnected);
      busy = false; openingShortcut = false; render();
      if (restore) deps.host.querySelector<HTMLElement>('[data-app-renewal-action="' + focusAction + '"]')?.focus({ preventScroll: true });
    } }
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-app-renewal-action]');
    if (!target || !deps.host.contains(target) || target.hasAttribute('disabled')) return;
    const action = target.dataset.appRenewalAction; event.preventDefault();
    if (action === 'close') { stop(); generation++; visible = false; busy = false; openingShortcut = false; retire(); render(); returnFocus?.(); }
    else if (!busy && action === 'status') pending = status();
    else if (!busy && action === 'review' && app && !lookup) pending = open(app, returnFocus);
    else if (!busy && action === 'run') pending = run();
    else if (!busy && action === 'verify-again') pending = shortcut('verify');
    else if (!busy && action === 'verify-access' && result?.status === 'completed' && deps.navigate) {
      if (deps.canNavigate?.() === false) { error = 'Save or cancel the other app review before opening Verify access.'; render(); return; }
      const href = connectionsVerifyAccessAddress({ kind: 'renewal', id: result.id }).hash;
      stop(); retire(); visible = false; render(); deps.navigate(href);
    }
    else if (!busy && action?.startsWith('shortcut:')) {
      const match = /^shortcut:([a-f0-9]{64}):(\d{1,3})$/.exec(action);
      if (match) pending = shortcut({ grantId: match[1]!, index: Number(match[2]) });
    }
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement | null; const id = target?.dataset.appRenewalGrant;
    if (!target || !id || !deps.host.contains(target) || busy || lookup || !review?.grants.some(g => g.id === id && g.eligible)) return;
    if (target.checked) selected.add(id); else selected.delete(id); render();
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', change);
  try { const saved = storage()?.getItem(storageKey); if (saved && (/^[A-Za-z0-9_-]{43}$/.test(saved) || /^renewal-[a-f0-9-]{36}$/.test(saved))) lookup = saved; } catch { /* Storage is optional. */ }
  if (lookup) { visible = true; pending = Promise.resolve().then(status); }
  return { open, render, whenLoaded: () => pending, busy: () => busy, hasDraft: () => !!review || !!lookup && result?.status !== 'checking',
    canOpen: (selectedApp: SavedOAuthApp) => !lookup || app?.issuer === selectedApp.issuer && app.id === selectedApp.id,
    dispose() { disposed = true; generation++; stop(); retire(); deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', change); },
  };
};
