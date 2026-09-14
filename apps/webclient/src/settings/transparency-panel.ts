/** Settings → Transparency panel (D-145 § B.8.9).
 *
 *  User-facing controls for the chat activity disclosure's visibility
 *  policy: the master "Show inline thought stream" toggle, the three
 *  user-tunable per-class toggles, and the max-redaction-tier detail
 *  level. Persisted as per-pair `ui.transparency.*` instance prefs
 *  (`prefs.get` / `prefs.set` pair rpc) — per-device by design, like
 *  the notification opt-ins: verbose on the desk machine, quiet on the
 *  phone. The chat route re-reads prefs on every mount, so a change
 *  here applies on the next navigation to #chat.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Caller seams are narrow Promise functions (`runPrefsGet` /
 *  `runPrefsSet`), mirroring `notifications-panel.ts`. The bootstrap
 *  wires the pair rpc conn through thunks; tests inject fakes.
 *
 *  DD#2 — Render-on-transition rebuild via `createElement`, same as
 *  the notifications / TLS / Privacy panels. Every state change
 *  rebuilds the panel's inner DOM; no diffing.
 *
 *  DD#3 — Saves are serialized + authoritative. One control change →
 *  one `prefs.set` with a single-key patch; every control ARIA-locks
 *  while the save is in flight without dropping keyboard focus; the
 *  response's merged `prefs` replaces local state (the server is the source
 *  of truth — a concurrent write from another surface lands here on the next
 *  response).
 *
 *  DD#4 — The `failure` class renders as a fixed, disabled, checked
 *  row. § B.8.2's user-must-see invariant makes truthful failure
 *  messaging a substrate guarantee — `applyVisibilityPolicy` bypasses
 *  Settings for failure-class events, so a toggle here would be a lie.
 *
 *  DD#5 — The detail-level select offers ONLY `none` + `summary_only`.
 *  The third tier (`hidden`, § B.8.9's "debug mode") cannot render
 *  anything extra today: `applyVisibilityPolicy` returns `'hidden'`
 *  both for "filtered out" AND for a passed-through hidden tier, so
 *  every consumer drops it either way. Offering it would be a no-op
 *  option. The pref's `allowed` list keeps all three tiers so a future
 *  debug surface (which disambiguates the policy return) adds the
 *  option here without a contracts change.
 *
 *  DD#6 — Class toggles stay enabled while the master is off (both
 *  states are valid prefs — pre-configure the mix, then flip the
 *  master). A muted hint notes the stream is currently off. */

import type { InstancePrefKey, InstancePrefs } from '@recued/contracts';
import { getPref } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const TRANSPARENCY_PANEL_HOST_ATTR = 'data-recued-transparency-panel';
/** Per-toggle checkbox hook; the attribute VALUE is the pref key. */
export const TRANSPARENCY_PANEL_TOGGLE_ATTR =
  'data-recued-transparency-toggle';
/** The fixed failure-class row (disabled, always checked). */
export const TRANSPARENCY_PANEL_FAILURE_ROW_ATTR =
  'data-recued-transparency-failure-row';
/** Detail-level `<select>` hook. */
export const TRANSPARENCY_PANEL_TIER_ATTR = 'data-recued-transparency-tier';
export const TRANSPARENCY_PANEL_ERROR_ATTR = 'data-recued-transparency-error';
/** Muted "stream is currently off" hint shown while the master toggle
 *  is off. */
export const TRANSPARENCY_PANEL_OFF_HINT_ATTR =
  'data-recued-transparency-off-hint';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

export type TransparencyPrefsGetCaller = () => Promise<{
  prefs: InstancePrefs;
}>;
export type TransparencyPrefsSetCaller = (args: {
  patch: Partial<InstancePrefs>;
}) => Promise<{ prefs: InstancePrefs }>;

export interface MountTransparencyPanelOptions {
  /** Host element the panel renders into; inner DOM is rebuilt on
   *  every state transition and cleared on `dispose()`. */
  host: HTMLElement;
  document: Document;
  runPrefsGet: TransparencyPrefsGetCaller;
  runPrefsSet: TransparencyPrefsSetCaller;
}

