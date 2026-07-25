/** D-173 P6 - Reception Inbox DOM mount.
 *
 *  A thin PWA panel: renders server-projected inbox items, sends approve /
 *  reject rpc requests, and refreshes on `reception_inbox` broadcasts. The
 *  renderer uses DOM nodes (`createElement` + `clearChildren`) throughout.
 */

import type {
  Conn,
  InboxItem,
  ReceptionInboxView,
  ServerRpcRegistry,
} from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  buildReceptionInboxApproveDispatch,
  buildReceptionInboxListDispatch,
  buildReceptionInboxModel,
  buildReceptionInboxRejectDispatch,
  isReceptionDestinationPickerField,
  mapSourceRegistrationsToDestinationOptions,
  resolveReceptionDestinationEdit,
  resolveReceptionInboxApproveResultCopy,
  resolveReceptionInboxErrorCopy,
  type ReceptionInboxDetailModel,
  type ReceptionInboxFieldModel,
  type ReceptionInboxModel,
} from './inbox-model.js';

/** The broadcast kind this panel subscribes to (D-173 Reception Inbox
 *  review-then-approve queue). Exposed as a const so the panel's own test can
 *  assert it's in `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` — the server fans only the
 *  kinds each client names (D-169 TR-10), so an un-listed kind would make this
 *  panel's listener silently never fire. Single source of truth: the panel
 *  subscribes off this list. Mirrors `RECEPTION_PAGE_SHELL_BROADCAST_KINDS`. */
export const RECEPTION_INBOX_BROADCAST_KINDS = ['reception_inbox'] as const;

/** D-177 N.14 — the "Approve & allow for this form" button (rendered only
 *  when the server projected a real offer off the hold's ask). */
export const RECEPTION_INBOX_ALLOW_BUTTON_ATTR =
  'data-recued-reception-inbox-allow';
/** D-177 N.14 — allow never combines with edits (the server refuses; the
 *  client explains instead of silently dropping the edits). */
export const RECEPTION_INBOX_ALLOW_WITH_EDITS_COPY =
  "Clear your edits first — an edited approval can't grant standing trust for this form.";

/** Render the allow offer's bounds ("24 h / 20 uses"; days past 48 h). */
const formatAllowBounds = (offer: { ttl_ms: number; max_uses: number }): string => {
  const hours = Math.round(offer.ttl_ms / 3_600_000);
  const span = hours >= 48 ? `${Math.round(hours / 24)} d` : `${hours} h`;
  return `${span} / ${offer.max_uses} uses`;
};

export type ReceptionInboxConn = Conn<
  Pick<
    ServerRpcRegistry,
    | 'reception.inbox.list'
    | 'reception.inbox.approve'
    | 'reception.inbox.reject'
    // D-174 ref-picker — the held-op "Destination" field resolves its
    // options from the work-entity Source registry (no new rpc).
    | 'work_entity.source.list'
  >
>;

export interface ReceptionInboxPanelOptions {
  host: HTMLElement;
  conn: ReceptionInboxConn;
  subscribe?: BroadcastSubscriber['on'];
  document?: Document;
  now?: () => number;
}

export interface ReceptionInboxPanelMount {
  getState(): {
    view: ReceptionInboxView;
    items: ReadonlyArray<InboxItem>;
    selected_hold_id: string | null;
    loading: boolean;
    in_flight: boolean;
    error: string | null;
  };
  refresh(view?: ReceptionInboxView): Promise<void>;
  select(holdId: string): void;
  dispose(): void;
}

interface InternalState {
  view: ReceptionInboxView;
  items: ReadonlyArray<InboxItem>;
  selected_hold_id: string | null;
  loading: boolean;
  in_flight: boolean;
  error: string | null;
  acknowledge_risk: boolean;
}

const errMessage = (err: unknown): string => resolveReceptionInboxErrorCopy(err);

