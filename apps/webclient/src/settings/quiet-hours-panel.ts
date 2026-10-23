/** D-269 step 3 — Settings → Approval & notifications → Quiet hours.
 *
 *  ⛔⛔ THE PANEL'S REAL JOB IS THE PREVIEW, NOT THE INPUTS. Two time fields are
 *  trivial; what an owner cannot do in their head is answer "what did I just
 *  set?" — because a wall-clock window lives in the SERVER's zone, which may not
 *  be theirs, and because "10pm–8am" does not say which 8am. So the panel states
 *  it the way the owner would:
 *
 *      You set          22:00 → 07:00
 *      Server clock     Mon 15 Jun 22:00  →  Tue 16 Jun 07:00   Asia/Hong_Kong
 *      This browser     Mon 15 Jun 15:00  →  Tue 16 Jun 00:00   Europe/London
 *
 *  ⚠ WITH DATES ON BOTH ROWS, ALWAYS. The row without a date is the one a reader
 *  assumes is today, and for a cross-midnight window that guess is wrong half
 *  the time — and the two zones do not even cross at the same end.
 *
 *  ⛔ ARMING IS GATED ON A RESOLVABLE SERVER TIMEZONE, and the panel says so
 *  rather than rendering a toggle that silently does nothing. A wall-clock
 *  window with no zone is a setting whose failure the owner only discovers at
 *  3am. */

import { twoClockWindowPreview, type TwoClockWindowView } from '@recued/ui-shared';
import {
  isValidIanaZone,
  isValidQuietHoursMinute,
  QUIET_HOURS_APPLIES_TO,
  resolveQuietHoursOccurrence,
  type QuietHoursGetResponse,
  type QuietHoursSetRequest,
} from '@recued/contracts';

export const QUIET_HOURS_PANEL_ATTR = 'data-recued-quiet-hours-panel';
export const QUIET_HOURS_STATE_ATTR = 'data-recued-quiet-hours-state';
export const QUIET_HOURS_TOGGLE_ATTR = 'data-recued-quiet-hours-toggle';
export const QUIET_HOURS_FROM_ATTR = 'data-recued-quiet-hours-from';
export const QUIET_HOURS_TO_ATTR = 'data-recued-quiet-hours-to';
export const QUIET_HOURS_SAVE_ATTR = 'data-recued-quiet-hours-save';
export const QUIET_HOURS_ERROR_ATTR = 'data-recued-quiet-hours-error';
export const QUIET_HOURS_RETRY_ATTR = 'data-recued-quiet-hours-retry';
export const QUIET_HOURS_DECLARED_ATTR = 'data-recued-quiet-hours-declared';
export const QUIET_HOURS_ROW_ATTR = 'data-recued-quiet-hours-row';
export const QUIET_HOURS_ROW_ROLE_ATTR = 'data-recued-quiet-hours-row-role';
export const QUIET_HOURS_BLOCKED_ATTR = 'data-recued-quiet-hours-blocked';
export const QUIET_HOURS_APPROVAL_ATTR = 'data-recued-quiet-hours-approval';
export const QUIET_HOURS_APPROVAL_HINT_ATTR = 'data-recued-quiet-hours-approval-hint';
export const QUIET_HOURS_TZ_LINK_ATTR = 'data-recued-quiet-hours-timezone-link';

/** Settings → Server → Timezone, where this window's clock is declared. */
const SERVER_TIMEZONE_HREF = '#settings/server/timezone';

export type QuietHoursGetCaller = () => Promise<QuietHoursGetResponse>;
export type QuietHoursSetCaller = (
  args: QuietHoursSetRequest,
) => Promise<QuietHoursGetResponse>;

export interface MountQuietHoursPanelOptions {
  host: HTMLElement;
  document?: Document;
  runGet: QuietHoursGetCaller;
  runSet: QuietHoursSetCaller;
  now?: () => number;
  clientZone?: string;
  locale?: string;
}

export interface QuietHoursPanelMount {
  getState(): 'loading' | 'ready' | 'error';
  /** The rendered window preview, or null before the first read. */
  getPreview(): TwoClockWindowView | null;
  /** True when the server says the window cannot be armed (no timezone). */
  isBlocked(): boolean;
  getError(): string | null;
  /** Refreshes confirmed settings unless a pending save owns the result. */
  refresh(): Promise<void>;
  /** User-started saves, including the two checkbox settings. */
  hasInFlightWork(): boolean;
  /** Protects edited windows and window saves whose outcome is still unknown. */
  hasUnsavedChanges(): boolean;
  dispose(): void;
}

