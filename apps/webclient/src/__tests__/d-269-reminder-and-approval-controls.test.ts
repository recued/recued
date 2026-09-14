/** D-269 — the two settings surfaces the audit found MISSING, not broken.
 *
 *  ⛔⛔ BOTH GAPS HAVE THE SAME SHAPE AND IT IS THE ONE HARDEST TO NOTICE: the
 *  enforcement shipped and the REACH did not. Step 2's per-kind reminder policy
 *  had an rpc, a store, an MCP reservation and a sweep that honoured it — at
 *  exactly one value, because nothing in the UI could change `offset_ms`, the
 *  very constant D-269 existed to stop being one. Step 5's approval opt-in had
 *  `applies_to` plumbed end to end and no checkbox. Nothing was red. Every test
 *  passed. A setting the owner cannot open is the same as no setting.
 *
 *  ⇒ SO THESE TESTS DRIVE THE CONTROLS AND READ WHAT WENT OUT ON THE WIRE.
 *  Asserting a control EXISTS would have passed against a panel wired to the
 *  wrong kind, or one that echoes the stored value back instead of flipping it.
 *  Every assertion below names the kind AND the value, because a per-row panel
 *  whose rows all write to row one is the defect this shape actually has. */

import { describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_ANCHORED_KINDS,
  type NotificationAnchoredKind,
  type NotificationKindPolicy,
  type NotificationKindPolicyGetResponse,
  type NotificationKindPolicySetRequest,
  type QuietHoursGetResponse,
  type QuietHoursSetRequest,
} from '@recued/contracts';
import {
  mountKindPolicyPanel,
  KIND_POLICY_ENABLED_ATTR,
  KIND_POLICY_PANEL_ATTR,
  KIND_POLICY_UNREACHABLE_ATTR,
  KIND_POLICY_OFFSET_ATTR,
  KIND_POLICY_ROW_ATTR,
  KIND_POLICY_STATE_ATTR,
} from '../settings/notification-kind-policy-panel.js';
import {
  mountQuietHoursPanel,
  QUIET_HOURS_APPROVAL_ATTR,
  QUIET_HOURS_APPROVAL_HINT_ATTR,
  QUIET_HOURS_PANEL_ATTR,
  QUIET_HOURS_SAVE_ATTR,
  QUIET_HOURS_TOGGLE_ATTR,
  QUIET_HOURS_TZ_LINK_ATTR,
  QUIET_HOURS_BLOCKED_ATTR,
  QUIET_HOURS_ROW_ATTR,
} from '../settings/quiet-hours-panel.js';
import {
  bootstrapSettingsRoute,
  SETTINGS_ROUTE_SECTION_ATTR,
  SETTINGS_ROUTE_STYLES_MARKER,
} from '../settings/bootstrap-settings-route.js';
import { SOURCE_TOP_TIER_COPY } from '../reception/inbox-model.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

