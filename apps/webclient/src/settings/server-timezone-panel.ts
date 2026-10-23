/** D-269 step 1 — Settings → Server → Timezone.
 *
 *  The owner states where this SERVER lives relative to them. That is the one
 *  fact no clock can report, and every wall-clock surface resolves through it.
 *
 *  ⛔⛔ THE MODE IS THE CONTROL; THE ZONE IS ITS ARGUMENT. Reading the host
 *  clock was never wrong in itself — right for a laptop, a datacenter's on a
 *  VPS — and the defect was that the assumption could not be SAID. So the
 *  primary control here is the question "does this server travel with you?",
 *  and the zone picker is what `fixed` needs, not the headline.
 *
 *  ⛔ THE PICKER SHOWS THE IANA ID, BECAUSE IT *IS* THE VALUE (REV 7). A human
 *  reading `America/Los_Angeles` in a list does not conclude they live in Los
 *  Angeles; a MODEL handed the same string parrots it into location-flavoured
 *  answers, which is why the chat packet renders an offset and never this. The
 *  suppression belongs to the READER, not the value — and a common-name label
 *  ("Pacific Time") would be strictly worse here, because it maps to
 *  `America/Los_Angeles`, `America/Vancouver` AND `America/Tijuana` and so
 *  cannot round-trip to the single id being set.
 *
 *  ⚠ `resolved_zone` AND `host_zone` COME FROM THE SERVER AND CANNOT BE
 *  COMPUTED HERE. Under `follows_host` the resolved value IS the server's host
 *  reading; a browser asking `Intl` would get its OWN zone and believe it had
 *  the server's. Every clock this panel shows for the server comes off the wire.
 *
 *  Spec: internal design notes D-269 REV 3 / REV 4 / REV 5 / REV 7 / REV 9. */

import {
  twoClockPreview,
  type TwoClockView,
} from '@recued/ui-shared';
import {
  isValidIanaZone,
  type ServerTimeZoneGetResponse,
  type ServerTimeZoneMode,
  type ServerTimeZoneSetRequest,
} from '@recued/contracts';

export const SERVER_TZ_PANEL_ATTR = 'data-recued-server-timezone-panel';
export const SERVER_TZ_STATE_ATTR = 'data-recued-server-timezone-state';
export const SERVER_TZ_MODE_ATTR = 'data-recued-server-timezone-mode';
export const SERVER_TZ_ZONE_INPUT_ATTR = 'data-recued-server-timezone-zone';
export const SERVER_TZ_SAVE_ATTR = 'data-recued-server-timezone-save';
export const SERVER_TZ_ERROR_ATTR = 'data-recued-server-timezone-error';
export const SERVER_TZ_RETRY_ATTR = 'data-recued-server-timezone-retry';
export const SERVER_TZ_CHECK_ATTR = 'data-recued-server-timezone-check';
export const SERVER_TZ_LOADING_ATTR = 'data-recued-server-timezone-loading';
export const SERVER_TZ_CLOCK_ROW_ATTR = 'data-recued-server-timezone-clock';
export const SERVER_TZ_CLOCK_ROLE_ATTR = 'data-recued-server-timezone-clock-role';
const SERVER_TZ_SAVING_ATTR = 'data-recued-server-timezone-saving';
const SERVER_TZ_CHECKING_ATTR = 'data-recued-server-timezone-checking';

export type ServerTimeZoneGetCaller = () => Promise<ServerTimeZoneGetResponse>;
export type ServerTimeZoneSetCaller = (
  args: ServerTimeZoneSetRequest,
) => Promise<ServerTimeZoneGetResponse>;

export type ServerTimeZonePanelState = 'loading' | 'ready' | 'error';

export interface MountServerTimeZonePanelOptions {
  host: HTMLElement;
  document?: Document;
  runGet: ServerTimeZoneGetCaller;
  runSet: ServerTimeZoneSetCaller;
  /** Test seams — pinned so assertions do not depend on the runner's clock,
   *  locale or zone. */
  now?: () => number;
  clientZone?: string;
  locale?: string;
}

