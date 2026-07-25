/** D-202 §4 — the `#contracts` Switch A/B quality kill-switch control.
 *
 *  A prominent, always-visible safety control at the top of `#contracts`: the
 *  owner can, at will, pause the delegation shortcuts and return sends to manual
 *  review. TWO switches mapped to the two axes:
 *
 *    - **Switch A** ("Pause everything") — pause BOTH delegation axes; every
 *      action goes back to full manual approve.
 *    - **Switch B** ("Pause quality review only") — pause the quality axis only;
 *      outputs return to per-artifact review, authorization grants stay live.
 *
 *  It is a GATE-OVERRIDE (§12.12): toggling never touches learned confidence, so
 *  it is instantly + losslessly reversible — no confirm step, that is the point.
 *  State is the server's persisted two-switch flag (`server.getQualitySwitches`
 *  / `server.setQualitySwitch`, owner-only). Each `*_since` drives the §4
 *  self-evidencing "Paused since…" status.
 *
 *  Self-contained (its own `QUALITY_SWITCH_PANEL_STYLES`, joined into the route's
 *  one `<style>` bundle) and disposable, mirroring `suggested-rules-panel.ts`.
 *
 *  Spec: docs/d-202-spec.md §4 / §5. */

import type { QualityGateSwitchStatus } from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `server.getQualitySwitches` caller seam. */
export type QualitySwitchesGetCaller = () => Promise<QualityGateSwitchStatus>;

/** `server.setQualitySwitch` caller seam. */
export type QualitySwitchSetCaller = (args: {
  which: 'all' | 'quality';
  active: boolean;
}) => Promise<QualityGateSwitchStatus>;

export type QualitySwitchPanelState = 'loading' | 'ready' | 'error';

export interface MountQualitySwitchPanelOptions {
  /** Host element the panel renders into (the panel owns one wrapper inside). */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  runGetSwitches: QualitySwitchesGetCaller;
  runSetSwitch: QualitySwitchSetCaller;
}

export interface QualitySwitchPanelMount {
  getState(): QualitySwitchPanelState;
  /** The last-loaded two-switch status, or null before the first load. */
  getStatus(): QualityGateSwitchStatus | null;
  /** Host-driven refresh — re-reads the switches. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the first read settles. */
  whenLoaded(): Promise<void>;
  /** Toggle one switch programmatically (test seam / host driver). No-op while
   *  that switch has a write in flight or the panel is disposed. */
  setSwitch(which: 'all' | 'quality', active: boolean): Promise<void>;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the route shell
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */
export const QUALITY_SWITCH_PANEL_HOST_ATTR = 'data-recued-quality-switch-panel';
/** The section heading. */
export const QUALITY_SWITCH_HEADING_ATTR = 'data-recued-quality-switch-heading';
/** One switch's toggle button. Carries `data-which` = `all` | `quality`. */
export const QUALITY_SWITCH_TOGGLE_ATTR = 'data-recued-quality-switch-toggle';
/** One switch's status line. Carries `data-which`. */
export const QUALITY_SWITCH_STATUS_ATTR = 'data-recued-quality-switch-status';
/** The panel-level error chip. */
export const QUALITY_SWITCH_ERROR_ATTR = 'data-recued-quality-switch-error';

// ════════════════════════════════════════════════════════════════
// Row config
// ════════════════════════════════════════════════════════════════

interface SwitchRow {
  readonly which: 'all' | 'quality';
  readonly title: string;
  readonly hint: string;
  /** `all` is the bigger hammer — styled with the danger accent. */
  readonly danger: boolean;
}

const ROWS: ReadonlyArray<SwitchRow> = [
  {
    which: 'quality',
    title: 'Pause quality review only',
    hint: 'Outputs return to per-artifact review; authorization grants stay live.',
    danger: false,
  },
  {
    which: 'all',
    title: 'Pause everything',
    hint: 'Both axes pause — every action returns to full manual approval.',
    danger: true,
  },
];

const sinceLabel = (since: number | null): string => {
  if (since === null) return '';
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '';
  return ` · since ${d.toLocaleString()}`;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountQualitySwitchPanel = (
  opts: MountQualitySwitchPanelOptions,
): QualitySwitchPanelMount => {
  const doc = opts.document ?? globalThis.document;

  const wrapper = doc.createElement('section');
  wrapper.setAttribute(QUALITY_SWITCH_PANEL_HOST_ATTR, '');
  opts.host.appendChild(wrapper);

  let status: QualityGateSwitchStatus | null = null;
  let panelState: QualitySwitchPanelState = 'loading';
  let errorMessage: string | null = null;
  let disposed = false;
  let loadGeneration = 0;
  const inFlight = new Set<'all' | 'quality'>();

  let settledOnce = false;
  let resolveLoaded: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });

  const el = (
    tag: string,
    className?: string,
    text?: string,
  ): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Is this switch's OWN flag engaged? */
  const isEngaged = (which: 'all' | 'quality'): boolean =>
    status !== null && (which === 'all' ? status.all_paused : status.quality_paused);

