import { authenticationAccessRecheckResults, isAuthenticationRepairWorklist, type AuthenticationAccessChoice, type AuthenticationRepairCaller,
  type AuthenticationRepairGroup } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createFileDownloadPicker } from '../settings/file-download-picker.js';
import { appendAuthenticationAccessSummary, AUTHENTICATION_ACCESS_STYLES } from './authentication-access-panel.js';
import { BULK_ACCESS_ACCOUNT_LIMIT, BULK_ACCESS_TARGET_LIMIT, createBulkAuthenticationAccess } from './bulk-authentication-access.js';
import { connectionsVerifyAccessAddress } from './connections-navigation.js';
import { bulkAuthenticationAccessRechecks, bulkAuthenticationAccessRecheckSignature, type BulkAuthenticationAccessRecheck } from './bulk-authentication-access-rechecks.js';
import { createAuthenticationAccessRepairShortcuts } from './authentication-access-repair-shortcuts.js';
import { createAuthenticationAccessComparisons } from './authentication-access-comparison.js';

export const createBulkAuthenticationAccessPanel = (deps: { document: Document; read: AuthenticationRepairCaller;
  call: ManagedOAuthCaller; updated?(): void }) => {
  const doc = deps.document; let host: HTMLElement | null = null; let open = false; let disposed = false; let loading = false;
  let epoch = 0; let pending = Promise.resolve(); let groups: AuthenticationRepairGroup[] = []; let unavailable: string[] = []; let error = ''; let query = '';
  let rechecking = false; let rechecks: BulkAuthenticationAccessRecheck[] = []; let observedAt: number | undefined;
  let returnFocus: (() => void) | undefined; const selected = new Set<string>(); const choices = new Map<string, AuthenticationAccessChoice>();
  const pickerHost = doc.createElement('div');
  const batch = createBulkAuthenticationAccess({ call: deps.call, changed: () => render(), ...(deps.updated ? { updated: deps.updated } : {}) });
  const picker = createFileDownloadPicker({ document: doc, call: deps.call, mode: 'saved', changed: () => render() });
  const repairs = createAuthenticationAccessRepairShortcuts({ document: doc, call: deps.call, host: () => host,
    active: () => open && !disposed && !loading && !comparisons.busy() && ['finished', 'stopped'].includes(batch.phase()), changed: () => render() });
  const comparisons = createAuthenticationAccessComparisons({ document: doc, call: deps.call, host: () => host,
    active: () => open && !disposed && !loading && !repairs.busy() && ['finished', 'stopped'].includes(batch.phase()), changed: () => render() });
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n;
  };
  const live = (n: HTMLElement, gen: number): boolean => !disposed && open && gen === epoch && host?.contains(n) === true;
  const sectionFocused = (): boolean => !!doc.activeElement && doc.activeElement === host?.querySelector('[data-bulk-access]');
  const button = (label: string, action: string, fn: () => void, disabled = false): HTMLButtonElement => {
    const b = node('button', label); b.type = 'button'; b.disabled = disabled || (repairs.busy() || comparisons.busy()) && action !== 'close'; b.setAttribute('data-bulk-access-action', action);
    const gen = epoch; b.addEventListener('click', () => { if (live(b, gen) && !b.disabled) fn(); }); return b;
  };
  const close = (): void => { open = false; loading = false; epoch++; repairs.reset(); comparisons.reset(); picker.cancel(); batch.reset(); choices.clear(); selected.clear(); render(); returnFocus?.(); };
  const acceptList = (value: unknown): void => {
    if (!isAuthenticationRepairWorklist(value)) throw new Error('Invalid account list');
    const nextGroups = structuredClone(value.groups.filter(g => g.kind === 'account' && g.targets.some(t => t.kind !== 'oauth_apps')));
    const candidates = rechecking ? bulkAuthenticationAccessRechecks(value) : undefined;
    observedAt = value.observed_at; groups = nextGroups; rechecks = candidates?.checks ?? [];
    unavailable = [...value.unavailable, ...(candidates?.unavailable ?? [])];
    for (const id of selected) if (!(rechecking ? rechecks : groups).some(g => g.id === id)) selected.delete(id);
  };
  const load = (): Promise<void> => {
    if (disposed || !open || loading) return pending;
    const focusAtStart = doc.activeElement; const gen = ++epoch; repairs.reset(); comparisons.reset(); picker.cancel(); batch.reset(); choices.clear(); groups = []; rechecks = []; observedAt = undefined; unavailable = []; error = ''; loading = true; render();
    pending = (async () => {
      try {
        const value = await deps.read(); if (disposed || !open || gen !== epoch) return;
        acceptList(value);
      } catch { if (!disposed && open && gen === epoch) { selected.clear(); error = 'Saved accounts could not be read. Refresh or unlock Recued, then try again.'; } }
      finally { if (!disposed && open && gen === epoch) { loading = false; render(doc.activeElement === focusAtStart || doc.activeElement === doc.body || sectionFocused() ? 'search' : undefined); } }
    })(); return pending;
  };
  const review = (): void => {
    if (disposed || loading || batch.phase() !== 'idle' || !selected.size) return;
    const gen = epoch; const focusAtStart = doc.activeElement; choices.clear();
    const focusAfterReview = (): void => {
      if (!disposed && open && gen === epoch && (doc.activeElement === focusAtStart || doc.activeElement === doc.body || sectionFocused())) {
        render(batch.phase() === 'review' ? 'run' : selected.size ? 'review' : 'search');
      }
    };
    if (!rechecking) { void batch.prepare(groups.filter(g => selected.has(g.id))).then(focusAfterReview); return; }
    const chosen = rechecks.filter(c => selected.has(c.id)); loading = true; error = ''; render();
    pending = (async () => {
      try {
        const value = await deps.read(); if (disposed || !open || gen !== epoch) return;
        acceptList(value);
        const current = rechecks.filter(c => selected.has(c.id));
        if (chosen.some(before => !current.some(after => after.id === before.id && bulkAuthenticationAccessRecheckSignature(after) === bulkAuthenticationAccessRecheckSignature(before)))) {
          error = 'Saved results changed. Review the updated selections, then choose Review selected reads again.'; return;
        }
        loading = false; await batch.prepareRechecks(current);
      } catch { if (!disposed && open && gen === epoch) error = 'Saved results could not be refreshed. Retry the review or unlock Recued before continuing.'; }
      finally { if (!disposed && open && gen === epoch) { loading = false; render(); focusAfterReview(); } }
    })();
  };
  const render = (focus?: string): void => {
    if (!host || disposed) return;
    repairs.beginRender(); comparisons.beginRender();
    const ownedFocus = host.contains(doc.activeElement);
    const restore = focus ?? (ownedFocus ? doc.activeElement?.getAttribute('data-bulk-access-action') ?? undefined : undefined);
    const expandedSources = new Set(Array.from(host.querySelectorAll<HTMLDetailsElement>('[data-bulk-access-source]')).filter(n => n.open).map(n => n.getAttribute('data-bulk-access-source')));
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!open) return;
    const state = batch.snapshot(); const title = rechecking ? 'Recheck saved reads' : 'Verify multiple accounts'; const unit = rechecking ? 'saved check' : 'account';
    const section = node('section'); section.className = 'authentication-access bulk-authentication-access';
    section.setAttribute('aria-label', title); section.setAttribute('data-bulk-access', state.phase); section.setAttribute('data-bulk-access-mode', rechecking ? 'rechecks' : 'accounts'); section.tabIndex = -1;
    section.setAttribute('aria-busy', String(loading || state.phase === 'preparing' || state.issued));
    section.appendChild(node('h3', title));
    section.appendChild(node('p', rechecking ? 'Choose failed or unconfirmed reads from the latest retained completed checks. Review fresh resources, then run each saved check separately with current authentication. Earlier results stay in history.'
      : 'Choose saved accounts across your OAuth apps. Review their resources, then run read checks one account at a time using their saved authentication.'));
    if (error || state.error) { const p = node('p', error || state.error); p.setAttribute('role', 'alert'); section.appendChild(p); }
    if (loading) { const p = node('p', 'Reading saved accounts…'); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (state.phase === 'idle') {
      for (const message of unavailable) section.appendChild(node('p', message));
      if (rechecking && observedAt !== undefined) section.appendChild(node('p', 'Local results read: ' + new Date(observedAt).toLocaleString() + '. Refresh to include checks completed since then.'));
      section.appendChild(button(rechecking ? 'Show all saved accounts' : 'Recheck failed or unconfirmed reads', 'mode', () => { rechecking = !rechecking; selected.clear(); query = ''; void load(); }, loading));
      section.appendChild(node('p', 'Select up to ' + BULK_ACCESS_ACCOUNT_LIMIT + ' ' + unit + 's and ' + BULK_ACCESS_TARGET_LIMIT + ' resources. '
        + (rechecking ? 'Resources whose reads all passed are excluded. Unperformed writes are ignored. A saved check can cover several resources or accounts.' : 'This list includes accounts without recorded problems.')));
      const accounts = rechecking ? rechecks : groups;
      if (!loading && !accounts.length && !error) section.appendChild(node('p', rechecking ? 'No retained failed or unconfirmed reads are available to review. Show all saved accounts to check other resources.' : 'No saved accounts are available to review.'));
      const label = node('label', rechecking ? 'Find an account or saved check' : 'Find an account'); const search = node('input'); search.type = 'search'; search.id = 'bulk-access-search'; label.htmlFor = search.id;
      search.value = query; search.maxLength = 200; search.disabled = loading; search.setAttribute('data-bulk-access-action', 'search');
      const gen = epoch; search.addEventListener('input', () => { if (live(search, gen)) { query = search.value; render('search'); } }); section.appendChild(label); section.appendChild(search);
      section.appendChild(node('p', selected.size + ' selected.')); const list = node('ul');
      const filtered = accounts.filter(g => (g.label + ' ' + g.connection_names.join(' ') + ('account_labels' in g ? ' ' + g.account_labels.join(' ') : '')).toLowerCase().includes(query.trim().toLowerCase()));
      for (const group of filtered) {
        const li = node('li'); const choice = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = selected.has(group.id);
        input.disabled = loading || !input.checked && selected.size >= BULK_ACCESS_ACCOUNT_LIMIT;
        input.setAttribute('data-bulk-access-account', group.id); input.setAttribute('data-bulk-access-action', 'select-' + group.id);
        input.addEventListener('change', () => { if (!live(input, gen) || loading || input.disabled) return;
          if (input.checked && selected.size < BULK_ACCESS_ACCOUNT_LIMIT) selected.add(group.id); else selected.delete(group.id); render('select-' + group.id);
        });
        choice.appendChild(input); choice.appendChild(node('span', group.label)); li.appendChild(choice);
        li.appendChild(node('p', 'evidence' in group ? group.evidence.length + ' non-passing read resource' + (group.evidence.length === 1 ? '' : 's') + ' · Finished ' + new Date(group.evidence[0]!.finished_at!).toLocaleString()
          : group.authentication === 'direct_oauth' ? 'Recued direct OAuth' : group.authentication === 'broker' ? 'Broker sign-in' : 'Saved authentication')); list.appendChild(li);
      }
      if (!filtered.length && accounts.length) section.appendChild(node('p', 'No ' + unit + 's match this search.'));
      section.appendChild(list);
      section.appendChild(button(rechecking ? 'Review selected reads' : 'Review selected accounts', 'review', review, loading || !selected.size));
      section.appendChild(button(rechecking ? 'Refresh saved checks' : 'Refresh accounts', 'load', () => { void load(); }, loading));
    } else {
      const ready = state.rows.filter(r => r.state === 'ready'); const completed = state.rows.filter(r => r.state === 'completed').length;
      const progress = node('p', state.phase === 'preparing' ? 'Preparing local resource reviews…' : state.phase === 'review'
        ? ready.length + ' ' + unit + (ready.length === 1 ? ' ready, ' : 's ready, ') + ready.reduce((n, r) => n + r.target_ids.length, 0) + ' unique resources. Unavailable and duplicate checks will not start.'
        : completed + ' saved checks finished. Review each result below.'); progress.setAttribute('role', 'status'); section.appendChild(progress);
      if (state.phase === 'review') section.appendChild(node('p', 'Duplicate resources are included once. Blank API URLs remain unconfirmed. File downloads require a file you choose. Only Run checks contacts vendors.'));
      if (state.phase === 'paused') { const p = node('p', 'The queue is paused because a saved outcome could not be confirmed. Recover the current outcome to continue, or stop the remaining checks.');
        p.setAttribute('role', 'alert'); section.appendChild(p); section.appendChild(button('Recover saved outcome and continue', 'recover', () => { void batch.recover(); }, state.issued)); }
      if (state.phase === 'stopped') section.appendChild(node('p', 'Unstarted checks were stopped. Started jobs keep running on the server and stay in connection history.'));
      for (const row of state.rows) {
        const article = node('article'); article.setAttribute('data-bulk-access-row', row.id); article.appendChild(node('h4', row.label));
        const labels = { preparing: 'Reading local review', ready: 'Ready to check', unavailable: 'Review unavailable', duplicate: 'Already included', queued: 'Waiting to start',
          starting: 'Starting check', checking: 'Reading saved progress', completed: 'Saved check finished', unconfirmed: 'Outcome unconfirmed', stopped: 'Not started' } as const;
        article.appendChild(node('p', labels[row.state])); if (row.message) article.appendChild(node('p', row.message));
        if (row.source) { const original = node('details'); original.setAttribute('data-bulk-access-source', row.id); original.open = expandedSources.has(row.id);
          const summary = node('summary', 'Earlier saved check'); summary.setAttribute('data-bulk-access-action', 'source-' + row.id); original.appendChild(summary);
          appendAuthenticationAccessSummary(doc, original, row.source); article.appendChild(original);
          article.appendChild(node('p', 'Only the listed non-passing read resources are selected for this recheck. Earlier passes remain in their original receipt. File download checks may repeat metadata reads.'));
        }
        if (row.preview?.targets_truncated || row.preview && !row.preview.usage_available) article.appendChild(node('p', 'Some resources or affected uses are missing. This check covers only the listed resources.'));
        if (row.result) {
          appendAuthenticationAccessSummary(doc, article, row.result, ['finished', 'stopped'].includes(state.phase) && !state.issued ? repairs.append : undefined);
          if (['finished', 'stopped'].includes(state.phase) && !state.issued) comparisons.append(article, row.result);
        }
        else for (const target of row.preview?.targets.filter(t => row.target_ids.includes(t.id)) ?? []) {
          article.appendChild(node('h5', target.label));
          const editable = state.phase === 'review' && row.state === 'ready';
          if (target.check === 'api_read') {
            const label = node('label', 'Read-only API resource URL'); const input = node('input'); input.type = 'url'; input.maxLength = 4096;
            input.id = 'bulk-access-url-' + target.id; label.htmlFor = input.id; input.value = choices.get(target.id)?.url ?? ''; input.disabled = !editable || picker.active();
            input.setAttribute('data-bulk-access-url', target.id); input.setAttribute('data-bulk-access-action', 'url-' + target.id); const gen = epoch;
            input.addEventListener('input', () => { if (live(input, gen) && !input.disabled && batch.phase() === 'review') choices.set(target.id, { target_id: target.id, url: input.value }); });
            article.appendChild(label); article.appendChild(input); article.appendChild(node('p', 'Choose a protected resource within ' + target.base_url + '. A Google Sheets link is accepted. Leave blank to keep this read unconfirmed.'));
          } else if (target.check === 'file_metadata' && target.file_connection) {
            article.appendChild(node('p', choices.get(target.id)?.file_id ? 'A file is selected for download/export verification (up to 10 MiB).' : 'File metadata will be checked. Choose a file to check its download or export.'));
            article.appendChild(button(choices.get(target.id)?.file_id ? 'Change selected file' : 'Choose a file', 'file-' + target.id, () => {
              const gen = epoch; const connection = target.file_connection!;
              void picker.choose(connection.name, connection.updated_at, () => !disposed && open && gen === epoch && batch.phase() === 'review').then(choice => {
                if (!disposed && open && gen === epoch && batch.phase() === 'review') {
                  if (choice) choices.set(target.id, { target_id: target.id, ...(choice.fileId ? { file_id: choice.fileId } : {}) });
                  render('file-' + target.id);
                }
              });
            }, !editable || picker.active()));
          } else article.appendChild(node('p', target.check === 'collection_read' ? 'Check the saved account and its selected folders or calendars.' : target.check === 'file_metadata'
            ? 'Check file metadata. A download choice is unavailable for this source.' : 'A supported read check is unavailable; this result will stay unconfirmed.'));
        }
        if (row.preview?.uses.length) { const details = node('details'); details.appendChild(node('summary', 'Affected uses (' + row.preview.uses.length + ')'));
          for (const use of row.preview.uses) details.appendChild(node('p', use.label)); details.appendChild(node('p', 'These workflows are not run by access verification.')); article.appendChild(details); }
        const separate = node('a', rechecking ? 'Review this saved check separately' : 'Review this account separately'); separate.href = connectionsVerifyAccessAddress(row.selection).hash;
        separate.setAttribute('href', separate.href); article.appendChild(separate); section.appendChild(article);
      }
      section.appendChild(pickerHost);
      if (state.phase === 'review') section.appendChild(button('Run checks for ' + ready.length + ' ' + unit + (ready.length === 1 ? '' : 's'), 'run', () => { picker.cancel(); void batch.start([...choices.values()]); }, !ready.length || picker.active()));
      if (state.phase === 'running' || state.phase === 'paused') section.appendChild(button('Stop remaining checks', 'stop', () => batch.stop()));
      if (state.phase === 'running' || state.phase === 'paused') section.appendChild(node('p', 'Finish or stop the remaining checks before opening authentication settings from these results.'));
      if (state.phase === 'finished' || state.phase === 'stopped') section.appendChild(button('Refresh saved outcomes', 'status', () => { comparisons.reset(); void batch.refresh(); }, state.issued));
      if ((state.phase === 'finished' || state.phase === 'stopped') && state.rows.some(r => r.result && authenticationAccessRecheckResults(r.result).length)) {
        section.appendChild(button('Review failed or unconfirmed reads', 'recheck-results', () => {
          const ids = state.rows.flatMap(r => r.result && authenticationAccessRecheckResults(r.result).length ? [r.result.id] : []);
          rechecking = true; selected.clear(); ids.forEach(id => selected.add(id)); query = ''; void load();
        }, state.issued));
      }
      if (state.phase !== 'running' && state.phase !== 'preparing') section.appendChild(button(state.phase === 'review' ? 'Change accounts' : 'Review accounts again', 'again', () => { void load(); }, state.issued || picker.active()));
    }
    const history = node('a', 'Connection incident history'); history.href = '#connections/others/incident-history'; history.setAttribute('href', history.href); section.appendChild(history);
    section.appendChild(node('p', 'A failed read continues to the next account. Uncertain start or status replies pause the queue. Reads do not prove writes, workflows or sync, and do not clear recorded incidents.'));
    section.appendChild(button('Close', 'close', close, state.phase === 'running'));
    host.appendChild(section);
    // The picker restores focus while rendering, so its host must be connected.
    if (state.phase !== 'idle') picker.mount(pickerHost);
    if (!picker.active()) {
      const destination = restore ? host.querySelector<HTMLElement>('[data-bulk-access-action="' + restore + '"]') : null;
      if (destination && !('disabled' in destination && destination.disabled === true)) destination.focus();
      else if (ownedFocus || focus) section.focus();
    }
  };
  return {
    mount(element: HTMLElement): void { if (host !== element) { host = element; render(); } },
    open(onClose?: () => void): Promise<void> { if (disposed || open) return pending; open = true; rechecking = false; returnFocus = onClose; selected.clear(); query = ''; return load(); },
    hasDraft: (): boolean => open && (selected.size > 0 && batch.phase() === 'idle' || ['preparing', 'review', 'paused'].includes(batch.phase())),
    busy: (): boolean => open && batch.phase() === 'running',
    whenLoaded: async (): Promise<void> => { await pending; await batch.whenLoaded(); await repairs.whenLoaded(); await comparisons.whenLoaded(); },
    dispose(): void { disposed = true; open = false; epoch++; repairs.dispose(); comparisons.dispose(); picker.dispose(); batch.dispose(); host = null; },
  };
};
export const BULK_AUTHENTICATION_ACCESS_STYLES = AUTHENTICATION_ACCESS_STYLES + `.bulk-authentication-access ul{list-style:none;padding:0}.bulk-authentication-access li{padding:8px 0;border-top:1px solid var(--border)}.bulk-authentication-access input[type=checkbox]{margin-right:8px}.bulk-authentication-access input[type=search]{box-sizing:border-box;width:100%;font:inherit;padding:8px}.bulk-authentication-access h5{font-size:14px;margin:10px 0}.bulk-authentication-access a{display:inline-block;max-width:100%;overflow-wrap:anywhere}`;
