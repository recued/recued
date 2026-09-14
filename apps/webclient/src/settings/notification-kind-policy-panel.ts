/** D-269 — Settings → Approval & notifications → What you are notified about.
 *
 *  🔑 THE THREE PANELS IN THIS SECTION ANSWER THREE DIFFERENT QUESTIONS, and
 *  keeping them apart is the whole point of REV 15: the D-163 panel above
 *  answers **WHERE** (which channels, and notify-vs-approval on each), this one
 *  answers **WHAT** (which kinds, and how far ahead), and quiet hours answers
 *  **WHEN** (one window, everything). A control that cannot be placed in exactly
 *  one of those three belongs to none of them.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE STEP 2 SHIPPED WITHOUT IT. The rpc, the store, the
 *  MCP reservation and the sweep that reads the policy all landed; nothing in
 *  the UI could change it. So every owner had `offset_ms` — the thing D-269 set
 *  out to stop being a constant — as a constant they could not reach. **A
 *  setting the owner cannot open is the same as no setting**, and shipping the
 *  enforcement first makes that especially easy to miss: everything works, and
 *  works at exactly one value.
 *
 *  ⛔⛔ AND IT IS ONLY ABOUT THE NOTIFICATIONS — NOT ABOUT WHEN THEY MAY REACH
 *  YOU. Each row carried a third control ("hold until quiet hours end") until
 *  REV 15, which made one window mean four different things and put a
 *  quiet-hours question on a notification-policy row. **Quiet hours is a master
 *  silencer** with two controls of its own, on/off and a range; this panel
 *  answers *which kinds do I want, and how far ahead*. Two concerns, two panels,
 *  each readable alone.
 *
 *  ⚠ OFFSETS ARE OFFERED AS DURATIONS, NOT MILLISECONDS. The wire carries ms
 *  because the sweep does arithmetic with it; a field that asks an owner for
 *  86400000 is a field that gets a typo. The choices are deliberately coarse —
 *  this is an attention setting, and the difference between 90 and 100 minutes
 *  is not one anybody can feel. */

import {
  NOTIFICATION_ANCHORED_KINDS,
  type NotificationAnchoredKind,
  type NotificationKindPolicy,
  type NotificationKindPolicyGetResponse,
  type NotificationKindPolicySetRequest,
} from '@recued/contracts';

export const KIND_POLICY_PANEL_ATTR = 'data-recued-kind-policy-panel';
export const KIND_POLICY_STATE_ATTR = 'data-recued-kind-policy-state';
export const KIND_POLICY_ROW_ATTR = 'data-recued-kind-policy-row';
export const KIND_POLICY_ENABLED_ATTR = 'data-recued-kind-policy-enabled';
export const KIND_POLICY_OFFSET_ATTR = 'data-recued-kind-policy-offset';
export const KIND_POLICY_ERROR_ATTR = 'data-recued-kind-policy-error';
export const KIND_POLICY_UNREACHABLE_ATTR = 'data-recued-kind-policy-unreachable';

export type KindPolicyGetCaller = () => Promise<NotificationKindPolicyGetResponse>;
export type KindPolicySetCaller = (
  args: NotificationKindPolicySetRequest,
) => Promise<NotificationKindPolicyGetResponse>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ⚠ Coarse on purpose — see the header. `0` is offered because "only when it is
 *  actually due" is a real preference, and the contract's minimum is 0. */
const OFFSET_CHOICES: ReadonlyArray<readonly [number, string]> = [
  [0, 'When it is due'],
  [15 * MINUTE, '15 minutes before'],
  [30 * MINUTE, '30 minutes before'],
  [HOUR, '1 hour before'],
  [2 * HOUR, '2 hours before'],
  [6 * HOUR, '6 hours before'],
  [DAY, '1 day before'],
  [2 * DAY, '2 days before'],
  [7 * DAY, '1 week before'],
];

/** ⛔⛔ THESE ARE THE PRODUCT'S OWN NOUNS, NOT FRESH PROSE FOR THIS PANEL.
 *  `commitment` read "Promises you made" here — a phrase used NOWHERE else in
 *  the app, and wrong for two of the three directions a commitment can have
 *  (`outbound | inbound | internal`; the Today view already renders them as
 *  "You promised" / "Promised to you" / "Personal commitment"). So the row
 *  claimed a third of what it governs: an owner wanting to stop reminders about
 *  a promise made TO them had no reason to think this switch was theirs, and
 *  turning it off would have silenced those too.
 *
 *  🔑 A SETTING IS FOUND BY ITS NAME. `Commitments` is what `inbox-model.ts` and
 *  `server-switch-continuity.ts` both call the kind, which is what the owner
 *  sees in Data — so that is what this row has to say. `Task deadlines` keeps
 *  its qualifier because it still contains the noun and the reminder really is
 *  about the deadline rather than the task. */
const KIND_LABEL: Readonly<Record<NotificationAnchoredKind, string>> = {
  task: 'Task deadlines',
  commitment: 'Commitments',
  booking: 'Bookings',
  calendar: 'Calendar events',
};