const RECEPTION_INBOX_STYLES = `
.reception-inbox-shell {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04), 0 14px 36px rgba(24, 24, 27, 0.045);
}
.reception-inbox-head,
.reception-inbox-toolbar,
.reception-inbox-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reception-inbox-head {
  justify-content: space-between;
  padding: 17px 18px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(110deg, var(--accent-weak), transparent 48%), var(--surface);
}
.reception-inbox-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
}
.reception-inbox-meta,
.reception-inbox-muted {
  color: var(--fg-muted);
  font-size: 12px;
}
.reception-inbox-body {
  display: grid;
  grid-template-columns: minmax(270px, 0.82fr) minmax(320px, 1.4fr);
  gap: 0;
}
.reception-inbox-list,
.reception-inbox-detail {
  padding: 16px;
}
.reception-inbox-list {
  border-right: 1px solid var(--border);
  background: var(--surface-sunk);
}
.reception-inbox-detail {
  min-width: 0;
  background: var(--surface);
}
.reception-inbox-group + .reception-inbox-group {
  margin-top: 12px;
}
.reception-inbox-group-title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.reception-inbox-row {
  width: 100%;
  display: block;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--surface);
  color: inherit;
  padding: 11px 12px;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}
.reception-inbox-row + .reception-inbox-row {
  margin-top: 6px;
}
.reception-inbox-row[aria-selected="true"] {
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: inset 3px 0 0 var(--accent), 0 4px 14px rgba(24, 24, 27, 0.07);
}
.reception-inbox-row:hover {
  border-color: var(--border-strong, var(--border));
  transform: translateY(-1px);
}
.reception-inbox-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.reception-inbox-row-title,
.reception-inbox-detail-title {
  display: block;
  font-weight: 650;
  font-size: 13px;
}
.reception-inbox-detail-title { font-size: 18px; letter-spacing: -0.01em; }
.reception-inbox-row-subtitle,
.reception-inbox-detail-subtitle {
  display: block;
  margin-top: 3px;
  color: var(--fg-muted);
  font-size: 12px;
}
/* D-173 D7 — the overlap count. Since the substrate stopped refusing
   overlapping bookings, this line is what the owner judges capacity on, so it
   must out-rank the muted metadata above it: full foreground rather than the
   muted token, plus a heavier weight. Per the D-174 sheet it earns that WITHOUT
   a new hue — weight + neutrals only, no alarm colour. It is not an error; it
   is a fact the owner might act on, and colouring it red would cry wolf on
   every consecutive booking. */
.reception-inbox-row-overlap,
.reception-inbox-detail-overlap {
  display: block;
  margin-top: 3px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
}
.reception-inbox-chip {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
}
.reception-inbox-chip--target {
  /* Neutral surface (D-174 — meaning rides the label, not an amber hue);
     token-based so it adapts to dark mode instead of a fixed light chip. */
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
.reception-inbox-error {
  margin: 10px 12px 0;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12px;
}
.reception-inbox-empty {
  padding: 16px;
  color: var(--fg-muted);
  font-size: 13px;
}
.reception-inbox-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 16px;
}
.reception-inbox-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reception-inbox-field label {
  font-size: 12px;
  font-weight: 600;
}
.reception-inbox-field input,
.reception-inbox-field select,
.reception-inbox-field textarea,
.reception-inbox-reason {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  min-height: 42px;
  border-radius: 9px;
  background: var(--surface-sunk);
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 9px 10px;
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}
.reception-inbox-field input:focus,
.reception-inbox-field select:focus,
.reception-inbox-field textarea:focus,
.reception-inbox-reason:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.reception-inbox-field textarea {
  min-height: 92px;
  resize: vertical;
}
.reception-inbox-field .is-masked {
  -webkit-text-security: disc;
}
.reception-inbox-help {
  color: var(--fg-muted);
  font-size: 11px;
}
.reception-inbox-attachment {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-inbox-response-summary {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-inbox-response-summary h4 {
  margin: 0 0 9px;
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.reception-inbox-response-body {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.reception-inbox-detail-actions {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.reception-inbox-btn {
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 11px;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.reception-inbox-btn:hover:not(:disabled) {
  border-color: var(--border-strong, var(--border));
  background: var(--surface-sunk);
  transform: translateY(-1px);
}
.reception-inbox-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.reception-inbox-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.reception-inbox-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.reception-inbox-btn--primary:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-dim, var(--accent));
}
.reception-inbox-btn--danger {
  color: var(--danger);
  border-color: var(--danger);
}
@media (max-width: 820px) {
  .reception-inbox-body {
    grid-template-columns: 1fr;
  }
  .reception-inbox-list {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
@media (max-width: 560px) {
  .reception-inbox-shell { border-radius: 12px; }
  .reception-inbox-head { align-items: flex-start; padding: 15px 14px; }
  .reception-inbox-toolbar { width: 100%; }
  .reception-inbox-toolbar .reception-inbox-btn { flex: 1 1 auto; }
  .reception-inbox-list,
  .reception-inbox-detail { padding: 13px; }
  .reception-inbox-detail-actions .reception-inbox-btn { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .reception-inbox-shell * { transition: none !important; }
}
`;

