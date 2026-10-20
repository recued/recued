import { isAuthenticationAccessPreview, isAuthenticationAccessVerification, authenticationAccessRecheckResults, authenticationIncidentScope,
  type AuthenticationAccessPreview, type AuthenticationAccessSelection, type AuthenticationAccessVerification,
  type AuthenticationAccessChoice, type AuthenticationAccessResult, type AuthenticationAccessSummaryEvidence } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createFileDownloadPicker, FILE_DOWNLOAD_PICKER_STYLES } from '../settings/file-download-picker.js';
import { connectionsVerifyAccessAddress, connectionsAccessCheckAddress, isConnectionAccessResultReference, isConnectionAccessCheckReference,
  type ConnectionAccessResultReference, type ConnectionAccessCheckReference } from './connections-navigation.js';
import { authenticationAccessRepairLabel, createAuthenticationAccessRepairShortcuts, type AccessRepairRenderer } from './authentication-access-repair-shortcuts.js';
import { appendAuthenticationAccessResult } from './authentication-access-result.js';
import { createAuthenticationAccessComparisons, matchesAuthenticationAccessEvidence, AUTHENTICATION_ACCESS_COMPARISON_STYLES } from './authentication-access-comparison.js';
export { appendAuthenticationAccessResult } from './authentication-access-result.js';
export const matchesAuthenticationAccessTargets = (value: Pick<AuthenticationAccessVerification, 'results'>,
  expected: readonly Pick<AuthenticationAccessPreview['targets'][number], 'id' | 'target' | 'authentication_revision'>[]): boolean =>
  value.results.length === expected.length && value.results.every(result => expected.some(target => target.id === result.id
    && target.authentication_revision === result.authentication_revision
    && JSON.stringify(authenticationIncidentScope(target.target)) === JSON.stringify(authenticationIncidentScope(result.target))));
export const appendAuthenticationAccessSummary = (doc: Document, parent: HTMLElement, value: AuthenticationAccessVerification, repair?: AccessRepairRenderer, targetId?: string): void => {
  const add = (tag: 'p' | 'h4', text: string, where = parent): HTMLElement => { const node = doc.createElement(tag); node.textContent = text; where.appendChild(node); return node; };
  const section = doc.createElement('div'); section.setAttribute('data-authentication-access-result', value.id); parent.appendChild(section);
  add('p', value.status === 'checking' ? 'Access checks are running in the background.' : 'Access check finished: ' + new Date(value.finished_at!).toLocaleString() + '.', section);
  if (value.selection.kind === 'verification') add('p', 'This is a separate recheck of selected reads. Earlier results remain in history; they are not new proof of access.', section);
  for (const result of value.results) { appendAuthenticationAccessResult(doc, section, result); repair?.(section, value, result); }
  if (repair && value.results.some(r => authenticationAccessRepairLabel(value, r))) add('p', 'Review authentication opens current settings before any sign-in or change. An unconfirmed read may need a resource choice instead.', section);
  if (value.targets_truncated || !value.usage_available) add('p', 'The affected-use inventory is incomplete. These results cover only the listed checks.', section);
  if (value.uses.length) {
    const details = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Related uses (' + value.uses.length + ')'; details.appendChild(summary);
    const list = doc.createElement('ul');
    for (const use of value.uses) { const item = doc.createElement('li'); item.textContent = use.label + ' · ' + use.kind
      + (['pack', 'recipe', 'dish', 'schedule'].includes(use.kind) ? ' · Workflow execution unconfirmed' : ' · Only the listed read checks are covered'); list.appendChild(item); }
    details.appendChild(list); section.appendChild(details);
  }
  add('p', 'Read results cover the checked resources. Sending, editing, workflows and failed jobs were not run. Repair and sync outcomes remain separate.', section);
  const page = doc.createElement('a'); page.className = 'authentication-access-page'; page.textContent = 'Open saved check page';
  page.href = connectionsAccessCheckAddress({ verification_id: value.id, view: 'result', ...(targetId ? { target_id: targetId } : {}) }).hash;
  page.setAttribute('href', page.href); page.setAttribute('data-authentication-access-page', value.id); section.appendChild(page);
};