/** ⚠ NO JSDOM — same convention as every other panel test here. */
interface FakeEl {
  tagName: string;
  textContent: string;
  type: string;
  value: string;
  checked: boolean;
  selected: boolean;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(e: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  readonly firstChild: FakeEl | null;
  remove(): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  scrollIntoView(o?: unknown): void;
  focus(o?: unknown): void;
  innerHTML: string;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(e: { type: string }): void;
  click(): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '', type: '', value: '',
    checked: false, selected: false, disabled: false,
    attrs: new Map(), children: [], listeners: new Map(),
    parent: null,
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    hasAttribute(k) { return el.attrs.has(k); },
    removeAttribute(k) { el.attrs.delete(k); },
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) { el.children.splice(i, 1); c.parent = null; }
      return c;
    },
    get firstChild() { return el.children[0] ?? null; },
    remove() { el.parent?.removeChild(el); },
    removeEventListener(t, fn) {
      const list = el.listeners.get(t) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    scrollIntoView() { /* layout has no meaning in a fake tree */ },
    focus() { /* ditto */ },
    set innerHTML(v: string) { if (v === '') el.children.length = 0; },
    get innerHTML() { return ''; },
    addEventListener(t, fn) {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    dispatchEvent(e) {
      // ⚠ A real browser fires no `change` on a disabled control; the fake would
      // happily deliver one, so a test that only dispatched would report a
      // disabled toggle as working. Modelled here so `disabled` MEANS something.
      if (el.disabled) return;
      for (const fn of el.listeners.get(e.type) ?? []) fn(e);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const fakeDocument = { createElement: makeFakeElement } as unknown as Document;

/** The route appends a `<style>` tag, so the boot needs a `head`. */
const makeFakeDocument = (): Document => {
  const styles: FakeEl[] = [];
  return {
    createElement: makeFakeElement,
    head: {
      appendChild: (n: FakeEl) => { styles.push(n); return n; },
      querySelector: (sel: string) => {
        const m = /^([\w-]+)\[([\w-]+)\]$/.exec(sel);
        if (m === null) return null;
        return styles.find((x) => x.tagName === m[1]!.toUpperCase() && x.attrs.has(m[2]!)) ?? null;
      },
    },
  } as unknown as Document;
};

const byAttr = (root: FakeEl, attr: string, value?: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr) && (value === undefined || root.attrs.get(attr) === value)) out.push(root);
  for (const c of root.children) byAttr(c, attr, value, out);
  return out;
};
const one = (root: FakeEl, attr: string, value?: string): FakeEl => {
  const hits = byAttr(root, attr, value);
  expect(hits).toHaveLength(1);
  return hits[0]!;
};
const allText = (root: FakeEl): string =>
  root.textContent + root.children.map(allText).join(' ');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

// ─── the per-kind reminder policy ────────────────────────────────────────────

const policy = (
  kind: NotificationAnchoredKind,
  over: Partial<NotificationKindPolicy> = {},
): NotificationKindPolicy => ({
  kind, enabled: true, offset_ms: DAY, updated_at: 1, ...over,
});

/** ⛔ The seed gives every kind a DIFFERENT value on every axis. A panel that
 *  renders row one's policy four times, or writes every change to the first
 *  kind, passes against a uniform fixture and fails against this one. */
const KIND_SEED: NotificationKindPolicy[] = [
  policy('task', { offset_ms: DAY, enabled: true }),
  policy('commitment', { offset_ms: 2 * DAY, enabled: false }),
  policy('booking', { offset_ms: 2 * HOUR, enabled: true }),
  policy('calendar', { offset_ms: 15 * MINUTE, enabled: true }),
];

type Roster = ReadonlyArray<{ channel: string; notification: boolean }>;
/** Only `ui` on — the state the warning exists for. `ui` cannot be switched off. */
const IN_APP_ONLY: Roster = [
  { channel: 'ui', notification: true },
  { channel: 'slack', notification: false },
  { channel: 'bridge', notification: false },
];
const REACHABLE: Roster = [
  { channel: 'ui', notification: true },
  { channel: 'telegram', notification: true },
];

const mountKinds = async (
  policies: NotificationKindPolicy[] = KIND_SEED,
  describe?: () => Promise<{ rows: Roster }>,
) => {
  const sent: NotificationKindPolicySetRequest[] = [];
  const host = makeFakeElement('div');
  const runSet = vi.fn(async (args: NotificationKindPolicySetRequest) => {
    sent.push(args);
    const next = policies.map((p) => (p.kind === args.kind ? { ...p, ...args } : p));
    return { policies: next } satisfies NotificationKindPolicyGetResponse;
  });
  const panel = mountKindPolicyPanel({
    host: host as unknown as HTMLElement,
    document: fakeDocument,
    runGet: async () => ({ policies }),
    runSet,
    ...(describe === undefined ? {} : { describeChannels: describe }),
  });
  await flush();
  return { host, panel, sent, runSet };
};

describe('D-269 step 2 — the reminder offset is reachable, per kind', () => {
  it('⛔ renders a row per anchored kind and NO row for anything else', async () => {
    const { host, panel } = await mountKinds();
    expect(panel.getState()).toBe('ready');
    expect(host.getAttribute(KIND_POLICY_STATE_ATTR)).toBe('ready');
    const rows = byAttr(host, KIND_POLICY_ROW_ATTR).map((r) => r.getAttribute(KIND_POLICY_ROW_ATTR));
    expect(rows).toEqual([...NOTIFICATION_ANCHORED_KINDS]);
    // ⚠ `project` has a target date and deliberately no reminder. Named, not
    // omitted — a blank space reads as an oversight worth reporting.
    expect(rows).not.toContain('project');
    expect(allText(host)).toContain('Projects have a target date but no reminder');
  });

  it('⛔⛔ each row SHOWS ITS OWN stored offset — the whole point of step 2', async () => {
    // This is the assertion the shipped gap would have failed: before the panel
    // existed the offset was one number nobody could see or change.
    const { host } = await mountKinds();
    const selectedOf = (kind: NotificationAnchoredKind): string[] =>
      one(host, KIND_POLICY_OFFSET_ATTR, kind).children
        .filter((o) => o.selected).map((o) => o.value);
    expect(selectedOf('task')).toEqual([String(DAY)]);
    expect(selectedOf('commitment')).toEqual([String(2 * DAY)]);
    expect(selectedOf('booking')).toEqual([String(2 * HOUR)]);
    expect(selectedOf('calendar')).toEqual([String(15 * MINUTE)]);
  });

  it('⛔ changing one row writes THAT kind and that value', async () => {
    const { host, sent } = await mountKinds();
    const sel = one(host, KIND_POLICY_OFFSET_ATTR, 'booking');
    sel.value = String(6 * HOUR);
    sel.dispatchEvent({ type: 'change' });
    await flush();
    expect(sent).toEqual([{ kind: 'booking', offset_ms: 6 * HOUR }]);
  });

  it('⛔ a toggle sends the FLIP of what is stored, not the stored value', async () => {
    // Seeded `task: enabled` and `commitment: disabled`, so a panel echoing the
    // current value back would send `true`/`false` and be caught on one of them.
    const { host, sent } = await mountKinds();
    one(host, KIND_POLICY_ENABLED_ATTR, 'task').dispatchEvent({ type: 'change' });
    await flush();
    expect(sent).toEqual([{ kind: 'task', enabled: false }]);
  });

  it('⛔⛔ NO per-row quiet-hours control — that is one window, not four', () => {
    // REV 15: each row carried "hold until quiet hours end", which made the same
    // window mean a different thing per row and put a quiet-hours question on a
    // notification-policy row. Quiet hours is a master silencer with its own two
    // controls; this panel answers which kinds, and how far ahead.
    return mountKinds().then(({ host }) => {
      const row = one(host, KIND_POLICY_ROW_ATTR, 'booking');
      const boxes = byAttr(row, KIND_POLICY_ENABLED_ATTR);
      expect(boxes).toHaveLength(1);                    // exactly one checkbox
      expect(allText(row).toLowerCase()).not.toContain('quiet');
      // ⚠ But the panel must still SAY where that lives, or "why did this not
      // reach me at 3am" has no answer on this screen.
      expect(allText(host).toLowerCase()).toContain('quiet hours holds every reminder');
    // ⚠ And the panel is named for the QUESTION, not for one of its answers:
    // "Reminders" would be wrong the moment an arrival axis joins, because an
    // arrival notice is a notification and is not a reminder.
    expect(allText(host)).toContain('What you are notified about');
    });
  });

  it('⚠ a disabled kind cannot be re-timed, but CAN be re-enabled', async () => {
    // The offset of a kind you are not told about is not a live setting; the
    // switch that brings it back must stay reachable or the row is a dead end.
    const { host } = await mountKinds();
    expect(one(host, KIND_POLICY_OFFSET_ATTR, 'commitment').disabled).toBe(true);
    expect(one(host, KIND_POLICY_ENABLED_ATTR, 'commitment').disabled).toBe(false);
  });

  it('⛔ a stored offset outside the choices stays VISIBLE and selected', async () => {
    // Set through the rpc, or a default we later change. A picker that silently
    // snaps to its nearest option misreports what is stored — and the owner
    // would only find out from a reminder arriving at the wrong time.
    const { host } = await mountKinds([policy('task', { offset_ms: 45 * MINUTE }), ...KIND_SEED.slice(1)]);
    const sel = one(host, KIND_POLICY_OFFSET_ATTR, 'task');
    const chosen = sel.children.filter((o) => o.selected);
    expect(chosen.map((o) => o.value)).toEqual([String(45 * MINUTE)]);
    expect(chosen[0]!.textContent).toContain('45 minutes before');
  });
});

// ─── the quiet-hours approval opt-in ─────────────────────────────────────────

const quietSnapshot = (
  applies_to: Array<'notification' | 'approval'> = ['notification'],
  can_arm = true,
): QuietHoursGetResponse => ({
  policy: {
    enabled: true, from_minute: 22 * 60, to_minute: 8 * 60,
    applies_to, updated_at: 1,
  },
  can_arm,
  resolved_zone: 'Asia/Hong_Kong',
});

const mountQuiet = async (
  snapshot: QuietHoursGetResponse,
  clientZone = 'Asia/Hong_Kong',
) => {
  const sent: QuietHoursSetRequest[] = [];
  const host = makeFakeElement('div');
  const panel = mountQuietHoursPanel({
    host: host as unknown as HTMLElement,
    document: fakeDocument,
    runGet: async () => snapshot,
    runSet: async (args: QuietHoursSetRequest) => {
      sent.push(args);
      return { ...snapshot, policy: { ...snapshot.policy, ...args } };
    },
    now: () => Date.parse('2026-06-15T20:00:00Z'),
    clientZone,
    locale: 'en-US',
  });
  await flush();
  return { host, panel, sent };
};

describe('D-269 step 5 — holding approvals is reachable, and argued against', () => {
  it('⛔ opting IN sends both, and does not drop notification on the way', async () => {
    const { host, sent } = await mountQuiet(quietSnapshot(['notification']));
    const box = one(host, QUIET_HOURS_APPROVAL_ATTR);
    expect(box.checked).toBe(false);
    box.dispatchEvent({ type: 'change' });
    await flush();
    expect(sent).toEqual([{ applies_to: ['notification', 'approval'] }]);
  });

  it('⛔ opting OUT removes approval and KEEPS notification', async () => {
    // `applies_to: []` would silently disarm quiet hours entirely while the
    // toggle above it still read "on" — the unticking path is the one that can
    // turn a narrowing into an off switch.
    const { host, sent } = await mountQuiet(quietSnapshot(['notification', 'approval']));
    const box = one(host, QUIET_HOURS_APPROVAL_ATTR);
    expect(box.checked).toBe(true);
    box.dispatchEvent({ type: 'change' });
    await flush();
    expect(sent).toEqual([{ applies_to: ['notification'] }]);
  });

  it('⛔⛔ the pre-approval pointer shows in BOTH states — it is the reason not to tick', async () => {
    // Shown only once ticked, it arrives after the decision it exists to inform.
    for (const applies of [['notification'], ['notification', 'approval']] as const) {
      const { host } = await mountQuiet(quietSnapshot([...applies]));
      const hint = one(host, QUIET_HOURS_APPROVAL_HINT_ATTR);
      expect(hint.textContent).toContain('Approving a run in advance');
      expect(hint.textContent).toContain('makes the work wait');
    }
  });

  it('⚠ unarmable window ⇒ the opt-in is disabled, not merely ignored', async () => {
    // No declared timezone means no window; a checkbox that ticks and does
    // nothing is worse than one that is visibly unavailable.
    const { host, sent } = await mountQuiet(quietSnapshot(['notification'], false));
    const box = one(host, QUIET_HOURS_APPROVAL_ATTR);
    expect(box.disabled).toBe(true);
    box.dispatchEvent({ type: 'change' });
    await flush();
    expect(sent).toEqual([]);
  });
});


// ─── the composition root ────────────────────────────────────────────────────

/** ⛔ THE SECTION ITSELF IS GATED — D-163's two notification callers open it,
 *  and everything D-269 appended lives inside. Worth knowing rather than
 *  stubbing silently: a server too old to describe channels shows the owner no
 *  reminder settings at all, because there is no section for them to sit in. */
const NOTIF_SECTION_GATE = {
  notificationsDescribeCaller: async () => ({ rows: [] }),
  notificationsSetChannelCaller: async () => ({ ok: true } as never),
};

describe('D-269 — both controls reach the owner from the real settings route', () => {
  /** ⛔⛔ THIS IS THE TEST THE ORIGINAL GAP WOULD HAVE FAILED, and the reason a
   *  panel suite alone is not enough. Both panels above mount perfectly when a
   *  test mounts them; what shipped wrong was that NOTHING ELSE DID. A hand-
   *  wired harness proves the panel; only the route proves the reach. */
  it('mounts the reminder panel AND the quiet-hours panel inside Approval & notifications', async () => {
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument(),
      localStore: createInMemoryWebclientLocalStore(),
      ...NOTIF_SECTION_GATE,
      kindPolicyGetCaller: async () => ({ policies: KIND_SEED }),
      kindPolicySetCaller: async () => ({ policies: KIND_SEED }),
      quietHoursGetCaller: async () => quietSnapshot(['notification']),
      quietHoursSetCaller: async () => quietSnapshot(['notification']),
    });
    await flush();

    const section = byAttr(host, SETTINGS_ROUTE_SECTION_ATTR, 'notifications');
    expect(section).toHaveLength(1);
    // ⚠ Scoped to the SECTION, not the page: a panel rendered into the wrong
    // section is still findable from the root, and would pass a looser search.
    expect(byAttr(section[0]!, KIND_POLICY_STATE_ATTR)).toHaveLength(1);
    expect(byAttr(section[0]!, QUIET_HOURS_PANEL_ATTR)).toHaveLength(1);
    // The offset select is the control that did not exist; assert it arrived
    // wired, not merely that a heading with the word "Reminders" rendered.
    expect(byAttr(section[0]!, KIND_POLICY_OFFSET_ATTR)).toHaveLength(
      NOTIFICATION_ANCHORED_KINDS.length,
    );
    expect(byAttr(section[0]!, QUIET_HOURS_APPROVAL_ATTR)).toHaveLength(1);
    // ⛔⛔ AND THE ROSTER CALLER REACHED THE PANEL. The gate stub describes NO
    // channels, so the "nothing can reach you" line must render — which it can
    // only do if the route actually passed `describeChannels` down. Without this
    // the route could silently stop passing it and every panel-level test would
    // still pass, which is exactly what happened when it was first written.
    expect(byAttr(section[0]!, KIND_POLICY_UNREACHABLE_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('⚠ omitting the callers omits the panel — no half-mounted control', async () => {
    // A panel that renders against an absent caller would show an owner a
    // picker that cannot save. The gate is per-pair, and this pins it.
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument(),
      localStore: createInMemoryWebclientLocalStore(),
      ...NOTIF_SECTION_GATE,
      quietHoursGetCaller: async () => quietSnapshot(['notification']),
      quietHoursSetCaller: async () => quietSnapshot(['notification']),
    });
    await flush();
    expect(byAttr(host, KIND_POLICY_STATE_ATTR)).toHaveLength(0);
    expect(byAttr(host, QUIET_HOURS_PANEL_ATTR)).toHaveLength(1);
    route.dispose();
  });
});


// ─── legible, not merely present ─────────────────────────────────────────────

describe('D-269 — the rows say what the rest of the app calls these things', () => {
  /** ⛔⛔ THE DEFECT THIS CATCHES IS A ROW THAT NAMES ONLY PART OF WHAT IT
   *  GOVERNS. `commitment` read "Promises you made" — a phrase used nowhere else
   *  in the product, and true of ONE of the three directions a commitment has
   *  (`outbound | inbound | internal`). An owner wanting to stop reminders about
   *  a promise made TO them had no reason to think that switch was theirs.
   *
   *  🔑 The rule is CONTAINMENT, not equality, because a qualifier is fine and a
   *  new noun is not: "Task deadlines" still contains the word the owner sees in
   *  Data, so they can find it. "Promises you made" contains nothing they have
   *  ever been shown. */
  const CANONICAL: Readonly<Record<NotificationAnchoredKind, string>> = {
    task: SOURCE_TOP_TIER_COPY.task,
    commitment: SOURCE_TOP_TIER_COPY.commitment,
    booking: SOURCE_TOP_TIER_COPY.booking,
    calendar: SOURCE_TOP_TIER_COPY['calendar.event'],
  };

  it.each(NOTIFICATION_ANCHORED_KINDS)('%s is named the way the app names it', async (kind) => {
    const { host } = await mountKinds();
    const row = one(host, KIND_POLICY_ROW_ATTR, kind);
    // Singularised, so a label may pluralise or qualify but not rename.
    const noun = CANONICAL[kind].replace(/s$/, '');
    expect(allText(row).toLowerCase()).toContain(noun.toLowerCase());
  });

  it('⚠ and the commitment row does NOT claim only one direction', async () => {
    // A commitment is outbound, inbound OR internal; Today already renders those
    // as "You promised" / "Promised to you" / "Personal commitment". A settings
    // row that says any one of them is lying about the other two.
    const { host } = await mountKinds();
    const text = allText(one(host, KIND_POLICY_ROW_ATTR, 'commitment'));
    for (const oneSided of ['you made', 'you promised', 'promised to you']) {
      expect(text.toLowerCase()).not.toContain(oneSided);
    }
  });
});

describe('D-269 — the panels are styled, which is not the same as mounted', () => {
  it('⛔⛔ all three panel stylesheets reach the route bundle', async () => {
    // Exported styles that nothing joins are inert — the same declared-is-not-
    // backed shape as an rpc with no caller, and invisible in exactly the same
    // way: the panel renders, so nothing looks wrong until you see it.
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc,
      localStore: createInMemoryWebclientLocalStore(),
      ...NOTIF_SECTION_GATE,
      kindPolicyGetCaller: async () => ({ policies: KIND_SEED }),
      kindPolicySetCaller: async () => ({ policies: KIND_SEED }),
      quietHoursGetCaller: async () => quietSnapshot(['notification']),
      quietHoursSetCaller: async () => quietSnapshot(['notification']),
    });
    await flush();

    const styles = (doc as unknown as { head: { querySelector(s: string): FakeEl | null } })
      .head.querySelector(`style[${SETTINGS_ROUTE_STYLES_MARKER}]`);
    expect(styles).not.toBeNull();
    const css = styles!.textContent;
    // Each panel's own scope selector, so a rename of the attribute that forgot
    // the stylesheet is caught too.
    expect(css).toContain(`[${KIND_POLICY_PANEL_ATTR}]`);
    expect(css).toContain(`[${QUIET_HOURS_PANEL_ATTR}]`);
    expect(css).toContain('[data-recued-server-timezone-panel]');
    // ⚠ And the row rule specifically — the panel-level card rule alone would
    // pass while the four rows still ran together, which was the actual defect.
    expect(css).toContain(`[${KIND_POLICY_PANEL_ATTR}] [${KIND_POLICY_ROW_ATTR}]`);
    route.dispose();
  });
});