const clearChildren = (node: HTMLElement): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const appendText = (doc: Document, parent: HTMLElement, text: string): HTMLElement => {
  const span = doc.createElement('span');
  span.textContent = text;
  parent.appendChild(span);
  return span;
};

const makeButton = (
  doc: Document,
  label: string,
  onClick: () => void,
  opts: { primary?: boolean; danger?: boolean; disabled?: boolean } = {},
): HTMLButtonElement => {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = [
    'reception-inbox-btn',
    opts.primary === true ? 'reception-inbox-btn--primary' : '',
    opts.danger === true ? 'reception-inbox-btn--danger' : '',
  ].filter(Boolean).join(' ');
  btn.textContent = label;
  if (opts.disabled === true) btn.disabled = true;
  btn.addEventListener('click', onClick);
  return btn;
};

const appendChip = (
  doc: Document,
  parent: HTMLElement,
  text: string,
  target = false,
): void => {
  const chip = doc.createElement('span');
  chip.className = target
    ? 'reception-inbox-chip reception-inbox-chip--target'
    : 'reception-inbox-chip';
  chip.textContent = text;
  parent.appendChild(chip);
};

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const parseFieldValue = (
  field: ReceptionInboxFieldModel,
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): unknown => {
  if (field.type === 'boolean') {
    return (control as HTMLInputElement).checked;
  }
  const raw = control.value;
  if (raw.trim() === '' && field.required === false) return undefined;
  switch (field.type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${field.label} must be a number.`);
      return n;
    }
    case 'datetime':
      if (typeof field.value === 'number') return new Date(raw).getTime();
      return raw;
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`${field.label} must be valid JSON.`);
      }
  }
};

const renderFieldControl = (
  doc: Document,
  field: ReceptionInboxFieldModel,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  if (field.input_kind === 'textarea') {
    const textarea = doc.createElement('textarea');
    textarea.value = field.value_text;
    return textarea;
  }
  if (field.input_kind === 'select') {
    const select = doc.createElement('select');
    select.required = field.required;
    const empty = doc.createElement('option');
    empty.value = '';
    // The destination options_source (reception_destination_sources) is
    // resolved upstream as a live ref-picker (renderDestinationPickerShell),
    // so it never reaches here. This select is the generic fallback for any
    // OTHER options_source without a client-side resolver: it renders a clear
    // "unavailable" label (and stays disabled) rather than an empty dropdown.
    empty.textContent =
      field.options_source !== null
        ? `Picker unavailable: ${field.options_source}`
        : 'Select';
    select.appendChild(empty);
    select.value = typeof field.value === 'string' ? field.value : '';
    return select;
  }
  const input = doc.createElement('input');
  input.type = field.input_kind;
  input.required = field.required;
  if (field.type === 'boolean') {
    input.checked = field.value === true;
  } else {
    input.value = field.value_text;
  }
  if (field.type === 'number') {
    if (field.validation?.min !== undefined) input.min = String(field.validation.min);
    if (field.validation?.max !== undefined) input.max = String(field.validation.max);
  }
  if (field.validation?.pattern !== undefined) input.pattern = field.validation.pattern;
  return input;
};

const applyPrivacyMask = (
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  field: ReceptionInboxFieldModel,
): void => {
  if (!field.masked) return;
  control.classList.add('is-masked');
  control.addEventListener('focus', () => control.classList.remove('is-masked'));
  control.addEventListener('blur', () => control.classList.add('is-masked'));
};

export const mountReceptionInboxPanel = (
  opts: ReceptionInboxPanelOptions,
): ReceptionInboxPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionInboxPanel: no document available - pass opts.document for non-browser environments',
    );
  }
  const now = opts.now ?? (() => Date.now());
  const root = doc.createElement('div');
  root.setAttribute('data-recued-reception-inbox', '');
  opts.host.appendChild(root);

  let state: InternalState = {
    view: 'open',
    items: [],
    selected_hold_id: null,
    loading: true,
    in_flight: false,
    error: null,
    acknowledge_risk: false,
  };
  let disposed = false;
  let loadGeneration = 0;
  let currentModel: ReceptionInboxModel = buildReceptionInboxModel({
    items: [],
    view: 'open',
    selected_hold_id: null,
    now: now(),
  });

  // ── Destination ref-picker (D-174) ──────────────────────────────────
  // The held-op "Destination" field (`options_source:
  // reception_destination_sources`) renders as the shared name→id combobox
  // instead of the old "Picker unavailable" stub. Options come from the
  // work-entity Source registry, loaded lazily the first time a destination
  // field shows. Pickers are EPHEMERAL — `render()` rebuilds the whole DOM
  // tree, so the prior paint's handles are torn down and re-attached each
  // render; the committed pick lives in `pickerValues` (the source of truth),
  // keyed by field, reset when the selected hold changes.
  let destinationOptions: ReadonlyArray<RefPicker.RefPickerOption> | null = null;
  let destinationLoad: 'idle' | 'loading' | 'loaded' | 'error' = 'idle';
  let destinationPickers: RefPicker.RefPickerHandle[] = [];
  let pickerHold: string | null = null;
  let pickerValues = new Map<string, string>();

  const resolveDestinationLabel = (id: string): string =>
    destinationOptions?.find((option) => option.id === id)?.label ?? id;

  const destinationSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(destinationOptions ?? [], query));

  const destinationPickerConfig = (
    field: ReceptionInboxFieldModel,
  ): RefPicker.RefPickerRenderConfig => ({
    pickerId: `reception-inbox-dest-${field.key}`,
    placeholder:
      destinationLoad === 'loading' ? 'Loading destinations...' : 'Search destinations',
    ariaLabel: field.label,
    emptyText:
      destinationLoad === 'error'
        ? 'Could not load destinations.'
        : 'No destinations match.',
  });

  const destinationSeed = (
    field: ReceptionInboxFieldModel,
  ): RefPicker.RefPickerSelection | null => {
    const staged = pickerValues.get(field.key);
    const id =
      staged ?? (typeof field.value === 'string' ? field.value : '');
    if (id === '') return null;
    return { id, label: resolveDestinationLabel(id) };
  };

  const ensureDestinationOptions = (): void => {
    if (destinationLoad !== 'idle') return;
    destinationLoad = 'loading';
    void (async () => {
      try {
        const result = await opts.conn('work_entity.source.list');
        if (disposed) return;
        destinationOptions = mapSourceRegistrationsToDestinationOptions(result.sources);
        destinationLoad = 'loaded';
        render();
      } catch {
        if (disposed) return;
        destinationOptions = [];
        destinationLoad = 'error';
        render();
      }
    })();
  };

  /** Render the picker shell into a field wrap (the host's static markup);
   *  `attachDestinationPickers` wires it after the paint. */
  const renderDestinationPickerShell = (
    wrap: HTMLElement,
    field: ReceptionInboxFieldModel,
  ): void => {
    const container = doc.createElement('div');
    container.setAttribute('data-recued-reception-inbox-picker', field.key);
    container.innerHTML = RefPicker.renderRefPicker(
      RefPicker.initialRefPickerState(destinationSeed(field)),
      destinationPickerConfig(field),
    );
    wrap.appendChild(container);
  };

  const teardownDestinationPickers = (): void => {
    for (const handle of destinationPickers) {
      try {
        handle.destroy();
      } catch {
        // Isolated teardown.
      }
    }
    destinationPickers = [];
  };

  const attachDestinationPickers = (
    detail: ReceptionInboxDetailModel | null,
  ): void => {
    // Staged picks belong to the selected hold — drop them whenever the
    // selection changes, even to a row WITHOUT a destination field (and on
    // deselect). This runs BEFORE the early return below so `pickerHold`
    // tracks every selection; otherwise a stale pick could survive an
    // A -> other-row -> A detour and leak into A's edits.
    const holdId = detail?.item.hold_id ?? null;
    if (pickerHold !== holdId) {
      pickerHold = holdId;
      pickerValues = new Map();
    }
    const pickerFields = (detail?.fields ?? []).filter(isReceptionDestinationPickerField);
    if (pickerFields.length === 0) return;
    // Load the Source registry the first time a destination field appears;
    // `ensureDestinationOptions` re-renders on completion to hydrate labels.
    ensureDestinationOptions();
    // The unit-test fake DOM stores innerHTML as a string (no parse), so the
    // live picker cannot mount there — wire would no-op; skip cleanly.
    if (typeof root.querySelector !== 'function') return;
    for (const field of pickerFields) {
      const handle = RefPicker.wireRefPicker(root, {
        search: destinationSearch,
        config: destinationPickerConfig(field),
        minChars: 0,
        initialValue: destinationSeed(field),
        onChange: (selection) => {
          if (selection === null) pickerValues.delete(field.key);
          else pickerValues.set(field.key, selection.id);
        },
      });
      destinationPickers.push(handle);
    }
  };

  const render = (): void => {
    if (disposed) return;
    // Release the prior paint's pickers before `clearChildren` removes the
    // DOM they attached to (ephemeral — re-created below if still shown).
    teardownDestinationPickers();
    currentModel = buildReceptionInboxModel({
      items: state.items,
      view: state.view,
      selected_hold_id: state.selected_hold_id,
      now: now(),
    });
    clearChildren(root);

    const style = doc.createElement('style');
    style.textContent = [RECEPTION_INBOX_STYLES, RefPicker.REF_PICKER_STYLES].join('\n');
    root.appendChild(style);

    const shell = doc.createElement('section');
    shell.className = 'reception-inbox-shell';
    shell.setAttribute('aria-label', 'Reception Inbox');
    root.appendChild(shell);

    const header = doc.createElement('div');
    header.className = 'reception-inbox-head';
    shell.appendChild(header);

    const titleWrap = doc.createElement('div');
    header.appendChild(titleWrap);
    const title = doc.createElement('h3');
    title.className = 'reception-inbox-title';
    title.textContent = 'Reception Inbox';
    titleWrap.appendChild(title);
    const meta = doc.createElement('div');
    meta.className = 'reception-inbox-meta';
    meta.textContent = `${currentModel.view_label} - ${currentModel.total_items} ${currentModel.total_items === 1 ? 'item' : 'items'}`;
    titleWrap.appendChild(meta);

    const toolbar = doc.createElement('div');
    toolbar.className = 'reception-inbox-toolbar';
    header.appendChild(toolbar);
    toolbar.appendChild(
      makeButton(doc, 'Open', () => void refresh('open'), {
        primary: state.view === 'open',
        disabled: state.loading || state.in_flight,
      }),
    );
    toolbar.appendChild(
      makeButton(doc, 'Dismissed / expired', () => void refresh('subview'), {
        primary: state.view === 'subview',
        disabled: state.loading || state.in_flight,
      }),
    );
    toolbar.appendChild(
      makeButton(doc, 'Refresh', () => void refresh(), {
        disabled: state.loading || state.in_flight,
      }),
    );

    if (state.error !== null) {
      const error = doc.createElement('div');
      error.className = 'reception-inbox-error';
      error.setAttribute('role', 'alert');
      error.textContent = state.error;
      shell.appendChild(error);
    }

    if (state.loading && state.items.length === 0) {
      const loading = doc.createElement('div');
      loading.className = 'reception-inbox-empty';
      loading.textContent = 'Loading Reception Inbox...';
      shell.appendChild(loading);
      return;
    }

    const body = doc.createElement('div');
    body.className = 'reception-inbox-body';
    shell.appendChild(body);

    const list = doc.createElement('div');
    list.className = 'reception-inbox-list';
    body.appendChild(list);
    if (currentModel.is_empty) {
      const empty = doc.createElement('div');
      empty.className = 'reception-inbox-empty';
      empty.textContent =
        state.view === 'open'
          ? 'No held Reception requests.'
          : 'No dismissed or expired Reception requests.';
      list.appendChild(empty);
    } else {
      for (const group of currentModel.groups) {
        const groupEl = doc.createElement('section');
        groupEl.className = 'reception-inbox-group';
        list.appendChild(groupEl);
        const groupTitle = doc.createElement('h4');
        groupTitle.className = 'reception-inbox-group-title';
        groupTitle.textContent = group.label;
        groupEl.appendChild(groupTitle);
        for (const row of group.rows) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'reception-inbox-row';
          btn.setAttribute(
            'aria-selected',
            row.hold_id === state.selected_hold_id ? 'true' : 'false',
          );
          btn.addEventListener('click', () => {
            state = {
              ...state,
              selected_hold_id: row.hold_id,
              error: null,
              acknowledge_risk: false,
            };
            render();
          });
          const rowTitle = doc.createElement('span');
          rowTitle.className = 'reception-inbox-row-title';
          rowTitle.textContent = row.title;
          btn.appendChild(rowTitle);
          const subtitle = doc.createElement('span');
          subtitle.className = 'reception-inbox-row-subtitle';
          subtitle.textContent = [
            row.subtitle,
            row.when_label,
            row.source_label,
          ].filter(Boolean).join(' - ');
          btn.appendChild(subtitle);
          // D-173 D7 — its OWN line, deliberately not folded into the ' - '
          // subtitle above. This is the count the owner judges capacity on now
          // that the substrate no longer refuses an overlapping booking; joined
          // in among source/when metadata it reads as trivia, and the one time
          // it matters is the time it must not be skimmed past.
          if (row.overlap_label !== null) {
            const overlap = doc.createElement('span');
            overlap.className = 'reception-inbox-row-overlap';
            overlap.textContent = row.overlap_label;
            btn.appendChild(overlap);
          }
          groupEl.appendChild(btn);
        }
      }
    }

    const detail = doc.createElement('div');
    detail.className = 'reception-inbox-detail';
    body.appendChild(detail);
    renderDetail(detail, currentModel.selected);

    // (Re-)attach destination pickers to the freshly-painted form shells.
    attachDestinationPickers(currentModel.selected);
  };

  const setError = (err: unknown): void => {
    state = { ...state, error: errMessage(err), loading: false, in_flight: false };
    render();
  };

  const refresh = async (view: ReceptionInboxView = state.view): Promise<void> => {
    const gen = ++loadGeneration;
    state = { ...state, view, loading: true, error: null };
    render();
    try {
      const dispatch = buildReceptionInboxListDispatch(view);
      const result = await opts.conn(dispatch.op, { view: dispatch.view });
      if (disposed || gen !== loadGeneration) return;
      const stillSelected =
        state.selected_hold_id !== null
        && result.items.some((item) => item.hold_id === state.selected_hold_id);
      state = {
        ...state,
        items: result.items,
        selected_hold_id: stillSelected
          ? state.selected_hold_id
          : result.items[0]?.hold_id ?? null,
        loading: false,
        error: null,
        acknowledge_risk: false,
      };
      render();
    } catch (err) {
      if (disposed || gen !== loadGeneration) return;
      setError(err);
    }
  };

  const collectEdits = (detail: ReceptionInboxDetailModel): Record<string, unknown> => {
    const edits: Record<string, unknown> = {};
    for (const field of detail.fields) {
      // Resolvable destination fields carry their value in `pickerValues`
      // (the picker is ephemeral; the staged id is the source of truth).
      if (isReceptionDestinationPickerField(field)) {
        const decision = resolveReceptionDestinationEdit(
          field,
          pickerValues.get(field.key) ?? null,
        );
        if (decision.include && decision.value !== undefined) {
          edits[field.key] = decision.value;
        }
        continue;
      }
      if (field.picker_stubbed) continue;
      const control = root.querySelector(
        `[data-recued-reception-inbox-field="${CSS.escape(field.key)}"]`,
      ) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (control === null) continue;
      const next = parseFieldValue(field, control);
      if (!sameValue(next, field.value)) edits[field.key] = next;
    }
    return edits;
  };

  const approveSelected = async (
    detail: ReceptionInboxDetailModel,
    submitOpts: { allow?: boolean } = {},
  ): Promise<void> => {
    if (state.in_flight) return;
    // Mirror the Approve button's disabled predicate so an Enter-key form
    // submit can't bypass the scan-gate UX (the server re-checks regardless —
    // no security gap — but this keeps the client honest): a `pending` hold
    // (approve_disabled_reason) or an un-acknowledged advisory attachment
    // blocks the submit.
    if (
      detail.approve_disabled_reason !== null
      || (detail.attachment?.requires_acknowledgement === true && !state.acknowledge_risk)
    ) {
      return;
    }
    let edits: Record<string, unknown>;
    try {
      edits = collectEdits(detail);
    } catch (err) {
      setError(err);
      return;
    }
    // D-177 N.14 — allow never combines with edits (the server refuses the
    // combination; explain rather than silently dropping the edits).
    if (submitOpts.allow === true && Object.keys(edits).length > 0) {
      state = { ...state, error: RECEPTION_INBOX_ALLOW_WITH_EDITS_COPY };
      render();
      return;
    }
    state = { ...state, in_flight: true, error: null };
    render();
    try {
      const dispatch = buildReceptionInboxApproveDispatch({
        hold_id: detail.item.hold_id,
        edits,
        ...(state.acknowledge_risk ? { acknowledge_attachment_risk: true } : {}),
        ...(submitOpts.allow === true ? { allow: true } : {}),
      });
      const { op, ...payload } = dispatch;
      const result = await opts.conn(op, payload);
      const approveError = resolveReceptionInboxApproveResultCopy(result);
      if (approveError !== null) {
        state = { ...state, in_flight: false, error: approveError };
        render();
        return;
      }
      state = { ...state, in_flight: false };
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  const rejectSelected = async (detail: ReceptionInboxDetailModel): Promise<void> => {
    if (state.in_flight) return;
    const reasonEl = root.querySelector(
      '[data-recued-reception-inbox-reason]',
    ) as HTMLTextAreaElement | null;
    const reason = reasonEl?.value.trim();
    state = { ...state, in_flight: true, error: null };
    render();
    try {
      const dispatch = buildReceptionInboxRejectDispatch({
        hold_id: detail.item.hold_id,
        ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      });
      const { op, ...payload } = dispatch;
      await opts.conn(op, payload);
      state = { ...state, in_flight: false };
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  const renderDetail = (
    parent: HTMLElement,
    detail: ReceptionInboxDetailModel | null,
  ): void => {
    if (detail === null) {
      const empty = doc.createElement('div');
      empty.className = 'reception-inbox-empty';
      empty.textContent = 'Select an inbox item.';
      parent.appendChild(empty);
      return;
    }
    const title = doc.createElement('span');
    title.className = 'reception-inbox-detail-title';
    title.textContent = detail.item.title;
    parent.appendChild(title);
    const subtitle = doc.createElement('span');
    subtitle.className = 'reception-inbox-detail-subtitle';
    subtitle.textContent = [
      detail.item.subtitle,
      detail.item.when_label,
      detail.item.proposed_action,
    ].filter(Boolean).join(' - ');
    parent.appendChild(subtitle);
    // D-173 D7 — the count, on the surface where the decision is actually made.
    // Own line, same reasoning as the row.
    if (detail.item.overlap_label !== null) {
      const overlap = doc.createElement('span');
      overlap.className = 'reception-inbox-detail-overlap';
      overlap.textContent = detail.item.overlap_label;
      parent.appendChild(overlap);
    }

    const chips = doc.createElement('div');
    chips.className = 'reception-inbox-toolbar';
    chips.style.marginTop = '8px';
    parent.appendChild(chips);
    appendChip(doc, chips, detail.item.top_tier_label);
    appendChip(doc, chips, detail.item.status);
    appendChip(doc, chips, detail.item.operation_id);

    if (detail.attachment !== null) {
      const attachment = doc.createElement('div');
      attachment.className = 'reception-inbox-attachment';
      parent.appendChild(attachment);
      appendText(
        doc,
        attachment,
        `${detail.attachment.filename} - ${detail.attachment.mime_type} - ${detail.attachment.size_label}`,
      );
      attachment.appendChild(doc.createElement('br'));
      appendChip(doc, attachment, `scan ${detail.attachment.scan_label}`);
      if (detail.attachment.warning !== null) {
        const warn = doc.createElement('div');
        warn.className = 'reception-inbox-help';
        warn.style.marginTop = '6px';
        warn.textContent = `⚠ ${detail.attachment.warning}`;
        attachment.appendChild(warn);
      }
      // Advisory confirm (N.2) — an `unscanned` / `flagged` attachment attaches
      // once the admin ticks the box (warn-and-confirm, not a hard block). A
      // `pending` scan shows no box: it's a brief self-clearing hold, and
      // approve stays disabled via `approve_disabled_reason`.
      if (detail.attachment.requires_acknowledgement) {
        const label = doc.createElement('label');
        label.className = 'reception-inbox-help';
        label.style.display = 'block';
        label.style.marginTop = '8px';
        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.acknowledge_risk;
        checkbox.disabled = state.in_flight;
        checkbox.addEventListener('change', () => {
          state = { ...state, acknowledge_risk: checkbox.checked };
          render();
        });
        label.appendChild(checkbox);
        label.appendChild(
          doc.createTextNode(' I reviewed this attachment — attach it anyway'),
        );
        attachment.appendChild(label);
      }
    }

    if (detail.review_body !== null) {
      const summary = doc.createElement('section');
      summary.className = 'reception-inbox-response-summary';
      parent.appendChild(summary);
      const heading = doc.createElement('h4');
      heading.textContent = 'Submitted answers';
      summary.appendChild(heading);
      const body = doc.createElement('pre');
      body.className = 'reception-inbox-response-body';
      body.textContent = detail.review_body;
      summary.appendChild(body);
    }

    const form = doc.createElement('form');
    form.className = 'reception-inbox-form';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void approveSelected(detail);
    });
    parent.appendChild(form);

    if (detail.fields.length === 0) {
      const noFields = doc.createElement('div');
      noFields.className = 'reception-inbox-muted';
      noFields.textContent = 'No editable args for this held operation.';
      form.appendChild(noFields);
    }

    for (const field of detail.fields) {
      const wrap = doc.createElement('div');
      wrap.className = 'reception-inbox-field';
      form.appendChild(wrap);
      const label = doc.createElement('label');
      label.textContent = field.required ? `${field.label} *` : field.label;
      wrap.appendChild(label);
      const isDestinationPicker = isReceptionDestinationPickerField(field);
      if (isDestinationPicker) {
        renderDestinationPickerShell(wrap, field);
      } else {
        const control = renderFieldControl(doc, field);
        control.setAttribute('data-recued-reception-inbox-field', field.key);
        control.disabled = state.in_flight || field.picker_stubbed;
        applyPrivacyMask(control, field);
        wrap.appendChild(control);
      }
      const helpParts: string[] = [];
      if (field.privacy !== null) helpParts.push(`privacy: ${field.privacy}`);
      if (field.affects_target) helpParts.push('changes the destination');
      // The live picker IS the affordance for a resolvable destination — only
      // surface the raw `picker:` hint for a source that is still stubbed.
      if (field.options_source !== null && !isDestinationPicker) {
        helpParts.push(`picker: ${field.options_source}`);
      }
      if (helpParts.length > 0) {
        const help = doc.createElement('div');
        help.className = 'reception-inbox-help';
        help.textContent = helpParts.join(' - ');
        wrap.appendChild(help);
      }
      if (field.affects_target) appendChip(doc, wrap, 'changes the destination', true);
    }

    const reason = doc.createElement('textarea');
    reason.className = 'reception-inbox-reason';
    reason.setAttribute('data-recued-reception-inbox-reason', '');
    reason.placeholder = 'Reject reason';
    reason.disabled = state.in_flight;
    parent.appendChild(reason);

    const actions = doc.createElement('div');
    actions.className = 'reception-inbox-detail-actions';
    parent.appendChild(actions);
    actions.appendChild(
      makeButton(doc, 'Approve', () => void approveSelected(detail), {
        primary: true,
        disabled:
          state.in_flight
          || detail.approve_disabled_reason !== null
          || (detail.attachment?.requires_acknowledgement === true && !state.acknowledge_risk),
      }),
    );
    // D-177 N.14 — "Approve & allow for this form": rendered ONLY when the
    // hold's ask actually carries the offer (the server-projected hint; the
    // rpc re-verifies at the act site). Refused with edits — the submit
    // path checks and explains rather than silently dropping them.
    if (detail.item.allow_offer !== null) {
      const allowButton = makeButton(
        doc,
        `Approve & allow for this form (${formatAllowBounds(detail.item.allow_offer)})`,
        () => void approveSelected(detail, { allow: true }),
        {
          disabled:
            state.in_flight
            || detail.approve_disabled_reason !== null
            || (detail.attachment?.requires_acknowledgement === true
              && !state.acknowledge_risk),
        },
      );
      allowButton.setAttribute(RECEPTION_INBOX_ALLOW_BUTTON_ATTR, '');
      actions.appendChild(allowButton);
    }
    actions.appendChild(
      makeButton(doc, 'Reject', () => void rejectSelected(detail), {
        danger: true,
        disabled: state.in_flight,
      }),
    );
    if (detail.approve_disabled_reason !== null) {
      const disabled = doc.createElement('div');
      disabled.className = 'reception-inbox-help';
      disabled.textContent = detail.approve_disabled_reason;
      parent.appendChild(disabled);
    }
    if (detail.immutable_arg_keys.length > 0) {
      const immutable = doc.createElement('div');
      immutable.className = 'reception-inbox-help';
      immutable.textContent = `Immutable args: ${detail.immutable_arg_keys.join(', ')}`;
      parent.appendChild(immutable);
    }
  };

  const unsubs: Array<() => void> = [];
  const subscribe = opts.subscribe;
  if (subscribe !== undefined) {
    const onInboxChanged = (): void => {
      if (disposed) return;
      void refresh();
    };
    for (const kind of RECEPTION_INBOX_BROADCAST_KINDS) {
      unsubs.push(subscribe(kind, onInboxChanged));
    }
  }

  void refresh('open');

  return {
    getState: () => ({
      view: state.view,
      items: state.items,
      selected_hold_id: state.selected_hold_id,
      loading: state.loading,
      in_flight: state.in_flight,
      error: state.error,
    }),
    refresh,
    select: (holdId) => {
      if (!state.items.some((item) => item.hold_id === holdId)) return;
      state = { ...state, selected_hold_id: holdId, error: null, acknowledge_risk: false };
      render();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      teardownDestinationPickers();
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Isolated teardown.
        }
      }
      unsubs.length = 0;
      root.remove();
    },
  };
};
