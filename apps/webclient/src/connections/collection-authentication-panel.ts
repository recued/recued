/** Reviewed same-account switching; the parent owns the detail page and its stable event host. */
import { isCollectionAuthenticationReview, isCollectionAuthenticationOutcome, isCollectionAuthenticationSource,
  isCollectionPermissionChoices, collectionPermissionScopes, type CollectionPermissionChoices, type CollectionAuthenticationProvider,
  type AuthenticationCollectionPlatform, type CollectionAuthenticationReview, type CollectionAuthenticationOutcome,
  type CollectionAuthenticationSource } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { renderCollectionPermissionChoices, sameCollectionPermissionChoices } from '@recued/ui-shared';
const escape = (v: string): string => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const createCollectionAuthenticationPanel = (deps: {
  host: HTMLElement; call: ManagedOAuthCaller; changed(): void; openConnections(name?: string): void;
  updated?(): void; id?(): string; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; now?(): number;
}) => {
  let selected: { platform: AuthenticationCollectionPlatform; slug: string } | undefined;
  let sources: CollectionAuthenticationSource[] = []; let source = ''; let review: CollectionAuthenticationReview | undefined;
  let outcome: CollectionAuthenticationOutcome | undefined; let attempt: string | undefined;
  let busy = false; let error = ''; let disposed = false; let generation = 0;
  let poll: ReturnType<typeof setTimeout> | undefined; let polls = 0;
  let permissionsOnly = false; let currentChoice: CollectionPermissionChoices | undefined;
  let permissionChoice: CollectionPermissionChoices | undefined; let provider: CollectionAuthenticationProvider | undefined;
  let pinnedSource = '';
  const now = deps.now ?? Date.now;
  const storage = (): typeof deps.storage => { try { return deps.storage ?? deps.host.ownerDocument.defaultView?.sessionStorage; } catch { return undefined; } };
  const key = (): string => 'recued:collection-authentication:' + selected?.platform + ':' + selected?.slug;
  const remember = (): void => { try { if (attempt) storage()?.setItem(key(), attempt); else storage()?.removeItem(key()); } catch { /* Reply recovery still works in this mount. */ } };
  const retire = (): void => { const old = review; review = undefined; if (old) void deps.call({ action: 'collection_authentication_retire', review_id: old.id }).catch(() => {}); };
  const clearPoll = (): void => { if (poll !== undefined) clearTimeout(poll); poll = undefined; };
  const render = (): void => {
    const host = deps.host.querySelector<HTMLElement>('[data-collection-authentication-host]');
    if (!host || disposed) return;
    if (!selected) { host.innerHTML = ''; deps.updated?.(); return; }
    const pending = !!attempt;
    const buttonsDisabled = busy || pending;
    host.innerHTML = '<section class="accounts-authentication-review" aria-label="' + (permissionsOnly ? 'Review permission choices' : 'Switch authentication') + '"><style>'
      + '.accounts-authentication-review{border:1px solid var(--border);border-radius:12px;padding:16px;min-width:0;overflow-wrap:anywhere}'
      + '.accounts-authentication-review select{max-width:100%;width:100%;box-sizing:border-box}.accounts-authentication-review code{white-space:normal}'
      + '.accounts-authentication-review button{margin:4px}.accounts-authentication-review dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px}'
      + '.accounts-authentication-review dd{margin:0;min-width:0}.accounts-authentication-review h3{margin-top:0}'
      + '</style><h3 tabindex="-1" data-collection-authentication-heading>' + (permissionsOnly ? 'Permission choices for ' : 'Switch authentication for ') + escape(selected.slug) + '</h3>'
      + '<p>' + (permissionsOnly ? 'Keep the current API connection and vendor account. If more vendor permissions are needed, re-authorize this connection in Apps & APIs, return here, and review your choices again.'
        : 'Use a saved Apps & APIs connection for the same vendor account. Recued direct OAuth is the first choice; a broker is optional.') + '</p>'
      + '<label>Saved API connection <select data-collection-auth-source' + (buttonsDisabled || permissionsOnly ? ' disabled' : '') + '>'
      + '<option value="">Choose authentication</option>' + sources.map(s => '<option value="' + escape(s.name) + '"' + (s.name === source ? ' selected' : '') + '>'
        + escape(s.display_name + ' · ' + (s.authentication === 'direct_oauth' ? 'Recued direct OAuth' : 'Broker account')) + '</option>').join('') + '</select></label>'
      + (!sources.length && !busy ? '<p>Add or authorize a matching Google or Microsoft API connection in Apps & APIs, then return here.</p>' : '')
      + (permissionsOnly && currentChoice && permissionChoice && provider ? renderCollectionPermissionChoices({ owner: 'collection-auth', disabled: buttonsDisabled || !!review,
        rows: [{ provider, current: currentChoice, selected: permissionChoice }] })
        + '<details><summary>Vendor permissions for these choices</summary><ul>' + collectionPermissionScopes(provider, permissionChoice)
          .map(scope => '<li><code>' + escape(scope) + '</code></li>').join('')
          + '</ul><p>Enabling writes requires vendor-reported permission evidence. A broker with unknown grants cannot confirm these choices.</p></details>' : '')
      + (error ? '<p role="alert">' + escape(error) + '</p>' : '')
      + (busy ? '<p role="status">Checking authentication and access…</p>' : '')
      + (review ? '<p>Same vendor account verified. Access checks passed.</p><dl><dt>Current email</dt><dd>' + escape(review.current.email ?? 'Unknown')
        + '</dd><dt>Selected email</dt><dd>' + escape(review.target.email ?? 'Unknown') + '</dd><dt>Collection</dt><dd>' + escape(review.slug)
        + '</dd><dt>Folders/calendars kept</dt><dd>' + escape(review.selections.join(', ') || 'Existing default selection') + '</dd></dl>'
        + '<details><summary>Review permissions</summary><p>Required:</p><ul>' + review.required_scopes.map(s => '<li><code>' + escape(s) + '</code></li>').join('')
        + '</ul><p>Vendor-reported grants: ' + (review.granted_scopes ? escape(review.granted_scopes.join(', ')) : 'Unknown; protected reads were checked.') + '</p></details>'
        + review.warnings.map(w => '<p>' + escape(w) + '</p>').join('') : '')
      + (outcome ? '<p role="status">' + (outcome.status === 'applied' ? (outcome.intent === 'permissions' ? 'Permission choices applied.' : 'Authentication switched.') + ' Collection name, selections, and sync state were kept.'
        + (outcome.restart_needed ? ' The collection needs a restart; reload Recued or restart the server to resume sync.' : '')
        : outcome.status === 'failed' ? 'Authentication was kept. ' + (outcome.reason === 'changed' ? 'The collection or authentication changed; review again.'
          : outcome.reason === 'interrupted' ? 'The server restarted during verification; review again.' : 'The access check failed; repair authentication and review again.')
        : 'Migration is still being checked. You can check its result without repeating authorization.') + '</p>' : '')
      + (pending ? '<button type="button" data-collection-auth-action="status"' + (busy ? ' disabled' : '') + '>Check result</button>'
        : '<button type="button" data-collection-auth-action="review"' + (buttonsDisabled || !source || permissionsOnly && !permissionChoice ? ' disabled' : '') + '>Verify account and access</button>'
          + (review ? '<button type="button" data-collection-auth-action="apply"' + (buttonsDisabled || review.expires_at <= now() ? ' disabled' : '') + '>' + (permissionsOnly ? 'Apply permission choices' : 'Apply authentication switch') + '</button>'
            + (permissionsOnly ? '<button type="button" data-collection-auth-action="choices"' + (buttonsDisabled ? ' disabled' : '') + '>Change permission choices</button>' : '') : '')
          + (permissionsOnly && !permissionChoice ? '<button type="button" data-collection-auth-action="refresh-choices"' + (buttonsDisabled ? ' disabled' : '') + '>Refresh permission choices</button>' : ''))
      + '<button type="button" data-collection-auth-action="connections"' + (busy ? ' disabled' : '') + '>Open Apps & APIs</button>'
      + '<button type="button" data-collection-auth-action="close"' + (busy ? ' disabled' : '') + '>Close review</button></section>';
    deps.updated?.();
  };
  const loadSources = async (platform: AuthenticationCollectionPlatform, slug: string, currentName: string | undefined, gen: number): Promise<void> => {
    const response = await deps.call({ action: 'collection_authentication_candidates', platform, slug });
    if (disposed || gen !== generation) return;
    if (response.action !== 'collection_authentication_candidates' || !Array.isArray(response.sources) || !response.sources.every(isCollectionAuthenticationSource)) throw new Error('Upgrade required');
    if (permissionsOnly) {
      if (!isCollectionPermissionChoices(response.permissions) || response.permissions.platform !== platform || response.permissions.slug !== slug
        || response.current_connection_name !== currentName || !['gmail', 'gcal', 'graph'].includes(response.provider ?? '')) throw new Error('Permission choices unavailable');
      currentChoice = structuredClone(response.permissions); permissionChoice = structuredClone(currentChoice); provider = response.provider;
    }
    sources = [...response.sources].sort((a, b) => Number(a.authentication === 'broker') - Number(b.authentication === 'broker'));
    const current = sources.find(s => s.name === currentName);
    source = permissionsOnly ? current?.name ?? '' : current?.authentication === 'direct_oauth' ? current.name
      : sources.find(s => s.authentication === 'direct_oauth')?.name ?? current?.name ?? sources[0]?.name ?? '';
  };
  const finishOutcome = async (value: CollectionAuthenticationOutcome, gen: number): Promise<void> => {
    outcome = value;
    if (value.status === 'checking') return;
    if (!value.restart_needed) { attempt = undefined; remember(); }
    retire();
    if (value.status !== 'applied') return;
    if (permissionsOnly && selected) {
      // A confirmed receipt is not a current permission snapshot. Invalidate
      // old choices until a fresh local read succeeds, including on recovery.
      currentChoice = undefined; permissionChoice = undefined; pinnedSource = value.connection_name;
      try { await loadSources(selected.platform, selected.slug, pinnedSource, gen); }
      catch { if (!disposed && gen === generation) error = 'The change is confirmed, but current permission choices could not be read. Refresh choices before making another change.'; }
    }
    if (disposed || gen !== generation) return;
    try { deps.changed(); }
    catch { error = 'The change is confirmed. Refresh the account view to see its current status.'; }
  };
  const refreshStatus = async (): Promise<void> => {
    if (!attempt || busy || disposed) return;
    const gen = generation; const id = attempt; busy = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'collection_authentication_status', attempt_id: id });
      if (disposed || gen !== generation) return;
      if (response.action !== 'collection_authentication_status' || response.outcome !== null && !isCollectionAuthenticationOutcome(response.outcome)) throw new Error('Invalid response');
      if (response.outcome && (response.outcome.attempt_id !== id || response.outcome.slug !== selected?.slug || response.outcome.platform !== selected.platform)) throw new Error('Different result');
      outcome = response.outcome ?? undefined;
      if (!outcome || outcome.status !== 'checking') {
        if (outcome) await finishOutcome(outcome, gen);
        else { attempt = undefined; remember(); retire(); }
      } else if (polls++ < 60) { clearPoll(); poll = setTimeout(() => { void refreshStatus(); }, 2000); }
    } catch { if (!disposed && gen === generation) error = 'The result could not be read. Check again before starting another migration.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); } }
  };
  const close = (): void => { generation++; polls = 0; clearPoll(); retire(); selected = undefined; sources = []; source = ''; outcome = undefined; attempt = undefined; busy = false; error = '';
    permissionsOnly = false; currentChoice = undefined; permissionChoice = undefined; provider = undefined; pinnedSource = ''; render(); };
  const open = async (platform: AuthenticationCollectionPlatform, slug: string, currentName?: string, managePermissions = false): Promise<void> => {
    close(); permissionsOnly = managePermissions; pinnedSource = currentName ?? ''; selected = { platform, slug }; const gen = generation; busy = true; render();
    try { const saved = storage()?.getItem(key()); if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) attempt = saved; } catch { /* In-memory recovery. */ }
    try {
      await loadSources(platform, slug, currentName, gen);
    } catch { if (!disposed && gen === generation) error = 'Authentication switching is unavailable. Refresh Recued or upgrade the server.'; }
    finally { if (!disposed && gen === generation) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-collection-authentication-heading]')?.focus(); if (attempt) void refreshStatus(); } }
  };
  const act = async (action: string): Promise<void> => {
    if (busy || !selected) return;
    if (action === 'close') { close(); return; }
    if (action === 'connections') { const name = permissionsOnly ? pinnedSource : undefined; close(); deps.openConnections(name); return; }
    if (action === 'status') { await refreshStatus(); return; }
    if (attempt) return;
    const gen = generation;
    if (action === 'choices' && permissionsOnly) { retire(); error = ''; render(); deps.host.querySelector<HTMLElement>('[data-permission-feature="send"], [data-permission-feature="edit_events"]')?.focus(); return; }
    if (action === 'refresh-choices' && permissionsOnly) {
      retire(); busy = true; error = ''; currentChoice = undefined; permissionChoice = undefined; render();
      try { await loadSources(selected.platform, selected.slug, pinnedSource, gen); }
      catch { if (!disposed && gen === generation) error = 'Current permission choices could not be read. Refresh again before changing permissions.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); } }
      return;
    }
    if (action === 'review' && source) {
      retire(); outcome = undefined; busy = true; error = ''; render();
      try {
        if (permissionsOnly && !permissionChoice) throw new Error('Refresh Recued to review permission choices.');
        const response = await deps.call({ action: 'collection_authentication_review', ...selected, connection_name: source,
          ...(permissionsOnly && permissionChoice ? { intent: 'permissions' as const, permissions: permissionChoice } : {}) });
        if (disposed || gen !== generation) {
          if (response.action === 'collection_authentication_review' && isCollectionAuthenticationReview(response.review)) void deps.call({ action: 'collection_authentication_retire', review_id: response.review.id }).catch(() => {});
          return;
        }
        if (response.action !== 'collection_authentication_review' || !isCollectionAuthenticationReview(response.review)
          || response.review.platform !== selected.platform || response.review.slug !== selected.slug || response.review.source.name !== source
          || permissionsOnly && (response.review.intent !== 'permissions' || !response.review.permissions || !permissionChoice
            || !sameCollectionPermissionChoices(response.review.permissions.selected, permissionChoice))) throw new Error('Invalid review');
        review = response.review;
        if (permissionsOnly && review.permissions) { currentChoice = structuredClone(review.permissions.current); permissionChoice = structuredClone(review.permissions.selected); }
      } catch { if (!disposed && gen === generation) error = 'Could not verify the same vendor account and required access. The collection is unchanged. Repair account permissions in Apps & APIs and try again.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-collection-authentication-heading]')?.focus(); } }
    } else if (action === 'apply' && review && review.expires_at > now()) {
      attempt = (deps.id ?? newId)(); remember(); busy = true; error = ''; render();
      try {
        const response = await deps.call({ action: 'collection_authentication_apply', review_id: review.id, fingerprint: review.fingerprint, attempt_id: attempt });
        if (disposed || gen !== generation) return;
        if (response.action !== 'collection_authentication_apply' || !isCollectionAuthenticationOutcome(response.outcome)
          || response.outcome.attempt_id !== attempt || response.outcome.slug !== selected.slug || response.outcome.platform !== selected.platform) throw new Error('Invalid result');
        await finishOutcome(response.outcome, gen);
      } catch { if (!disposed && gen === generation) error = 'The reply was lost. Check the saved result before starting another migration.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); if (outcome?.status === 'checking') void refreshStatus(); } }
    }
  };
  const onClick = (event: Event): void => {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-collection-auth-action]');
    if (!node || !deps.host.contains(node) || node.getAttribute('disabled') !== null) return;
    event.preventDefault(); void act(node.dataset.collectionAuthAction ?? '');
  };
  const onChange = (event: Event): void => {
    const node = event.target as HTMLSelectElement | null;
    if (node?.getAttribute?.('data-collection-permission-owner') === 'collection-auth') {
      if (!deps.host.contains(node) || !permissionsOnly || busy || attempt || review || !permissionChoice) return;
      const input = node as unknown as HTMLInputElement;
      if (input.dataset.permissionPlatform !== permissionChoice.platform || input.dataset.permissionSlug !== permissionChoice.slug) return;
      const feature = input.dataset.permissionFeature;
      if (permissionChoice.platform === 'mail' && ['send', 'organize'].includes(feature ?? '')) {
        if (feature === 'send') permissionChoice.send = input.checked; else permissionChoice.organize = input.checked;
      } else if (permissionChoice.platform === 'calendar' && feature === 'edit_events') permissionChoice.edit_events = input.checked;
      else return;
      outcome = undefined; error = ''; render();
      deps.host.querySelector<HTMLElement>('[data-permission-feature="' + feature + '"]')?.focus(); return;
    }
    if (!node?.hasAttribute('data-collection-auth-source') || busy || attempt || permissionsOnly) return;
    retire(); source = node.value; outcome = undefined; error = ''; render();
    deps.host.querySelector<HTMLElement>('[data-collection-auth-source]')?.focus();
  };
  deps.host.addEventListener('click', onClick); deps.host.addEventListener('change', onChange);
  return { open, permissions: (platform: AuthenticationCollectionPlatform, slug: string, name: string) => open(platform, slug, name, true), close, render, busy: () => busy,
    context(platform: string, slug: string | null): void { if (selected && (selected.platform !== platform || selected.slug !== slug)) close(); },
    dispose(): void { close(); disposed = true; deps.host.removeEventListener('click', onClick); deps.host.removeEventListener('change', onChange); } };
};