// ─── REV 18: order, the way out, and what the two rows are called ────────────

/** Depth-first index of a node inside the host, so ORDER can be asserted. */
const orderOf = (host: FakeEl, attr: string): number => {
  let i = 0, hit = -1;
  const walk = (n: FakeEl): void => {
    if (n.attrs.has(attr) && hit < 0) hit = i;
    i += 1;
    for (const c of n.children) walk(c);
  };
  walk(host);
  return hit;
};

describe('D-269 REV 18 — quiet hours leads with its own two controls', () => {
  it('⛔ the TIME RANGE comes before the approval opt-in, not after', () => {
    // It rendered after the opt-in and its three-line caveat, so the primary
    // control of a two-control panel sat below the longest paragraph on it.
    return mountQuiet(quietSnapshot(['notification'])).then(({ host }) => {
      const toggle = orderOf(host, QUIET_HOURS_TOGGLE_ATTR);
      const range = orderOf(host, QUIET_HOURS_SAVE_ATTR);
      const optIn = orderOf(host, QUIET_HOURS_APPROVAL_ATTR);
      const pointer = orderOf(host, QUIET_HOURS_APPROVAL_HINT_ATTR);
      expect(toggle).toBeGreaterThanOrEqual(0);
      expect(toggle).toBeLessThan(range);
      expect(range).toBeLessThan(optIn);
      expect(optIn).toBeLessThan(pointer);
    });
  });
});