export interface MountKindPolicyPanelOptions {
  host: HTMLElement;
  document?: Document;
  runGet: KindPolicyGetCaller;
  runSet: KindPolicySetCaller;
  /** D-269 REV 19 — the channel roster, read ONLY to answer *"can any of this
   *  actually reach the owner while they are away?"*
   *
   *  ⛔ THE SAME CALLER THE PANEL ABOVE ALREADY USES, not a new rpc and not a
   *  cross-panel handle. Reading the neighbour's MOUNT would couple two panels
   *  through load order; re-deriving the answer server-side would add a contract
   *  field for something the client can already see. Absent ⇒ the panel says
   *  nothing, which is the right silence: *unknown* must not look like *bad*. */
  describeChannels?: () => Promise<{ rows: ReadonlyArray<{ channel: string; notification: boolean }> }>;
}

export interface KindPolicyPanelMount {
  getState(): 'loading' | 'ready' | 'error';
  getPolicies(): NotificationKindPolicy[];
  getError(): string | null;
  refresh(): Promise<void>;
  dispose(): void;
}

export const mountKindPolicyPanel = (
  opts: MountKindPolicyPanelOptions,
): KindPolicyPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountKindPolicyPanel: no document available — pass `opts.document`');
  }

  let state: 'loading' | 'ready' | 'error' = 'loading';
  let policies: NotificationKindPolicy[] = [];
  let error: string | null = null;
  /** `null` ⇒ not known (never fetched, or the fetch failed). */
  let reachableWhenAway: boolean | null = null;
  let saving = false;
  let disposed = false;

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const save = async (patch: NotificationKindPolicySetRequest): Promise<void> => {
    if (saving) return;
    saving = true;
    error = null;
    render();
    try {
      const next = await opts.runSet(patch);
      if (disposed) return;
      policies = next.policies;
      state = 'ready';
    } catch (err) {
      if (disposed) return;
      // Verbatim — the server owns why an offset was refused, and a second copy
      // of that reasoning here is a second copy to drift.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
      if (!disposed) render();
    }
  };

  const render = (): void => {
    if (disposed) return;
    opts.host.innerHTML = '';
    opts.host.setAttribute(KIND_POLICY_PANEL_ATTR, '');
    opts.host.setAttribute(KIND_POLICY_STATE_ATTR, state);
    // ⛔ NOT "Reminders" ANY MORE. This panel IS the notification policy for
    // kinds, and "reminder" names only one of the things it can answer — the
    // one about something UPCOMING. An arrival notice is a notification and is
    // not a reminder, so the old heading would have had to be wrong the moment
    // an incoming axis joined. Named for the question it answers instead.
    opts.host.appendChild(el('h3', 'What you are notified about'));

    if (state === 'loading') {
      opts.host.appendChild(el('p', 'Loading…'));
      return;
    }
    if (policies.length === 0) {
      const p = el('p', error ?? 'Could not read your reminder settings.');
      p.setAttribute(KIND_POLICY_ERROR_ATTR, '');
      opts.host.appendChild(p);
      return;
    }

    const lede = el('p', 'Which kinds Recued tells you about, and how far ahead.');
    lede.className = 'kp-lede';
    opts.host.appendChild(lede);

    for (const kind of NOTIFICATION_ANCHORED_KINDS) {
      const policy = policies.find((p) => p.kind === kind);
      if (!policy) continue;
      const row = el('div');
      row.setAttribute(KIND_POLICY_ROW_ATTR, kind);

      const enabled = doc.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = policy.enabled;
      enabled.disabled = saving;
      enabled.setAttribute(KIND_POLICY_ENABLED_ATTR, kind);
      enabled.addEventListener('change', () => {
        void save({ kind, enabled: !policy.enabled });
      });
      const enabledLabel = el('label');
      enabledLabel.className = 'kp-kind';
      enabledLabel.appendChild(enabled);
      enabledLabel.appendChild(el('span', ` ${KIND_LABEL[kind]}`));
      row.appendChild(enabledLabel);

      const offset = doc.createElement('select');
      offset.disabled = saving || !policy.enabled;
      offset.setAttribute(KIND_POLICY_OFFSET_ATTR, kind);
      for (const [ms, label] of OFFSET_CHOICES) {
        const option = doc.createElement('option');
        option.value = String(ms);
        option.textContent = label;
        if (ms === policy.offset_ms) option.selected = true;
        offset.appendChild(option);
      }
      // ⚠ A stored offset that is not one of the choices (set through the rpc,
      // or a default we later change) must still be selectable and visible —
      // otherwise the picker silently misreports what is stored.
      if (!OFFSET_CHOICES.some(([ms]) => ms === policy.offset_ms)) {
        const custom = doc.createElement('option');
        custom.value = String(policy.offset_ms);
        custom.textContent = `${Math.round(policy.offset_ms / MINUTE)} minutes before`;
        custom.selected = true;
        offset.appendChild(custom);
      }
      offset.addEventListener('change', () => {
        const next = Number(offset.value);
        if (Number.isFinite(next)) void save({ kind, offset_ms: next });
      });
      row.appendChild(offset);

      opts.host.appendChild(row);
    }

    // ⛔⛔ THE LINE THAT SAVES THIS WHOLE PANEL FROM BEING DECORATIVE. Every row
    // above says WHEN to tell the owner; none of them can say whether the telling
    // has anywhere to go. ⚠ And the condition is NOT "no channels are on" — that
    // is unreachable: `channelNotifyEnabled` hardcodes `ui` to `true`, so a check
    // for zero would have been dead code that always passed. The real question is
    // whether anything reaches the owner **when they are not looking at Recued**,
    // which is the entire premise of a reminder.
    if (reachableWhenAway === false) {
      const warn = el(
        'p',
        'Only in-app notifications are on, so these will be waiting in Recued '
        + 'rather than reaching you. Turn on a channel above.',
      );
      warn.className = 'kp-note';
      warn.setAttribute(KIND_POLICY_UNREACHABLE_ATTR, '');
      opts.host.appendChild(warn);
    }

    // ⛔ Names the ONE kind an owner will look for and not find, because its
    // absence is a decision and a blank space reads as an oversight to report.
    const note = el(
      'p',
      'Projects have a target date but no reminder: it is a date you move, not '
      + 'one that arrives.',
    );
    note.className = 'kp-note';
    opts.host.appendChild(note);

    // ⚠ NAMES THE OTHER CONCERN RATHER THAN IMPORTING IT. Separating the two
    // panels is only an improvement if the owner can still find the second one;
    // otherwise "why did this not reach me at 3am" has no answer on this screen.
    const silencer = el(
      'p',
      'Quiet hours holds every reminder while it is running, whatever you set '
      + 'here. It is one window for everything, below.',
    );
    silencer.className = 'kp-note';
    opts.host.appendChild(silencer);

    if (error !== null) {
      const p = el('p', error);
      p.setAttribute(KIND_POLICY_ERROR_ATTR, '');
      opts.host.appendChild(p);
    }
  };

  /** ⚠ BEST-EFFORT AND SEPARATE FROM THE POLICY READ. A roster this panel could
   *  not fetch must leave the question UNANSWERED, never answered "no" — a
   *  warning raised by a failed lookup sends the owner to fix a setting that was
   *  never wrong. */
  const refreshReach = async (): Promise<void> => {
    if (opts.describeChannels === undefined) return;
    try {
      const { rows } = await opts.describeChannels();
      if (disposed) return;
      // ⛔ `ui` NAMED EXPLICITLY, not derived from `notification_togglable`.
      // They coincide today, but "you may switch this off" and "this only
      // reaches you in-app" are different properties, and a new fixed-on
      // channel should make someone think rather than silently join the set.
      reachableWhenAway = rows.some((r) => r.channel !== 'ui' && r.notification);
    } catch {
      if (!disposed) reachableWhenAway = null;
    }
  };

  const refresh = async (): Promise<void> => {
    await refreshReach();
    try {
      const next = await opts.runGet();
      if (disposed) return;
      policies = next.policies;
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
    getPolicies: () => policies,
    getError: () => error,
    refresh,
    dispose: () => { disposed = true; },
  };
};

