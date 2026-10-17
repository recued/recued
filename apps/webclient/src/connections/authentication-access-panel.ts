import { isAuthenticationAccessPreview, isAuthenticationAccessVerification,
  type AuthenticationAccessPreview, type AuthenticationAccessSelection, type AuthenticationAccessVerification,
  type AuthenticationAccessCheck, type AuthenticationAccessChoice } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createFileDownloadPicker, FILE_DOWNLOAD_PICKER_STYLES } from '../settings/file-download-picker.js';

const labels = { api_read: 'Protected API read', collection_read: 'Account and selected folders/calendars', file_metadata: 'File metadata',
  file_download: 'Chosen file download/export', write_permissions: 'Sending, editing and other writes' } as const;
const reasons: Record<NonNullable<AuthenticationAccessCheck['reason']>, string> = {
  not_checked: 'Waiting for this check', unsupported: 'This saved account has no supported check', resource_required: 'Choose a resource to check',
  access_rejected: 'The saved account was refused access', unavailable: 'The check could not finish; unlock Recued or try again',
  inconclusive: 'The response did not prove protected access', changed: 'Authentication or configuration changed; review again',
  interrupted: 'The server restarted before this check finished', permission_evidence_missing: 'Vendor permission evidence is unavailable',
  not_executed: 'This operation was not performed',
};
export const appendAuthenticationAccessSummary = (doc: Document, parent: HTMLElement, value: AuthenticationAccessVerification): void => {
  const add = (tag: 'p' | 'h4', text: string, where = parent): HTMLElement => { const node = doc.createElement(tag); node.textContent = text; where.appendChild(node); return node; };
  const section = doc.createElement('div'); section.setAttribute('data-authentication-access-result', value.id); parent.appendChild(section);
  add('p', value.status === 'checking' ? 'Access checks are running in the background.' : 'Access check finished: ' + new Date(value.finished_at!).toLocaleString() + '.', section);
  for (const result of value.results) {
    add('h4', result.label, section);
    if (result.current === 'no') add('p', 'Superseded · The saved authentication or source changed after this check.', section);
    else if (result.current === 'unknown') add('p', 'Current authentication could not be compared. Unlock Recued and refresh before relying on this result.', section);
    for (const check of result.checks) add('p', labels[check.kind] + ': ' + (check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Unconfirmed')
      + (check.reason ? ' · ' + reasons[check.reason] : '') + (result.current !== 'yes' && check.status === 'passed' ? ' (historical result)' : ''), section);
  }
  if (value.targets_truncated || !value.usage_available) add('p', 'The affected-use inventory is incomplete. These results cover only the listed checks.', section);
  if (value.uses.length) {
    const details = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Related uses (' + value.uses.length + ')'; details.appendChild(summary);
    const list = doc.createElement('ul');
    for (const use of value.uses) { const item = doc.createElement('li'); item.textContent = use.label + ' · ' + use.kind
      + (['pack', 'recipe', 'dish', 'schedule'].includes(use.kind) ? ' · Workflow execution unconfirmed' : ' · Only the listed read checks are covered'); list.appendChild(item); }
    details.appendChild(list); section.appendChild(details);
  }
  add('p', 'Read results cover the checked resources. Sending, editing, workflows and failed jobs were not run. Repair and sync outcomes remain separate.', section);
};

/** A review starts local-only. Only Run checks contacts the selected vendors. */
export const createAuthenticationAccessPanel = (deps: { document: Document; call: ManagedOAuthCaller; updated?(): void }) => {
  const doc = deps.document; let host: HTMLElement | null = null; let disposed = false; let open = false; let generation = 0;
  let selection: AuthenticationAccessSelection | undefined; let preview: AuthenticationAccessPreview | undefined; let result: AuthenticationAccessVerification | undefined;
  let busy = false; let starting = false; let error = ''; let attempt: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve(); const choices = new Map<string, AuthenticationAccessChoice>();
  let returnFocus: (() => void) | undefined;
  const retire = (id: string | undefined): void => {
    if (!id) return;
    try { void deps.call({ action: 'authentication_access_retire', review_id: id }).catch(() => {}); } catch { /* Closing still works while disconnected. */ }
  };
  const sameSelection = (other: AuthenticationAccessSelection): boolean => other.kind === selection?.kind && other.id === selection.id;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const stopTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const button = (text: string, action: string, fn: () => void, disabled = busy): HTMLButtonElement => {
    const b = node('button', text); b.type = 'button'; b.disabled = disabled; b.setAttribute('data-authentication-access-action', action);
    const gen = generation; b.addEventListener('click', () => { if (!disposed && open && gen === generation && host?.contains(b) && !b.disabled) fn(); }); return b;
  };
  const picker = createFileDownloadPicker({ document: doc, call: deps.call, mode: 'saved', changed: () => render() });
  const render = (focus?: string): void => {
    if (disposed || !host) return;
    const restore = focus ?? (host.contains?.(doc.activeElement) ? doc.activeElement?.getAttribute('data-authentication-access-action') ?? undefined : undefined);
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!open) return;
    const section = node('section'); section.className = 'authentication-access'; section.setAttribute('aria-label', 'Verify access');
    section.setAttribute('aria-busy', String(busy)); section.tabIndex = -1;
    section.appendChild(node('h3', 'Verify access'));
    section.appendChild(node('p', 'Check the authentication currently saved in Recued. Review the resources below, then run bounded read checks. Earlier repairs and token renewals remain recorded separately.'));
    if (selection?.kind === 'renewal') section.appendChild(node('p', 'This review covers the accounts retained with that renewal result, including excluded or unavailable authorizations. Current authentication may have changed since renewal.'));
    if (busy) { const p = node('p', preview ? 'Starting access checks…' : 'Reading saved authentication…'); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (error) { const p = node('p', error); p.setAttribute('role', 'alert'); section.appendChild(p); }
    if (error && !preview && !result) section.appendChild(button('Retry review', 'retry-review', () => { void review(); }));
    if (error && preview) section.appendChild(button('Review again', 'restart-review', () => { void review(); }));
    if (result) {
      appendAuthenticationAccessSummary(doc, section, result);
      if (result.status === 'checking') section.appendChild(button('Refresh check status', 'status', () => { void status(); }));
      else section.appendChild(button('Review new checks', 'review', () => { void review(); }));
    }
    if (preview) {
      section.appendChild(node('p', preview.label));
      if (preview.targets_truncated || !preview.usage_available) section.appendChild(node('p', 'Some affected uses are unavailable or omitted. Verification covers only the listed targets.'));
      for (const target of preview.targets) {
        const article = node('article'); article.appendChild(node('h4', target.label));
        if (target.check === 'api_read') {
          const id = 'authentication-access-url-' + target.id; const label = node('label', 'Read-only API resource URL'); label.htmlFor = id; article.appendChild(label);
          const input = node('input'); input.type = 'url'; input.id = id; input.maxLength = 4096; input.disabled = busy;
          input.value = choices.get(target.id)?.url ?? ''; input.setAttribute('data-authentication-access-url', target.id);
          const gen = generation; input.addEventListener('input', () => { if (!disposed && gen === generation && host?.contains(input) && !busy) {
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
          }, busy || picker.active()));
        } else article.appendChild(node('p', target.check === 'collection_read' ? 'Check the saved account and its selected folders or calendars.' : 'A supported read check is unavailable for this target.'));
        section.appendChild(article);
      }
      section.appendChild(node('p', 'No messages are sent, events edited, or workflows executed. Remote reads can refresh an expired OAuth token.'));
      section.appendChild(button('Run checks', 'run', () => { void run(); }, busy || picker.active()));
    }
    const pickerHost = node('div'); section.appendChild(pickerHost); host.appendChild(section); picker.mount(pickerHost);
    section.appendChild(button('Close', 'close', () => { generation++; open = false; busy = false; starting = false; stopTimer(); retire(preview?.id); preview = undefined; picker.cancel(); render(); returnFocus?.(); }, false));
    if (restore) (host.querySelector<HTMLElement>('[data-authentication-access-action="' + restore + '"]') ?? section).focus({ preventScroll: true });
  };
  const review = (): Promise<void> => {
    if (!selection || disposed || busy) return pending;
    const focusAtStart = doc.activeElement;
    stopTimer(); const gen = ++generation; picker.cancel(); retire(preview?.id); busy = true; error = ''; preview = undefined; result = undefined; choices.clear(); attempt = undefined; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_preview', selection: selection! });
        if (disposed || !open || gen !== generation) {
          if (reply.action === 'authentication_access_preview' && isAuthenticationAccessPreview(reply.preview)) retire(reply.preview.id);
          return;
        }
        if (reply.action !== 'authentication_access_preview' || !isAuthenticationAccessPreview(reply.preview) || !sameSelection(reply.preview.selection)) throw new Error('Invalid preview');
        preview = structuredClone(reply.preview);
        if (preview.running) { result = preview.running; retire(preview.id); preview = undefined; }
        else for (const target of preview.targets) choices.set(target.id, { target_id: target.id, ...(target.default_url ? { url: target.default_url } : {}) });
      } catch { if (!disposed && gen === generation) error = 'Access checks could not be prepared. Unlock Recued, refresh the saved accounts, or update the server, then try again.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(doc.activeElement === focusAtStart ? result ? 'status' : 'run' : undefined); if (!error) poll(); } }
    })(); return pending;
  };
  const poll = (): void => { stopTimer(); if (!disposed && open && result?.status === 'checking') timer = setTimeout(() => { void status(); }, 1500); };
  const status = (): Promise<void> => {
    if (disposed || !result || busy) return pending;
    stopTimer(); const gen = generation; const id = result.id; busy = true; error = ''; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_status', id });
        if (disposed || !open || gen !== generation) return;
        if (reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification)
          || reply.verification.id !== id || !sameSelection(reply.verification.selection)) throw new Error('Invalid status');
        result = structuredClone(reply.verification); if (result.status === 'completed') deps.updated?.();
      } catch { if (!disposed && gen === generation) error = 'Check status could not be refreshed. Earlier results are still shown. Retry refresh to read the saved outcome.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); if (!error) poll(); } }
    })(); return pending;
  };
  const run = (): Promise<void> => {
    if (!preview || disposed || busy || picker.active()) return pending;
    if (!attempt) {
      const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes);
      attempt = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const gen = generation; const plan = preview; busy = true; starting = true; error = ''; render();
    pending = (async () => {
      try {
        const reply = await deps.call({ action: 'authentication_access_run', review_id: plan.id, fingerprint: plan.fingerprint, attempt_id: attempt!, choices: [...choices.values()] });
        if (disposed || !open || gen !== generation) return;
        if (reply.action !== 'authentication_access_run' || !isAuthenticationAccessVerification(reply.verification) || !sameSelection(reply.verification.selection)) throw new Error('Invalid result');
        result = structuredClone(reply.verification); preview = undefined; deps.updated?.();
      } catch { if (!disposed && gen === generation) error = 'The checks could not be started or their receipt was not received. Retry with the same review, or refresh history to read any saved outcome.'; }
      finally { if (!disposed && gen === generation) { busy = false; starting = false; render('status'); if (!error) poll(); } }
    })(); return pending;
  };
  return {
    open(selected: AuthenticationAccessSelection, previous?: AuthenticationAccessVerification, onClose?: () => void): void {
      stopTimer(); generation++; picker.cancel(); retire(preview?.id); returnFocus = onClose; open = true; selection = selected; busy = false; starting = false; error = ''; preview = undefined; result = previous; render();
      if (previous) poll(); else void review();
    },
    mount(element: HTMLElement): void { host = element; render(); },
    whenLoaded: (): Promise<void> => pending,
    busy: (): boolean => busy,
    hasInFlightWork: (): boolean => !disposed && starting,
    hasDraft: (): boolean => open && !!preview,
    dispose(): void { disposed = true; generation++; stopTimer(); retire(preview?.id); preview = undefined; picker.dispose(); host = null; },
  };
};
export const AUTHENTICATION_ACCESS_STYLES = `.authentication-access{padding:16px;margin:12px 0;border:1px solid var(--border,#d9dfeb);border-radius:8px;overflow-wrap:anywhere;min-width:0}.authentication-access article{padding:12px 0;border-top:1px solid var(--border,#d9dfeb)}.authentication-access h4{margin:10px 0 4px}.authentication-access input[type=url]{font:inherit;box-sizing:border-box;width:100%;padding:8px}.authentication-access label{display:block;margin:6px 0}.authentication-access button{font:inherit;min-height:44px;max-width:100%;white-space:normal;margin:4px 8px 4px 0;padding:7px 12px}.authentication-access [role=alert]{color:var(--danger,#b42318)}` + FILE_DOWNLOAD_PICKER_STYLES;
