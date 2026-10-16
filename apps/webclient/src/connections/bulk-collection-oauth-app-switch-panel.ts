/** Bulk owner review composes the existing same-account, atomic grant switches.
 * No tokens enter batch state, and recovery never resumes unstarted writes. */
import { OAUTH_APP_ID, savedOAuthAppsForIssuer, type AuthenticationCollectionPlatform,
  type OAuthAppConfigSnapshot, type SavedOAuthApp } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import { createCollectionOAuthAppSwitchPanel } from './collection-oauth-app-switch-panel.js';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import type { AccountsOAuthEnv } from './accounts-lane-panel.js';

export interface BulkOAuthAppAccount { platform: AuthenticationCollectionPlatform; slug: string; issuer: 'google' | 'microsoft'; email?: string }
interface Recovery { platform: AuthenticationCollectionPlatform; slug: string; app_id?: string; attempt: string }
type Child = ReturnType<typeof createCollectionOAuthAppSwitchPanel>;
interface Group { account: Pick<BulkOAuthAppAccount, 'platform' | 'slug'>; child: Child; skipped?: string }
export const BULK_SAVED_APP_LIMIT = 20;
const recoveryKey = 'recued:collection-oauth-app:bulk';
const key = (row: { platform: string; slug: string }) => row.platform + ':' + row.slug;
const validRecovery = (value: unknown): value is Recovery => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Recovery>;
  return (v.platform === 'mail' || v.platform === 'calendar') && typeof v.slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.slug)
    && (v.app_id === undefined || typeof v.app_id === 'string' && OAUTH_APP_ID.test(v.app_id)) && typeof v.attempt === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.attempt);
};
export const createBulkCollectionOAuthAppSwitchPanel = (deps: {
  host: HTMLElement; call: ManagedOAuthCaller; accounts(): Promise<readonly BulkOAuthAppAccount[]>;
  apps(): Promise<OAuthAppConfigSnapshot>; changed(): void; openApps(): void; oauth?(): AccountsOAuthEnv;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; now?(): number; id?(): string;
}) => {
  let visible = false; let disposed = false; let generation = 0; let loading = false; let applying = false; let stopped = false; let leaveAfterApply = false;
  let phase: 'select' | 'review' = 'select'; let accounts: readonly BulkOAuthAppAccount[] = []; let apps: SavedOAuthApp[] = [];
  let appKey = ''; let selected = new Set<string>(); let groups: Group[] = []; let history = new Map<string, Recovery>();
  let error = ''; let storageWarning = ''; let pending = Promise.resolve(); let lane = '';
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; };
  const now = deps.now ?? Date.now;
  const slot = () => deps.host.querySelector<HTMLElement>('[data-bulk-collection-oauth-app-host]');
  const target = () => apps.find(app => app.issuer + ':' + app.id === appKey);
  const storage = () => { try { return deps.storage ?? deps.host.ownerDocument?.defaultView?.sessionStorage; } catch { return undefined; } };
  const busy = () => loading || applying || groups.some(g => g.child.busy());
  const unresolved = () => groups.some(g => !!g.child.snapshot().attempt);
  const ready = (group: Group) => {
    const value = group.child.snapshot(); const app = target();
    return !group.skipped && !value.busy && !value.attempt && !!value.review && value.review.expires_at > now()
      && !!app && value.review.app.issuer === app.issuer && value.review.app.id === app.id
      && value.review.app.client_id === app.client_id && value.review.app.revision === app.revision;
  };
  const persist = () => {
    try {
      const store = storage(); if (!store) throw Error('No session storage');
      if (history.size) store.setItem(recoveryKey, JSON.stringify([...history.values()])); else store.removeItem(recoveryKey);
    } catch { storageWarning = 'Browser result recovery is unavailable. Keep this view open until every switch result is confirmed.'; }
  };
  const button = (action: string, label: string, disabled = false) => '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-bulk-app-action="'
    + action + '"' + (disabled ? ' disabled' : '') + '>' + e(label) + '</button>';
  const restoreFooterFocus = (action: string | undefined) => {
    if (!action) return;
    const buttons = [...slot()?.querySelectorAll<HTMLButtonElement>('[data-bulk-app-action]') ?? []].filter(node => !node.disabled);
    const replacement = buttons.find(node => node.dataset.bulkAppAction === action)
      ?? buttons.find(node => node.dataset.bulkAppAction === (applying && !stopped ? 'stop' : 'status'))
      ?? buttons.find(node => node.dataset.bulkAppAction === 'close');
    (replacement ?? slot()?.querySelector<HTMLElement>('[data-bulk-app-heading]'))?.focus({ preventScroll: true });
  };
  const renderFooter = () => {
    if (!visible || disposed) return;
    const footer = slot()?.querySelector<HTMLElement>('[data-bulk-app-footer]'); if (!footer) return;
    const active = deps.host.ownerDocument?.activeElement as HTMLElement | null | undefined;
    const focusedAction = active && footer.contains(active) ? active.dataset.bulkAppAction : undefined;
    for (const fieldset of slot()?.querySelectorAll<HTMLFieldSetElement>('[data-bulk-app-guard]') ?? []) {
      const index = Number(fieldset.dataset.bulkAppGuard);
      fieldset.disabled = loading || applying || groups.some((group, i) => i !== index && group.child.busy());
    }
    const count = groups.filter(ready).length; const app = target();
    const switched = groups.filter(g => {
      const outcome = g.child.snapshot().outcome;
      return outcome?.status === 'applied' && (!app || outcome.app_id === app.id);
    }).length;
    footer.innerHTML = (error ? '<p role="alert">' + e(error) + '</p>' : '') + (storageWarning ? '<p role="status">' + e(storageWarning) + '</p>' : '')
      + (loading ? '<p role="status">Reading accounts and saved apps…</p>' : '')
      + (phase === 'review' ? '<p role="status">' + count + ' sign-in groups ready; ' + switched + ' switched. Failed checks keep their saved app.</p>'
        + (stopped ? '<p>Stopped. Remaining groups were not applied. You can explicitly apply verified groups later while their reviews are valid.</p>' : '')
        + button('apply', 'Apply verified groups (' + count + ')', busy() || count === 0)
        + button('status', 'Check switch results', busy() || !history.size)
        + (applying ? button('stop', 'Stop remaining switches', stopped) : '')
        + button('again', 'Choose accounts again', busy() || unresolved()) : button('review', 'Review selected accounts', busy() || !target() || !selected.size || selected.size > BULK_SAVED_APP_LIMIT))
      + (phase === 'select' ? button('reload', 'Refresh accounts and apps', busy()) : '')
      + button('apps', 'Manage saved apps', busy() || unresolved()) + button('close', loading ? 'Cancel review' : 'Close bulk switching', applying);
    restoreFooterFocus(focusedAction);
    clearTimer();
    const next = groups.map(g => g.child.snapshot().review?.expires_at).filter((expiry): expiry is number => expiry !== undefined && expiry > now()).sort((a, b) => a - b)[0];
    if (next !== undefined) expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      for (const group of groups) {
        const review = group.child.snapshot().review;
        if (review && review.expires_at === next && review.expires_at <= now()) group.child.render();
      }
      renderFooter();
    }, Math.min(2_147_483_647, Math.max(1, next - now())));
  };
  const updated = () => {
    if (!visible || disposed) return;
    for (const group of groups) {
      const value = group.child.snapshot(); const attempt = value.attempt ?? value.outcome?.attempt_id;
      const appId = value.outcome?.app_id ?? value.review?.app.id ?? history.get(key(group.account))?.app_id;
      if (attempt) history.set(key(group.account), { ...group.account, attempt, ...(appId ? { app_id: appId } : {}) });
    }
    if (history.size) persist(); renderFooter();
  };
  const render = () => {
    const host = slot(); if (!host || disposed) return;
    if (!visible) { host.innerHTML = ''; return; }
    const app = target(); const active = deps.host.ownerDocument?.activeElement as HTMLElement | null | undefined;
    const focusedAction = active && host.contains(active) ? active.dataset.bulkAppAction : undefined;
    const focusChoice = active?.hasAttribute('data-bulk-app-choice') === true && host.contains(active);
    host.innerHTML = '<section class="accounts-bulk-app-switch" aria-label="Bulk saved-app switching"><style>'
      + '.accounts-bulk-app-switch{border:1px solid var(--border,#ccc);border-radius:12px;padding:16px;overflow-wrap:anywhere;min-width:0}'
      + '.accounts-bulk-app-switch label{display:block;margin:10px 0}.accounts-bulk-app-switch select{max-width:100%;width:100%;box-sizing:border-box}'
      + '.accounts-bulk-app-switch button{margin:4px}.accounts-bulk-app-switch li{margin:12px 0}.accounts-bulk-app-switch code{white-space:normal}</style>'
      + '<h2 tabindex="-1" data-bulk-app-heading>Bulk saved-app switching</h2>'
      + '<p>Move native Mail and Calendar accounts to another saved Google or Microsoft OAuth app. Keep collection names, saved data, resource selections and sync state.</p>'
      + '<p>Each distinct sign-in needs authorization with the same vendor account. Linked collections sharing a grant switch together, including unselected companions shown in the review.</p>'
      + (phase === 'select' ? '<label>Destination saved OAuth app<select data-bulk-app-choice' + (loading ? ' disabled' : '') + '><option value="">Choose a saved app</option>'
        + apps.map(a => '<option value="' + e(a.issuer + ':' + a.id) + '"' + (appKey === a.issuer + ':' + a.id ? ' selected' : '') + '>'
          + e((a.issuer === 'google' ? 'Google' : 'Microsoft') + ' · ' + a.label + ' · ' + a.client_id) + '</option>').join('') + '</select></label>'
        + '<p>Select up to ' + BULK_SAVED_APP_LIMIT + ' native accounts for this vendor. Accounts already using the destination will be skipped.</p>'
        + (app ? '<ul>' + accounts.filter(a => a.issuer === app.issuer).map(a => '<li><label><input type="checkbox" data-bulk-app-account="' + e(key(a)) + '"'
          + (selected.has(key(a)) ? ' checked' : '') + '> ' + e(a.platform + ' ' + a.slug) + ' · ' + e(a.email || 'Vendor email unknown') + '</label></li>').join('') + '</ul>' : '')
        + (!loading && !apps.length ? '<p>Add a saved OAuth app with its secret in Apps & APIs first.</p>' : '')
        + (!loading && app && !accounts.some(a => a.issuer === app.issuer) ? '<p>No native OAuth accounts are available for this vendor.</p>' : '') :
        (app ? '<p>Destination: <strong>' + e(app.label) + '</strong> · <code>' + e(app.client_id) + '</code></p>' : '<p>Saved results for switches already started. Unstarted switches will not resume.</p>')
        + '<p>Authorize and verify each group below. Then review the results and explicitly apply the verified groups. A failed or unconfirmed row does not roll back earlier successful switches.</p>'
        + '<ol>' + groups.map((group, i) => '<li><h3>' + e(group.account.platform + ' ' + group.account.slug) + '</h3>'
          + (group.skipped ? '<p role="status">' + e(group.skipped) + '</p>' : '')
          + '<fieldset data-bulk-app-guard="' + i + '" style="border:0;margin:0;padding:0;min-width:0"><div data-bulk-app-slot="' + i + '"></div></fieldset></li>').join('') + '</ol>')
      + '<div data-bulk-app-footer></div></section>';
    for (const group of groups) if (!group.skipped) group.child.render(); renderFooter();
    if (focusChoice) host.querySelector<HTMLElement>('[data-bulk-app-choice]')?.focus({ preventScroll: true });
    restoreFooterFocus(focusedAction);
  };
  const resetChildren = () => { const prior = groups; groups = []; for (const group of prior) group.child.dispose(); };
  const makeGroup = (account: Group['account'], app?: SavedOAuthApp): Group => {
    const index = groups.length;
    const child = createCollectionOAuthAppSwitchPanel({ host: deps.host, call: deps.call, changed: deps.changed, openApps: deps.openApps,
      bulk: true, slotSelector: '[data-bulk-app-slot="' + index + '"]', ...(app ? { targetApp: app } : {}), updated,
      locked: () => loading || applying || groups.some(group => group.child.busy()),
      ...(deps.oauth ? { oauth: deps.oauth } : {}), ...(deps.storage ? { storage: deps.storage } : {}), now, ...(deps.id ? { id: deps.id } : {}) });
    const group = { account, child }; groups.push(group); return group;
  };
  const close = () => {
    if (applying) return;
    visible = false; generation++; clearTimer(); resetChildren(); loading = false; leaveAfterApply = false; error = ''; render();
  };
  const loadSelection = async (gen: number) => {
    const [found, config] = await Promise.all([deps.accounts(), deps.apps()]); if (disposed || gen !== generation) return;
    accounts = found; apps = (['google', 'microsoft'] as const).flatMap(issuer => savedOAuthAppsForIssuer(config, issuer)).filter(a => a.has_secret);
    appKey = ''; selected.clear(); phase = 'select';
  };
  const open = async (currentLane: string) => {
    if (disposed || busy()) return;
    close(); lane = currentLane; visible = true; phase = 'select'; accounts = []; apps = []; appKey = ''; selected.clear(); history = new Map(); error = ''; storageWarning = ''; loading = true; const gen = generation; render();
    try {
      try {
        const raw = storage()?.getItem(recoveryKey);
        if (raw) {
          if (raw.length > 20_000) throw Error('Invalid result references');
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed) || parsed.length > BULK_SAVED_APP_LIMIT || !parsed.every(validRecovery)
            || new Set(parsed.map(key)).size !== parsed.length) throw Error('Invalid result references');
          for (const row of parsed) history.set(key(row), { platform: row.platform, slug: row.slug, attempt: row.attempt,
            ...(row.app_id ? { app_id: row.app_id } : {}) });
        }
      } catch { storageWarning = 'Saved result references could not be read. Check affected accounts before starting a new switch.'; }
      if (history.size) {
        phase = 'review'; appKey = '';
        for (const row of history.values()) makeGroup({ platform: row.platform, slug: row.slug });
        render();
        for (const [i, row] of [...history.values()].entries()) { await groups[i]!.child.open(row.platform, row.slug, '', row); if (disposed || gen !== generation) return; }
      } else await loadSelection(gen);
    } catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'Accounts could not be read.'; }
    finally { if (!disposed && gen === generation) { loading = false; render(); slot()?.querySelector<HTMLElement>('[data-bulk-app-heading]')?.focus(); } }
  };
  const prepare = async () => {
    const app = target(); if (busy() || !app || !selected.size || selected.size > BULK_SAVED_APP_LIMIT) return;
    loading = true; phase = 'review'; stopped = false; error = ''; const gen = generation; const chosen = accounts.filter(a => a.issuer === app.issuer && selected.has(key(a)));
    const covered = new Set<string>(); render();
    try {
      for (const account of chosen) {
        if (disposed || gen !== generation) return; if (covered.has(key(account))) continue;
        const group = makeGroup({ platform: account.platform, slug: account.slug }, app); render(); await group.child.open(account.platform, account.slug, app.id);
        if (disposed || gen !== generation) return;
        const ctx = group.child.snapshot().context;
        if (ctx) {
          ctx.collections.forEach(row => covered.add(key(row)));
          if (ctx.current_app.id === app.id) { group.skipped = 'Already using the destination saved app. No switch needed.'; group.child.close(); }
        }
      }
    } finally { if (!disposed && gen === generation) { loading = false; render(); slot()?.querySelector<HTMLElement>('[data-bulk-app-heading]')?.focus(); } }
  };
  const apply = async () => {
    if (busy()) return;
    const checked = groups.filter(ready); if (!checked.length) return;
    const gen = generation; applying = true; stopped = false; error = ''; renderFooter();
    try { for (const group of checked) { if (disposed || gen !== generation || stopped) break; await group.child.apply(); } }
    finally { if (!disposed && gen === generation) { applying = false; if (leaveAfterApply) close(); else updated(); } }
  };
  const status = async () => {
    if (busy()) return; loading = true; const gen = generation; renderFooter();
    try { for (const group of groups) {
      if (disposed || gen !== generation) return;
      const saved = history.get(key(group.account)); if (!saved) continue;
      if (group.child.snapshot().attempt) await group.child.refreshStatus();
      else await group.child.open(saved.platform, saved.slug, '', saved);
    } } finally { if (!disposed && gen === generation) { loading = false; updated(); } }
  };
  const click = (event: Event) => {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-bulk-app-action]');
    if (!node || !slot()?.contains(node) || node.hasAttribute('disabled')) return; event.preventDefault();
    const action = node.dataset.bulkAppAction;
    if (action === 'stop') { stopped = true; renderFooter(); return; }
    if (action === 'close') { close(); return; }
    if (busy()) return;
    if (action === 'review') pending = prepare(); else if (action === 'apply') pending = apply(); else if (action === 'status') pending = status();
    else if (action === 'reload') pending = open(lane);
    else if (action === 'apps' && !unresolved()) { close(); deps.openApps(); }
    else if (action === 'again' && !unresolved()) {
      resetChildren(); history.clear(); persist(); pending = open(lane);
    }
  };
  const change = (event: Event) => {
    const node = event.target as HTMLInputElement | HTMLSelectElement | null; if (!node || !slot()?.contains(node) || busy() || phase !== 'select') return;
    if (node.hasAttribute('data-bulk-app-choice')) { appKey = node.value; selected.clear(); error = ''; render(); }
    else if (node.dataset.bulkAppAccount) {
      const account = accounts.find(a => key(a) === node.dataset.bulkAppAccount && a.issuer === target()?.issuer); if (!account) return;
      if ((node as HTMLInputElement).checked) { if (selected.size < BULK_SAVED_APP_LIMIT) selected.add(key(account)); else { (node as HTMLInputElement).checked = false; error = 'Select at most ' + BULK_SAVED_APP_LIMIT + ' accounts.'; } }
      else { selected.delete(key(account)); error = ''; } renderFooter();
    }
  };
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', change);
  return { open: (currentLane: string) => { pending = open(currentLane); return pending; }, close, render, busy, whenLoaded: () => pending,
    context(currentLane: string, stage: string) {
      if (!visible || currentLane === lane && stage === 'list') return;
      if (applying) { stopped = true; leaveAfterApply = true; renderFooter(); } else close();
    },
    dispose() { generation++; visible = false; stopped = true; clearTimer(); resetChildren(); disposed = true; deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', change); },
  };
};
