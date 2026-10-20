let copyCounter = 0;
const copyLabels = {
  value: { action: 'Copy saved value', manual: 'Saved value for manual copy', select: 'Select saved value',
    copying: 'Copying saved value…', copied: 'Saved value copied.', failed: 'This value could not be copied. Select the saved value and copy it yourself.' },
  record: { action: 'Copy record as JSON', manual: 'Record JSON for manual copy', select: 'Select record JSON',
    copying: 'Copying record JSON…', copied: 'Record JSON copied.', failed: 'This record could not be copied. Select the JSON and copy it yourself.' },
  timeline: { action: 'Copy support timeline', manual: 'Support timeline for manual copy', select: 'Select support timeline',
    copying: 'Copying support timeline…', copied: 'Support timeline copied.', failed: 'The support timeline could not be copied. Select the text and copy it yourself.' },
  comparison: { action: 'Copy comparison summary', manual: 'Comparison summary for manual copy', select: 'Select comparison summary',
    copying: 'Copying comparison summary…', copied: 'Comparison summary copied.', failed: 'The comparison summary could not be copied. Select the text and copy it yourself.' },
  bundle: { action: 'Copy related history as JSON', manual: 'Related history JSON for manual copy', select: 'Select related history JSON',
    copying: 'Copying related history JSON…', copied: 'Related history JSON copied.', failed: 'This related history could not be copied. Select the JSON and copy it yourself.' },
} as const;

/** Native WebKit needs explicit scrolling for focused, read-only text. Owners
 * check their capture lifetime before calling; modifiers preserve selection. */