describe('D-269 REV 18 — there is a way to the timezone from here', () => {
  it('⛔⛔ the BLOCKED state carries the link — it is the state that needs it most', async () => {
    // "Set the timezone first" with no way there is the shape of instruction
    // people give up on, and this is the one state where the feature is unusable.
    const { host } = await mountQuiet(quietSnapshot(['notification'], false));
    const blocked = one(host, QUIET_HOURS_BLOCKED_ATTR);
    const link = byAttr(blocked, QUIET_HOURS_TZ_LINK_ATTR);
    expect(link).toHaveLength(1);
    expect(link[0]!.attrs.get('href')).toBe('#settings/server');
  });

  it('⚠ and it is a LINK, never a second picker', async () => {
    // One declaration read by cron, housekeeping and the sweeps; a second place
    // to set it is a second place for it to disagree with itself.
    const { host } = await mountQuiet(quietSnapshot(['notification']));
    for (const link of byAttr(host, QUIET_HOURS_TZ_LINK_ATTR)) {
      expect(link.tagName).toBe('A');
      expect(link.attrs.get('href')).toBe('#settings/server');
    }
    expect(byAttr(host, QUIET_HOURS_TZ_LINK_ATTR).length).toBeGreaterThan(0);
  });
});

describe('D-269 REV 18 — the two rows are named for their ASYMMETRY', () => {
  it('⛔ not "server" vs "browser" — one defines the window, the other reports it', async () => {
    // To a solo self-hoster the server is not a place, it is their own machine,
    // so "server vs browser" reads as two peers to choose between.
    const { host } = await mountQuiet(quietSnapshot(['notification']));
    const rows = byAttr(host, QUIET_HOURS_ROW_ATTR).map(allText).join(' ');
    expect(rows).toContain('Recued’s clock');
    expect(rows).toContain('Where you are now');
    expect(rows).not.toContain('Server time');
    expect(rows).not.toContain('This browser');
  });

  it('⛔⛔ the fix is SUGGESTED, not instructed — being away is not a misconfiguration', async () => {
    // A server at home keeping home time while its owner is abroad is the design
    // working, per the owner's own ruling. Telling a traveller to "fix" it would
    // be telling them to break it.
    // ⚠ Driven with the clocks APART, because the sentence exists for exactly
    // that case; asserting it against agreeing clocks would test nothing and
    // pass only by accident of the copy being unconditional.
    const { host } = await mountQuiet(quietSnapshot(['notification']), 'Europe/Paris');
    const text = allText(host);
    expect(text).toContain('Quiet hours runs on Recued’s clock');
    expect(text).toContain('rather than you simply being away');
    // ⚠ Never an imperative about the zone being wrong.
    expect(text).not.toContain('your timezone is wrong');
    expect(text).not.toContain('You should change');
  });
});