export interface TransparencyPanelState {
  phase: 'loading' | 'ready' | 'error';
  /** Authoritative merged prefs from the last get/set response. */
  prefs: InstancePrefs | null;
  /** Pref key currently being saved, or null when idle. */
  saving: InstancePrefKey | null;
  /** Load failure (phase 'error') or save failure (phase 'ready'). */
  error: string | null;
}

export interface TransparencyPanelMount {
  getState(): TransparencyPanelState;
  /** A user-started preference write whose authoritative response has not
   *  settled. Initial preference loading is deliberately excluded. */
  hasInFlightWork(): boolean;
  /** Initial-load promise — resolves after the first `runPrefsGet`
   *  settles (either phase). */
  whenLoaded(): Promise<void>;
  /** Latest save promise — resolves after the in-flight `runPrefsSet`
   *  settles; immediately-resolved when no save has fired. */
  whenSaveSettled(): Promise<void>;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Row copy — § B.8.9 wording
// ════════════════════════════════════════════════════════════════

interface ToggleRowSpec {
  key: InstancePrefKey;
  label: string;
  detail: string;
}

const MASTER_ROW: ToggleRowSpec = {
  key: 'ui.transparency.enabled',
  label: 'Show what Recued is thinking',
  detail:
    'Per-turn narrative of what Recued is doing during AI turns — ' +
    'tool provenance rows and failure notices always render.',
};

const CLASS_ROWS: ReadonlyArray<ToggleRowSpec> = [
  {
    key: 'ui.transparency.class.ai_emitted',
    label: 'AI observations',
    detail: 'Extractions, alias resolutions, pattern observations.',
  },
  {
    key: 'ui.transparency.class.engine_brokering',
    label: 'Engine activity',
    detail: 'Memory lookups, "thinking..." cues, approval requests.',
  },
  {
    key: 'ui.transparency.class.orchestration',
    label: 'Internal orchestration',
    detail: 'Multi-turn round cues and per-turn token usage. Default off.',
  },
];

/** Detail-level options (DD#5 — `hidden` deliberately absent). */
const TIER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'Essential lines only' },
  { value: 'summary_only', label: 'Standard (recommended)' },
];

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountTransparencyPanel = (
  opts: MountTransparencyPanelOptions,
): TransparencyPanelMount => {
  const doc = opts.document;
  let disposed = false;
  let state: TransparencyPanelState = {
    phase: 'loading',
    prefs: null,
    saving: null,
    error: null,
  };
  let pendingLoad: Promise<void> = Promise.resolve();
  let pendingSave: Promise<void> | null = null;
  let pendingValue: boolean | string | null = null;

  opts.host.setAttribute(TRANSPARENCY_PANEL_HOST_ATTR, '');

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const controlHasFocus = (key: InstancePrefKey): boolean => {
    const active = (doc as Document & { activeElement?: Element | null })
      .activeElement;
    return key === 'ui.transparency.max_redaction_tier'
      ? active?.hasAttribute?.(TRANSPARENCY_PANEL_TIER_ATTR) === true
      : active?.getAttribute?.(TRANSPARENCY_PANEL_TOGGLE_ATTR) === key;
  };

  const focusControl = (key: InstancePrefKey): void => {
    const selector = key === 'ui.transparency.max_redaction_tier'
      ? `[${TRANSPARENCY_PANEL_TIER_ATTR}]`
      : `[${TRANSPARENCY_PANEL_TOGGLE_ATTR}="${key}"]`;
    const control = opts.host.querySelector?.(selector) as
      | HTMLElement
      | null
      | undefined;
    control?.focus?.();
  };

  const renderedValue = (key: InstancePrefKey): boolean | string =>
    state.saving === key && pendingValue !== null
      ? pendingValue
      : getPref(state.prefs ?? undefined, key);

  const setState = (patch: Partial<TransparencyPanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const doLoad = async (): Promise<void> => {
    setState({ phase: 'loading', error: null });
    try {
      const { prefs } = await opts.runPrefsGet();
      if (disposed) return;
      setState({ phase: 'ready', prefs, error: null });
    } catch (err) {
      if (disposed) return;
      setState({ phase: 'error', error: errMessage(err) });
    }
  };

  const doSave = async (
    patch: Partial<InstancePrefs>,
    key: InstancePrefKey,
    value: boolean | string,
  ): Promise<void> => {
    const returnToControl = controlHasFocus(key);
    pendingValue = value;
    setState({ saving: key, error: null });
    if (returnToControl) focusControl(key);
    try {
      const { prefs } = await opts.runPrefsSet({ patch });
      if (disposed) return;
      const retainFocus = controlHasFocus(key);
      pendingValue = null;
      // Authoritative merged set replaces local state (DD#3).
      setState({ saving: null, prefs, error: null });
      if (retainFocus) focusControl(key);
    } catch (err) {
      if (disposed) return;
      const retainFocus = controlHasFocus(key);
      pendingValue = null;
      setState({ saving: null, error: errMessage(err) });
      if (retainFocus) focusControl(key);
    }
  };

  const saveOne = (key: InstancePrefKey, value: boolean | string): void => {
    if (state.saving !== null) return;
    pendingSave = doSave(
      { [key]: value } as Partial<InstancePrefs>,
      key,
      value,
    );
  };

  const renderToggleRow = (
    host: HTMLElement,
    spec: ToggleRowSpec,
  ): void => {
    const row = doc.createElement('label');
    row.className = 'transparency-row';
    const checkbox = doc.createElement('input');
    checkbox.setAttribute('type', 'checkbox');
    checkbox.setAttribute(TRANSPARENCY_PANEL_TOGGLE_ATTR, spec.key);
    const displayedChecked = renderedValue(spec.key) === true;
    (checkbox as HTMLInputElement).checked = displayedChecked;
    if (state.saving !== null) {
      checkbox.setAttribute('aria-disabled', 'true');
      if (state.saving === spec.key) checkbox.setAttribute('aria-busy', 'true');
    }
    checkbox.addEventListener('change', () => {
      if (state.saving !== null) {
        (checkbox as HTMLInputElement).checked = displayedChecked;
        return;
      }
      saveOne(spec.key, (checkbox as HTMLInputElement).checked);
    });
    row.appendChild(checkbox);
    const text = doc.createElement('span');
    text.className = 'transparency-row-text';
    const label = doc.createElement('span');
    label.className = 'transparency-row-label';
    label.textContent = spec.label;
    text.appendChild(label);
    const detail = doc.createElement('span');
    detail.className = 'transparency-row-detail';
    detail.textContent = spec.detail;
    text.appendChild(detail);
    row.appendChild(text);
    host.appendChild(row);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(opts.host);

    if (state.phase === 'loading') {
      const loading = doc.createElement('div');
      loading.className = 'transparency-muted';
      loading.textContent = 'Loading transparency settings...';
      opts.host.appendChild(loading);
      return;
    }
    if (state.phase === 'error') {
      const error = doc.createElement('div');
      error.setAttribute(TRANSPARENCY_PANEL_ERROR_ATTR, '');
      error.textContent = `Could not load transparency settings: ${state.error ?? 'unknown error'}`;
      opts.host.appendChild(error);
      return;
    }

    renderToggleRow(opts.host, MASTER_ROW);

    if (getPref(state.prefs ?? undefined, 'ui.transparency.enabled') === false) {
      const hint = doc.createElement('div');
      hint.setAttribute(TRANSPARENCY_PANEL_OFF_HINT_ATTR, '');
      hint.className = 'transparency-muted';
      hint.textContent =
        'The thought stream is off — the toggles below apply when it is back on.';
      opts.host.appendChild(hint);
    }

    const classGroup = doc.createElement('div');
    classGroup.className = 'transparency-class-group';
    for (const spec of CLASS_ROWS) renderToggleRow(classGroup, spec);

    // DD#4 — fixed failure-class row: checked, disabled, explained.
    const failureRow = doc.createElement('label');
    failureRow.className = 'transparency-row';
    failureRow.setAttribute(TRANSPARENCY_PANEL_FAILURE_ROW_ATTR, '');
    const failureBox = doc.createElement('input');
    failureBox.setAttribute('type', 'checkbox');
    (failureBox as HTMLInputElement).checked = true;
    (failureBox as HTMLInputElement).disabled = true;
    failureRow.appendChild(failureBox);
    const failureText = doc.createElement('span');
    failureText.className = 'transparency-row-text';
    const failureLabel = doc.createElement('span');
    failureLabel.className = 'transparency-row-label';
    failureLabel.textContent = 'Failures (always shown)';
    failureText.appendChild(failureLabel);
    const failureDetail = doc.createElement('span');
    failureDetail.className = 'transparency-row-detail';
    failureDetail.textContent =
      'Recued never hides failure messages — truthful failure reporting ' +
      'is a substrate guarantee, not a preference.';
    failureText.appendChild(failureDetail);
    failureRow.appendChild(failureText);
    classGroup.appendChild(failureRow);
    opts.host.appendChild(classGroup);

    const tierRow = doc.createElement('label');
    tierRow.className = 'transparency-tier-row';
    const tierLabel = doc.createElement('span');
    tierLabel.className = 'transparency-row-label';
    tierLabel.textContent = 'Detail level';
    tierRow.appendChild(tierLabel);
    const tierSelect = doc.createElement('select');
    tierSelect.setAttribute(TRANSPARENCY_PANEL_TIER_ATTR, '');
    const currentTier = renderedValue(
      'ui.transparency.max_redaction_tier',
    ) as string;
    for (const option of TIER_OPTIONS) {
      const el = doc.createElement('option');
      el.setAttribute('value', option.value);
      el.textContent = option.label;
      if (option.value === currentTier) el.setAttribute('selected', '');
      tierSelect.appendChild(el);
    }
    (tierSelect as HTMLSelectElement).value = currentTier;
    if (state.saving !== null) {
      tierSelect.setAttribute('aria-disabled', 'true');
      if (state.saving === 'ui.transparency.max_redaction_tier') {
        tierSelect.setAttribute('aria-busy', 'true');
      }
    }
    tierSelect.addEventListener('change', () => {
      if (state.saving !== null) {
        (tierSelect as HTMLSelectElement).value = currentTier;
        return;
      }
      saveOne(
        'ui.transparency.max_redaction_tier',
        (tierSelect as HTMLSelectElement).value,
      );
    });
    tierRow.appendChild(tierSelect);
    opts.host.appendChild(tierRow);

    if (state.error !== null) {
      const error = doc.createElement('div');
      error.setAttribute(TRANSPARENCY_PANEL_ERROR_ATTR, '');
      error.textContent = `Could not save: ${state.error}`;
      opts.host.appendChild(error);
    }
  };

  render();
  pendingLoad = doLoad();

  return {
    getState: () => state,
    hasInFlightWork: () => !disposed && state.saving !== null,
    whenLoaded: () => pendingLoad,
    whenSaveSettled: () => pendingSave ?? Promise.resolve(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearChildren(opts.host);
      opts.host.removeAttribute(TRANSPARENCY_PANEL_HOST_ATTR);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const TRANSPARENCY_PANEL_STYLES = `
[${TRANSPARENCY_PANEL_HOST_ATTR}] {
  display: grid;
  gap: 10px;
  max-width: 64ch;
  font-size: 13px;
  color: var(--fg);
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-row {
  box-sizing: border-box;
  min-height: 36px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  cursor: pointer;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-row input {
  margin-top: 2px;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-row-text {
  display: grid;
  gap: 2px;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-row-label {
  font-weight: 650;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-row-detail,
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-muted {
  font-size: 12px;
  color: var(--muted);
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-class-group {
  display: grid;
  gap: 8px;
  margin-left: 22px;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] .transparency-tier-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
[${TRANSPARENCY_PANEL_HOST_ATTR}] select {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 5px 8px;
  font: inherit;
}
[${TRANSPARENCY_PANEL_ERROR_ATTR}] {
  color: var(--fail);
  font-size: 12px;
}
`;
