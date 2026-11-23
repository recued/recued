import { SETTINGS_FINDER_TARGETS, locateSetting, searchSettingsTargets, type SettingsFinderTarget } from './settings-finder-targets.js';

let sequence = 0;

export interface SettingsFinder {
  reveal(id: string, section?: string): boolean;
  restore(id: string, section?: string): void;
  cancelReveal(): void;
  dispose(): void;
}

/** Reveal existing panels in place. Selecting a search result never rebuilds
 * the Settings route, so drafts and unsettled writes retain their owners. */
export const mountSettingsFinder = (opts: {
  host: HTMLElement;
  content: HTMLElement;
  document: Document;
  activateSection(section: string): void;
  onOpen(entry: SettingsFinderTarget): void;
}): SettingsFinder => {
  const doc = opts.document, id = `settings-finder-${++sequence}`;
  const root = doc.createElement('section'); root.className = 'settings-finder';
  root.setAttribute('role', 'search'); root.setAttribute('aria-label', 'Find a setting');
  const style = doc.createElement('style'); style.textContent = SETTINGS_FINDER_STYLES; root.appendChild(style);
  const label = doc.createElement('label'); label.setAttribute('for', id); label.textContent = 'Find a setting';
  const input = doc.createElement('input'); input.id = id; input.type = 'search'; input.autocomplete = 'off';
  input.placeholder = 'Find a setting…'; input.maxLength = 200;
  input.setAttribute('aria-describedby', `${id}-status`);
  const status = doc.createElement('p'); status.id = `${id}-status`; status.setAttribute('role', 'status');
  const results = doc.createElement('ul'); results.setAttribute('aria-label', 'Matching settings'); results.hidden = true;
  root.appendChild(label); root.appendChild(input); root.appendChild(status); root.appendChild(results); opts.host.appendChild(root);
  let disposed = false, expanded = true, signature = '';
  let matches: SettingsFinderTarget[] = [];
  let focused: { id: string; element: HTMLElement } | null = null;
  let pending: SettingsFinderTarget | null = null;

  const unavailable = (): void => {
    expanded = false; results.hidden = true;
    status.textContent = 'This setting is not available here. Try another search.';
  };

  const available = () => SETTINGS_FINDER_TARGETS.filter(entry => locateSetting(opts.content, entry) !== null);
  const markPanel = (element: HTMLElement, entry: SettingsFinderTarget): void => {
    element.setAttribute('tabindex', '-1');
    if (!element.hasAttribute('role')) element.setAttribute('role', 'region');
    if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) element.setAttribute('aria-label', entry.title);
    element.setAttribute('data-recued-settings-found', entry.id);
  };
  const reveal = (targetId: string, section?: string): boolean => {
    pending = null;
    const entry = SETTINGS_FINDER_TARGETS.find(entry => entry.id === targetId && (section === undefined || entry.section === section));
    if (disposed || !entry) return false;
    let element = locateSetting(opts.content, entry);
    if (!element) return false;
    opts.activateSection(entry.section);
    // Tabs keep their panels mounted. Use their declared ARIA relationship to
    // activate outer tabs before inner ones, including AI / Models' own tabs.
    const ancestors: HTMLElement[] = [];
    for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== opts.content; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
    for (const ancestor of ancestors) {
      if (ancestor.getAttribute('role') === 'tabpanel') {
        const tabId = ancestor.getAttribute('aria-labelledby');
        if (tabId) doc.getElementById?.(tabId)?.click();
      }
      if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
    }
    element = locateSetting(opts.content, entry);
    if (!element) return false;
    expanded = false; results.hidden = true;
    status.textContent = `Opened ${entry.title}.`;
    markPanel(element, entry);
    element.scrollIntoView?.({ block: 'start', inline: 'nearest' });
    element.focus?.({ preventScroll: true });
    focused = { id: entry.id, element };
    return true;
  };
  const open = (entry: SettingsFinderTarget): void => {
    if (reveal(entry.id, entry.section)) opts.onOpen(entry);
    else { refresh(); input.focus?.(); unavailable(); }
  };
  const refresh = (): void => {
    if (disposed) return;
    matches = searchSettingsTargets(available(), input.value);
    const nextSignature = `${input.value}\n${matches.map(entry => entry.id).join('\n')}`;
    if (nextSignature !== signature) {
      const held = doc.activeElement;
      const heldResult = held !== null && results.contains?.(held);
      while (results.firstChild) results.removeChild(results.firstChild);
      for (const entry of matches) {
        const item = doc.createElement('li'), button = doc.createElement('button'); button.type = 'button';
        button.setAttribute('data-recued-settings-finder-result', entry.id);
        const title = doc.createElement('strong'); title.textContent = entry.title;
        const location = doc.createElement('span'); location.className = 'settings-finder-location'; location.textContent = entry.location;
        const description = doc.createElement('span'); description.textContent = entry.description;
        button.appendChild(title); button.appendChild(location); button.appendChild(description);
        button.addEventListener('click', () => open(entry));
        button.addEventListener('keydown', event => {
          const buttons = Array.from(results.querySelectorAll('button')), index = buttons.indexOf(button);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          } else if (event.key === 'Escape') { event.preventDefault(); input.value = ''; expanded = true; refresh(); input.focus(); }
        });
        item.appendChild(button); results.appendChild(item);
      }
      signature = nextSignature;
      if (heldResult) input.focus?.({ preventScroll: true });
    }
    results.hidden = !expanded || matches.length === 0;
    if (expanded) status.textContent = !input.value.trim() ? 'Search by name, such as quiet hours, timezone, or default model.'
      : matches.length ? `${matches.length} ${matches.length === 1 ? 'setting' : 'settings'} found.` : 'No settings match. Try another name.';
  };
  input.addEventListener('input', () => { expanded = true; refresh(); });
  input.addEventListener('focus', () => { expanded = true; refresh(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && matches[0]) { event.preventDefault(); open(matches[0]); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); results.querySelectorAll<HTMLButtonElement>('button')[event.key === 'ArrowDown' ? 0 : matches.length - 1]?.focus();
    } else if (event.key === 'Escape') { event.preventDefault(); input.value = ''; expanded = true; refresh(); }
  });
  const releaseFocus = (event: Event): void => {
    pending = null;
    if (focused && event.target !== focused.element) focused = null;
  };
  doc.addEventListener?.('focusin', releaseFocus);
  doc.addEventListener?.('pointerdown', releaseFocus, true);
  const observer = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => {
    refresh();
    if (pending && locateSetting(opts.content, pending)) {
      const entry = pending;
      reveal(entry.id, entry.section);
    }
    // A panel may replace its card after a pending read. Restore only the
    // finder-owned panel focus; typing or clicking elsewhere releases it.
    if (focused && !focused.element.isConnected && (doc.activeElement === doc.body || doc.activeElement === null)) {
      const entry = SETTINGS_FINDER_TARGETS.find(entry => entry.id === focused?.id);
      const element = entry && locateSetting(opts.content, entry);
      if (entry && element) { markPanel(element, entry); element.focus({ preventScroll: true }); focused = { id: entry.id, element }; }
    }
  }) : null;
  observer?.observe(opts.content, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  refresh();
  return {
    reveal,
    restore(targetId, section) {
      if (reveal(targetId, section)) return;
      unavailable();
      const entry = SETTINGS_FINDER_TARGETS.find(entry => entry.id === targetId && (section === undefined || entry.section === section));
      // A feature card can start hidden while its server read is pending.
      // Keep only this explicit bookmark intent, and release it on interaction
      // or navigation so a late read cannot take over the owner's next task.
      if (entry && opts.content.querySelector?.(`[data-recued-settings-section="${entry.section}"]`)) pending = entry;
    },
    cancelReveal() { pending = null; focused = null; },
    dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect();
      doc.removeEventListener?.('focusin', releaseFocus);
      doc.removeEventListener?.('pointerdown', releaseFocus, true);
      root.parentNode?.removeChild(root);
    },
  };
};

const SETTINGS_FINDER_STYLES = `
.settings-finder { display:grid; gap:8px; margin:0 0 20px; }
.settings-finder label { font-weight:600; font-size:14px; }
.settings-finder input { width:100%; min-height:44px; padding:10px 12px; font:inherit; border:1px solid var(--border); border-radius:8px; color:var(--fg); background:var(--surface); scroll-margin-block-start:5rem; }
.settings-finder p { margin:0; font-size:13px; color:var(--fg-muted); }
.settings-finder ul { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.settings-finder ul[hidden] { display:none; }
.settings-finder button { display:grid; gap:4px; width:100%; min-height:44px; padding:12px; text-align:left; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:8px; cursor:pointer; }
.settings-finder button:hover { background:var(--surface-sunk); }
.settings-finder button span { font-size:13px; }
.settings-finder-location { color:var(--fg-muted); }
[data-recued-settings-found] { scroll-margin-block-start:5rem; }
.settings-finder :is(input,button):focus-visible, [data-recued-settings-found]:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
`;