describe('D-269 REV 19 — the panel says when nothing it sets can reach you', () => {
  it('⛔⛔ in-app only ⇒ it says so, and points at the panel that fixes it', async () => {
    const { host } = await mountKinds(KIND_SEED, async () => ({ rows: IN_APP_ONLY }));
    const warn = one(host, KIND_POLICY_UNREACHABLE_ATTR);
    expect(warn.textContent).toContain('waiting in Recued rather than reaching you');
    expect(warn.textContent).toContain('Turn on a channel above');
  });

  it('⛔ one reachable channel is enough to silence it', async () => {
    const { host } = await mountKinds(KIND_SEED, async () => ({ rows: REACHABLE }));
    expect(byAttr(host, KIND_POLICY_UNREACHABLE_ATTR)).toEqual([]);
  });

  it('⛔⛔ "zero channels on" would have been DEAD CODE — `ui` cannot be off', async () => {
    // `channelNotifyEnabled` hardcodes `ui` to true, so a check for an empty
    // roster could never fire. The condition is "nothing reaches you when you
    // are not looking", and a roster where only `ui` is on is exactly that.
    const { host } = await mountKinds(KIND_SEED, async () => ({
      rows: [{ channel: 'ui', notification: true }],
    }));
    expect(byAttr(host, KIND_POLICY_UNREACHABLE_ATTR)).toHaveLength(1);
  });

  it('⚠ a FAILED roster lookup says NOTHING — unknown must not look like bad', async () => {
    // A warning raised by a failed fetch sends the owner to fix a setting that
    // was never wrong, and the policy rows must still render.
    const { host, panel } = await mountKinds(KIND_SEED, async () => {
      throw new Error('offline');
    });
    expect(byAttr(host, KIND_POLICY_UNREACHABLE_ATTR)).toEqual([]);
    expect(panel.getState()).toBe('ready');
    expect(byAttr(host, KIND_POLICY_ROW_ATTR)).toHaveLength(4);
  });

  it('⚠ and no roster caller at all is silent too', async () => {
    const { host } = await mountKinds();
    expect(byAttr(host, KIND_POLICY_UNREACHABLE_ATTR)).toEqual([]);
  });
});