export interface ServerTimeZonePanelMount {
  getState(): ServerTimeZonePanelState;
  /** The rendered two-clock rows. ⚠ ONE row when the clocks agree — the
   *  collapse is the design, not an empty state. */
  getClocks(): TwoClockView | null;
  getMode(): ServerTimeZoneMode | null;
  getError(): string | null;
  /** True while a save is in flight. */
  isSaving(): boolean;
  /** Active drafts or saves whose outcome is still unknown. */
  hasUnsavedChanges(): boolean;
  /** Refreshes the saved clock unless a pending save owns the result.
   *  Concurrent initial reads share the pending request. */
  refresh(): Promise<void>;
  dispose(): void;
}

const checkedSnapshot = (next: ServerTimeZoneGetResponse): ServerTimeZoneGetResponse => {
  const setting = next?.setting;
  if (!setting || (setting.mode !== 'fixed' && setting.mode !== 'follows_host')
    // Stored zones can outlive the timezone database that accepted them. Keep
    // their raw value editable; the server supplies the resolved fallback clock.
    || (setting.zone !== null && typeof setting.zone !== 'string')
    || !Number.isFinite(setting.updated_at) || setting.updated_at < 0
    || !isValidIanaZone(next.resolved_zone) || typeof next.host_zone !== 'string') {
    throw new Error('Recued could not confirm the server timezone. Try again.');
  }
  return next;
};