/** A review starts local-only. Only Run checks contacts the selected vendors. */
export const createAuthenticationAccessPanel = (deps: { document: Document; call: ManagedOAuthCaller; updated?(): void;
  savedCheck?(reference: ConnectionAccessCheckReference): void }) => {
  const doc = deps.document; let host: HTMLElement | null = null; let disposed = false; let open = false; let generation = 0;
  let selection: AuthenticationAccessSelection | undefined; let preview: AuthenticationAccessPreview | undefined; let result: AuthenticationAccessVerification | undefined;
  let busy = false; let starting = false; let error = ''; let attempt: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve(); const choices = new Map<string, AuthenticationAccessChoice>(); const selected = new Set<string>();
  let returnFocus: (() => void) | undefined;
  let savedEntry: AuthenticationAccessSummaryEvidence | undefined;
  let savedReviewSelection: AuthenticationAccessSelection | undefined;
  let savedResultReference: ConnectionAccessResultReference | undefined;
  let savedCheckReference: ConnectionAccessCheckReference | undefined; let pendingComparison = false;
  let recheckTarget: Pick<AuthenticationAccessResult, 'id' | 'target'> | undefined;
  const retire = (id: string | undefined): void => {
    if (!id) return;
    try { void deps.call({ action: 'authentication_access_retire', review_id: id }).catch(() => {}); } catch { /* Closing still works while disconnected. */ }
  };
  const sameSelection = (other: AuthenticationAccessSelection): boolean => other.kind === selection?.kind && other.id === selection.id;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const stopTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const button = (text: string, action: string, fn: () => void, disabled = busy || repairs.busy() || comparisons.busy()): HTMLButtonElement => {
    const b = node('button', text); b.type = 'button'; b.disabled = disabled; b.setAttribute('data-authentication-access-action', action);
    const gen = generation; b.addEventListener('click', () => { if (!disposed && open && gen === generation && host?.contains(b) && !b.disabled) fn(); }); return b;
  };
  const picker = createFileDownloadPicker({ document: doc, call: deps.call, mode: 'saved', changed: () => render() });
  const repairs = createAuthenticationAccessRepairShortcuts({ document: doc, call: deps.call, host: () => host,
    active: () => open && !disposed && !busy && !starting && !comparisons.busy(), changed: () => render() });
  const comparisons = createAuthenticationAccessComparisons({ document: doc, call: deps.call, host: () => host,
    active: () => open && !disposed && !busy && !starting && !repairs.busy(), changed: () => render() });
  const render = (focus?: string): void => {
    if (disposed || !host) return;
    repairs.beginRender(); comparisons.beginRender();
    const restore = focus ?? (host.contains?.(doc.activeElement) ? doc.activeElement?.getAttribute('data-authentication-access-action') ?? undefined : undefined);
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!open) return;
    const savedView = !!savedEntry || !!savedResultReference || !!savedCheckReference;
    const section = node('section'); section.className = 'authentication-access'; section.setAttribute('aria-label', savedView ? 'Saved access check' : 'Verify access');
    section.setAttribute('aria-busy', String(busy)); section.tabIndex = -1;
    section.appendChild(node('h3', savedView ? 'Saved access check' : 'Verify access'));
    section.appendChild(node('p', savedView ? 'These are saved read results. Opening this result does not confirm that a repair succeeded. Review current access to run a new check.' : selection?.kind === 'verification'
      ? 'Choose which failed or unconfirmed reads to check again. Review the saved accounts and resources, then choose Run checks.'
      : 'Check the authentication currently saved in Recued. Review the resources below, then run bounded read checks. Earlier repairs and token renewals remain recorded separately.'));
    if (selection?.kind === 'renewal') section.appendChild(node('p', 'This review covers the accounts retained with that renewal result, including excluded or unavailable authorizations. Current authentication may have changed since renewal.'));
    if (selection?.kind === 'verification') section.appendChild(node('p', 'Earlier passed results stay in history. Sending and editing are not tested. Checking a file download or export may repeat its metadata read.'));
    if (busy) { const p = node('p', savedView ? 'Reading saved check…' : preview ? 'Starting access checks…' : 'Reading saved authentication…'); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (error) { const p = node('p', error); p.setAttribute('role', 'alert'); section.appendChild(p); }
    if (error && !preview && !result) section.appendChild(button(savedView ? 'Retry saved check' : 'Retry review', 'retry-review', () => {
      if (savedCheckReference) void openCheck(savedCheckReference, returnFocus);
      else if (savedResultReference) void openResult(savedResultReference, returnFocus);
      else if (savedEntry) void openSaved(savedEntry, returnFocus, savedReviewSelection); else void review();
    }));
    if (error && preview) section.appendChild(button('Review again', 'restart-review', () => { void review(); }));
    if (error && (savedResultReference || savedCheckReference || selection?.kind === 'verification')) {
      const fallback = node('a', 'Open Authentication repairs'); fallback.href = '#connections/others';
      fallback.setAttribute('data-authentication-access-fallback', 'repairs'); section.appendChild(fallback);
    }
    if (result) {
      const focusedId = savedResultReference?.target_id ?? savedCheckReference?.target_id;
      const returnedTarget = focusedId ? result.results.find(r => r.id === focusedId) : undefined;
      if (returnedTarget) section.appendChild(node('p', savedResultReference ? 'Showing the resource that opened this repair. Other results stay in connection history.' : 'Showing the selected resource in this saved check.'));
      if (savedCheckReference?.target_id) {
        const all = node('a', 'View all results in this check'); all.href = connectionsAccessCheckAddress({ verification_id: result.id, view: 'result' }).hash;
        all.setAttribute('href', all.href); all.setAttribute('data-authentication-access-all', result.id); section.appendChild(all);
      }
      if (savedCheckReference?.view === 'comparison' && (result.status !== 'completed' || result.selection.kind !== 'verification' || result.id === result.selection.id)) {
        const notice = node('p', result.status === 'checking' ? 'This saved check is still running. Its comparison will open when the recheck finishes.'
          : 'Comparisons are available for completed rechecks. This saved result is still shown.'); notice.setAttribute('role', 'status'); section.appendChild(notice);
      }
      appendAuthenticationAccessSummary(doc, section, returnedTarget ? { ...result, results: [returnedTarget] } : result, repairs.append, returnedTarget?.id);
      comparisons.append(section, result, returnedTarget?.id);
      if (savedCheckReference && result.status === 'completed') section.appendChild(button('Refresh saved check', 'status', () => { void status(); }));
      if (result.status === 'checking') section.appendChild(button('Refresh check status', 'status', () => { void status(); }));
      else {
        if (returnedTarget && authenticationAccessRecheckResults(result).some(r => r.id === returnedTarget.id)) section.appendChild(button('Review current access for this resource', 'review-returned', () => {
          recheckTarget = { id: returnedTarget.id, target: structuredClone(returnedTarget.target) };
          selection = { kind: 'verification', id: result!.id }; savedResultReference = undefined; savedEntry = undefined; savedReviewSelection = undefined;
          void review();
        }));
        else if (!returnedTarget && authenticationAccessRecheckResults(result).length) {
          const recheck = node('a', 'Review failed or unconfirmed reads'); recheck.href = connectionsVerifyAccessAddress({ kind: 'verification', id: result.id }).hash;
          recheck.setAttribute('href', recheck.href); recheck.setAttribute('data-authentication-access-action', 'recheck'); section.appendChild(recheck);
        }
        if (!returnedTarget && savedEntry && savedReviewSelection) {
          const link = node('a', 'Review current access'); link.href = connectionsVerifyAccessAddress(savedReviewSelection).hash;
          link.setAttribute('href', link.href); link.setAttribute('data-authentication-access-action', 'review'); section.appendChild(link);
        } else if (!returnedTarget && selection?.kind !== 'verification') section.appendChild(button('Review new checks', 'review', () => { void review(); }));
      }
    }
    if (preview) {
      section.appendChild(node('p', preview.label));
      if (recheckTarget) section.appendChild(node('p', 'The resource that opened the repair starts selected. Review current authentication and choose fresh URLs or files. Include other resources only if you want to check them too.'));
      if (preview.targets_truncated || !preview.usage_available) section.appendChild(node('p', 'Some affected uses are unavailable or omitted. Verification covers only the listed targets.'));
      for (const target of preview.targets) {
        const article = node('article'); article.appendChild(node('h4', target.label));
        const locked = busy || attempt !== undefined;
        if (selection?.kind === 'verification') {
          const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = selected.has(target.id); input.disabled = locked || picker.active();
          input.setAttribute('aria-label', 'Recheck ' + target.label);
          input.setAttribute('data-authentication-access-target', target.id); input.setAttribute('data-authentication-access-action', 'target-' + target.id);
          const gen = generation; input.addEventListener('change', () => { if (!disposed && gen === generation && host?.contains(input) && !busy && !attempt && !picker.active()) {
            if (input.checked) selected.add(target.id); else selected.delete(target.id); render('target-' + target.id);
          } }); label.appendChild(input); label.appendChild(node('span', ' Include in recheck')); article.appendChild(label);
        }
        const disabled = locked || selection?.kind === 'verification' && !selected.has(target.id);
        if (target.check === 'api_read') {
          const id = 'authentication-access-url-' + target.id; const label = node('label', 'Read-only API resource URL'); label.htmlFor = id; article.appendChild(label);
          const input = node('input'); input.type = 'url'; input.id = id; input.maxLength = 4096; input.disabled = disabled;
          input.value = choices.get(target.id)?.url ?? ''; input.setAttribute('data-authentication-access-url', target.id);
          const gen = generation; input.addEventListener('input', () => { if (!disposed && gen === generation && host?.contains(input) && !input.disabled) {
            choices.set(target.id, { target_id: target.id, url: input.value });
          } }); article.appendChild(input);
          article.appendChild(node('p', 'Choose a resource requiring sign-in within ' + target.base_url + '. A Google Sheets link is accepted. Leave blank to keep this API read unconfirmed.'));
        } else if (target.check === 'file_metadata' && target.file_connection) {
          article.appendChild(node('p', choices.get(target.id)?.file_id ? 'A file is selected for download/export verification (up to 10 MiB).' : 'File metadata will be checked. Choose a file to also check its download or export.'));
          article.appendChild(button(choices.get(target.id)?.file_id ? 'Change selected file' : 'Choose a file', 'file-' + target.id, () => {
            const plan = preview!; const gen = generation;
            void picker.choose(target.file_connection!.name, target.file_connection!.updated_at, () => !disposed && open && preview === plan && gen === generation).then(choice => {
              if (!disposed && open && preview === plan && gen === generation && choice) {
                choices.set(target.id, { target_id: target.id, ...(choice.fileId ? { file_id: choice.fileId } : {}) }); render('file-' + target.id);
              }
            });
          }, disabled || picker.active()));
        } else article.appendChild(node('p', target.check === 'collection_read' ? 'Check the saved account and its selected folders or calendars.' : 'A supported read check is unavailable for this target.'));
        section.appendChild(article);
      }
      section.appendChild(node('p', 'No messages are sent, events edited, or workflows executed. Remote reads can refresh an expired OAuth token.'));
      if (selection?.kind === 'verification') section.appendChild(node('p', selected.size + ' of ' + preview.targets.length + ' targets selected.'));
      if (error && attempt) section.appendChild(node('p', 'Retry keeps the same selected targets and resources. Choose Review again to change them.'));
      section.appendChild(button('Run checks', 'run', () => { void run(); }, busy || repairs.busy() || picker.active() || selection?.kind === 'verification' && !selected.size));
    }
    const pickerHost = node('div'); section.appendChild(pickerHost); host.appendChild(section); picker.mount(pickerHost);
    section.appendChild(button('Close', 'close', () => { generation++; repairs.reset(); comparisons.reset(); open = false; busy = false; starting = false; stopTimer(); retire(preview?.id); preview = undefined; picker.cancel(); render(); returnFocus?.(); }, false));
    if (restore) (host.querySelector<HTMLElement>('[data-authentication-access-action="' + restore + '"]') ?? section).focus({ preventScroll: true });
  };
  const openRequestedComparison = async (): Promise<void> => {
    if (!pendingComparison || !savedCheckReference || result?.status !== 'completed') return;
    pendingComparison = false;
    if (result.selection.kind === 'verification' && result.id !== result.selection.id) await comparisons.open(result, savedCheckReference.target_id);
  };
  const review = (): Promise<void> => {
    if (!selection || disposed || busy || repairs.busy() || comparisons.busy()) return pending;
    const focusAtStart = doc.activeElement;
    stopTimer(); const gen = ++generation; repairs.reset(); comparisons.reset(); savedCheckReference = undefined; pendingComparison = false; picker.cancel(); retire(preview?.id); busy = true; error = ''; preview = undefined; result = undefined; choices.clear(); selected.clear(); attempt = undefined; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_preview', selection: selection! });
        if (disposed || !open || gen !== generation) {
          if (reply.action === 'authentication_access_preview' && isAuthenticationAccessPreview(reply.preview)) retire(reply.preview.id);
          return;
        }
        if (reply.action !== 'authentication_access_preview' || !isAuthenticationAccessPreview(reply.preview) || !sameSelection(reply.preview.selection)
          || reply.preview.running && !matchesAuthenticationAccessTargets(reply.preview.running, reply.preview.targets)) throw new Error('Invalid preview');
        if (recheckTarget && !reply.preview.targets.some(t => t.id === recheckTarget!.id
          && JSON.stringify(authenticationIncidentScope(t.target)) === JSON.stringify(authenticationIncidentScope(recheckTarget!.target)))) {
          retire(reply.preview.id); throw new Error('The original resource is no longer in this review');
        }
        preview = structuredClone(reply.preview);
        if (preview.running) { result = preview.running; retire(preview.id); preview = undefined; }
        else for (const target of preview.targets) {
          if (!recheckTarget || target.id === recheckTarget.id) selected.add(target.id);
          choices.set(target.id, { target_id: target.id, ...(target.default_url ? { url: target.default_url } : {}) });
        }
      } catch { if (!disposed && gen === generation) error = selection?.kind === 'verification'
        ? 'Access checks could not be prepared. Unlock Recued and retry. If the saved result is gone, open Authentication repairs for a fresh Verify access review.'
        : 'Access checks could not be prepared. Unlock Recued, refresh the saved accounts, or update the server, then try again.'; }
      finally { if (!disposed && gen === generation) {
        const restoreFocus = doc.activeElement === focusAtStart || doc.activeElement === doc.body || doc.activeElement === host?.firstChild;
        busy = false; render(restoreFocus ? error ? 'retry-review' : result ? 'status' : 'run' : undefined); if (!error) {
          poll(); if (result) deps.savedCheck?.({ verification_id: result.id, view: 'result' });
        }
      } }
    })(); return pending;
  };
  const poll = (): void => { stopTimer(); if (!disposed && open && result?.status === 'checking') timer = setTimeout(() => { void status(); }, 1500); };
  const status = (): Promise<void> => {
    if (disposed || !result || busy || repairs.busy() || comparisons.busy()) return pending;
    stopTimer(); comparisons.reset(); pendingComparison = savedCheckReference?.view === 'comparison';
    const gen = generation; const previous = result; const id = previous.id; busy = true; error = ''; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_status', id });
        if (disposed || !open || gen !== generation) return;
        if (reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification)
          || reply.verification.id !== id || !sameSelection(reply.verification.selection) || reply.verification.started_at !== previous.started_at
          || previous.status === 'completed' && (reply.verification.status !== 'completed' || reply.verification.finished_at !== previous.finished_at)
          || !matchesAuthenticationAccessTargets(reply.verification, previous.results)
          || previous.status === 'completed' && !matchesAuthenticationAccessEvidence(reply.verification, previous)) throw new Error('Invalid status');
        result = structuredClone(reply.verification); if (result.status === 'completed') deps.updated?.();
      } catch { if (!disposed && gen === generation) error = 'Check status could not be refreshed. Earlier results are still shown. Retry refresh to read the saved outcome.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); if (!error) { await openRequestedComparison(); if (!disposed && gen === generation) poll(); } } }
    })(); return pending;
  };
  const run = (): Promise<void> => {
    if (!preview || disposed || busy || repairs.busy() || picker.active() || selection?.kind === 'verification' && !selected.size) return pending;
    if (!attempt) {
      const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes);
      attempt = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const gen = generation; const plan = preview; const targets = plan.targets.filter(t => selected.has(t.id)); busy = true; starting = true; error = ''; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_run', review_id: plan.id, fingerprint: plan.fingerprint, attempt_id: attempt!,
          choices: [...choices.values()].filter(c => selected.has(c.target_id)),
          ...(plan.selection.kind === 'verification' ? { target_ids: targets.map(t => t.id) } : {}) });
        if (disposed || !open || gen !== generation) return;
        if (reply.action !== 'authentication_access_run' || !isAuthenticationAccessVerification(reply.verification) || !sameSelection(reply.verification.selection)
          || !matchesAuthenticationAccessTargets(reply.verification, targets)) throw new Error('Invalid result');
        result = structuredClone(reply.verification); preview = undefined; deps.updated?.();
      } catch { if (!disposed && gen === generation) error = 'The checks could not be started or their receipt was not received. Retry with the same review, or refresh history to read any saved outcome.'; }
      finally { if (!disposed && gen === generation) { busy = false; starting = false; render('status'); if (!error) {
        poll(); if (result) deps.savedCheck?.({ verification_id: result.id, view: 'result' });
      } } }
    })(); return pending;
  };
  const openSaved = (entry: AuthenticationAccessSummaryEvidence, onClose?: () => void, reviewSelection = entry.selection): Promise<void> => {
    stopTimer(); generation++; repairs.reset(); comparisons.reset(); picker.cancel(); retire(preview?.id); savedEntry = structuredClone(entry); returnFocus = onClose;
    savedResultReference = undefined; recheckTarget = undefined;
    savedCheckReference = undefined; pendingComparison = false;
    open = true; selection = { kind: entry.selection.kind, id: entry.selection.id }; busy = true; starting = false; error = ''; preview = undefined; result = undefined; attempt = undefined;
    savedReviewSelection = { kind: reviewSelection.kind, id: reviewSelection.id };
    const gen = generation; const expected = savedEntry; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_status', id: expected.id });
        if (disposed || !open || gen !== generation) return;
        const target = reply.action === 'authentication_access_status' && isAuthenticationAccessVerification(reply.verification)
          ? reply.verification.results.find(r => r.id === expected.result.id) : undefined;
        if (reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification)
          || reply.verification.id !== expected.id || !sameSelection(reply.verification.selection) || reply.verification.started_at !== expected.started_at
          || expected.status === 'completed' && (reply.verification.status !== 'completed' || reply.verification.finished_at !== expected.finished_at)
          || !target || !matchesAuthenticationAccessTargets({ results: [target] }, [expected.result])) throw new Error('Invalid saved check');
        result = structuredClone(reply.verification);
      } catch { if (!disposed && gen === generation) error = 'This saved check could not be opened. Refresh the summary or open connection history. No new checks were started.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(result?.status === 'checking' ? 'status' : undefined); if (!error) poll(); } }
    })(); return pending;
  };
  const openResult = (reference: ConnectionAccessResultReference, onClose?: () => void): Promise<void> => {
    if (disposed) return pending;
    const focusAtStart = doc.activeElement;
    stopTimer(); generation++; repairs.reset(); comparisons.reset(); picker.cancel(); retire(preview?.id); savedEntry = undefined; savedReviewSelection = undefined;
    savedResultReference = { verification_id: reference.verification_id, target_id: reference.target_id }; recheckTarget = undefined; returnFocus = onClose;
    savedCheckReference = undefined; pendingComparison = false;
    open = true; selection = undefined; busy = true; starting = false; error = ''; preview = undefined; result = undefined; attempt = undefined; choices.clear(); selected.clear();
    const gen = generation; const expected = savedResultReference; render();
    pending = (async () => {
      try {
        if (!isConnectionAccessResultReference(expected)) throw new Error('Invalid reference');
        const reply = await deps.call({ action: 'authentication_access_status', id: expected.verification_id });
        if (disposed || !open || gen !== generation) return;
        if (!reply || reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification)
          || reply.verification.id !== expected.verification_id
          || !authenticationAccessRecheckResults(reply.verification).some(r => r.id === expected.target_id)) throw new Error('Invalid saved check');
        result = structuredClone(reply.verification); selection = { kind: result.selection.kind, id: result.selection.id };
      } catch { if (!disposed && gen === generation) error = 'This saved result is unavailable or no longer contains that failed or unconfirmed read. Open connection history or Authentication repairs for a fresh review. No new checks were started.'; }
      finally { if (!disposed && gen === generation) {
        const restoreFocus = doc.activeElement === focusAtStart || doc.activeElement === doc.body || doc.activeElement === host?.firstChild;
        busy = false; render(restoreFocus ? result ? 'review-returned' : 'retry-review' : undefined);
      } }
    })(); return pending;
  };
  const openCheck = (reference: ConnectionAccessCheckReference, onClose?: () => void): Promise<void> => {
    if (disposed) return pending;
    const focusAtStart = doc.activeElement;
    stopTimer(); generation++; repairs.reset(); comparisons.reset(); picker.cancel(); retire(preview?.id);
    savedCheckReference = structuredClone(reference); savedResultReference = undefined; recheckTarget = undefined; savedEntry = undefined; savedReviewSelection = undefined;
    returnFocus = onClose; open = true; busy = true; starting = false; error = ''; preview = undefined; result = undefined; selection = undefined; attempt = undefined; choices.clear(); selected.clear();
    pendingComparison = reference?.view === 'comparison'; const gen = generation; const expected = savedCheckReference; render();
    pending = (async () => {
      try {
        if (!isConnectionAccessCheckReference(expected)) throw new Error('Invalid reference');
        const reply = await deps.call({ action: 'authentication_access_status', id: expected.verification_id });
        if (disposed || !open || gen !== generation) return;
        if (!reply || reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification) || reply.verification.id !== expected.verification_id
          || expected.target_id && !reply.verification.results.some(r => r.id === expected.target_id)) throw new Error('Invalid saved check');
        result = structuredClone(reply.verification); selection = { kind: result.selection.kind, id: result.selection.id };
      } catch { if (!disposed && gen === generation) error = 'This saved check is unavailable or does not contain that resource. Retry or open connection history or Authentication repairs. No new checks were started.'; }
      finally { if (!disposed && gen === generation) {
        const restore = doc.activeElement === focusAtStart || doc.activeElement === doc.body || doc.activeElement === host?.firstChild;
        busy = false; render(restore ? result ? 'status' : 'retry-review' : undefined);
        if (!error) { await openRequestedComparison(); if (!disposed && gen === generation) poll(); }
      } }
    })(); return pending;
  };
  return {
    open(selected: AuthenticationAccessSelection, previous?: AuthenticationAccessVerification, onClose?: () => void): void {
      stopTimer(); generation++; repairs.reset(); comparisons.reset(); picker.cancel(); retire(preview?.id); savedEntry = undefined; savedReviewSelection = undefined; savedResultReference = undefined; savedCheckReference = undefined; pendingComparison = false; recheckTarget = undefined; returnFocus = onClose; open = true; selection = selected; busy = false; starting = false; error = ''; preview = undefined; result = previous; attempt = undefined; render();
      if (previous) poll(); else void review();
    },
    openSaved,
    openResult,
    openCheck,
    mount(element: HTMLElement): void { host = element; render(); },
    whenLoaded: async (): Promise<void> => { await pending; await repairs.whenLoaded(); await comparisons.whenLoaded(); },
    busy: (): boolean => busy || repairs.busy() || comparisons.busy(),
    hasInFlightWork: (): boolean => !disposed && starting,
    hasDraft: (): boolean => open && !!preview,
    dispose(): void { disposed = true; generation++; repairs.dispose(); comparisons.dispose(); stopTimer(); retire(preview?.id); preview = undefined; picker.dispose(); host = null; },
  };
};
export const AUTHENTICATION_ACCESS_STYLES = `.authentication-access{padding:16px;margin:12px 0;border:1px solid var(--border,#d9dfeb);border-radius:8px;overflow-wrap:anywhere;min-width:0}.authentication-access article{padding:12px 0;border-top:1px solid var(--border,#d9dfeb)}.authentication-access h4{margin:10px 0 4px}.authentication-access input[type=url]{font:inherit;box-sizing:border-box;width:100%;padding:8px}.authentication-access label{display:block;margin:6px 0}.authentication-access button{font:inherit;min-height:44px;max-width:100%;white-space:normal;margin:4px 8px 4px 0;padding:7px 12px}.authentication-access a{display:inline-block;padding:12px 0}.authentication-access [role=alert]{color:var(--danger,#b42318)}a.authentication-access-page{display:inline-block;box-sizing:border-box;min-height:44px;max-width:100%;padding:12px 0;overflow-wrap:anywhere}` + FILE_DOWNLOAD_PICKER_STYLES + AUTHENTICATION_ACCESS_COMPARISON_STYLES;