/** ⛔ EVERY SIBLING PANEL IN THIS ROUTE SHIPS ONE OF THESE AND THIS ONE DID NOT,
 *  so four rows of `checkbox · select · checkbox` rendered as one unseparated
 *  run: which box meant "tell me" and which meant "not at night" was positional
 *  only. **A control that is mounted, wired and illegible is still unreachable**
 *  — the same defect as having no UI, one layer further out.
 *
 *  ⚠ Scoped to `[${KIND_POLICY_PANEL_ATTR}]` like the rest of the bundle, so the
 *  rules are inert when the bootstrap omits the kind-policy callers and the
 *  panel never mounts. */
export const KIND_POLICY_PANEL_STYLES = `
[${KIND_POLICY_PANEL_ATTR}] {
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
[${KIND_POLICY_PANEL_ATTR}] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${KIND_POLICY_PANEL_ATTR}] .kp-lede,
[${KIND_POLICY_PANEL_ATTR}] .kp-note {
  margin: 0;
  color: var(--fg-muted);
}
[${KIND_POLICY_PANEL_ATTR}] .kp-note {
  font-size: 12px;
  padding-top: 4px;
}
[${KIND_POLICY_PANEL_ATTR}] [${KIND_POLICY_ROW_ATTR}] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
/* The kind's name takes the width so the four rows read as a column of names
   with their settings beside them, rather than four ragged sentences. */
[${KIND_POLICY_PANEL_ATTR}] .kp-kind {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 190px;
  min-width: 160px;
  font-weight: 500;
}
[${KIND_POLICY_PANEL_ATTR}] select {
  flex: 0 0 auto;
  font: inherit;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
}
/* ⚠ A switched-off kind greys its own words too. The browser dims a disabled
   INPUT and leaves its label at full contrast, which reads as "available". */
[${KIND_POLICY_PANEL_ATTR}] input:disabled + span,
[${KIND_POLICY_PANEL_ATTR}] select:disabled {
  opacity: 0.55;
}
[${KIND_POLICY_PANEL_ATTR}] [${KIND_POLICY_ERROR_ATTR}] {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
}
`;
