/** D-178 — Settings → Updates page.
 *
 *  Frontend surface over the already-built `update.*` server rpcs (check /
 *  mode / set_mode / apply / rollback). The page:
 *    - checks for a new release (`update.check`) on mount + on demand, and on a
 *      periodic poll so the rail item can show an "update available" badge
 *      without the user opening this page (no push channel exists — D-178 has no
 *      update broadcast, so availability is poll-driven);
 *    - renders the available release (version, migration/major/urgent flags,
 *      notes link) and applies it (`update.apply`), with a confirm step for a
 *      major bump (the server returns `major-blocked` until `force`);
 *    - exposes the auto/notify/off apply-mode toggle (`update.mode` /
 *      `update.set_mode`), locked when the server pins it via env;
 *    - offers an in-place rollback (`update.rollback`).
 *
 *  DOM-only (vanilla), driven by injected rpc callers so it unit-tests against
 *  the webclient's fake `Document`. Every control is gated: an absent caller
 *  renders a degraded-but-honest surface rather than a broken button.
 */

import type {
  ReleaseCheckResponse,
  ReleaseCheckStatus,
  UpdateApplyResponse,
  UpdateMode,
  UpdateModeStatus,
  UpdateRollbackResponse,
} from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const UPDATES_PAGE_ATTR = 'data-recued-updates-page';
export const UPDATES_PAGE_STATE_ATTR = 'data-recued-updates-page-state';
export const UPDATES_VERSION_ATTR = 'data-recued-updates-version';
export const UPDATES_CHECK_BTN_ATTR = 'data-recued-updates-check';
export const UPDATES_STATUS_ATTR = 'data-recued-updates-status';
export const UPDATES_ERROR_ATTR = 'data-recued-updates-error';
export const UPDATES_AVAILABLE_ATTR = 'data-recued-updates-available';
export const UPDATES_APPLY_BTN_ATTR = 'data-recued-updates-apply';
export const UPDATES_FORCE_APPLY_BTN_ATTR = 'data-recued-updates-force-apply';
export const UPDATES_APPLY_RESULT_ATTR = 'data-recued-updates-apply-result';
export const UPDATES_MODE_SELECT_ATTR = 'data-recued-updates-mode';
export const UPDATES_MODE_NOTE_ATTR = 'data-recued-updates-mode-note';
export const UPDATES_ROLLBACK_BTN_ATTR = 'data-recued-updates-rollback';
export const UPDATES_ROLLBACK_RESULT_ATTR = 'data-recued-updates-rollback-result';

/** Default availability re-check cadence (6h — matches the server's stable
 *  housekeeping check). Injectable via `pollIntervalMs`. */
export const UPDATES_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateCheckCaller = () => Promise<ReleaseCheckResponse>;
export type UpdateModeGetCaller = () => Promise<UpdateModeStatus>;
export type UpdateModeSetCaller = (args: { mode: UpdateMode }) => Promise<UpdateModeStatus>;
export type UpdateApplyCaller = (args: { force?: boolean }) => Promise<UpdateApplyResponse>;
export type UpdateRollbackCaller = () => Promise<UpdateRollbackResponse>;

export interface MountUpdatesPageOptions {
  host: HTMLElement;
  document?: Document;
  runCheck?: UpdateCheckCaller;
  runGetMode?: UpdateModeGetCaller;
  runSetMode?: UpdateModeSetCaller;
  runApply?: UpdateApplyCaller;
  runRollback?: UpdateRollbackCaller;
  /** Fires whenever the check outcome's availability changes — the route wires
   *  this to the "Updates" rail badge. Best-effort (a throw is swallowed). */
  onAvailabilityChanged?: (available: boolean) => void;
  /** Periodic re-check scheduler (returns a cancel fn). Omit → no auto-poll (the
   *  page still checks once on mount + on the Check button). Tests inject a
   *  controllable fake; production wires a `setInterval` wrapper. */
  startPoll?: (cb: () => void, ms: number) => () => void;
  pollIntervalMs?: number;
}

export type UpdatesCheckPhase = 'idle' | 'checking' | 'checked' | 'error';