export const mountServerTimeZonePanel = (
  opts: MountServerTimeZonePanelOptions,
): ServerTimeZonePanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountServerTimeZonePanel: no document available — pass `opts.document`',
    );
  }
  const now = opts.now ?? ((): number => Date.now());

  let state: ServerTimeZonePanelState = 'loading';
  let snapshot: ServerTimeZoneGetResponse | null = null;
  let error: string | null = null;
  let saving = false;
  let checking = false;
  let disposed = false;
  /** The mode the owner has selected but not yet saved. Held separately from
   *  the snapshot so the zone field can appear the instant they pick `fixed`,
   *  before any write. */
  let draftMode: ServerTimeZoneMode | null = null;
  let draftZone: string | null = null;
  let unconfirmedSave = false;
  let clocks: TwoClockView | null = null;
  let loadGeneration = 0;
  let initialRead: Promise<void> | null = null;
  type FocusKey = 'zone' | 'save' | 'fixed' | 'follows_host' | 'saving' | 'retry' | 'loading' | 'check' | 'checking';
  const focusKey = (node: Element | null | undefined): FocusKey | null => {
    if (!node || !opts.host.contains(node)) return null;
    const mode = node?.getAttribute?.(SERVER_TZ_MODE_ATTR);
    if (mode === 'fixed' || mode === 'follows_host') return mode;
    if (node?.getAttribute?.(SERVER_TZ_ZONE_INPUT_ATTR) != null) return 'zone';
    if (node?.getAttribute?.(SERVER_TZ_SAVE_ATTR) != null) return 'save';
    if (node?.getAttribute?.(SERVER_TZ_SAVING_ATTR) != null) return 'saving';
    if (node?.getAttribute?.(SERVER_TZ_RETRY_ATTR) != null) return 'retry';
    if (node?.getAttribute?.(SERVER_TZ_LOADING_ATTR) != null) return 'loading';
    if (node?.getAttribute?.(SERVER_TZ_CHECK_ATTR) != null) return 'check';
    if (node?.getAttribute?.(SERVER_TZ_CHECKING_ATTR) != null) return 'checking';
    return null;
  };
  const selectionOf = (node: Element | null | undefined) => {
    if (focusKey(node) !== 'zone') return null;
    const input = node as HTMLInputElement;
    return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  };
  let saveFocus: FocusKey | null = null;
  let saveSelection: ReturnType<typeof selectionOf> = null;

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const currentMode = (): ServerTimeZoneMode | null =>
    draftMode ?? snapshot?.setting.mode ?? null;
  const matchesSavedSetting = (): boolean => snapshot !== null
    && currentMode() === snapshot.setting.mode
    && (currentMode() !== 'fixed' || (draftZone ?? snapshot.setting.zone ?? '') === (snapshot.setting.zone ?? ''));
  const retireRestoredDraft = (): void => {
    if (unconfirmedSave || !matchesSavedSetting()) return;
    draftMode = null;
    // A successful follows-host choice keeps the inactive fixed-zone draft.
    if (snapshot?.setting.mode === 'fixed') draftZone = null;
  };

  const focusReadRecovery = (node: HTMLElement | undefined): void => {
    node?.focus?.({ preventScroll: true });
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const save = async (mode: ServerTimeZoneMode, zone?: string | null): Promise<void> => {
    if (saving || disposed) return;
    // A failed reply does not prove the server rejected the write. Only a
    // complete confirmation or fresh read can retire that uncertainty.
    unconfirmedSave = true;
    // A read started before this write must not replace its confirmation or
    // clear its error after the owner has already retried.
    loadGeneration += 1;
    checking = false;
    saveFocus = focusKey(doc.activeElement);
    saveSelection = selectionOf(doc.activeElement);
    saving = true;
    error = null;
    render();
    try {
      const next = await opts.runSet({
        mode,
        ...(zone === undefined ? {} : { zone }),
      });
      if (disposed) return;
      snapshot = checkedSnapshot(next);
      unconfirmedSave = false;
      draftMode = null;
      if (mode === 'fixed') draftZone = null;
      state = 'ready';
    } catch (err) {
      if (disposed) return;
      // ⚠ The server's message is surfaced VERBATIM. It is the only place that
      // knows why a zone was refused — that a fixed offset cannot follow DST,
      // or that `fixed` needs a zone — and paraphrasing it here would put a
      // second, drifting copy of that reasoning in the client.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
      if (!disposed) render();
      saveFocus = null;
      saveSelection = null;
    }
  };

  const renderClocks = (into: HTMLElement): void => {
    if (!snapshot) { clocks = null; return; }
    clocks = twoClockPreview({
      serverZone: snapshot.resolved_zone,
      at: now(),
      ...(opts.clientZone === undefined ? {} : { clientZone: opts.clientZone }),
      ...(opts.locale === undefined ? {} : { locale: opts.locale }),
    });

    for (const row of clocks.rows) {
      const line = el('p');
      line.setAttribute(SERVER_TZ_CLOCK_ROW_ATTR, '');
      line.setAttribute(SERVER_TZ_CLOCK_ROLE_ATTR, row.role);
      // ⛔ ASYMMETRIC BY CONSTRUCTION. The server row is the value; the browser
      // row is a translation of it. Rendered as peers an owner tries to edit
      // the local one — the two-editors failure arriving through visual weight.
      if (row.role === 'authoritative') {
        const strong = el('strong', `${row.label}: ${row.text}`);
        line.appendChild(strong);
        line.appendChild(el('span', ` · ${row.zone}`));
      } else {
        // ⚠ "right now", literally. The gap between two zones is not stable —
        // they observe DST on different dates — so this is a present-tense
        // translation and never a standing "you are N hours apart".
        line.appendChild(el('span', `${row.label}: ${row.text} · ${row.zone} — right now`));
      }
      into.appendChild(line);
    }

    if (clocks.diverged) {
      // The warning earns its place only in the diverged case, which on a
      // `follows_host` laptop is also the signal that the mode is wrong.
      into.appendChild(el(
        'p',
        'Your browser is on a different clock than the server. '
        + 'Times are scheduled on the server clock.',
      ));
    }
  };

  // Reads replace only feedback. Keeping the editor connected preserves native
  // undo history and active composition while its saved clock is checked.
  const feedbackHost = el('div');
  feedbackHost.className = 'server-timezone-feedback';
  let renderedMode: ServerTimeZoneMode | null = null;
  let editorControls = new Map<FocusKey, HTMLElement>();

  const render = (preserveEditor = false): void => {
    if (disposed) return;
    const held = focusKey(doc.activeElement);
    const selection = held === 'saving' ? saveSelection : selectionOf(doc.activeElement)
      ?? selectionOf(opts.host.querySelector?.(`[${SERVER_TZ_ZONE_INPUT_ATTR}]`));
    const mode = currentMode();
    const keepEditor = preserveEditor && snapshot !== null && feedbackHost.isConnected === true && renderedMode === mode;
    const controls = keepEditor ? new Map(editorControls) : new Map<FocusKey, HTMLElement>();
    opts.host.setAttribute(SERVER_TZ_PANEL_ATTR, '');
    opts.host.setAttribute(SERVER_TZ_STATE_ATTR, state);
    if (!keepEditor) {
      // ⚠ `innerHTML = ''`, NOT `replaceChildren()`. Every other settings panel
      // clears this way, and the webclient's test fakes implement exactly the
      // surface those panels use — a panel reaching for a newer DOM method makes
      // every fake in the tree grow a method to accommodate one file. Found by
      // the composition-root test, not by this panel's own: its fake had
      // `replaceChildren` because I wrote both.
      opts.host.innerHTML = '';

      opts.host.appendChild(el('h3', 'Timezone'));

      if (state === 'loading') {
        const status = el('p', 'Loading timezone…');
        status.setAttribute(SERVER_TZ_LOADING_ATTR, '');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-atomic', 'true');
        status.setAttribute('tabindex', '-1');
        opts.host.appendChild(status);
        if (held === 'retry' || held === 'loading') focusReadRecovery(status);
        return;
      }

      if (state === 'error' && snapshot === null) {
        const p = el('p', error ?? 'Could not read the server timezone.');
        p.setAttribute(SERVER_TZ_ERROR_ATTR, '');
        p.setAttribute('role', 'alert');
        opts.host.appendChild(p);
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry loading timezone';
        retry.setAttribute(SERVER_TZ_RETRY_ATTR, '');
        retry.addEventListener('click', () => {
          if (snapshot === null && state === 'error') void refresh();
        });
        opts.host.appendChild(retry);
        if (held === 'retry' || held === 'loading') focusReadRecovery(retry);
        return;
      }

      // ⛔ THE DEPLOYMENT QUESTION LEADS, because it is the one the owner can
      // answer and the machine cannot. Asking for a zone first would invite them
      // to set one on a laptop, where the right answer is to follow the host.
      opts.host.appendChild(el('p', 'Does this server travel with you?'));

      for (const [value, label, hint] of [
        ['follows_host', 'Yes — it runs on a machine I carry',
          'Uses this machine’s clock, so it moves with you.'],
        ['fixed', 'No — it stays in one place',
          'Uses the timezone you set, wherever you are.'],
      ] as ReadonlyArray<readonly [ServerTimeZoneMode, string, string]>) {
        const wrap = el('label');
        const input = doc.createElement('input');
        input.type = 'radio';
        input.name = 'recued-server-timezone-mode';
        input.value = value;
        input.checked = mode === value;
        input.disabled = saving;
        input.setAttribute(SERVER_TZ_MODE_ATTR, value);
        controls.set(value, input);
        input.addEventListener('change', () => {
          if (saving || disposed) return;
          // ⚠ `follows_host` saves immediately — there is nothing more to ask.
          // `fixed` only sets the DRAFT, because it needs a zone and saving now
          // would either fail or silently keep a stale one.
          if (value === 'follows_host') { void save('follows_host'); return; }
          draftMode = 'fixed';
          retireRestoredDraft();
          render();
          // Choosing a fixed clock explicitly opens its required argument.
          opts.host.querySelector?.<HTMLInputElement>(`[${SERVER_TZ_ZONE_INPUT_ATTR}]`)?.focus?.({ preventScroll: true });
        });
        wrap.appendChild(input);
        wrap.appendChild(el('span', ` ${label} — ${hint}`));
        opts.host.appendChild(wrap);
      }

      if (mode === 'fixed') {
        const field = el('p');
        const input = doc.createElement('input');
        input.type = 'text';
        input.placeholder = 'America/Los_Angeles';
        input.value = draftZone ?? snapshot?.setting.zone ?? '';
        input.disabled = saving;
        input.setAttribute(SERVER_TZ_ZONE_INPUT_ATTR, '');
        input.setAttribute('aria-label', 'Server timezone');
        input.addEventListener('input', () => {
          if (saving || disposed) return;
          draftZone = input.value;
          draftMode = 'fixed';
          retireRestoredDraft();
        });
        controls.set('zone', input);
        field.appendChild(input);

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = saving ? 'Saving…' : 'Save';
        btn.disabled = saving;
        btn.setAttribute(SERVER_TZ_SAVE_ATTR, '');
        controls.set('save', btn);
        const submit = (): void => {
          if (saving || disposed) return;
          // Keep the exact draft on screen; trim only the frozen RPC argument.
          draftZone = input.value;
          draftMode = 'fixed';
          void save('fixed', draftZone.trim());
        };
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); }
        });
        field.appendChild(btn);
        opts.host.appendChild(field);
        // ⚠ Names the id form rather than a friendly label. "Pacific Time" maps
        // to three different IANA zones, so a common name cannot round-trip to
        // the one value being set — and the id is what the owner will see echoed
        // back, including when an abbreviation resolved to somewhere they did not
        // expect.
        opts.host.appendChild(el(
          'p',
          'Use an IANA zone id, like Europe/London or Asia/Tokyo. '
          + 'Daylight saving is handled for you.',
        ));
      }

      editorControls = new Map(controls);
      renderedMode = mode;
      opts.host.appendChild(feedbackHost);
    } else {
      const input = controls.get('zone') as HTMLInputElement | undefined;
      const value = draftZone ?? snapshot?.setting.zone ?? '';
      if (input && input.value !== value) input.value = value;
    }
    feedbackHost.innerHTML = '';

    if (error !== null) {
      const p = el('p', error);
      p.setAttribute(SERVER_TZ_ERROR_ATTR, '');
      p.setAttribute('role', 'alert');
      feedbackHost.appendChild(p);
    }
    if (unconfirmedSave && !saving) {
      feedbackHost.appendChild(el('p', 'The save could not be confirmed. Check the saved timezone before trying again.'));
      const check = doc.createElement('button');
      check.type = 'button';
      check.textContent = 'Check saved timezone';
      check.disabled = checking;
      check.setAttribute(SERVER_TZ_CHECK_ATTR, '');
      check.addEventListener('click', () => { void refresh(true); });
      controls.set('check', check);
      feedbackHost.appendChild(check);
    }
    if (checking) {
      const status = el('p', 'Checking saved timezone…');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-atomic', 'true');
      status.setAttribute('tabindex', '-1');
      status.setAttribute(SERVER_TZ_CHECKING_ATTR, '');
      controls.set('checking', status);
      feedbackHost.appendChild(status);
    }
    if (saving) {
      const status = el('p', 'Saving timezone…');
      status.setAttribute('role', 'status');
      status.setAttribute('tabindex', '-1');
      status.setAttribute(SERVER_TZ_SAVING_ATTR, '');
      controls.set('saving', status);
      feedbackHost.appendChild(status);
    }

    if (snapshot) {
      const clockHost = el('div');
      renderClocks(clockHost);
      feedbackHost.appendChild(clockHost);

      // ⛔ THE ROUND-TRIP IS THE POINT WHEN AN ABBREVIATION WAS TYPED. `EST`
      // resolves to `America/Panama`, which never observes DST — no validator
      // can know a New Yorker meant New York, so showing what was actually
      // stored is the only thing that can catch it.
      if (snapshot.setting.mode === 'fixed' && snapshot.setting.zone) {
        feedbackHost.appendChild(el('p', `Saved as ${snapshot.setting.zone}.`));
      }
      if (snapshot.setting.mode === 'follows_host') {
        feedbackHost.appendChild(el(
          'p',
          `Following this machine — currently ${snapshot.host_zone}.`,
        ));
      }
    }
    // Save and recovery statuses carry focus until their action finishes.
    // Preserve a live editor and outside focus when a read settles.
    const recovering = held === 'loading' || held === 'retry';
    const editor: FocusKey = mode === 'fixed' ? 'zone' : 'follows_host';
    const afterCheck = (key: FocusKey | null): FocusKey | null =>
      key === 'check' || key === 'checking' ? unconfirmedSave ? 'check' : editor : key;
    const wanted = recovering ? editor
      : saving && held !== null ? 'saving'
      : checking && (held === 'check' || held === 'checking') ? 'checking'
      : held === 'saving' ? afterCheck(saveFocus) : afterCheck(held);
    if (wanted !== null) {
      if (recovering) focusReadRecovery(controls.get(wanted));
      else if (doc.activeElement !== controls.get(wanted)) controls.get(wanted)?.focus?.({ preventScroll: true });
    }
    const zone = controls.get('zone') as HTMLInputElement | undefined;
    if (selection && zone && (zone.selectionStart !== selection.start || zone.selectionEnd !== selection.end
      || zone.selectionDirection !== selection.direction)) {
      zone.setSelectionRange?.(
        selection.start ?? 0, selection.end ?? 0, selection.direction ?? undefined,
      );
    }
  };

  const refresh = (checkSaved = false): Promise<void> => {
    if (disposed || saving) return Promise.resolve();
    if (checkSaved && (!unconfirmedSave || snapshot === null || checking)) return Promise.resolve();
    if (snapshot === null && initialRead !== null) return initialRead;
    const generation = ++loadGeneration;
    const initial = snapshot === null;
    if (checkSaved) {
      checking = true;
      error = null;
      render(true);
    }
    if (initial) {
      state = 'loading';
      error = null;
      render(true);
    }
    const read = (async () => {
      try {
        const next = await opts.runGet();
        if (disposed || generation !== loadGeneration) return;
        snapshot = checkedSnapshot(next);
        unconfirmedSave = false;
        retireRestoredDraft();
        state = 'ready';
        error = null;
      } catch (err) {
        if (disposed || generation !== loadGeneration) return;
        state = 'error';
        error = err instanceof Error ? err.message : String(err);
      }
      // Only the latest read can retire its indicator. A newer save or a
      // disposed panel has already invalidated this read above.
      checking = false;
      render(true);
    })();
    if (!initial) return read;
    const pending = read.finally(() => { if (initialRead === pending) initialRead = null; });
    initialRead = pending;
    return pending;
  };

  render();
  void refresh();

  return {
    getState: () => state,
    getClocks: () => clocks,
    getMode: () => currentMode(),
    getError: () => error,
    isSaving: () => !disposed && saving,
    hasUnsavedChanges: () => !disposed && (unconfirmedSave || (snapshot !== null && !matchesSavedSetting())),
    refresh,
    dispose: () => { disposed = true; checking = false; loadGeneration += 1; initialRead = null; },
  };
};

