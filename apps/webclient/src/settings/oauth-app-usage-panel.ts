import { isOAuthAppsResponse, isOAuthAppUsageReview, isOAuthAppSecretRotationOutcome, isOAuthAppSecretExpiryDate,
  type OAuthAppUsageReview, type OAuthAppSecretRotationOutcome, type SavedOAuthApp } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import type { OAuthAppsCaller } from './oauth-apps-panel.js';
const storageKey = 'recued:oauth-app-secret-rotation';
const nonce = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const createOAuthAppUsagePanel = (deps: {
  host: HTMLElement; call: OAuthAppsCaller; changed(): void; now?(): number; id?(): string;
  verifyRenewal?(app: SavedOAuthApp): void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) => {
  let review: OAuthAppUsageReview | undefined; let app: SavedOAuthApp | undefined;
  let chosen = new Set<string>(); let secret = ''; let confirming = false; let busy = false; let disposed = false; let generation = 0;
  let expiryDate = ''; let expiryInvalid = false; let supportsExpiry = false;
  let requestedExpiry: string | null | undefined; let expiryUnconfirmed = false;
  let attempt: string | undefined; let outcome: OAuthAppSecretRotationOutcome | undefined; let error = ''; let pending = Promise.resolve();
  let renewalApp: SavedOAuthApp | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined; let polls = 0; let visible = true;
  const now = deps.now ?? Date.now;
  const storage = () => { try { return deps.storage ?? deps.host.ownerDocument?.defaultView?.sessionStorage; } catch { return undefined; } };
  const remember = () => { try { if (attempt) storage()?.setItem(storageKey, attempt); else storage()?.removeItem(storageKey); } catch { /* Mounted recovery still works. */ } };
  const retire = () => { const id = review?.id; review = undefined; if (id) void deps.call({ action: 'retire_usage', id }).catch(() => {}); };
  const clearPoll = () => { if (poll !== undefined) clearTimeout(poll); poll = undefined; };
  const button = (action: string, label: string, disabled = false) => '<button type="button" class="rx-btn rx-btn-sm '
    + (action === 'apply' ? 'rx-btn-primary' : 'rx-btn-outline') + '" data-app-usage-action="' + action + '"' + (busy || disabled ? ' disabled' : '') + '>' + e(label) + '</button>';
  const render = () => {
    const host = deps.host.querySelector?.<HTMLElement>('[data-oauth-app-usage-host]'); if (!host || disposed) return;
    if (!visible || !app && !attempt && !outcome) { host.innerHTML = ''; return; }
    host.innerHTML = '<section class="oauth-app-usage" aria-label="Saved app usage and secret rotation"><h3 tabindex="-1" data-app-usage-heading>Usage and rotate secret</h3>'
      + (app ? '<p><strong>' + e(app.label) + '</strong> · ' + e(app.issuer === 'google' ? 'Google' : 'Microsoft') + '<br>Client ID: <code>' + e(app.client_id) + '</code></p>' : '')
      + (busy ? '<p role="status">' + (attempt ? 'Saving or checking the rotation result…' : 'Reading local app usage…') + '</p>' : '')
      + (review ? '<h4>Mail and Calendar using this app</h4>'
        + (supportsExpiry ? '<p>Current recorded secret expiry: ' + e(review.app.secret_expires_on ?? 'not recorded') + '. This date is not checked with the vendor.</p>' : '')
        + (review.native_accounts.length ? '<ul>' + review.native_accounts.map(a => '<li>' + e(a.platform + ' ' + a.slug) + '</li>').join('') + '</ul><p>These accounts read this app’s secret when renewing access. They pick up the new secret automatically.</p>' : '<p>No native Mail or Calendar account uses this saved app.</p>')
        + '<h4>API credential copies</h4><p>Confirmed copies are selected by default. You can exclude them. Connections sharing one authorization must stay together.</p>'
        + (review.connections.length ? '<ul>' + review.connections.map(c => '<li><label><input type="checkbox" data-app-usage-copy="' + e(c.name) + '"'
          + (chosen.has(c.name) ? ' checked' : '') + (busy || confirming || !c.group_complete ? ' disabled' : '') + '> <strong>' + e(c.display_name) + '</strong> <code>' + e(c.name) + '</code></label>'
          + '<p>' + (c.origin === 'confirmed' ? 'Confirmed copy from this saved app.' : 'Same Client ID; saved app origin unknown.')
          + (c.secret_matches ? ' Its secret matches this app.' : ' Its secret differs or could not be compared.')
          + (!c.client_id_matches ? ' Its Client ID differs from the saved app. Reconnect it before using this app’s secret.' : '')
          + (!c.group_complete ? ' Its shared authorization cannot be rotated in this review.' : '') + '</p>'
          + (c.uses.length ? '<details><summary>' + e(String(c.uses.length)) + ' local uses</summary><ul>' + c.uses.slice(0, 25).map(u => '<li>' + e(u.kind + ': ' + u.label) + (u.may_use ? ' (may use)' : '') + (u.paused ? ' (paused)' : '') + '</li>').join('') + '</ul>'
            + (c.uses.length > 25 ? '<p>' + e(String(c.uses.length - 25)) + ' more local uses.</p>' : '') + '</details>' : '<p>' + (c.usage_available ? 'No downstream use was found.' : 'Downstream usage is unknown.') + '</p>') + '</li>').join('') + '</ul>' : '<p>No matching API credential copies were found.</p>')
        + (review.unreadable_connections.length ? '<p>Unreadable API credentials: ' + e(review.unreadable_connections.join(', ')) + '</p>' : '')
        + review.warnings.map(w => '<p role="note">' + e(w) + '</p>').join('')
        + '<p>This view covers this Recued server. Other tools can use the same vendor app.</p>'
        + '<p>Rotation keeps the same Client ID, accounts, permissions, connection names and sync state. It changes the local secret copies only.</p>'
        + '<label>New client secret <input type="password" data-app-usage-secret autocomplete="off" value="' + e(secret) + '"' + (busy || confirming || !review.can_rotate ? ' disabled' : '') + '></label>'
        + (supportsExpiry ? '<label>New secret expiry date (optional) <input type="date" data-app-usage-expiry value="' + e(expiryDate) + '" min="0001-01-01" max="9999-12-31"'
          + (busy || confirming || !review.can_rotate ? ' disabled' : '') + '></label>' + button('clear-expiry', 'Clear new expiry date', confirming || !review.can_rotate)
          + '<p>Record the new secret’s date from the vendor, if known. Leave blank when unknown. Rotation clears this app’s old date and reminder. Excluded copies can still use the old secret.</p>' : '')
        + (review.app.issuer === 'google'
          ? '<p>Reset the secret for this same Client ID in Google Cloud, then paste the new value here. A Google reset revokes the old secret at once. Update other tools using this app too; some accounts may need to sign in again.</p>'
          : '<p>Add a new secret for this same app in Microsoft Entra, then paste its Value here. Keep the old secret valid until access has renewed successfully.</p>')
        + '<p>No vendor renewal check runs during this save. A current access token can still work while a new secret is wrong.</p>'
        + (confirming ? '<div role="group" aria-label="Confirm secret rotation"><p>Update this saved app and ' + e(String(chosen.size)) + ' API credential copies: '
          + e([...chosen].join(', ') || 'none') + '.</p><p>Native accounts using the app: ' + e(String(review.native_accounts.length)) + '. Excluded copies keep their old secret and may need repair when it is revoked.</p>'
          + (supportsExpiry ? '<p>' + (expiryDate ? 'New recorded secret expiry: ' + e(expiryDate) + '.' : 'The new secret has no recorded expiry date. The old reminder will clear.') + '</p>' : '')
          + button('apply', 'Apply secret rotation', !review.can_rotate || !secret.trim() || review.expires_at <= now()) + button('back', 'Change selection') + '</div>'
          : button('review', 'Review rotation', !review.can_rotate || review.expires_at <= now())) + button('refresh', 'Refresh usage') : '')
      + (outcome ? '<p role="status">' + (outcome.status === 'applied' ? 'Secret rotation saved. Updated ' + e(String(outcome.selected_names.length)) + ' API copies. Native accounts keep using the saved app. Vendor renewal has not been checked.'
        : outcome.status === 'checking' ? 'The rotation is still being saved. Check its result before trying again.'
        : 'No secret changes from this attempt were saved. ' + (outcome.reason === 'changed' ? 'The app or local usage changed; start a fresh review.' : outcome.reason === 'locked' ? 'Unlock Recued, then start a fresh review.' : outcome.reason === 'interrupted' ? 'The server restarted before the update committed. Start a fresh review.' : 'The update could not be committed. Start a fresh review.')) + '</p>' : '')
      + (outcome?.status === 'applied' && expiryUnconfirmed ? '<p role="alert">The server did not confirm the requested expiry date. Refresh the saved app before recording its date. The secret rotation was saved; do not repeat it to repair the date.</p>'
        : outcome?.status === 'applied' && supportsExpiry ? '<p>' + (outcome.secret_expires_on ? 'Recorded expiry for the new secret: ' + e(outcome.secret_expires_on) + '.' : 'No expiry date is recorded for the new secret.') + '</p>' : '')
      + (outcome?.status === 'applied' && renewalApp && deps.verifyRenewal ? button('verify-renewal', 'Verify token renewal') : '')
      + (error ? '<p role="alert">' + e(error) + '</p>' : '')
      + (attempt ? button('status', 'Check rotation result') : '')
      + button('close', 'Close review') + '</section>';
  };
  const finish = (value: OAuthAppSecretRotationOutcome) => {
    outcome = value;
    if (value.status !== 'checking') {
      expiryUnconfirmed = value.status === 'applied' && requestedExpiry !== undefined
        && (!supportsExpiry || value.secret_expires_on !== (requestedExpiry ?? undefined));
      requestedExpiry = undefined;
      attempt = undefined; remember(); retire(); secret = ''; expiryDate = ''; expiryInvalid = false; confirming = false;
      if (value.status === 'applied') { try { deps.changed(); } catch { error = 'The rotation is saved. Refresh the app list to see the change.'; } }
    }
  };
  const check = async () => {
    if (!attempt || busy || disposed) return;
    const gen = generation; const id = attempt; busy = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'rotation_status', attempt_id: id }); if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(response) || response.action !== 'rotation_status'
        || response.rotation_outcome !== null && (!isOAuthAppSecretRotationOutcome(response.rotation_outcome) || response.rotation_outcome.attempt_id !== id
          || app && (response.rotation_outcome.issuer !== app.issuer || response.rotation_outcome.app_id !== app.id))) throw Error('Invalid result');
      supportsExpiry = response.secret_expiry_supported === true;
      if (response.rotation_outcome) {
        renewalApp = response.apps.find(a => a.issuer === response.rotation_outcome!.issuer && a.id === response.rotation_outcome!.app_id && a.revision === response.rotation_outcome!.app_revision);
        finish(response.rotation_outcome);
      }
      else { attempt = undefined; remember(); error = 'No saved result was found. Refresh the app list and start a fresh review.'; }
      if (outcome?.status === 'checking' && polls++ < 60) poll = setTimeout(() => { void check(); }, 2000);
    } catch { if (!disposed && gen === generation) error = 'The result could not be read. Check it again before trying another rotation.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); } }
  };
  const close = () => {
    if (busy) return;
    generation++; clearPoll(); retire(); app = undefined; renewalApp = undefined; chosen.clear(); secret = ''; expiryDate = ''; expiryInvalid = false; supportsExpiry = false; expiryUnconfirmed = false; confirming = false; outcome = undefined; error = ''; visible = false; render();
    if (!attempt) requestedExpiry = undefined;
  };
  const open = (selected: SavedOAuthApp): Promise<void> => {
    if (busy || disposed) return pending;
    visible = true;
    if (attempt) { pending = check(); return pending; }
    close(); visible = true; app = selected; const gen = generation; busy = true; render();
    pending = (async () => {
      try {
        const response = await deps.call({ action: 'usage', issuer: selected.issuer, id: selected.id, expected_revision: selected.revision });
        if (disposed || gen !== generation) {
          if (response.action === 'usage' && isOAuthAppUsageReview(response.usage)) void deps.call({ action: 'retire_usage', id: response.usage.id }).catch(() => {});
          return;
        }
        if (!isOAuthAppsResponse(response) || response.action !== 'usage' || !isOAuthAppUsageReview(response.usage)
          || response.usage.app.issuer !== selected.issuer || response.usage.app.id !== selected.id || response.usage.app.revision !== selected.revision || response.usage.app.client_id !== selected.client_id
          || response.usage.expires_at <= now()) throw Error('Usage could not be read. Refresh the saved apps or update the server.');
        review = response.usage; chosen = new Set(review.connections.filter(c => c.selected_by_default).map(c => c.name));
        supportsExpiry = response.secret_expiry_supported === true;
      } catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'Usage could not be read.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-app-usage-heading]')?.focus(); } }
    })(); return pending;
  };
  const apply = async () => {
    if (!review || busy || attempt || !confirming || !secret.trim() || !review.can_rotate) return;
    if (supportsExpiry && (expiryInvalid || expiryDate && !isOAuthAppSecretExpiryDate(expiryDate))) { error = 'Enter a real new secret expiry date, or use Clear new expiry date when unknown.'; render(); return; }
    if (review.expires_at <= now()) { retire(); secret = ''; confirming = false; error = 'This usage review expired. Refresh the saved apps and start again.'; render(); return; }
    const gen = generation; const checked = review; const clientSecret = secret.trim(); const selected = [...chosen].sort(); const expiry = supportsExpiry ? expiryDate || null : undefined;
    requestedExpiry = expiry; expiryUnconfirmed = false; attempt = (deps.id ?? nonce)(); remember(); secret = ''; busy = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'rotate_secret', review_id: checked.id, fingerprint: checked.fingerprint,
        selected_names: selected, client_secret: clientSecret, attempt_id: attempt,
        ...(expiry !== undefined ? { secret_expires_on: expiry } : {}) });
      if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(response) || response.action !== 'rotate_secret' || !isOAuthAppSecretRotationOutcome(response.rotation_outcome)
        || response.rotation_outcome.attempt_id !== attempt || response.rotation_outcome.issuer !== checked.app.issuer || response.rotation_outcome.app_id !== checked.app.id
        || JSON.stringify(response.rotation_outcome.selected_names) !== JSON.stringify(selected)) throw Error('Invalid result');
      supportsExpiry = response.secret_expiry_supported === true;
      renewalApp = response.apps.find(a => a.issuer === checked.app.issuer && a.id === checked.app.id && a.revision === response.rotation_outcome!.app_revision);
      finish(response.rotation_outcome);
    } catch { if (!disposed && gen === generation) error = 'The reply was lost. Check the rotation result before trying again.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); if (outcome?.status === 'checking') void check(); } }
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-app-usage-action]');
    if (!target || !deps.host.contains(target) || target.hasAttribute('disabled') || busy) return;
    const action = target.dataset.appUsageAction; event.preventDefault(); error = '';
    if (action === 'close') close();
    else if (action === 'verify-renewal' && outcome?.status === 'applied' && renewalApp) deps.verifyRenewal?.(renewalApp);
    else if (!attempt && action === 'clear-expiry' && review?.can_rotate && supportsExpiry && !confirming) {
      expiryDate = ''; expiryInvalid = false; render(); deps.host.querySelector<HTMLElement>('[data-app-usage-expiry]')?.focus({ preventScroll: true });
    }
    else if (action === 'status') pending = check();
    else if (!attempt && action === 'refresh' && app) pending = open(app);
    else if (!attempt && action === 'back') { confirming = false; render(); }
    else if (!attempt && action === 'review' && review) {
      if (!secret.trim()) error = 'Enter the new client secret before reviewing the rotation.';
      else if (supportsExpiry && (expiryInvalid || expiryDate && !isOAuthAppSecretExpiryDate(expiryDate))) error = 'Enter a real new secret expiry date, or use Clear new expiry date when unknown.';
      else confirming = true;
      render();
    } else if (!attempt && action === 'apply') pending = apply();
  };
  const input = (event: Event) => {
    const target = event.target as HTMLInputElement | null; if (!target || busy || attempt || !deps.host.contains(target)) return;
    if (target.hasAttribute('data-app-usage-secret') && review?.can_rotate && !confirming) { secret = target.value; }
    else if (target.hasAttribute('data-app-usage-expiry') && supportsExpiry && review?.can_rotate && !confirming) { expiryDate = target.value; expiryInvalid = target.validity?.badInput === true; }
    else if (target.dataset.appUsageCopy && review && !confirming) {
      const copy = review.connections.find(c => c.name === target.dataset.appUsageCopy); if (!copy?.group_complete) return;
      for (const member of review.connections.filter(c => c.group_id === copy.group_id)) {
        if (target.checked) chosen.add(member.name); else chosen.delete(member.name);
      }
      confirming = false; render();
    }
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('input', input); deps.host.addEventListener('change', input);
  try { const saved = storage()?.getItem(storageKey); if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) attempt = saved; } catch { /* Mounted recovery remains available. */ }
  if (attempt) pending = Promise.resolve().then(check);
  return { open, render, whenLoaded: () => pending, busy: () => busy, hasDraft: () => !!secret || !!expiryDate || expiryInvalid || !!attempt,
    dispose() { generation++; clearPoll(); retire(); secret = ''; expiryDate = ''; expiryInvalid = false; requestedExpiry = undefined; disposed = true;
      const host = deps.host.querySelector?.<HTMLElement>('[data-oauth-app-usage-host]'); if (host) host.innerHTML = '';
      deps.host.removeEventListener('click', click); deps.host.removeEventListener('input', input); deps.host.removeEventListener('change', input); },
  };
};
