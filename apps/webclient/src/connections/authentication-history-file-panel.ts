import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import { openAuthenticationHistoryFile, AuthenticationHistoryFileError } from './authentication-history-saved-file.js';
import { createAuthenticationHistoryPreview } from './authentication-history-preview.js';
import { createAuthenticationHistoryComparisonPanel, AUTHENTICATION_HISTORY_COMPARISON_STYLES } from './authentication-history-comparison-panel.js';

let filePanelCounter = 0;

/** Own local file/paste selection separately from live exports.
 * Only checked, immutable snapshots enter the existing read-only preview. */
export const createAuthenticationHistoryFilePanel = (deps: { document: Document; download?(filename: string, json: string): void; downloadText?(filename: string, text: string): void }) => {
  const doc = deps.document; const id = 'history-file-' + ++filePanelCounter;
  type Source = 'file' | 'paste';
  let disposed = false; let version = 0; let reading = false; let openingPaste = false; let pending = Promise.resolve();
  let lastSource: Source = 'file'; let reviewSource: Source | undefined; let failedSource: Source | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n;
  };
  const element = node('section'); element.className = 'authentication-history-file'; element.setAttribute('data-history-file', 'panel'); element.setAttribute('aria-label', 'Open saved history');
  element.appendChild(node('h3', 'Open saved history'));
  const help = node('p', 'Choose or paste a Recued history export, comparison pair, related history bundle or saved record, up to 8 MiB. Names and IDs or saved aliases stay as recorded. A comparison pair restores both complete Names and IDs reports. This history opens only in this browser tab.'); help.id = id + '-help';
  const input = node('input'); input.type = 'file'; input.accept = '.json,application/json'; input.id = id + '-input'; input.setAttribute('data-history-file', 'input'); input.setAttribute('aria-describedby', help.id);
  const label = node('label', 'Choose history JSON'); label.htmlFor = input.id;
  const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('data-history-file', 'status'); status.hidden = true;
  const error = node('p'); error.id = id + '-error'; error.setAttribute('role', 'alert'); error.setAttribute('data-history-file', 'error'); error.hidden = true;
  const clear = node('button', 'Clear opened history'); clear.type = 'button'; clear.setAttribute('data-history-file', 'clear');
  const pastePanel = node('details'); pastePanel.className = 'authentication-history-paste'; pastePanel.setAttribute('data-history-paste', 'panel');
  pastePanel.appendChild(node('summary', 'Paste history JSON'));
  const form = node('form'); form.setAttribute('data-history-paste', 'form'); form.setAttribute('aria-label', 'Open pasted history JSON'); form.setAttribute('autocomplete', 'off');
  const pasteHelp = node('p', 'Paste the complete JSON, then choose Open pasted history. Editing this text does not change the opened preview. Up to 8 MiB.'); pasteHelp.id = id + '-paste-help';
  const paste = node('textarea'); paste.id = id + '-paste'; paste.rows = 6; paste.wrap = 'off'; paste.spellcheck = false; paste.autocomplete = 'off'; paste.setAttribute('autocapitalize', 'off');
  paste.setAttribute('data-history-paste', 'text'); paste.setAttribute('aria-describedby', pasteHelp.id + ' ' + error.id); paste.setAttribute('aria-invalid', 'false');
  const pasteLabel = node('label', 'History JSON'); pasteLabel.htmlFor = paste.id;
  const openPaste = node('button', 'Open pasted history'); openPaste.type = 'submit'; openPaste.setAttribute('data-history-paste', 'open'); openPaste.setAttribute('aria-describedby', pasteHelp.id + ' ' + error.id);
  const clearPaste = node('button', 'Clear pasted text'); clearPaste.type = 'button'; clearPaste.setAttribute('data-history-paste', 'clear'); clearPaste.setAttribute('aria-controls', paste.id);
  const active = (control: HTMLElement): boolean => !disposed && element.contains(control);
  const render = (): void => {
    if (disposed) return;
    comparison.setReading(reading || openingPaste);
    element.setAttribute('aria-busy', String(reading || openingPaste)); clear.disabled = !reading && !openingPaste && !preview.hasSnapshot() && error.hidden;
    openPaste.disabled = openingPaste || paste.value.length === 0; openPaste.setAttribute('aria-busy', String(openingPaste));
    clearPaste.disabled = paste.value.length === 0 && failedSource !== 'paste';
  };
  const clearError = (): void => { error.textContent = ''; error.hidden = true; failedSource = undefined; paste.setAttribute('aria-invalid', 'false'); };
  const reset = (): void => {
    version++; reading = false; pending = Promise.resolve(); input.value = ''; preview.clear(); comparison.reset(); reviewSource = undefined; status.textContent = ''; status.hidden = true; clearError(); render();
  };
  const returnToInput = (): void => {
    if (disposed) return;
    const target = lastSource === 'paste' ? paste : input;
    if (target === paste) pastePanel.open = true;
    target.focus({ preventScroll: true });
    if (active(target) && doc.activeElement === target) target.scrollIntoView?.({ block: 'nearest' });
  };
  const preview = createAuthenticationHistoryPreview({ document: doc, ...(deps.download ? { download: deps.download } : {}), closed: () => {
    if (!disposed) { reset(); returnToInput(); }
  } });
  preview.element.setAttribute('data-history-preview', 'file');
  const comparison = createAuthenticationHistoryComparisonPanel({ document: doc, ...(deps.download ? { download: deps.download } : {}), ...(deps.downloadText ? { downloadText: deps.downloadText } : {}) });
  clear.addEventListener('click', () => { if (active(clear) && !clear.disabled) { reset(); returnToInput(); } });
  const showError = (err: unknown, source: Source): void => {
    failedSource = source;
    error.textContent = (err instanceof AuthenticationHistoryFileError ? err.message : source === 'paste' ? 'This JSON could not be opened. Paste a complete history report or saved record and try again.' : 'This file could not be read. Choose it again or try another file.')
      + (preview.hasSnapshot() ? reviewSource === 'paste' ? ' The earlier JSON preview remains open.' : ' The earlier file remains open.' : '');
    error.hidden = false; status.textContent = ''; status.hidden = true;
    if (source === 'paste') paste.setAttribute('aria-invalid', 'true');
  };
  const show = (text: string, selected: number, source: Source, filename?: string): void => {
    const result = openAuthenticationHistoryFile(text);
    if (disposed || selected !== version) return;
    // Controls in the previous preview are about to be removed. Preserve newer
    // focus outside that preview and the source control used for this attempt.
    const focused = doc.activeElement;
    const focus = focused === doc.body || preview.element.contains(focused) || result.kind === 'comparison' && comparison.element.contains(focused)
      || (source === 'file' ? focused === input : focused === paste || focused === openPaste);
    const value = result.kind === 'comparison' ? result.comparison.comparison : result.kind === 'record' ? result.record : result.snapshot;
    preview.show(value, { ...(source === 'paste' ? { source: 'paste' as const } : { filename: filename! }), ...(result.kind === 'report' && result.bundle ? { bundle: result.bundle } : {}), ...(result.kind === 'comparison' ? { comparisonPair: true as const } : {}) });
    if (disposed || selected !== version) return;
    if (result.kind === 'comparison') comparison.openPair(result.comparison);
    else comparison.setCurrent(result, source === 'paste' ? 'Pasted history JSON' : filename!);
    reviewSource = source;
    status.textContent = (source === 'paste' ? 'Opened pasted JSON: ' : 'Opened saved file: ')
      + (result.kind === 'comparison' ? 'Comparison pair restored: ' + result.comparison.baseline.count + ' baseline records and ' + result.comparison.comparison.count + ' comparison records. The file preview shows the comparison report.'
        : result.kind === 'record' ? result.record.context ? '1 saved record with source context. Other records were not included.' : '1 saved record. Snapshot context was not included.' : value.count + ' recorded entries.') + ' Current vendor access was not checked.'; status.hidden = false;
    if (focus) { if (result.kind === 'comparison') comparison.focus(); else preview.focus(); }
  };
  paste.addEventListener('input', () => { if (active(paste)) { if (failedSource === 'paste') clearError(); render(); } });
  clearPaste.addEventListener('click', () => {
    if (!active(clearPaste) || clearPaste.disabled) return;
    paste.value = ''; if (failedSource === 'paste') clearError(); render(); paste.focus({ preventScroll: true });
    if (active(paste) && doc.activeElement === paste) paste.scrollIntoView?.({ block: 'nearest' });
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!active(form) || openingPaste || paste.value.length === 0) return;
    openingPaste = true; const selected = ++version; lastSource = 'paste'; reading = false; pending = Promise.resolve(); input.value = ''; clearError(); render();
    try { show(paste.value, selected, 'paste'); }
    catch (err) { if (!disposed && selected === version) showError(err, 'paste'); }
    finally { openingPaste = false; render(); }
  });
  input.addEventListener('change', () => {
    if (!active(input)) return;
    const file = input.files?.[0]; if (!file) return;
    const selected = ++version; const filename = file.name.slice(0, 256); lastSource = 'file';
    reading = true; clearError(); status.textContent = 'Reading saved history file…'; status.hidden = false; render();
    pending = (async () => {
      try {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new AuthenticationHistoryFileError('too_large');
        const text = await file.text();
        if (!active(input) || selected !== version) return;
        show(text, selected, 'file', filename);
      } catch (err) {
        if (active(input) && selected === version) showError(err, 'file');
      } finally {
        if (active(input) && selected === version) { reading = false; input.value = ''; render(); }
      }
    })();
  });
  form.appendChild(pasteHelp); form.appendChild(pasteLabel); form.appendChild(paste); form.appendChild(openPaste); form.appendChild(clearPaste); pastePanel.appendChild(form);
  element.appendChild(help); element.appendChild(label); element.appendChild(input); element.appendChild(clear); element.appendChild(pastePanel); element.appendChild(status); element.appendChild(error); element.appendChild(comparison.element); element.appendChild(preview.element); render();
  return { element, whenLoaded: () => pending, dispose: (): void => { disposed = true; version++; reading = false; paste.value = ''; preview.dispose(); comparison.dispose(); } };
};

const FILE_STYLES = `.authentication-history-file{box-sizing:border-box;min-width:0;border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0}.authentication-history-file label{display:block;margin:8px 0 4px}.authentication-history-file input[type=file]{box-sizing:border-box;display:block;width:100%;max-width:100%;min-width:0;min-height:44px;font:inherit;color:var(--fg)}.authentication-history-file input::file-selector-button{min-height:44px;max-width:100%;font:inherit;white-space:normal;border:1px solid var(--border);border-radius:6px;padding:7px 12px;background:var(--surface);color:var(--fg)}.authentication-history-paste>summary{min-height:44px;display:list-item;align-content:center;cursor:pointer}.authentication-history-paste textarea{box-sizing:border-box;display:block;width:100%;max-width:100%;min-width:0;min-height:144px;max-height:320px;resize:vertical;overflow:auto;font:12px/1.5 ui-monospace,monospace;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}`;

export const AUTHENTICATION_HISTORY_FILE_STYLES = FILE_STYLES + AUTHENTICATION_HISTORY_COMPARISON_STYLES;