export const scrollAuthenticationHistoryText = (doc: Document, content: HTMLElement, event: KeyboardEvent): void => {
  if (doc.activeElement !== content || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const maximum = Math.max(0, content.scrollHeight - content.clientHeight), current = content.scrollTop;
  const step = Math.max(40, content.clientHeight - 40);
  const next = event.key === 'ArrowDown' ? current + 40 : event.key === 'ArrowUp' ? current - 40
    : event.key === 'PageDown' ? current + step : event.key === 'PageUp' ? current - step
      : event.key === 'Home' ? 0 : event.key === 'End' ? maximum : undefined;
  if (next === undefined) return;
  const bounded = Math.max(0, Math.min(maximum, next));
  if (bounded === current) return;
  event.preventDefault(); content.scrollTop = bounded;
};

/** Copies only the supplied prepared text. The owner guards both snapshot
 * and selection lifetime, including clipboard replies that arrive later. */
export const createAuthenticationHistoryCopy = (deps: {
  document: Document; label: string; origin: HTMLElement; active(control: HTMLElement): boolean;
  interactive?(control: HTMLElement): boolean;
} & ({ kind: 'value'; raw: string; readable: string } | { kind: 'record'; raw: string; additionalAction?: HTMLButtonElement; help?: string }
  | { kind: 'bundle'; raw(): string; additionalAction?: HTMLButtonElement } | { kind: 'timeline'; raw(): string; additionalAction?: HTMLButtonElement }
  | { kind: 'comparison'; raw(): string; additionalAction?: HTMLButtonElement })): HTMLElement => {
  const doc = deps.document; const interactive = deps.interactive ?? deps.active;
  const key = deps.kind; const labels = copyLabels[key]; const { action, manual: manualLabel, select: selectLabel } = labels;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const additional = deps.kind !== 'value' ? deps.additionalAction : undefined;
  const root = node('div'); root.className = 'authentication-history-preview-copy'; root.setAttribute('data-history-preview-copy', key === 'value' ? 'controls' : key + '-controls');
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', (additional ? key === 'bundle' ? 'Related history actions' : 'Saved record actions' : action) + ': ' + deps.label);
  const id = 'history-value-copy-' + ++copyCounter;
  const copy = node('button', action); copy.type = 'button'; copy.setAttribute('data-history-preview-control', 'copy-' + key);
  copy.setAttribute('aria-label', action + ': ' + deps.label); copy.setAttribute('aria-busy', 'false'); copy.setAttribute('aria-disabled', 'false');
  const help = node('p', deps.kind === 'comparison' ? 'Copies all captured differences and source limits, including saved IDs. Detailed values and search text are omitted. Filters and paging do not change it. Review before sharing.'
    : deps.kind === 'timeline' ? 'Copies a readable incident timeline in this captured privacy mode. It includes saved observations, not a new access check.' : deps.kind === 'bundle' ? "Copies this complete related history bundle with its saved records, links and limits. Uses this preview's privacy mode and original aliases."
    : deps.kind === 'record' ? deps.help ?? 'Contains this complete saved entry as JSON, including its type and recorded outcome. Keeps the saved fields and aliases shown here. References may point outside this entry.'
    : deps.raw === deps.readable ? 'Copies this complete saved value without the field name.' : 'Copies the saved form: '); help.id = id + '-help';
  if (deps.kind === 'value' && deps.raw !== deps.readable) help.appendChild(node('code', deps.raw));
  const status = node('p'); status.id = id + '-status'; status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('data-history-preview-copy', key === 'value' ? 'status' : key + '-status');
  copy.setAttribute('aria-describedby', help.id + ' ' + status.id); root.appendChild(copy);
  if (additional) root.appendChild(additional);
  root.appendChild(help); root.appendChild(status);
  let pending = false; let dispatching = false; let manual: HTMLPreElement | undefined;
  const report = (text: string): void => { status.textContent = text; status.hidden = false; };
  const busy = (value: boolean): void => {
    pending = value; copy.setAttribute('aria-busy', String(value)); copy.setAttribute('aria-disabled', String(value));
  };
  const selectManual = (): void => {
    if (!manual || !interactive(manual)) return;
    manual.focus({ preventScroll: true });
    if (!interactive(manual) || doc.activeElement !== manual) return;
    manual.scrollIntoView?.({ block: 'nearest' });
    try {
      const range = doc.createRange(); range.selectNodeContents(manual);
      const selection = doc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } catch { /* The literal text remains available for normal mouse selection. */ }
  };
  const failed = (raw: string, synchronous: boolean): void => {
    if (!deps.active(copy)) return;
    busy(false); report(labels.failed);
    if (!manual) {
      const box = node('div'); box.setAttribute('data-history-preview-copy', key === 'value' ? 'manual' : key + '-manual');
      box.appendChild(node('p', manualLabel));
      manual = node('pre', raw); manual.id = id + '-manual'; manual.setAttribute('tabindex', '0'); manual.setAttribute('role', 'textbox');
      manual.setAttribute('aria-readonly', 'true'); manual.setAttribute('aria-multiline', 'true'); manual.setAttribute('aria-label', manualLabel + ': ' + deps.label);
      manual.setAttribute('data-history-preview-copy', 'manual-' + key); manual.setAttribute('data-history-preview-copy-selection', 'manual'); manual.setAttribute('aria-describedby', status.id);
      manual.addEventListener('keydown', event => {
        if (!interactive(manual!)) return;
        if (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectManual(); return; }
        scrollAuthenticationHistoryText(doc, manual!, event);
      });
      const select = node('button', selectLabel); select.type = 'button'; select.setAttribute('data-history-preview-control', 'select-copy-' + key);
      select.setAttribute('aria-label', selectLabel + ': ' + deps.label); select.setAttribute('aria-controls', manual.id);
      select.addEventListener('click', () => { if (interactive(select)) selectManual(); });
      box.appendChild(manual); box.appendChild(select); root.appendChild(box);
    }
    const focused = doc.activeElement;
    if (focused === copy || synchronous && (focused === deps.origin || focused === doc.body)) selectManual();
  };
  copy.addEventListener('click', event => {
    if (!interactive(copy) || pending || dispatching) return;
    dispatching = true;
    try {
      // WebKit pointer activation can focus the enclosing field instead of the
      // button. Own that fallback so a later refusal can offer selected text;
      // preserve any newer control focus chosen by the user.
      if (event.detail > 0 && (doc.activeElement === deps.origin || doc.activeElement === doc.body)) copy.focus({ preventScroll: true });
      if (!interactive(copy) || pending) return;
      let raw: string;
      try { raw = deps.kind === 'bundle' || deps.kind === 'timeline' || deps.kind === 'comparison' ? deps.raw() : deps.raw; }
      catch {
        if (deps.active(copy)) report(deps.kind === 'comparison' ? 'The comparison summary could not be prepared. Capture smaller history exports; the summary must fit within 8 MiB.'
          : deps.kind === 'timeline' ? 'The support timeline could not be prepared. Capture a smaller history export; the timeline must fit within 8 MiB.' : 'Related history could not be prepared for copying. Capture a smaller history export; the bundle must fit within 8 MiB.');
        return;
      }
      if (!interactive(copy) || pending) return;
      let write: ((text: string) => Promise<void>) | undefined;
      try { const clipboard = doc.defaultView?.navigator.clipboard; write = clipboard?.writeText?.bind(clipboard); } catch { /* Browser policy can deny the getter. */ }
      // Focus handlers and browser capability getters can replace this view.
      // Recheck before invoking a clipboard operation or showing its fallback.
      if (!interactive(copy) || pending) return;
      if (!write) { failed(raw, true); return; }
      busy(true); report(labels.copying);
      try {
        // Invoke during the click so browsers retain the owner's user gesture.
        const result = write(raw);
        void Promise.resolve(result).then(() => { if (deps.active(copy)) { busy(false); report(labels.copied); } }, () => { failed(raw, false); });
      } catch { failed(raw, true); }
    } finally { dispatching = false; }
  });
  return root;
};

export const AUTHENTICATION_HISTORY_VALUE_COPY_STYLES = `.authentication-history-preview-copy{box-sizing:border-box;width:100%;max-width:340px;border-top:1px solid var(--border);margin:12px 0 0;padding-top:8px;min-width:0}.authentication-history-preview-copy button{box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:4px;white-space:normal}.authentication-history-preview-copy p{font-size:12px;margin:8px 0}.authentication-history-preview-copy pre{box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;width:100%;min-width:0;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--surface);color:var(--fg);user-select:text}.authentication-history-preview-copy>button+button{margin-top:8px}`;