export interface UpdatesPageState {
  phase: UpdatesCheckPhase;
  check: ReleaseCheckResponse | null;
  checkError: string | null;
  applying: boolean;
  applyResult: UpdateApplyResponse | null;
  applyError: string | null;
  mode: UpdateModeStatus | null;
  modeBusy: boolean;
  modeError: string | null;
  rollbackBusy: boolean;
  rollbackResult: UpdateRollbackResponse | null;
  rollbackError: string | null;
}

export interface UpdatesPageMount {
  /** Run a check now (mount + Check button + poll all route through this). */
  refresh: () => Promise<void>;
  getState: () => UpdatesPageState;
  dispose: () => void;
}

const CHECK_STATUS_COPY: Readonly<Record<ReleaseCheckStatus, string>> = {
  'update-available': '',
  'up-to-date': "You're on the latest version.",
  'not-configured': "Automatic updates aren't configured on this server yet.",
  'stale-feed': 'The release feed is past its freshness window — not acting on it.',
  'launcher-outdated': 'The launcher is too old to apply updates; update the launcher first.',
  replay: 'The release feed served an older manifest than this server has already seen (ignored).',
  'fetch-failed': "Couldn't reach the release feed.",
  'bad-signature': 'The release manifest failed signature verification.',
};

const APPLY_STATUS_COPY: Readonly<Record<UpdateApplyResponse['status'], string>> = {
  restarting: 'Updating now — the server will restart and be briefly unavailable.',
  deferred: "The server is busy; the update will apply once it's idle.",
  busy: 'Another update is already in progress.',
  'major-blocked': 'This is a major update — review the notes, then confirm below to proceed.',
  'insufficient-storage': 'Not enough free disk space on the server to apply this update.',
  'download-failed': 'Downloading the update failed.',
  'verify-failed': 'The downloaded update failed signature verification.',
  'stage-failed': 'Staging the update failed.',
  'not-applicable': 'This install updates via its image or package, not in place.',
  'not-available': 'No installable update is available right now.',
  'not-configured': "Automatic updates aren't configured on this server yet.",
};

const ROLLBACK_STATUS_COPY: Readonly<Record<UpdateRollbackResponse['status'], string>> = {
  'rolled-back': 'Rolled back to the previous version — the server is restarting.',
  refused: 'Rollback refused.',
  busy: 'An update is in progress; rollback is unavailable right now.',
  'not-configured': "This install can't roll back in place.",
  'not-applicable': 'This install updates via its image or package, not in place.',
};

const MODE_OPTION_LABEL: Readonly<Record<UpdateMode, string>> = {
  auto: 'Automatic — install eligible updates when the server is idle',
  notify: 'Notify only — tell me, but I apply manually',
  off: "Off — don't check or apply",
};

const MODE_SHORT: Readonly<Record<UpdateMode, string>> = {
  auto: 'Automatic',
  notify: 'Notify only',
  off: 'Off',
};

const isUpdateMode = (v: string): v is UpdateMode =>
  v === 'auto' || v === 'notify' || v === 'off';

