/** D-322 §26 — vendor-group selection, shared consent, reviewed checks and per-row results. */
import {
  isManagedOAuthMigrationView, isManagedOAuthMigrationCandidate, managedOAuthScopeUnion, MANAGED_OAUTH_MIGRATION_LIMIT,
  type ManagedOAuthAuth, type ManagedOAuthMigrationCandidate, type ManagedOAuthMigrationView,
} from '@recued/contracts';
import { createManagedOAuthPanel, type ManagedOAuthCaller, type ManagedOAuthPanelContext } from './managed-oauth-panel.js';
import { renderManagedOAuthImpact } from './managed-oauth-impact-view.js';

const escape = (value: string): string => value.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const groupKey = (row: ManagedOAuthMigrationCandidate): string => JSON.stringify([row.base_url, row.vendor ?? '']);
const stateLabels = { pending: 'Waiting for check', verified: 'Access checked', failed: 'Kept saved authentication',
  applying: 'Verifying and switching', migrated: 'Switched', skipped: 'Skipped. Saved authentication kept.' } as const;
export const createManagedOAuthMigrationPanel = (deps: {
  host: HTMLElement; call: ManagedOAuthCaller; closed(): void; changed?(): void;
  open?: () => ReturnType<NonNullable<Parameters<typeof createManagedOAuthPanel>[0]['open']>>;
  id?: () => string;
}) => {
  const doc = deps.host.ownerDocument;
  let candidates: ManagedOAuthMigrationCandidate[] = []; let selected = new Set<string>();
  let group = ''; let phase: 'select' | 'authorize' | 'review' = 'select'; let error = ''; let busy = false;
  let disposed = false; let generation = 0; let statusSequence = 0; let auth: ManagedOAuthAuth | undefined;
  let view: ManagedOAuthMigrationView | undefined; let recent: ManagedOAuthMigrationView[] = [];
  let poll: ReturnType<typeof setTimeout> | undefined;
  const urls = new Map<string, string>();
  const context: ManagedOAuthPanelContext = { enabled: false, mode: 'switch', name: '', base_url: '', scopes: [], profile_id: '', integration_id: '' };
  const chosen = (): ManagedOAuthMigrationCandidate[] => candidates.filter(c => selected.has(c.name));
  const brokerHost = doc.createElement('div'); brokerHost.setAttribute('data-bulk-broker', '');
  const broker = createManagedOAuthPanel({ call: deps.call, context: () => context,
    select: (profile, integration) => { context.profile_id = profile; context.integration_id = integration; },
    requiredScopes: scopes => { context.scopes = managedOAuthScopeUnion(context.scopes, scopes); },
    authorized: value => { auth = value; render(); }, invalidate: () => { auth = undefined; },
    changed: () => { broker.mount(context.enabled ? brokerHost : null); deps.changed?.(); renderButtons(); },
    ...(deps.open ? { open: deps.open } : {}) });
  const buttons = (): string => {
    if (phase === 'select') return '<button type="button" data-bulk-action="authorize">Review selected connections</button>';
    if (phase === 'authorize') return '<button type="button" data-bulk-action="prepare">Check all selected connections</button>';
    return '<button type="button" data-bulk-action="apply">Apply verified connections</button><button type="button" data-bulk-action="refresh">Refresh results</button>'
      + (view && ['ready', 'applying', 'preparing'].includes(view.state) ? '<button type="button" data-bulk-action="stop">Stop migration</button>' : '')
      + (view && !['applying', 'preparing'].includes(view.state) ? '<button type="button" data-bulk-action="again">Select remaining connections</button>' : '');
  };
  const renderButtons = (): void => {
    for (const button of deps.host.querySelectorAll<HTMLButtonElement>('[data-bulk-action]')) {
      const action = button.dataset.bulkAction;
      button.disabled = busy || broker.busy();
      if (action === 'authorize') button.disabled ||= selected.size === 0 || selected.size > MANAGED_OAUTH_MIGRATION_LIMIT;
      if (action === 'prepare') button.disabled ||= !auth || !broker.impactFingerprint() || chosen().some(c => !urls.get(c.name)?.trim());
      if (action === 'apply') button.disabled ||= view?.state !== 'ready' || !view.fingerprint || !view.rows.some(r => r.state === 'verified');
      if (action === 'stop' || action === 'refresh') button.disabled = busy;
    }
  };
  const render = (): void => {
    if (disposed) return;
    const active = doc.activeElement as HTMLInputElement | null;
    const name = active && deps.host.contains(active) ? active.dataset.bulkUrl : undefined;
    const start = active?.selectionStart; const end = active?.selectionEnd;
    const groups = [...new Map(candidates.map(c => [groupKey(c), c])).entries()];
    const choices = candidates.filter(c => groupKey(c) === group);
    const rows = view?.rows.map(row => '<li><h4>' + escape(row.connection.display_name) + ' <code>' + escape(row.connection.name)
      + '</code></h4><p role="status">' + stateLabels[row.state] + (row.http_status ? ' (HTTP ' + row.http_status + ')' : '')
      + (row.reason === 'changed' ? ' Account, permissions, or local use changed. Review again.' : '')
      + '</p><p>Read check: <code>' + escape(row.connection.verification_url) + '</code></p>'
      + (row.state === 'migrated' ? '<details><summary>Reviewed account and impact before this switch</summary>'
        + renderManagedOAuthImpact(row.impact) + '</details>' : renderManagedOAuthImpact(row.impact)) + '</li>').join('') ?? '';
    deps.host.innerHTML = '<section class="connections-bulk-migration" aria-label="Bulk authentication migration"><style>'
      + '.connections-bulk-migration{max-width:960px;min-width:0;overflow-wrap:anywhere}.connections-bulk-migration label{display:block;margin:8px 0}'
      + '.connections-bulk-migration input[type=url]{width:100%;box-sizing:border-box}.connections-bulk-migration code{white-space:normal}'
      + '.connections-bulk-migration button{margin:4px}.bulk-account-choice{padding:8px;border:1px solid var(--border,#ddd);border-radius:8px}'
      + '</style><h2>Bulk authentication migration</h2><p>Move several saved connections to one Nango account. Names, packs, and recipes stay linked.</p>'
      + '<p>Work through one vendor API service at a time. Failed checks keep the saved authentication. Successful switches remain applied.</p>'
      + (error ? '<p role="alert">' + escape(error) + '</p>' : '')
      + (busy ? '<p role="status">Reading the migration…</p>' : '')
      + (phase === 'select' ? '<label>Vendor API service <select data-bulk-group><option value="">Select a service</option>'
        + groups.map(([key, c]) => '<option value="' + escape(key) + '"' + (key === group ? ' selected' : '') + '>'
          + escape((c.vendor ?? new URL(c.base_url).hostname) + ' · ' + c.base_url) + '</option>').join('') + '</select></label>'
        + '<p>Select up to ' + MANAGED_OAUTH_MIGRATION_LIMIT + ' connections for this service.</p>'
        + choices.map(c => '<label class="bulk-account-choice"><input type="checkbox" data-bulk-select="' + escape(c.name) + '"'
          + (selected.has(c.name) ? ' checked' : '') + '> ' + escape(c.display_name) + ' <code>' + escape(c.name) + '</code>'
          + ' · ' + (c.authentication === 'direct_oauth' ? 'Your OAuth app' : c.authentication === 'broker' ? 'Broker account' : 'Saved token') + '</label>').join('')
        + (!candidates.length && !busy ? '<p>No supported API connections are available.</p>' : '')
        + (recent.length ? '<h3>Recent migration reviews</h3>' + recent.map(v => '<button type="button" data-bulk-resume="' + escape(v.id) + '">'
          + escape(v.rows.map(r => r.connection.display_name).join(', ') + ' · ' + v.state) + '</button>').join('') : '') : '')
      + (phase === 'authorize' ? '<h3>Selected connections and current accounts</h3>'
        + chosen().map(c => '<label>' + escape(c.display_name) + ' <code>' + escape(c.name) + '</code>'
          + '<p>' + escape(c.current?.identity.email ?? 'Vendor email unknown') + '</p>'
          + 'Protected read-only access check URL<input type="url" data-bulk-url="' + escape(c.name) + '" value="' + escape(urls.get(c.name) ?? '') + '"></label>').join('')
        + '<p>A private Google Sheets link can be used as its read check. Recued asks for the combined needs of these connections.</p><div data-bulk-broker-slot></div>' : '')
      + (phase === 'review' && view ? '<p>Migration: ' + escape(view.state) + '. '
        + view.rows.filter(r => r.state === 'migrated').length + ' switched, ' + view.rows.filter(r => r.state === 'verified').length + ' ready.</p>'
        + '<ul>' + rows + '</ul>' + view.warnings.map(w => '<p>' + escape(w) + '</p>').join('') : '')
      + '<div>' + buttons() + '<button type="button" data-bulk-action="close">Back to connections</button></div></section>';
    const slot = deps.host.querySelector('[data-bulk-broker-slot]');
    if (slot) { slot.appendChild(brokerHost); broker.mount(brokerHost); } else broker.mount(null);
    renderButtons();
    if (name) {
      const replacement = [...deps.host.querySelectorAll<HTMLInputElement>('[data-bulk-url]')].find(i => i.dataset.bulkUrl === name);
      replacement?.focus({ preventScroll: true });
      if (typeof start === 'number' && typeof end === 'number') try { replacement?.setSelectionRange(start, end); } catch { /* URL fields omit text selection. */ }
    }
  };
  const accept = (next: ManagedOAuthMigrationView): void => {
    if (!isManagedOAuthMigrationView(next)) throw new Error('The migration result is invalid. Refresh results before continuing.');
    statusSequence++;
    view = next; phase = 'review'; context.enabled = false; auth = undefined; render();
    if (poll) clearTimeout(poll);
    if (['preparing', 'applying'].includes(next.state)) poll = setTimeout(() => { void refresh().catch(showError); }, 2000);
  };
  const refresh = async (): Promise<void> => {
    const gen = generation; const id = view?.id; const sequence = ++statusSequence;
    let response: Awaited<ReturnType<ManagedOAuthCaller>>;
    try { response = await deps.call({ action: 'migration_status', ...(id ? { id } : {}) }); }
    catch (failure) { if (disposed || gen !== generation || sequence !== statusSequence) return; throw failure; }
    if (disposed || gen !== generation || sequence !== statusSequence) return;
    if (response.action !== 'migration_status' || response.migrations.some(v => !isManagedOAuthMigrationView(v))) throw new Error('Migration status is unavailable.');
    recent = [...response.migrations];
    if (id) {
      const found = response.migrations.find(v => v.id === id);
      if (!found) {
        view = undefined; phase = 'select'; selected.clear(); context.enabled = false;
        error = 'This server no longer has the review. Read saved connections before starting again.';
        const response = await deps.call({ action: 'migration_candidates' });
        if (disposed || gen !== generation) return;
        if (response.action === 'migration_candidates' && response.candidates.every(isManagedOAuthMigrationCandidate)) candidates = [...response.candidates];
        render(); return;
      }
      accept(found); deps.changed?.();
    } else render();
  };
  const showError = (): void => {
    if (disposed) return; busy = false;
    error = 'The migration could not be confirmed. Refresh results before trying again.';
    render(); deps.changed?.();
  };
  const load = async (): Promise<void> => {
    const gen = ++generation; busy = true; error = ''; render();
    try {
      const response = await deps.call({ action: 'migration_candidates' });
      if (disposed || gen !== generation) return;
      if (response.action !== 'migration_candidates' || !Array.isArray(response.candidates)
        || response.candidates.some(c => !isManagedOAuthMigrationCandidate(c))) throw new Error('Unavailable');
      candidates = [...response.candidates]; if (!group && candidates[0]) group = groupKey(candidates[0]);
      selected = new Set([...selected].filter(name => candidates.some(c => c.name === name && groupKey(c) === group)));
      await refresh();
    } catch { showError(); }
    if (!disposed && gen === generation) { busy = false; render(); }
  };
  const act = async (action: string): Promise<void> => {
    if (busy || broker.busy()) return;
    const gen = generation; error = '';
    if (action === 'authorize') {
      if (!selected.size || selected.size > MANAGED_OAUTH_MIGRATION_LIMIT) return;
      busy = true; renderButtons();
      const response = await deps.call({ action: 'migration_candidates', names: chosen().map(c => c.name) });
      if (disposed || gen !== generation) return;
      if (response.action !== 'migration_candidates' || !Array.isArray(response.candidates) || response.candidates.length !== selected.size
        || response.candidates.some(c => !isManagedOAuthMigrationCandidate(c))) throw new Error('Selected connections changed');
      const names = new Set(response.candidates.map(c => c.name));
      candidates = [...candidates.filter(c => !names.has(c.name)), ...response.candidates].sort((a, b) => a.name.localeCompare(b.name));
      const first = chosen()[0]!; phase = 'authorize'; context.enabled = true; context.name = first.name;
      context.expected_updated_at = first.updated_at; context.base_url = first.base_url; context.vendor = first.vendor;
      context.scopes = managedOAuthScopeUnion(...chosen().map(c => c.required_scopes)); auth = undefined;
      for (const row of chosen()) urls.set(row.name, row.verification_url);
      busy = false; render(); return;
    }
    if (action === 'prepare') {
      if (!auth || !broker.impactFingerprint() || chosen().some(c => !urls.get(c.name)?.trim())) return;
      const id = (deps.id ?? (() => crypto.randomUUID()))();
      // Keep the ID before sending; a lost reply can be reconciled without the credential.
      view = { id, created_at: Date.now(), expires_at: Date.now() + 30 * 60_000, state: 'preparing',
        rows: chosen().map(connection => ({ connection, state: 'pending' })), requested_scopes: [...auth.requested_scopes], warnings: [] };
      busy = true; context.saving = true; broker.mount(brokerHost); renderButtons();
      try {
        const response = await deps.call({ action: 'migration_prepare', id, auth, impact_fingerprint: broker.impactFingerprint()!,
          selections: chosen().map(c => ({ name: c.name, expected_updated_at: c.updated_at, verification_url: urls.get(c.name)! })) });
        if (disposed || gen !== generation) return;
        if (response.action !== 'migration_prepare' || response.migration.id !== id) throw new Error('Invalid migration');
        busy = false; context.saving = false; accept(response.migration);
      } catch (failure) {
        if (!disposed && gen === generation) {
          context.enabled = false; auth = undefined; phase = 'review'; busy = false;
          const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
          if (['bad_request', 'conflict', 'not_configured', 'not_found'].includes(String(code))) {
            view = undefined; phase = 'select';
          }
          render();
        }
        throw failure;
      } finally { context.saving = false; }
      return;
    }
    if (action === 'refresh') { await refresh(); return; }
    if (action === 'apply' && view?.state === 'ready' && view.fingerprint && view.rows.some(r => r.state === 'verified')) {
      busy = true; renderButtons();
      const response = await deps.call({ action: 'migration_apply', id: view.id, fingerprint: view.fingerprint });
      if (disposed || gen !== generation) return;
      if (response.action !== 'migration_apply' || response.migration.id !== view.id) throw new Error('Invalid migration');
      busy = false; accept(response.migration); return;
    }
    if (action === 'stop' && view) {
      const response = await deps.call({ action: 'migration_stop', id: view.id });
      if (disposed || gen !== generation) return;
      if (response.action !== 'migration_stop') throw new Error('Invalid migration');
      accept(response.migration); return;
    }
    if (action === 'again') {
      if (!view || ['applying', 'preparing'].includes(view.state)) return;
      if (view.state === 'ready') await deps.call({ action: 'migration_stop', id: view.id });
      if (disposed || gen !== generation) return;
      selected = new Set(view.rows.filter(r => r.state !== 'migrated').map(r => r.connection.name));
      group = groupKey(view.rows[0]!.connection);
      view = undefined; phase = 'select'; await load(); return;
    }
    if (action === 'close') {
      if (view && ['ready', 'preparing'].includes(view.state)) await deps.call({ action: 'migration_stop', id: view.id });
      if (disposed || gen !== generation) return;
      deps.closed();
    }
  };
  const click = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-bulk-action], [data-bulk-resume]');
    if (!target || !deps.host.contains(target) || (target as HTMLButtonElement).disabled) return;
    event.preventDefault();
    if (target.dataset.bulkResume) {
      if (busy || broker.busy()) return;
      const found = recent.find(v => v.id === target.dataset.bulkResume); if (found) accept(found); return;
    }
    void act(target.dataset.bulkAction ?? '').catch(showError);
  };
  const input = (event: Event): void => {
    const field = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!field || !deps.host.contains(field) || busy || view?.state === 'applying') return;
    if (field.hasAttribute('data-bulk-group') && event.type === 'change') { group = field.value; selected.clear(); render(); }
    if (field.dataset.bulkSelect && event.type === 'change') {
      if ((field as HTMLInputElement).checked) selected.add(field.dataset.bulkSelect); else selected.delete(field.dataset.bulkSelect);
      renderButtons();
    }
    if (field.dataset.bulkUrl && event.type === 'input') { urls.set(field.dataset.bulkUrl, field.value); renderButtons(); }
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', input); deps.host.addEventListener('input', input);
  return { load, busy: () => busy || broker.busy() || ['preparing', 'applying'].includes(view?.state ?? ''),
    hasDraft: () => phase === 'authorize' || phase === 'select' && selected.size > 0 || broker.hasDraft(),
    dispose: () => { disposed = true; generation++; if (poll) clearTimeout(poll); broker.dispose();
      deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', input); deps.host.removeEventListener('input', input); } };
};
