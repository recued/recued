import {
  CHAT_HISTORY_SOURCES, CHAT_HISTORY_VENDORS, DEFAULT_CHAT_HISTORY_FILTERS,
  getMessengerVendorDeclaration, getPref, parseChatHistoryFilters,
  type ChatHistoryFilters, type InstancePrefs,
} from '@recued/contracts';

export const HISTORY_FILTER_ATTR = 'data-chat-history-filter';
export const CHAT_HISTORY_FILTER_STYLES = `
.chat-history-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 10px 0; }
.chat-history-filters label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); min-width: 0; }
.chat-history-filters select { width: 100%; min-width: 0; padding: 6px 3px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; }
.chat-history-filters .chat-history-attention { display: flex; align-items: center; color: var(--fg); }
.chat-history-filters label:has([data-chat-history-filter="scope"]) { grid-column: 1 / -1; }
.chat-history-filters [hidden] { display: none; }
.chat-history-filter-note { grid-column: 1 / -1; margin: 0; font-size: 12px; }
.chat-session-item[hidden], [data-recued-chat-route-history-group][hidden],
[data-recued-chat-route-history-empty][hidden] { display: none; }
`;

export type ChatHistoryScope = 'all' | 'current';
/** Per-pair preferences remember only the controls. Serial writes keep a slow
 * acknowledgement from overwriting the owner's latest selection. */
export const createHistoryFilters = (options: {
  document: Document;
  save(patch: Partial<InstancePrefs>): Promise<{ prefs: InstancePrefs }>;
  changed(): void;
}) => {
  let filters: ChatHistoryFilters = { ...DEFAULT_CHAT_HISTORY_FILTERS };
  let scope: ChatHistoryScope = 'all';
  let touched = false;
  let revision = 0;
  let savedRevision = 0;
  let saving = false;
  let disposed = false;
  let error = '';
  let syncControls: (() => void) | undefined;
  const patch = (): Partial<InstancePrefs> => ({
    'ui.chat.history.source': filters.source,
    'ui.chat.history.vendor': filters.vendor,
    'ui.chat.history.needs_attention': filters.needs_attention,
    'ui.chat.history.scope': scope,
  });
  const save = async (): Promise<void> => {
    if (saving || disposed) return;
    saving = true;
    while (savedRevision !== revision) {
      const ownRevision = revision;
      const wanted = patch();
      try {
        const reply = await options.save(wanted);
        if (Object.entries(wanted).some(([key, value]) => reply.prefs?.[key as keyof InstancePrefs] !== value)) {
          throw new Error('Recued could not save what you picked');
        }
        savedRevision = ownRevision;
        error = '';
      } catch {
        if (ownRevision !== revision) continue;
        error = 'These work now, but Recued will forget them.';
        break;
      }
    }
    saving = false;
    if (!disposed) syncControls?.();
  };
  const change = (): void => {
    touched = true; revision++; error = '';
    syncControls?.(); options.changed(); void save();
  };
  return {
    filters: () => filters,
    scope: () => scope,
    adopt(prefs: Partial<InstancePrefs>): void {
      if (touched || disposed) return;
      filters = parseChatHistoryFilters({
        source: getPref(prefs, 'ui.chat.history.source'),
        vendor: getPref(prefs, 'ui.chat.history.vendor'),
        needs_attention: getPref(prefs, 'ui.chat.history.needs_attention'),
      }) ?? { ...DEFAULT_CHAT_HISTORY_FILTERS };
      scope = getPref(prefs, 'ui.chat.history.scope') === 'current' ? 'current' : 'all';
      syncControls?.(); options.changed();
    },
    mount(host: HTMLElement): void {
      const doc = options.document;
      host.className = 'chat-history-filters';
      const select = (id: string, title: string, values: readonly string[], label: (value: string) => string, changeValue: (value: string) => void) => {
        const wrapper = doc.createElement('label'); wrapper.textContent = title;
        const control = doc.createElement('select'); control.setAttribute(HISTORY_FILTER_ATTR, id);
        for (const value of values) {
          const option = doc.createElement('option'); option.value = value; option.textContent = label(value); control.appendChild(option);
        }
        control.addEventListener('change', () => { changeValue(control.value); change(); });
        wrapper.appendChild(control); host.appendChild(wrapper); return control;
      };
      const source = select('source', 'Chats from', CHAT_HISTORY_SOURCES,
        value => value === 'all' ? 'All sources' : value === 'webclient' ? 'Webclient' : 'Messenger', value => {
          filters = parseChatHistoryFilters({ ...filters, source: value, ...(value === 'webclient' ? { vendor: 'all', needs_attention: false } : {}) })!;
        });
      const vendor = select('vendor', 'Messenger', CHAT_HISTORY_VENDORS,
        value => value === 'all' ? 'All messengers' : getMessengerVendorDeclaration(value)?.display_name ?? value, value => {
          filters = parseChatHistoryFilters({ ...filters, vendor: value, ...(value !== 'all' ? { source: 'messenger' } : {}) })!;
        });
      const attentionLabel = doc.createElement('label'); attentionLabel.className = 'chat-history-attention';
      const attention = doc.createElement('input'); attention.type = 'checkbox'; attention.setAttribute(HISTORY_FILTER_ATTR, 'attention');
      attention.addEventListener('change', () => {
        filters = { ...filters, needs_attention: attention.checked, ...(attention.checked && filters.source === 'webclient' ? { source: 'messenger' as const } : {}) }; change();
      });
      const attentionText = doc.createElement('span'); attentionText.textContent = 'Needs attention';
      attentionLabel.appendChild(attention); attentionLabel.appendChild(attentionText); host.appendChild(attentionLabel);
      const searchScope = select('scope', 'Search messages in', ['all', 'current'],
        value => value === 'all' ? 'All matching chats' : 'Current conversation', value => { scope = value === 'current' ? 'current' : 'all'; });
      const clear = doc.createElement('button'); clear.type = 'button'; clear.className = 'chat-session-action';
      clear.setAttribute(HISTORY_FILTER_ATTR, 'clear'); clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => { filters = { ...DEFAULT_CHAT_HISTORY_FILTERS }; scope = 'all'; change(); }); host.appendChild(clear);
      const note = doc.createElement('p'); note.className = 'chat-history-filter-note'; note.setAttribute('role', 'status'); host.appendChild(note);
      const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'chat-session-action';
      retry.setAttribute(HISTORY_FILTER_ATTR, 'retry'); retry.textContent = 'Try saving again';
      retry.addEventListener('click', () => { void save(); }); host.appendChild(retry);
      syncControls = () => {
        source.value = filters.source; vendor.value = filters.vendor; attention.checked = filters.needs_attention; searchScope.value = scope;
        note.textContent = error; note.hidden = !error; retry.hidden = !error;
      };
      syncControls();
    },
    dispose(): void { disposed = true; syncControls = undefined; },
  };
};