  /** The self-evidencing status line for a row. */
  const rowStatusText = (which: 'all' | 'quality'): string => {
    if (status === null) return '';
    if (which === 'all') {
      return status.all_paused ? `Paused${sinceLabel(status.all_since)}` : 'Active';
    }
    if (status.quality_paused) return `Paused${sinceLabel(status.quality_since)}`;
    // Quality is effectively paused when Switch A is on, even if B is off.
    if (status.all_paused) return 'Paused by “Pause everything”';
    return 'Auto-accepting';
  };

  const render = (): void => {
    while (wrapper.firstChild !== null) wrapper.removeChild(wrapper.firstChild);

    wrapper.appendChild(
      (() => {
        const h = el('h3', 'qs-heading', 'Quality auto-accept');
        h.setAttribute(QUALITY_SWITCH_HEADING_ATTR, '');
        return h;
      })(),
    );
    wrapper.appendChild(
      el(
        'p',
        'qs-copy',
        'Pause the auto-accept shortcuts and route sends back to manual review. '
          + 'Instantly reversible — your learned quality confidence is preserved.',
      ),
    );

    if (panelState === 'loading' && status === null) {
      wrapper.appendChild(el('p', 'qs-loading', 'Loading…'));
      return;
    }

    for (const row of ROWS) {
      const rowEl = el('div', 'qs-row');

      const info = el('div', 'qs-row-info');
      info.appendChild(el('span', 'qs-row-title', row.title));
      info.appendChild(el('span', 'qs-row-hint', row.hint));
      const statusEl = el('span', 'qs-row-status', rowStatusText(row.which));
      statusEl.setAttribute(QUALITY_SWITCH_STATUS_ATTR, '');
      statusEl.setAttribute('data-which', row.which);
      info.appendChild(statusEl);
      rowEl.appendChild(info);

      const engaged = isEngaged(row.which);
      const busy = inFlight.has(row.which);
      const btn = el(
        'button',
        `qs-toggle${engaged ? ' qs-toggle-on' : ''}${row.danger ? ' qs-toggle-danger' : ''}`,
        busy ? '…' : engaged ? 'Paused' : 'Live',
      ) as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute(QUALITY_SWITCH_TOGGLE_ATTR, '');
      btn.setAttribute('data-which', row.which);
      btn.setAttribute('aria-pressed', engaged ? 'true' : 'false');
      btn.disabled = busy || status === null;
      btn.addEventListener('click', () => {
        void setSwitch(row.which, !engaged);
      });
      rowEl.appendChild(btn);

      wrapper.appendChild(rowEl);
    }

    if (errorMessage !== null) {
      const err = el('p', 'qs-error', errorMessage);
      err.setAttribute(QUALITY_SWITCH_ERROR_ATTR, '');
      wrapper.appendChild(err);
    }
  };

  const load = async (): Promise<void> => {
    const gen = ++loadGeneration;
    if (status === null) {
      panelState = 'loading';
      render();
    }
    try {
      const next = await opts.runGetSwitches();
      if (disposed || gen !== loadGeneration) return;
      status = next;
      panelState = 'ready';
      errorMessage = null;
    } catch (err) {
      if (disposed || gen !== loadGeneration) return;
      panelState = 'error';
      errorMessage = humanizeRpcError(err);
    }
    render();
    if (!settledOnce) {
      settledOnce = true;
      resolveLoaded();
    }
  };

  const setSwitch = async (
    which: 'all' | 'quality',
    active: boolean,
  ): Promise<void> => {
    if (disposed || inFlight.has(which)) return;
    inFlight.add(which);
    render();
    try {
      const next = await opts.runSetSwitch({ which, active });
      if (disposed) return;
      status = next;
      panelState = 'ready';
      errorMessage = null;
    } catch (err) {
      if (disposed) return;
      errorMessage = humanizeRpcError(err);
    } finally {
      inFlight.delete(which);
      if (!disposed) render();
    }
  };

  render();
  void load();

  return {
    getState: () => panelState,
    getStatus: () => status,
    refresh: () => load(),
    whenLoaded: () => loaded,
    setSwitch: (which, active) => setSwitch(which, active),
    dispose: () => {
      disposed = true;
      if (wrapper.parentNode !== null) wrapper.parentNode.removeChild(wrapper);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — joined into the contracts route's one `<style>` bundle
// ════════════════════════════════════════════════════════════════

export const QUALITY_SWITCH_PANEL_STYLES = `
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] {
  display: block;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin: 0 0 18px;
  background: var(--surface-subtle);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-heading {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-copy {
  margin: 6px 0 12px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.45;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-loading {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-row-title {
  font-size: 14px;
  font-weight: 600;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-row-hint {
  font-size: 12px;
  color: var(--muted);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-row-status {
  font-size: 12px;
  color: var(--muted);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-toggle {
  flex: none;
  min-width: 76px;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  cursor: pointer;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-toggle:disabled {
  opacity: 0.55;
  cursor: default;
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-toggle-on {
  border-color: var(--accent);
  color: var(--accent);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-toggle-danger.qs-toggle-on {
  border-color: var(--danger);
  color: var(--danger);
}
[${QUALITY_SWITCH_PANEL_HOST_ATTR}] .qs-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--fail);
}
`;
