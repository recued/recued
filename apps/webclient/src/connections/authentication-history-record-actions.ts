import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import { createAuthenticationHistoryCopy } from './authentication-history-preview-copy.js';
import { previewRecordTypes as types } from './authentication-history-preview-fields.js';
import { prepareAuthenticationHistoryContextRecord, type AuthenticationHistoryRecordContext } from './authentication-history-record-context.js';

type Entry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
// One immutable entry can appear in the main preview and several related
// views. Share its JSON without retaining discarded snapshots.
const recordJSON = new WeakMap<Entry, string>();
let actionsCounter = 0;

/** Explicit actions on the complete prepared entry, never the rendered DOM.
 * Source positions keep filenames stable across queries, bundles and links. */
export const createAuthenticationHistoryRecordActions = (deps: {
  document: Document; entry: Entry; file: { snapshotFilename: string; sourcePosition?: number } | { filename: string };
  sourceContext?: AuthenticationHistoryRecordContext;
  origin: HTMLElement; context?: string; help?: string; active(control: HTMLElement): boolean;
  interactive?(control: HTMLElement): boolean; download(filename: string, json: string): void;
}): { element: HTMLElement; fileId: string } => {
  const doc = deps.document; const interactive = deps.interactive ?? deps.active;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  let json = recordJSON.get(deps.entry);
  if (json === undefined) { json = JSON.stringify(deps.entry); recordJSON.set(deps.entry, json); }
  const bare = json; const label = types[deps.entry.type] + ' · ' + deps.entry.record.id + (deps.context ? ' in ' + deps.context : '');
  const bareFilename = 'filename' in deps.file ? deps.file.filename
    : deps.file.snapshotFilename.slice(0, -5) + '-record-' + deps.entry.type
      + (deps.file.sourcePosition === undefined ? '' : '-' + (deps.file.sourcePosition + 1)) + '.json';
  const fileId = 'history-record-actions-' + ++actionsCounter;
  const element = node('div'); let group: HTMLElement | undefined; let version = 0;
  const render = (prepared?: ReturnType<typeof prepareAuthenticationHistoryContextRecord>): void => {
    const epoch = ++version;
    if (group) element.removeChild(group);
    const active = (control: HTMLElement): boolean => epoch === version && deps.active(control) && element.contains(control);
    const canUse = (control: HTMLElement): boolean => active(control) && interactive(control);
    const raw = prepared?.json ?? bare; const filename = prepared?.filename ?? bareFilename;
    const file = node('p', 'File: '); file.id = fileId; file.appendChild(node('code', filename));
    const saved = node('p'); saved.hidden = true; saved.id = fileId + '-status'; saved.setAttribute('role', 'status'); saved.setAttribute('data-history-preview-download', 'record-status');
    const refused = node('p'); refused.hidden = true; refused.id = fileId + '-error'; refused.setAttribute('role', 'alert'); refused.setAttribute('data-history-preview-download', 'record-error');
    const save = node('button', 'Download record as JSON'); save.type = 'button'; save.setAttribute('data-history-preview-control', 'download-record');
    save.setAttribute('aria-label', 'Download record as JSON: ' + label); save.setAttribute('aria-describedby', file.id + ' ' + saved.id + ' ' + refused.id);
    let downloading = false;
    save.addEventListener('click', event => {
      if (!canUse(save) || save.disabled || downloading) return;
      // Hold the guard through callbacks and feedback. Changing the context
      // choice invalidates this complete action group, including pending copy.
      downloading = true;
      try {
        if (event.detail > 0 && (doc.activeElement === deps.origin || doc.activeElement === doc.body)) save.focus({ preventScroll: true });
        if (!canUse(save) || save.disabled) return;
        deps.download(filename, raw); if (!active(save)) return;
        refused.textContent = ''; refused.hidden = true; saved.textContent = prepared ? 'Record file with source context download requested.' : 'Record file download requested.'; saved.hidden = false;
      } catch {
        if (!active(save)) return;
        saved.textContent = ''; saved.hidden = true; refused.textContent = 'This browser could not start the record download. Try again, or use Copy record as JSON.'; refused.hidden = false;
      } finally { downloading = false; }
    });
    group = createAuthenticationHistoryCopy({ kind: 'record', document: doc, raw, label, origin: deps.origin, active, interactive: canUse, additionalAction: save,
      ...(prepared ? { help: 'Contains this saved entry and its source snapshot date, scope, filters, privacy mode and limits. Other records are not included. Saved context is not authenticated evidence. References may point outside this entry.' } : deps.help ? { help: deps.help } : {}) });
    group.appendChild(file); group.appendChild(saved); group.appendChild(refused); element.appendChild(group);
  };
  if (deps.sourceContext) {
    const choice = node('input'); choice.type = 'checkbox'; choice.checked = false; choice.id = fileId + '-context'; choice.setAttribute('data-history-preview-control', 'include-record-context');
    const label = node('label'); label.htmlFor = choice.id; label.className = 'authentication-history-record-context-choice'; label.appendChild(choice); label.appendChild(node('span', 'Include source context'));
    const help = node('p', 'Adds the source snapshot date, scope, filters, privacy mode and limits to both record actions. Other records are not included.'); help.id = choice.id + '-help';
    const error = node('p'); error.id = choice.id + '-error'; error.hidden = true; error.setAttribute('role', 'alert'); error.setAttribute('data-history-preview-record-context-error', 'record');
    choice.setAttribute('aria-describedby', help.id + ' ' + error.id);
    let prepared: ReturnType<typeof prepareAuthenticationHistoryContextRecord> | undefined;
    choice.addEventListener('change', () => {
      if (!interactive(choice) || !deps.active(choice) || choice.disabled) return;
      const focused = doc.activeElement; const removedFocus = group?.contains(focused);
      error.textContent = ''; error.hidden = true;
      try {
        if (choice.checked) prepared ??= prepareAuthenticationHistoryContextRecord(deps.entry, deps.sourceContext!);
        render(choice.checked ? prepared : undefined);
        if (removedFocus && deps.active(choice) && (doc.activeElement === focused || doc.activeElement === doc.body)) choice.focus({ preventScroll: true });
      } catch {
        choice.checked = false;
        error.textContent = 'Source context could not be added within 8 MiB. Copy or download the record without it, or use the source report.'; error.hidden = false;
      }
    });
    element.appendChild(label); element.appendChild(help); element.appendChild(error);
  }
  render();
  return { element, fileId };
};