/** ⚠ Same omission as the two panels in Approval & notifications. Here the cost
 *  is sharpest: this panel exists so the owner can SEE what the zone they picked
 *  actually means, and an unstyled two-clock preview is two identical-looking
 *  sentences — the comparison the panel is for. */
export const SERVER_TIMEZONE_PANEL_STYLES = `
[${SERVER_TZ_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${SERVER_TZ_PANEL_ATTR}] .server-timezone-feedback {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[${SERVER_TZ_PANEL_ATTR}] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${SERVER_TZ_PANEL_ATTR}] p {
  margin: 0;
}
[${SERVER_TZ_PANEL_ATTR}] label {
  display: flex;
  align-items: center;
  gap: 6px;
}
[${SERVER_TZ_PANEL_ATTR}] [${SERVER_TZ_CLOCK_ROW_ATTR}] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
}
[${SERVER_TZ_PANEL_ATTR}] [${SERVER_TZ_CLOCK_ROLE_ATTR}]:not([${SERVER_TZ_CLOCK_ROLE_ATTR}="authoritative"]) {
  color: var(--fg-muted);
}
[${SERVER_TZ_PANEL_ATTR}] input[type="text"] {
  font: inherit;
  min-width: 16em;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
}
[${SERVER_TZ_PANEL_ATTR}] input:disabled,
[${SERVER_TZ_PANEL_ATTR}] button:disabled {
  opacity: 0.55;
}
[${SERVER_TZ_PANEL_ATTR}] [${SERVER_TZ_ERROR_ATTR}] {
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
}
`;