export const mountUpdatesPage = (opts: MountUpdatesPageOptions): UpdatesPageMount => {
  const doc = opts.document ?? globalThis.document;
  if (doc === undefined) throw new Error('mountUpdatesPage: no document available');
  const { host } = opts;

  const state: UpdatesPageState = {
    phase: 'idle',
    check: null,
    checkError: null,
    applying: false,
    applyResult: null,
    applyError: null,
    mode: null,
    modeBusy: false,
    modeError: null,
    rollbackBusy: false,
    rollbackResult: null,
    rollbackError: null,
  };

  const make = (
    tag: string,
    spec?: { text?: string; className?: string; attrs?: Record<string, string> },
  ): HTMLElement => {
    const node = doc.createElement(tag);
    if (spec?.text !== undefined) node.textContent = spec.text;
    if (spec?.className !== undefined) node.className = spec.className;
    if (spec?.attrs !== undefined) {
      for (const [k, v] of Object.entries(spec.attrs)) node.setAttribute(k, v);
    }
    return node;
  };
  const clear = (node: HTMLElement): void => {
    let child: ChildNode | null;
    while ((child = node.firstChild) !== null) node.removeChild(child);
  };
  const setDisabled = (node: HTMLElement, on: boolean): void => {
    if (on) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
  };
  const setHidden = (node: HTMLElement, on: boolean): void => {
    if (on) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  };

  // ── skeleton (built once; render() updates it from state) ────────────
  const root = make('div', { attrs: { [UPDATES_PAGE_ATTR]: '' } });
  const versionEl = make('p', { attrs: { [UPDATES_VERSION_ATTR]: '' } });
  const checkBtn = make('button', {
    text: 'Check for updates',
    attrs: { type: 'button', [UPDATES_CHECK_BTN_ATTR]: '' },
  });
  checkBtn.addEventListener('click', () => void doCheck());
  const statusEl = make('p', { attrs: { [UPDATES_STATUS_ATTR]: '' } });
  const errorEl = make('p', { attrs: { [UPDATES_ERROR_ATTR]: '' } });
  setHidden(errorEl, true);
  const availableEl = make('div', { attrs: { [UPDATES_AVAILABLE_ATTR]: '' } });
  setHidden(availableEl, true);
  const applyResultEl = make('p', { attrs: { [UPDATES_APPLY_RESULT_ATTR]: '' } });
  setHidden(applyResultEl, true);

  const modeBlock = make('div');
  setHidden(modeBlock, true);
  modeBlock.appendChild(make('label', { text: 'When updates are available' }));
  const modeSelect = doc.createElement('select') as HTMLSelectElement;
  modeSelect.setAttribute(UPDATES_MODE_SELECT_ATTR, '');
  for (const m of ['auto', 'notify', 'off'] as const) {
    const opt = doc.createElement('option') as HTMLOptionElement;
    opt.value = m;
    opt.textContent = MODE_OPTION_LABEL[m];
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener('change', () => {
    const v = modeSelect.value;
    if (isUpdateMode(v)) void doSetMode(v);
  });
  modeBlock.appendChild(modeSelect);
  const modeNoteEl = make('p', { attrs: { [UPDATES_MODE_NOTE_ATTR]: '' } });
  modeBlock.appendChild(modeNoteEl);

  const rollbackBlock = make('div');
  rollbackBlock.appendChild(
    make('p', {
      text: 'If a recent update caused problems, you can return to the previous version (the pre-update database snapshot is restored).',
    }),
  );
  const rollbackBtn = make('button', {
    text: 'Roll back to previous version',
    attrs: { type: 'button', [UPDATES_ROLLBACK_BTN_ATTR]: '' },
  });
  rollbackBtn.addEventListener('click', () => void doRollback());
  rollbackBlock.appendChild(rollbackBtn);
  const rollbackResultEl = make('p', { attrs: { [UPDATES_ROLLBACK_RESULT_ATTR]: '' } });
  setHidden(rollbackResultEl, true);
  rollbackBlock.appendChild(rollbackResultEl);

  root.appendChild(versionEl);
  root.appendChild(checkBtn);
  root.appendChild(statusEl);
  root.appendChild(errorEl);
  root.appendChild(availableEl);
  root.appendChild(applyResultEl);
  root.appendChild(modeBlock);
  root.appendChild(rollbackBlock);
  host.appendChild(root);

  let disposed = false;

  const renderAvailable = (): void => {
    clear(availableEl);
    // The "available" card reflects the LATEST authoritative signal, not just the
    // last stored check: hide it when the most recent check FAILED (phase
    // 'error') or when an apply proved the update is no longer installable —
    // otherwise a cleared rail badge could disagree with a still-visible "Update
    // now" card (Codex F1/F2).
    const applyProvedNoUpdate =
      state.applyResult !== null
      && (state.applyResult.status === 'not-available'
        || state.applyResult.status === 'not-applicable'
        || state.applyResult.status === 'not-configured');
    const a =
      state.phase !== 'error' && !applyProvedNoUpdate && state.check?.status === 'update-available'
        ? state.check.available
        : undefined;
    if (a === undefined) {
      setHidden(availableEl, true);
      return;
    }
    setHidden(availableEl, false);
    availableEl.appendChild(make('p', { text: `Version ${a.version} is available.` }));
    if (a.below_min_supported) {
      availableEl.appendChild(
        make('p', { text: '⚠ Your version is below the minimum supported — updating is urgent.' }),
      );
    }
    if (a.migration) {
      availableEl.appendChild(
        make('p', {
          text: 'This release migrates the database on first boot (a snapshot is taken first, so it can be rolled back).',
        }),
      );
    }
    if (a.is_major) {
      availableEl.appendChild(make('p', { text: 'This is a major version update.' }));
    }
    if (a.notes_url.length > 0) {
      const link = make('a', { text: 'Release notes' });
      link.setAttribute('href', a.notes_url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      availableEl.appendChild(link);
    }
    const applyBtn = make('button', {
      text: state.applying ? 'Updating…' : 'Update now',
      attrs: { type: 'button', [UPDATES_APPLY_BTN_ATTR]: '' },
    });
    setDisabled(applyBtn, state.applying || opts.runApply === undefined);
    applyBtn.addEventListener('click', () => void doApply(false));
    availableEl.appendChild(applyBtn);
    // The server refuses a major bump until forced; surface an explicit confirm.
    if (state.applyResult?.status === 'major-blocked') {
      const forceBtn = make('button', {
        text: 'Update anyway (major)',
        attrs: { type: 'button', [UPDATES_FORCE_APPLY_BTN_ATTR]: '' },
      });
      setDisabled(forceBtn, state.applying);
      forceBtn.addEventListener('click', () => void doApply(true));
      availableEl.appendChild(forceBtn);
    }
  };

  const render = (): void => {
    if (disposed) return;
    root.setAttribute(UPDATES_PAGE_STATE_ATTR, state.phase);

    versionEl.textContent =
      state.check !== null
        ? `Current version ${state.check.current_version} · ${state.check.channel} channel`
        : 'Current version —';

    setDisabled(checkBtn, state.phase === 'checking' || opts.runCheck === undefined);
    checkBtn.textContent = state.phase === 'checking' ? 'Checking…' : 'Check for updates';

    if (state.phase === 'checking') statusEl.textContent = 'Checking…';
    else if (state.check !== null && state.check.status !== 'update-available') {
      const base = CHECK_STATUS_COPY[state.check.status];
      statusEl.textContent =
        state.check.detail !== undefined && state.check.detail.length > 0
          ? `${base} (${state.check.detail})`
          : base;
    } else statusEl.textContent = '';

    if (state.checkError !== null) {
      setHidden(errorEl, false);
      errorEl.textContent = state.checkError;
    } else {
      setHidden(errorEl, true);
      errorEl.textContent = '';
    }

    renderAvailable();

    if (state.applyError !== null) {
      setHidden(applyResultEl, false);
      applyResultEl.textContent = state.applyError;
    } else if (state.applyResult !== null) {
      setHidden(applyResultEl, false);
      const base = APPLY_STATUS_COPY[state.applyResult.status];
      applyResultEl.textContent =
        state.applyResult.detail !== undefined && state.applyResult.detail.length > 0
          ? `${base} (${state.applyResult.detail})`
          : base;
    } else {
      setHidden(applyResultEl, true);
      applyResultEl.textContent = '';
    }

    if (state.mode !== null) {
      setHidden(modeBlock, false);
      modeSelect.value = state.mode.mode;
      setDisabled(
        modeSelect,
        state.mode.env_locked || state.modeBusy || opts.runSetMode === undefined,
      );
      const notes: string[] = [];
      if (state.mode.env_locked) notes.push('Locked by RECUED_SELF_UPDATE on the server.');
      else notes.push(`Default for the ${MODE_SHORT[state.mode.channel_default]} setting on this channel.`);
      if (state.modeError !== null) notes.push(state.modeError);
      modeNoteEl.textContent = notes.join(' ');
    } else {
      setHidden(modeBlock, true);
    }

    setDisabled(
      rollbackBtn,
      state.rollbackBusy || state.applying || opts.runRollback === undefined,
    );
    rollbackBtn.textContent = state.rollbackBusy
      ? 'Rolling back…'
      : 'Roll back to previous version';
    if (state.rollbackError !== null) {
      setHidden(rollbackResultEl, false);
      rollbackResultEl.textContent = state.rollbackError;
    } else if (state.rollbackResult !== null) {
      setHidden(rollbackResultEl, false);
      const base = ROLLBACK_STATUS_COPY[state.rollbackResult.status];
      const snap =
        state.rollbackResult.status === 'rolled-back' && state.rollbackResult.restored_snapshot === true
          ? ' The database was restored to its pre-update snapshot.'
          : '';
      const detail =
        state.rollbackResult.detail !== undefined && state.rollbackResult.detail.length > 0
          ? ` (${state.rollbackResult.detail})`
          : '';
      rollbackResultEl.textContent = `${base}${snap}${detail}`;
    } else {
      setHidden(rollbackResultEl, true);
      rollbackResultEl.textContent = '';
    }
  };

  const signalAvailability = (available: boolean): void => {
    try {
      opts.onAvailabilityChanged?.(available);
    } catch {
      /* best-effort — the badge is cosmetic */
    }
  };

  async function doCheck(): Promise<void> {
    if (disposed) return;
    if (opts.runCheck === undefined) {
      state.phase = 'checked';
      render();
      return;
    }
    state.phase = 'checking';
    state.checkError = null;
    render();
    try {
      const res = await opts.runCheck();
      if (disposed) return;
      state.check = res;
      state.phase = 'checked';
      state.checkError = null;
      signalAvailability(res.status === 'update-available');
    } catch (err) {
      if (disposed) return;
      state.phase = 'error';
      state.checkError = humanizeRpcError(err);
      signalAvailability(false);
    }
    render();
  }

  async function doApply(force: boolean): Promise<void> {
    if (disposed || opts.runApply === undefined || state.applying) return;
    state.applying = true;
    state.applyError = null;
    render();
    try {
      state.applyResult = await opts.runApply(force ? { force: true } : {});
      // An apply that proves nothing is installable reconciles the rail badge —
      // otherwise it stays lit against a card the result contradicts (Codex F2).
      if (
        state.applyResult.status === 'not-available'
        || state.applyResult.status === 'not-applicable'
        || state.applyResult.status === 'not-configured'
      ) {
        signalAvailability(false);
      }
    } catch (err) {
      state.applyError = humanizeRpcError(err);
    }
    if (disposed) return;
    state.applying = false;
    render();
  }

  async function doGetMode(): Promise<void> {
    if (disposed || opts.runGetMode === undefined) return;
    try {
      const res = await opts.runGetMode();
      if (disposed) return;
      state.mode = res;
      state.modeError = null;
    } catch {
      /* leave mode unset — the toggle stays hidden rather than mislead */
    }
    render();
  }

  async function doSetMode(mode: UpdateMode): Promise<void> {
    if (disposed || opts.runSetMode === undefined || state.modeBusy) return;
    state.modeBusy = true;
    state.modeError = null;
    render();
    try {
      state.mode = await opts.runSetMode({ mode });
    } catch (err) {
      state.modeError = humanizeRpcError(err);
    }
    if (disposed) return;
    state.modeBusy = false;
    render();
  }

  async function doRollback(): Promise<void> {
    if (disposed || opts.runRollback === undefined || state.rollbackBusy) return;
    state.rollbackBusy = true;
    state.rollbackError = null;
    state.rollbackResult = null;
    render();
    try {
      state.rollbackResult = await opts.runRollback();
    } catch (err) {
      state.rollbackError = humanizeRpcError(err);
    }
    if (disposed) return;
    state.rollbackBusy = false;
    render();
  }

  render();
  void doCheck();
  void doGetMode();

  let cancelPoll: (() => void) | null = null;
  if (opts.startPoll !== undefined) {
    cancelPoll = opts.startPoll(
      () => void doCheck(),
      opts.pollIntervalMs ?? UPDATES_POLL_INTERVAL_MS,
    );
  }

  return {
    refresh: () => doCheck(),
    getState: () => state,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (cancelPoll !== null) cancelPoll();
      root.remove();
    },
  };
};
