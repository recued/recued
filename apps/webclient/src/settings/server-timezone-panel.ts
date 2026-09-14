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
import type {
  ServerTimeZoneGetResponse,
  ServerTimeZoneMode,
  ServerTimeZoneSetRequest,
} from '@recued/contracts';

export const SERVER_TZ_PANEL_ATTR = 'data-recued-server-timezone-panel';
export const SERVER_TZ_STATE_ATTR = 'data-recued-server-timezone-state';
export const SERVER_TZ_MODE_ATTR = 'data-recued-server-timezone-mode';
export const SERVER_TZ_ZONE_INPUT_ATTR = 'data-recued-server-timezone-zone';
export const SERVER_TZ_SAVE_ATTR = 'data-recued-server-timezone-save';
export const SERVER_TZ_ERROR_ATTR = 'data-recued-server-timezone-error';
export const SERVER_TZ_CLOCK_ROW_ATTR = 'data-recued-server-timezone-clock';
export const SERVER_TZ_CLOCK_ROLE_ATTR = 'data-recued-server-timezone-clock-role';

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
  refresh(): Promise<void>;
  dispose(): void;
}

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
  let disposed = false;
  /** The mode the owner has selected but not yet saved. Held separately from
   *  the snapshot so the zone field can appear the instant they pick `fixed`,
   *  before any write. */
  let draftMode: ServerTimeZoneMode | null = null;
  let clocks: TwoClockView | null = null;

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const currentMode = (): ServerTimeZoneMode | null =>
    draftMode ?? snapshot?.setting.mode ?? null;

  const save = async (mode: ServerTimeZoneMode, zone?: string | null): Promise<void> => {
    if (saving) return;
    saving = true;
    error = null;
    render();
    try {
      const next = await opts.runSet({
        mode,
        ...(zone === undefined ? {} : { zone }),
      });
      if (disposed) return;
      snapshot = next;
      draftMode = null;
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

  const render = (): void => {
    if (disposed) return;
    // ⚠ `innerHTML = ''`, NOT `replaceChildren()`. Every other settings panel
    // clears this way, and the webclient's test fakes implement exactly the
    // surface those panels use — a panel reaching for a newer DOM method makes
    // every fake in the tree grow a method to accommodate one file. Found by
    // the composition-root test, not by this panel's own: its fake had
    // `replaceChildren` because I wrote both.
    opts.host.innerHTML = '';
    opts.host.setAttribute(SERVER_TZ_PANEL_ATTR, '');
    opts.host.setAttribute(SERVER_TZ_STATE_ATTR, state);

    opts.host.appendChild(el('h3', 'Timezone'));

    if (state === 'loading') {
      opts.host.appendChild(el('p', 'Loading…'));
      return;
    }

    if (state === 'error' && snapshot === null) {
      const p = el('p', error ?? 'Could not read the server timezone.');
      p.setAttribute(SERVER_TZ_ERROR_ATTR, '');
      opts.host.appendChild(p);
      return;
    }

    // ⛔ THE DEPLOYMENT QUESTION LEADS, because it is the one the owner can
    // answer and the machine cannot. Asking for a zone first would invite them
    // to set one on a laptop, where the right answer is to follow the host.
    opts.host.appendChild(el('p', 'Does this server travel with you?'));

    const mode = currentMode();
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
      input.addEventListener('change', () => {
        // ⚠ `follows_host` saves immediately — there is nothing more to ask.
        // `fixed` only sets the DRAFT, because it needs a zone and saving now
        // would either fail or silently keep a stale one.
        if (value === 'follows_host') { void save('follows_host'); return; }
        draftMode = 'fixed';
        render();
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
      input.value = snapshot?.setting.zone ?? '';
      input.disabled = saving;
      input.setAttribute(SERVER_TZ_ZONE_INPUT_ATTR, '');
      field.appendChild(input);

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = saving ? 'Saving…' : 'Save';
      btn.disabled = saving;
      btn.setAttribute(SERVER_TZ_SAVE_ATTR, '');
      btn.addEventListener('click', () => { void save('fixed', input.value.trim()); });
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

    if (error !== null) {
      const p = el('p', error);
      p.setAttribute(SERVER_TZ_ERROR_ATTR, '');
      opts.host.appendChild(p);
    }

    if (snapshot) {
      const clockHost = el('div');
      renderClocks(clockHost);
      opts.host.appendChild(clockHost);

      // ⛔ THE ROUND-TRIP IS THE POINT WHEN AN ABBREVIATION WAS TYPED. `EST`
      // resolves to `America/Panama`, which never observes DST — no validator
      // can know a New Yorker meant New York, so showing what was actually
      // stored is the only thing that can catch it.
      if (snapshot.setting.mode === 'fixed' && snapshot.setting.zone) {
        opts.host.appendChild(el('p', `Saved as ${snapshot.setting.zone}.`));
      }
      if (snapshot.setting.mode === 'follows_host') {
        opts.host.appendChild(el(
          'p',
          `Following this machine — currently ${snapshot.host_zone}.`,
        ));
      }
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await opts.runGet();
      if (disposed) return;
      snapshot = next;
      state = 'ready';
      error = null;
    } catch (err) {
      if (disposed) return;
      state = 'error';
      error = err instanceof Error ? err.message : String(err);
    }
    render();
  };

  render();
  void refresh();

  return {
    getState: () => state,
    getClocks: () => clocks,
    getMode: () => currentMode(),
    getError: () => error,
    isSaving: () => saving,
    refresh,
    dispose: () => { disposed = true; },
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