/** `22:00` ⇄ minutes. ⚠ The wire carries MINUTES; only this boundary speaks
 *  `HH:MM`, so a parsing mistake cannot reach the store. */
/** The way out of every timezone confusion this panel can produce.
 *
 *  ⛔ A LINK, NOT A SECOND PICKER. The zone is ONE declaration that the cron
 *  schedules, the housekeeping window and the reminder sweeps all read; a second
 *  place to set it is a second place for it to disagree with itself. */
const timezoneLink = (doc: Document, text: string): HTMLElement => {
  const a = doc.createElement('a');
  a.setAttribute('href', SERVER_TIMEZONE_HREF);
  a.setAttribute(QUIET_HOURS_TZ_LINK_ATTR, '');
  a.textContent = text;
  return a;
};

const toHHMM = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const fromHHMM = (value: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

const checkedSnapshot = (next: QuietHoursGetResponse): QuietHoursGetResponse => {
  const policy = next?.policy;
  if (!policy || typeof policy.enabled !== 'boolean'
    || !isValidQuietHoursMinute(policy.from_minute) || !isValidQuietHoursMinute(policy.to_minute)
    || !Array.isArray(policy.applies_to) || policy.applies_to.length === 0
    || !policy.applies_to.every(kind => QUIET_HOURS_APPLIES_TO.includes(kind))
    || !Number.isFinite(policy.updated_at) || policy.updated_at < 0
    || typeof next.can_arm !== 'boolean' || !isValidIanaZone(next.resolved_zone)) {
    throw new Error('Recued could not confirm the quiet hours settings. Try again.');
  }
  return next;
};

export const mountQuietHoursPanel = (
  opts: MountQuietHoursPanelOptions,
): QuietHoursPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountQuietHoursPanel: no document available — pass `opts.document`');
  }
  const now = opts.now ?? ((): number => Date.now());

  let state: 'loading' | 'ready' | 'error' = 'loading';
  let snapshot: QuietHoursGetResponse | null = null;
  let error: string | null = null;
  let saving = false;
  let disposed = false;
  let preview: TwoClockWindowView | null = null;
  let loadGeneration = 0;
  let initialRead: Promise<void> | null = null;
  let readFailed = false;
  let hasDraft = false;
  let unconfirmedWindow = false;
  let savingStatus: HTMLElement | null = null;
  let view: {
    toggle: HTMLInputElement;
    from: HTMLInputElement;
    to: HTMLInputElement;
    save: HTMLButtonElement;
    approvals: HTMLInputElement;
    blockedHost: HTMLElement;
    feedbackHost: HTMLElement;
    previewHost: HTMLElement;
    canArm: boolean | null;
  } | null = null;

  const windowRestored = (): boolean => view !== null && snapshot !== null
    && !view.from.validity.badInput && !view.to.validity.badInput
    && view.from.value === toHHMM(snapshot.policy.from_minute)
    && view.to.value === toHHMM(snapshot.policy.to_minute);
  const syncSavedWindow = (): void => {
    if (!view || !snapshot || hasDraft || view.from.validity.badInput || view.to.validity.badInput
      || doc.activeElement === view.from || doc.activeElement === view.to) return;
    const from = toHHMM(snapshot.policy.from_minute);
    const to = toHHMM(snapshot.policy.to_minute);
    if (view.from.value !== from) view.from.value = from;
    if (view.to.value !== to) view.to.value = to;
  };

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Keep read feedback attached through retries so native button focus survives.
  const readFeedback = el('div');
  readFeedback.className = 'qh-read-feedback';
  const readStatus = el('p');
  readStatus.setAttribute('aria-atomic', 'true');
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'rx-btn rx-btn-secondary';
  retry.textContent = 'Retry loading quiet hours';
  retry.setAttribute(QUIET_HOURS_RETRY_ATTR, '');
  retry.addEventListener('click', () => {
    if (!disposed && snapshot === null && state === 'error') void refresh();
  });
  readFeedback.appendChild(readStatus);

  const save = async (patch: QuietHoursSetRequest): Promise<void> => {
    if (saving || disposed) return;
    const savesWindow = patch.from_minute !== undefined && patch.to_minute !== undefined;
    // A failed write may have reached the server. Restoring the old times is
    // still a draft until a fresh read or a window acknowledgement resolves it.
    if (savesWindow) { hasDraft = true; unconfirmedWindow = true; }
    loadGeneration += 1;
    const initiator = view
      ? [view.toggle, view.from, view.to, view.save, view.approvals].find(control => control === doc.activeElement)
      : undefined;
    saving = true;
    error = null;
    render();
    if (initiator) savingStatus?.focus?.({ preventScroll: true });
    try {
      const next = await opts.runSet(patch);
      if (disposed) return;
      snapshot = checkedSnapshot(next);
      // Checkbox writes acknowledge only their own setting, not the time draft.
      if (savesWindow) { hasDraft = false; unconfirmedWindow = false; }
      state = 'ready';
    } catch (err) {
      if (disposed) return;
      // ⚠ Verbatim. The server owns the reason — that the zone is missing, that
      // approvals are a separate decision — and a second copy of that reasoning
      // in the client is a second copy to drift.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      const held = doc.activeElement === savingStatus;
      saving = false;
      if (!disposed) {
        render();
        if (held) (initiator?.disabled ? view?.save : initiator)?.focus?.({ preventScroll: true });
      }
    }
  };

  const renderPreview = (into: HTMLElement): void => {
    preview = null;
    if (!snapshot) return;
    const occurrence = resolveQuietHoursOccurrence(
      snapshot.policy, snapshot.resolved_zone, now(),
    );
    if (occurrence === null) {
      // An empty window (from === to) has no occurrence to draw, and silences
      // nothing — say that rather than render an empty block.
      into.appendChild(el('p', 'That window is empty, so nothing is held.'));
      return;
    }

    preview = twoClockWindowPreview({
      serverZone: snapshot.resolved_zone,
      start: occurrence.start,
      end: occurrence.end,
      active: occurrence.active,
      fromMinute: snapshot.policy.from_minute,
      toMinute: snapshot.policy.to_minute,
      ...(opts.clientZone === undefined ? {} : { clientZone: opts.clientZone }),
      ...(opts.locale === undefined ? {} : { locale: opts.locale }),
      // ⛔ NOT "Server time" / "This browser". To a solo self-hoster the server
      // is not a place, it is their own machine — so "server vs browser" reads
      // as two peers to choose between, when one DEFINES the window and the
      // other only reports what it lands on where they happen to be standing.
      // Named for that asymmetry instead.
      serverLabel: 'Recued’s clock',
      clientLabel: 'Where you are now',
    });

    const declared = el('p', `Saved window: ${preview.declared_text}`);
    declared.setAttribute(QUIET_HOURS_DECLARED_ATTR, '');
    into.appendChild(declared);

    into.appendChild(el(
      'p',
      preview.active
        ? 'Right now you are inside it. This is the stretch you are in:'
        : 'This is what that means next:',
    ));

    for (const row of preview.rows) {
      const line = el('p');
      line.setAttribute(QUIET_HOURS_ROW_ATTR, '');
      line.setAttribute(QUIET_HOURS_ROW_ROLE_ATTR, row.role);
      // ⛔ Asymmetric, like the instant preview: the window is SET in server
      // time and the browser row translates it. Peers invite editing the wrong
      // one.
      const body = `${row.label}: ${row.start_text} → ${row.end_text} · ${row.zone}`;
      if (row.role === 'authoritative') line.appendChild(el('strong', body));
      else line.appendChild(el('span', `${body} — right now`));
      into.appendChild(line);
    }

    // ⛔⛔ THE SENTENCE THAT MAKES THE TWO ROWS ACTIONABLE, AND IT IS CONDITIONAL
    // ON PURPOSE. The window is a wall clock in Recued's zone, so when the rows
    // disagree the fix is usually to move the ZONE, not the window. ⚠ But NOT
    // always, and that is why this suggests rather than instructs: a server at
    // home keeping home time while its owner is abroad is the design working —
    // the owner's own ruling — and telling a traveller to "fix" it would be
    // telling them to break it. So: state the relationship, offer the way there,
    // let them decide which case they are in.
    if (preview.diverged) {
      const why = el('p');
      why.className = 'qh-hint';
      why.appendChild(el('span',
        'Quiet hours runs on Recued’s clock. If that is not the clock you live '
        + 'by — rather than you simply being away — '));
      why.appendChild(timezoneLink(doc, 'change Recued’s timezone'));
      why.appendChild(el('span', '.'));
      into.appendChild(why);
    } else {
      const same = el('p');
      same.className = 'qh-hint';
      same.appendChild(timezoneLink(doc, 'Change Recued’s timezone'));
      into.appendChild(same);
    }

    if (preview.rows.some((r) => r.crosses_date)) {
      // ⚠ Named explicitly, because it is the thing the times alone hide — and
      // the two zones do not necessarily cross at the same end.
      into.appendChild(el('p', 'This window runs past midnight.'));
    }
  };

  const updateView = (): void => {
    if (!view || !snapshot) return;
    if (hasDraft && !unconfirmedWindow && windowRestored()) hasDraft = false;
    if (view.canArm !== snapshot.can_arm) {
      view.blockedHost.innerHTML = '';
      view.blockedHost.hidden = snapshot.can_arm;
      view.canArm = snapshot.can_arm;
      if (!snapshot.can_arm) {
        // ⛔ SAY WHY AND WHERE TO GO. A disabled toggle with no explanation is how
        // a safety feature becomes one nobody can turn on.
        const p = el(
          'p',
          'Set this server’s timezone first — quiet hours is a wall clock, and the '
          + 'server checks it with no browser attached.',
        );
        p.setAttribute(QUIET_HOURS_BLOCKED_ATTR, '');
        // ⚠ The link belongs MOST here: this is the one state where the owner
        // cannot use the feature at all, and "set it first" without a way there is
        // the shape of instruction people give up on.
        p.appendChild(el('span', ' '));
        p.appendChild(timezoneLink(doc, 'Set the timezone'));
        view.blockedHost.appendChild(p);
      }
    }
    // Keep the native fields and their ancestors connected. Incomplete time
    // segments and the active segment cannot be reconstructed from `value`.
    syncSavedWindow();
    view.toggle.checked = snapshot.policy.enabled;
    view.toggle.disabled = saving || !snapshot.can_arm;
    view.approvals.checked = snapshot.policy.applies_to.includes('approval');
    view.approvals.disabled = saving || !snapshot.can_arm;
    view.from.disabled = saving;
    view.to.disabled = saving;
    view.save.disabled = saving;
    view.save.textContent = saving ? 'Saving…' : 'Save';
    view.feedbackHost.innerHTML = '';
    view.feedbackHost.hidden = error === null && !saving;
    savingStatus = null;
    if (error !== null) {
      const p = el('p', error);
      p.setAttribute(QUIET_HOURS_ERROR_ATTR, '');
      p.setAttribute('role', 'alert');
      view.feedbackHost.appendChild(p);
    }
    if (saving) {
      savingStatus = el('p', 'Saving quiet hours…');
      savingStatus.setAttribute('role', 'status');
      savingStatus.setAttribute('tabindex', '-1');
      view.feedbackHost.appendChild(savingStatus);
    }
    const active = doc.activeElement;
    const heldLink = active?.getAttribute?.(QUIET_HOURS_TZ_LINK_ATTR) != null
      && view.previewHost.contains?.(active);
    view.previewHost.innerHTML = '';
    renderPreview(view.previewHost);
    if (heldLink) {
      const link = view.previewHost.querySelector?.<HTMLElement>(`[${QUIET_HOURS_TZ_LINK_ATTR}]`);
      (link ?? view.save).focus?.({ preventScroll: true });
    }
  };

  const render = (): void => {
    if (disposed) return;
    opts.host.setAttribute(QUIET_HOURS_PANEL_ATTR, '');
    opts.host.setAttribute(QUIET_HOURS_STATE_ATTR, state);
    if (view) { updateView(); return; }
    if (snapshot === null) {
      const failed = state === 'error';
      if (failed && !readFailed) { readFailed = true; readFeedback.appendChild(retry); }
      readStatus.setAttribute('role', failed ? 'alert' : 'status');
      if (failed) readStatus.setAttribute(QUIET_HOURS_ERROR_ATTR, '');
      else readStatus.removeAttribute(QUIET_HOURS_ERROR_ATTR);
      readStatus.textContent = failed ? error ?? 'Could not read quiet hours.'
        : readFailed ? 'Retrying quiet hours…' : 'Loading quiet hours…';
      retry.setAttribute('aria-disabled', String(!failed));
      retry.setAttribute('aria-busy', String(!failed));
      if (readFeedback.parentElement !== opts.host) {
        opts.host.innerHTML = '';
        opts.host.appendChild(el('h3', 'Quiet hours'));
        opts.host.appendChild(readFeedback);
      }
      return;
    }
    const returnToTime = doc.activeElement === retry;
    opts.host.innerHTML = '';
    opts.host.appendChild(el('h3', 'Quiet hours'));

    const blockedHost = el('div');
    opts.host.appendChild(blockedHost);
    const toggle = doc.createElement('input');
    toggle.type = 'checkbox';
    toggle.setAttribute(QUIET_HOURS_TOGGLE_ATTR, '');
    toggle.addEventListener('change', () => {
      if (!snapshot?.can_arm) return;
      void save({ enabled: !snapshot.policy.enabled });
    });
    const toggleLabel = el('label');
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(el('span', ' Hold reminders during quiet hours'));
    opts.host.appendChild(toggleLabel);

    const fromInput = doc.createElement('input');
    fromInput.type = 'time';
    fromInput.setAttribute(QUIET_HOURS_FROM_ATTR, '');
    fromInput.setAttribute('aria-label', 'Quiet hours start');
    const toInput = doc.createElement('input');
    toInput.type = 'time';
    toInput.setAttribute(QUIET_HOURS_TO_ATTR, '');
    toInput.setAttribute('aria-label', 'Quiet hours end');
    for (const input of [fromInput, toInput]) {
      input.addEventListener('input', () => {
        if (!saving && !disposed) hasDraft = unconfirmedWindow || !windowRestored();
      });
      input.addEventListener('blur', () => { if (!saving && !disposed) syncSavedWindow(); });
    }

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(QUIET_HOURS_SAVE_ATTR, '');
    const submit = (): void => {
      if (saving || disposed) return;
      hasDraft = true;
      const from = fromHHMM(fromInput.value);
      const to = fromHHMM(toInput.value);
      if (from === null || to === null) {
        error = 'Enter both times as HH:MM.';
        render();
        const invalid = from === null ? fromInput : toInput;
        if (doc.activeElement !== invalid) invalid.focus?.({ preventScroll: true });
        return;
      }
      void save({ from_minute: from, to_minute: to });
    };
    btn.addEventListener('click', submit);
    for (const input of [fromInput, toInput]) {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); }
      });
    }

    const fields = el('p');
    fields.appendChild(el('span', 'From '));
    fields.appendChild(fromInput);
    fields.appendChild(el('span', ' to '));
    fields.appendChild(toInput);
    fields.appendChild(btn);
    opts.host.appendChild(fields);

    const feedbackHost = el('div');
    opts.host.appendChild(feedbackHost);
    const previewHost = el('div');
    opts.host.appendChild(previewHost);

    // ⛔ LAST, DELIBERATELY (REV 18). This sat between the on/off toggle and the
    // time range, so the primary control — the range, one of quiet hours' only
    // two — rendered below a secondary opt-in and the longest paragraph on the
    // panel. That order made sense when this was "a window with options"; it
    // stopped making sense when REV 15 made quiet hours a master silencer whose
    // whole surface is on/off and a range. Secondary things go after.
    //
    // ⛔⛔ D-269 step 5 — THE APPROVAL OPT-IN, AND THE POINTER BESIDE IT. The
    // design's exact words: available, "surfaced with the pre-approval pointer
    // at the point of choosing it. Not hidden, not recommended." Hiding it would
    // make the rpc the only way in; recommending it would be wrong, because
    // pre-approval buys the same silence without the work waiting.
    const approvals = doc.createElement('input');
    approvals.type = 'checkbox';
    approvals.setAttribute(QUIET_HOURS_APPROVAL_ATTR, '');
    approvals.addEventListener('change', () => {
      if (!snapshot?.can_arm) return;
      void save({
        applies_to: snapshot.policy.applies_to.includes('approval') ? ['notification'] : ['notification', 'approval'],
      });
    });
    const approvalsLabel = el('label');
    approvalsLabel.appendChild(approvals);
    approvalsLabel.appendChild(el('span', ' Also hold approval prompts'));
    opts.host.appendChild(approvalsLabel);
    // ⚠ The pointer is always visible, not only once the box is ticked: it is
    // the reason NOT to tick it, so showing it afterwards would be too late.
    const pointer = el(
      'p',
      'Not usually what you want. Approving a run in advance keeps you '
      + 'unbothered and lets the work go ahead; holding the prompt keeps you '
      + 'unbothered and makes the work wait.',
    );
    pointer.className = 'qh-hint';
    pointer.setAttribute(QUIET_HOURS_APPROVAL_HINT_ATTR, '');
    opts.host.appendChild(pointer);
    view = { toggle, from: fromInput, to: toInput, save: btn, approvals, blockedHost, feedbackHost, previewHost, canArm: null };
    updateView();
    if (returnToTime) fromInput.focus({ preventScroll: true });
  };

  const refresh = (): Promise<void> => {
    if (disposed || saving) return Promise.resolve();
    if (snapshot === null && initialRead !== null) return initialRead;
    const generation = ++loadGeneration;
    const initial = snapshot === null;
    if (initial) {
      state = 'loading';
      error = null;
      render();
    }
    const read = (async () => {
      try {
        const next = await opts.runGet();
        if (disposed || generation !== loadGeneration) return;
        snapshot = checkedSnapshot(next);
        unconfirmedWindow = false;
        state = 'ready';
        error = null;
      } catch (err) {
        if (disposed || generation !== loadGeneration) return;
        state = 'error';
        error = err instanceof Error ? err.message : String(err);
      }
      render();
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
    getPreview: () => preview,
    isBlocked: () => snapshot !== null && !snapshot.can_arm,
    getError: () => error,
    refresh,
    hasInFlightWork: () => !disposed && saving,
    hasUnsavedChanges: () => !disposed && (hasDraft
      || view?.from.validity.badInput === true || view?.to.validity.badInput === true),
    dispose: () => { disposed = true; loadGeneration += 1; },
  };
};

/** ⚠ Same omission as the reminders panel next to it — see
 *  `KIND_POLICY_PANEL_STYLES`. The two-clock window preview is the part that
 *  suffers most unstyled: it is TWO LINES whose whole job is to be compared, and
 *  undifferentiated they read as one repeated sentence. The authoritative row is
 *  already `<strong>`; this gives the other one the recessive treatment that
 *  makes the pair legible as a comparison. */
export const QUIET_HOURS_PANEL_STYLES = `
[${QUIET_HOURS_PANEL_ATTR}] {
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
[${QUIET_HOURS_PANEL_ATTR}] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${QUIET_HOURS_PANEL_ATTR}] p {
  margin: 0;
}
[${QUIET_HOURS_PANEL_ATTR}] label {
  display: flex;
  align-items: center;
  gap: 6px;
}
[${QUIET_HOURS_PANEL_ATTR}] .qh-read-feedback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_RETRY_ATTR}] {
  min-height: 44px;
}
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_DECLARED_ATTR}] {
  color: var(--fg-muted);
}
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_ROW_ATTR}] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
}
/* The row that is NOT the server's own clock recedes, so the pair reads as
   "this is what it means" rather than as the same line said twice. */
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_ROW_ROLE_ATTR}]:not([${QUIET_HOURS_ROW_ROLE_ATTR}="authoritative"]) {
  color: var(--fg-muted);
}
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_TZ_LINK_ATTR}] {
  color: var(--accent, var(--fg));
  text-decoration: underline;
}
[${QUIET_HOURS_PANEL_ATTR}] .qh-hint {
  color: var(--fg-muted);
  font-size: 12px;
  max-width: 62ch;
}
[${QUIET_HOURS_PANEL_ATTR}] input[type="text"],
[${QUIET_HOURS_PANEL_ATTR}] input[type="time"] {
  font: inherit;
  width: 120px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
}
[${QUIET_HOURS_PANEL_ATTR}] input:disabled,
[${QUIET_HOURS_PANEL_ATTR}] button:disabled {
  opacity: 0.55;
}
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_BLOCKED_ATTR}],
[${QUIET_HOURS_PANEL_ATTR}] [${QUIET_HOURS_ERROR_ATTR}] {
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
}
`;
