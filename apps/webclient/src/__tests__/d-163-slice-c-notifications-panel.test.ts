/** D-163 Slice C — Notifications panel acceptance.
 *
 *  Drives `mountNotificationsPanel` through a fake Document — same
 *  pattern as `d-145-slice1-standing-instructions-panel.test.ts`,
 *  narrowed to the panel's two caller seams (`runDescribe` +
 *  `runSetChannel`) which the test injects as controllable fakes.
 *
 *  Covers:
 *    - construction throws when no document is available.
 *    - initial state is `loading` + paints loading copy.
 *    - `runDescribe` resolved → state `ready` + 5 rows render in order.
 *    - `runDescribe` threw → state `error` + retry button + list chip.
 *    - Retry → re-issues runDescribe + transitions through loading.
 *    - ui row uses `togglable: false` + button is disabled +
 *      `aria-disabled='true'` (spec § A.5 — Webclient cards is fixed-on).
 *    - bridge row carries the install_url link.
 *    - not-ready credential-backed row carries a static connect CTA
 *      (no `install_url` from the substrate).
 *    - Toggle click on a ready channel → row enters togglingChannels,
 *      calls runSetChannel, local row update reflects the new enabled
 *      state, button label updates.
 *    - Toggle click that returns `not_ready` → row error chip surfaces
 *      with the user-facing copy; the install / connect CTA stays
 *      visible because `ready` on the row didn't change.
 *    - Toggle click that returns `ui_fixed` → row chip surfaces (defense
 *      in depth; the button itself is disabled).
 *    - Toggle that throws on the rpc → row chip carries the error.
 *    - `refresh()` re-issues runDescribe.
 *    - `whenLoaded()` resolves after initial load.
 *    - Toggle uses `role='switch'` + `aria-checked` (not `aria-pressed`).
 *    - Re-entrant toggle returns the existing in-flight promise.
 *    - Dispose removes the wrapper from the host. */

import { describe, expect, it, vi } from 'vitest';

import type {
  NotificationChannelModeRow,
  NotificationChannelName,
  NotificationChannelToggleView,
  NotificationSetChannelResult,
  NotificationSetVerificationPhraseResult,
} from '@recued/contracts';

import {
  NOTIFICATIONS_AXIS_ATTR,
  NOTIFICATIONS_AXIS_FIXED_ATTR,
  NOTIFICATIONS_EMAIL_STEPS_ATTR,
  NOTIFICATIONS_LIST_ERROR_ATTR,
  NOTIFICATIONS_PANEL_ATTR,
  NOTIFICATIONS_PANEL_STATE_ATTR,
  NOTIFICATIONS_PHRASE_INPUT_ATTR,
  NOTIFICATIONS_PHRASE_SAVE_ATTR,
  NOTIFICATIONS_RETRY_BTN_ATTR,
  NOTIFICATIONS_ROW_ATTR,
  NOTIFICATIONS_ROW_CHANNEL_ATTR,
  NOTIFICATIONS_ROW_CONNECT_LINK_ATTR,
  NOTIFICATIONS_ROW_ERROR_ATTR,
  NOTIFICATIONS_ROW_INSTALL_LINK_ATTR,
  NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR,
  mountNotificationsPanel,
} from '../settings/notifications-panel.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (same shape as standing-instructions-panel.test.ts)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  type: string;
  classList: { add: (cls: string) => void };
  createTextNode?: (text: string) => FakeElement;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    classList: {
      add: (cls) => {
        el.className = el.className === '' ? cls : `${el.className} ${cls}`;
      },
    },
    setAttribute: (k, v) => {
      attrs.set(k, v);
    },
    removeAttribute: (k) => {
      attrs.delete(k);
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  createTextNode(text: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => ({
  createElement: (tag) => makeFakeElement(tag),
  createTextNode: (text) => {
    const node = makeFakeElement('#text');
    node.textContent = text;
    return node;
  },
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAxisToggle = (
  root: FakeElement,
  channel: NotificationChannelName,
  axis: 'notification' | 'approval',
): FakeElement | null => {
  if (
    root.getAttribute(NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR) === channel
    && root.getAttribute(NOTIFICATIONS_AXIS_ATTR) === axis
  ) return root;
  for (const child of root.children) {
    const hit = findAxisToggle(child, channel, axis);
    if (hit !== null) return hit;
  }
  return null;
};

const findRowByChannel = (
  root: FakeElement,
  channel: NotificationChannelName,
): FakeElement | null => {
  const walk = (n: FakeElement): FakeElement | null => {
    if (
      n.hasAttribute(NOTIFICATIONS_ROW_ATTR)
      && n.getAttribute(NOTIFICATIONS_ROW_CHANNEL_ATTR) === channel
    ) {
      return n;
    }
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
};

// ──────────────────────────────────────────────────────────────────
// Row builders
// ──────────────────────────────────────────────────────────────────

const uiRow: NotificationChannelToggleView = {
  channel: 'ui',
  capability: 'inline',
  notification: true,
  approval: true,
  notification_togglable: false,
  approval_togglable: false,
  ready: true,
};

const bridgeNotReadyRow: NotificationChannelToggleView = {
  channel: 'bridge',
  capability: 'notify-only',
  notification: false,
  approval: false,
  notification_togglable: true,
  approval_togglable: false,
  ready: false,
  install_url: 'https://recued.com/install/bridge',
};

const bridgeReadyRow: NotificationChannelToggleView = {
  channel: 'bridge',
  capability: 'notify-only',
  notification: false,
  approval: false,
  notification_togglable: true,
  approval_togglable: false,
  ready: true,
};

const slackNotReadyRow: NotificationChannelToggleView = {
  channel: 'slack',
  capability: 'inline',
  notification: false,
  approval: false,
  notification_togglable: true,
  approval_togglable: true,
  ready: false,
};

const telegramNotReadyRow: NotificationChannelToggleView = {
  channel: 'telegram',
  capability: 'inline',
  notification: false,
  approval: false,
  notification_togglable: true,
  approval_togglable: true,
  ready: false,
};

const emailNotReadyRow: NotificationChannelToggleView = {
  channel: 'email',
  capability: 'landing-page',
  notification: false,
  approval: false,
  notification_togglable: true,
  approval_togglable: true,
  ready: false,
};

const fiveRows: ReadonlyArray<NotificationChannelToggleView> = [
  uiRow,
  bridgeNotReadyRow,
  slackNotReadyRow,
  telegramNotReadyRow,
  emailNotReadyRow,
];

// ──────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────

describe('mountNotificationsPanel', () => {
  it('throws when neither opts.document nor globalThis.document is available', () => {
    const host = makeFakeElement('div');
    expect(() => {
      mountNotificationsPanel({
        host: host as unknown as HTMLElement,
        runDescribe: async () => ({ rows: [] }),
        runSetChannel: async () => ({
          ok: false,
          reason: 'ui_fixed',
        }),
      });
    }).toThrow(/no document available/);
  });

  it('initial state is loading; paints loading copy', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: () => new Promise(() => {}),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    expect(panel.getState()).toBe('loading');
    const root = findByAttr(host, NOTIFICATIONS_PANEL_ATTR)!;
    expect(root.getAttribute(NOTIFICATIONS_PANEL_STATE_ATTR)).toBe('loading');
  });

  it('resolves runDescribe → renders 5 rows in canonical order', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('ready');
    expect(panel.getRows().map((r) => r.channel)).toEqual([
      'ui',
      'bridge',
      'slack',
      'telegram',
      'email',
    ]);
    // 5 rendered row articles.
    for (const channel of ['ui', 'bridge', 'slack', 'telegram', 'email'] as const) {
      expect(findRowByChannel(host, channel)).not.toBeNull();
    }
  });

  it('ui row renders fixed always-on cells (non-togglable — no toggle button)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const uiRowEl = findRowByChannel(host, 'ui')!;
    // R31 — ui is the always-on floor: both axes render a fixed indicator
    // (no toggle button at all), so the always-on invariant is unbreakable
    // from the UI rather than merely a disabled switch.
    expect(findByAttr(uiRowEl, NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR)).toBeNull();
    const fixed = findByAttr(uiRowEl, NOTIFICATIONS_AXIS_FIXED_ATTR)!;
    expect(fixed).not.toBeNull();
    expect(fixed.textContent).toBe('Always on');
  });

  it('bridge not-ready row carries the install_url link', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const bridgeRow = findRowByChannel(host, 'bridge')!;
    const link = findByAttr(bridgeRow, NOTIFICATIONS_ROW_INSTALL_LINK_ATTR);
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://recued.com/install/bridge');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('credential-backed not-ready row deep-links #connections (no external install link)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const slackRow = findRowByChannel(host, 'slack')!;
    // No external install link — slack routes through the in-app route.
    expect(findByAttr(slackRow, NOTIFICATIONS_ROW_INSTALL_LINK_ATTR)).toBeNull();
    // R31 (defect #2) — the CTA is now an in-app anchor to `#connections`
    // (the stale "via Settings → Connections" text hint is gone; the
    // route graduated to the top-level `#connections`).
    const connect = findByAttr(slackRow, NOTIFICATIONS_ROW_CONNECT_LINK_ATTR);
    expect(connect).not.toBeNull();
    expect(connect!.getAttribute('href')).toBe('#connections');
    expect(connect!.textContent).toBe('Connect in Connections');
  });

  it('email not-ready row stays with a 3-step setup guide whose first step links #connections', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const emailRow = findRowByChannel(host, 'email')!;
    // R31 (defect #1) — the email row is NOT hidden; it carries the
    // 3-step instruction (Path-A wiring is a follow-on slice).
    const steps = findByAttr(emailRow, NOTIFICATIONS_EMAIL_STEPS_ATTR);
    expect(steps).not.toBeNull();
    expect(steps!.children.length).toBe(3);
    // Step ① deep-links Connections (the mail-enroll home).
    const step1Link = findByAttr(steps!, NOTIFICATIONS_ROW_CONNECT_LINK_ATTR);
    expect(step1Link).not.toBeNull();
    expect(step1Link!.getAttribute('href')).toBe('#connections');
  });

  it('capability badges read as delivery + render three distinct tones (R31 defect #3)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const badge = (channel: NotificationChannelName): FakeElement => {
      const row = findRowByChannel(host, channel)!;
      // The capability badge is the header span carrying the tone class.
      const walk = (n: FakeElement): FakeElement | null => {
        if (n.className.includes('notif-row-capability')) return n;
        for (const c of n.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(row)!;
    };
    // Delivery-language copy, not the pre-R31 "…approvals" wording.
    expect(badge('slack').textContent).toBe('Answer here'); // inline
    expect(badge('email').textContent).toBe('Answer via link'); // landing-page
    expect(badge('bridge').textContent).toBe('Notify only'); // notify-only
    // Three DISTINCT tone classes — pre-R31 inline + landing-page shared
    // the identical filled accent pill.
    expect(badge('slack').className).toContain('notif-row-capability-inline');
    expect(badge('email').className).toContain(
      'notif-row-capability-landing-page',
    );
    expect(badge('bridge').className).toContain(
      'notif-row-capability-notify-only',
    );
  });

  it('toggle click on ready channel calls runSetChannel + updates the row axis state', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setChannel = vi.fn(
      async (args: {
        channel: NotificationChannelName;
        patch: Partial<NotificationChannelModeRow>;
      }) =>
        ({
          ok: true,
          settings: {
            ui: true,
            bridge:
              args.channel === 'bridge'
                ? args.patch.notification ?? false
                : false,
            slack: { notification: false, approval: false, messenger: false },
            telegram: { notification: false, approval: false, messenger: false },
            whatsapp: { notification: false, approval: false, messenger: false },
            discord: { notification: false, approval: false, messenger: false },
            email: { notification: false, approval: false, messenger: false },
          },
        }) satisfies NotificationSetChannelResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [
          uiRow,
          bridgeReadyRow,
          slackNotReadyRow,
          telegramNotReadyRow,
          emailNotReadyRow,
        ],
      }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    await panel.clickAxis('bridge', 'notification');
    expect(setChannel).toHaveBeenCalledWith({
      channel: 'bridge',
      patch: { notification: true },
    });
    const updated = panel.getRows().find((r) => r.channel === 'bridge');
    expect(updated?.notification).toBe(true);
    expect(panel.getTogglingAxes().has('bridge::notification')).toBe(false);
    expect(panel.getRowError('bridge')).toBeUndefined();
  });

  it('R31 — a ready inline channel sends an approval-axis patch (independent of notify)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const slackReadyRow: NotificationChannelToggleView = {
      ...slackNotReadyRow,
      ready: true,
    };
    const setChannel = vi.fn(
      async (args: {
        channel: NotificationChannelName;
        patch: Partial<NotificationChannelModeRow>;
      }) =>
        ({
          ok: true,
          settings: {
            ui: true,
            bridge: false,
            slack: {
              notification: args.patch.notification ?? false,
              approval: args.patch.approval ?? false,
              messenger: false,
            },
            telegram: { notification: false, approval: false, messenger: false },
            whatsapp: { notification: false, approval: false, messenger: false },
            discord: { notification: false, approval: false, messenger: false },
            email: { notification: false, approval: false, messenger: false },
          },
        }) satisfies NotificationSetChannelResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: [uiRow, slackReadyRow] }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    await panel.clickAxis('slack', 'approval');
    expect(setChannel).toHaveBeenCalledWith({
      channel: 'slack',
      patch: { approval: true },
    });
    const updated = panel.getRows().find((r) => r.channel === 'slack');
    expect(updated?.approval).toBe(true);
    // Toggling approval leaves the notification axis untouched.
    expect(updated?.notification).toBe(false);
  });

  it('R31 — notify-only bridge: notification cell toggles, approval cell is a fixed non-toggle', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setChannel = vi.fn(
      async () =>
        ({
          ok: true,
          settings: {
            ui: true,
            bridge: true,
            slack: { notification: false, approval: false, messenger: false },
            telegram: { notification: false, approval: false, messenger: false },
            whatsapp: { notification: false, approval: false, messenger: false },
            discord: { notification: false, approval: false, messenger: false },
            email: { notification: false, approval: false, messenger: false },
          },
        }) satisfies NotificationSetChannelResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: [uiRow, bridgeReadyRow] }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    // The approval axis on a notify-only channel has no toggle button —
    // clicking it is a no-op (defense against `approval_unsupported`).
    await panel.clickAxis('bridge', 'approval');
    expect(setChannel).not.toHaveBeenCalled();
    // The notification axis IS a toggle.
    await panel.clickAxis('bridge', 'notification');
    expect(setChannel).toHaveBeenCalledWith({
      channel: 'bridge',
      patch: { notification: true },
    });
    // The bridge row renders a fixed approval indicator, not a switch.
    const bridgeRowEl = findRowByChannel(host, 'bridge')!;
    const fixed = findByAttr(bridgeRowEl, NOTIFICATIONS_AXIS_FIXED_ATTR);
    expect(fixed).not.toBeNull();
    expect(fixed!.getAttribute(NOTIFICATIONS_AXIS_ATTR)).toBe('approval');
  });

  it('R31 — verification phrase seeds from describe + saves via the caller', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setPhrase = vi.fn(
      async (args: { phrase: string | null }) =>
        ({
          ok: true,
          settings: {
            ui: true,
            bridge: false,
            slack: { notification: false, approval: false, messenger: false },
            telegram: { notification: false, approval: false, messenger: false },
            whatsapp: { notification: false, approval: false, messenger: false },
            discord: { notification: false, approval: false, messenger: false },
            email: { notification: false, approval: false, messenger: false },
            ...(args.phrase !== null
              ? { verification_phrase: args.phrase }
              : {}),
          },
        }) satisfies NotificationSetVerificationPhraseResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [uiRow],
        verification_phrase: 'purple otter',
      }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runSetVerificationPhrase: setPhrase,
    });
    await panel.whenLoaded();
    // Seeded from the describe response.
    expect(panel.getVerificationPhrase()).toBe('purple otter');
    expect(panel.hasUnsavedChanges()).toBe(false);

    const phraseInput = findByAttr(host, NOTIFICATIONS_PHRASE_INPUT_ATTR)!;
    for (const listener of phraseInput.listeners.get('input') ?? []) {
      listener({ target: { value: 'local draft' } });
    }
    expect(panel.hasUnsavedChanges()).toBe(true);
    for (const listener of phraseInput.listeners.get('input') ?? []) {
      listener({ target: { value: 'purple otter' } });
    }
    expect(panel.hasUnsavedChanges()).toBe(false);

    // Saving persists via the caller + reflects the confirmed value.
    await panel.savePhrase('green fox');
    expect(setPhrase).toHaveBeenCalledWith({ phrase: 'green fox' });
    expect(panel.getVerificationPhrase()).toBe('green fox');
    expect(panel.getPhraseError()).toBeUndefined();
  });

  it('R31 — an over-long verification phrase surfaces the too_long error', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setPhrase = vi.fn(
      async () =>
        ({
          ok: false,
          reason: 'too_long',
          max: 80,
        }) satisfies NotificationSetVerificationPhraseResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: [uiRow] }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runSetVerificationPhrase: setPhrase,
    });
    await panel.whenLoaded();
    await panel.savePhrase('x'.repeat(200));
    expect(panel.getPhraseError()).toMatch(/80/);
  });

  it('keeps phrase Save focusable and single-flight while persisting', async () => {
    const host = makeFakeElement('div');
    const dispatch: {
      resolve: (result: NotificationSetVerificationPhraseResult) => void;
    } = { resolve: () => undefined };
    const setPhrase = vi.fn(() =>
      new Promise<NotificationSetVerificationPhraseResult>((resolve) => {
        dispatch.resolve = resolve;
      }));
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: [uiRow] }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runSetVerificationPhrase: setPhrase,
    });
    await panel.whenLoaded();

    const first = panel.savePhrase('green fox');
    expect(panel.hasInFlightWork()).toBe(true);
    const busy = findByAttr(host, NOTIFICATIONS_PHRASE_SAVE_ATTR);
    expect(busy?.disabled).toBe(false);
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    const second = panel.savePhrase('ignored duplicate');
    expect(setPhrase).toHaveBeenCalledTimes(1);

    dispatch.resolve({
      ok: true,
      settings: {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        verification_phrase: 'green fox',
      },
    });
    await Promise.all([first, second]);
    expect(panel.hasInFlightWork()).toBe(false);
    expect(panel.getVerificationPhrase()).toBe('green fox');
  });

  it('R31 — a success on one axis does not clear a failure on the other axis of the same row', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const slackReadyRow: NotificationChannelToggleView = {
      ...slackNotReadyRow,
      ready: true,
    };
    // approval patch fails (not_ready); notification patch succeeds.
    const setChannel = vi.fn(
      async (args: {
        channel: NotificationChannelName;
        patch: Partial<NotificationChannelModeRow>;
      }) => {
        if (args.patch.approval !== undefined) {
          return {
            ok: false,
            reason: 'not_ready',
            channel: 'slack',
          } satisfies NotificationSetChannelResult;
        }
        return {
          ok: true,
          settings: {
            ui: true,
            bridge: false,
            slack: {
              notification: args.patch.notification ?? false,
              approval: false,
              messenger: false,
            },
            telegram: { notification: false, approval: false, messenger: false },
            whatsapp: { notification: false, approval: false, messenger: false },
            discord: { notification: false, approval: false, messenger: false },
            email: { notification: false, approval: false, messenger: false },
          },
        } satisfies NotificationSetChannelResult;
      },
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: [uiRow, slackReadyRow] }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    // Approval toggle fails → the row surfaces the not-ready error.
    await panel.clickAxis('slack', 'approval');
    expect(panel.getRowError('slack')).toBeDefined();
    // A subsequent SUCCESS on the notification axis must NOT clear the
    // approval axis's failure (axis-keyed errors — codex MEDIUM fold).
    await panel.clickAxis('slack', 'notification');
    expect(panel.getRowError('slack')).toBeDefined();
  });

  it('toggle returning ok:false not_ready surfaces an inline chip', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setChannel = vi.fn(
      async () =>
        ({
          ok: false,
          reason: 'not_ready',
          channel: 'bridge',
        }) satisfies NotificationSetChannelResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    await panel.clickAxis('bridge', 'notification');
    const err = panel.getRowError('bridge');
    expect(err).toBeDefined();
    expect(err).toMatch(/Not set up yet/);
    // After the chip surfaces, the row's notification axis is unchanged
    const bridge = panel.getRows().find((r) => r.channel === 'bridge');
    expect(bridge?.notification).toBe(false);
  });

  it('toggle returning ok:false ui_fixed surfaces a defense-in-depth chip', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const setChannel = vi.fn(
      async () =>
        ({ ok: false, reason: 'ui_fixed' }) satisfies NotificationSetChannelResult,
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    // The ui row's toggle button is disabled, so a UI click won't fire
    // setChannel. Drive it via a non-ui channel that the test forces to
    // return ui_fixed (defense-in-depth path).
    await panel.clickAxis('bridge', 'notification');
    expect(panel.getRowError('bridge')).toMatch(/always on/);
  });

  it('rpc throw surfaces row chip with the error message', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [
          uiRow,
          bridgeReadyRow,
          slackNotReadyRow,
          telegramNotReadyRow,
          emailNotReadyRow,
        ],
      }),
      runSetChannel: async () => {
        throw new Error('network drop');
      },
    });
    await panel.whenLoaded();
    await panel.clickAxis('bridge', 'notification');
    expect(panel.getRowError('bridge')).toBe('network drop');
  });

  it('runDescribe throw transitions to error + paints chip + retry recovers', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let attempt = 0;
    const retryDispatch: {
      resolve: (result: { rows: ReadonlyArray<NotificationChannelToggleView> }) => void;
    } = { resolve: () => undefined };
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return new Promise((resolve) => {
          retryDispatch.resolve = resolve;
        });
      },
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('error');
    const chip = findByAttr(host, NOTIFICATIONS_LIST_ERROR_ATTR)!;
    expect(chip.textContent).toBe('boom');
    expect(findByAttr(host, NOTIFICATIONS_RETRY_BTN_ATTR)).not.toBeNull();

    panel.clickRetry();
    expect(panel.getState()).toBe('loading');
    const busyRetry = findByAttr(host, NOTIFICATIONS_RETRY_BTN_ATTR);
    expect(busyRetry?.textContent).toBe('Retrying…');
    expect(busyRetry?.disabled).toBe(false);
    expect(busyRetry?.getAttribute('aria-disabled')).toBe('true');
    expect(busyRetry?.getAttribute('aria-busy')).toBe('true');
    panel.clickRetry();
    expect(attempt).toBe(2);
    retryDispatch.resolve({ rows: fiveRows });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('ready');
    expect(panel.getRows()).toHaveLength(5);
  });

  it('refresh() re-issues runDescribe', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const describe = vi.fn(async () => ({ rows: fiveRows }));
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: describe,
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    expect(describe).toHaveBeenCalledTimes(1);
    panel.refresh();
    await panel.whenLoaded();
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('dispose removes the wrapper from the host', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({ rows: fiveRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    expect(host.children).toHaveLength(1);
    panel.dispose();
    expect(host.children).toHaveLength(0);
    // Idempotent.
    panel.dispose();
    expect(host.children).toHaveLength(0);
  });

  it('re-entrant toggle returns the existing in-flight promise (no duplicate rpc)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    // Deferred-promise pattern — the synchronous mutation inside the
    // Promise constructor doesn't survive TypeScript's flow analysis at
    // the `resolveSetChannel?.(…)` call site, so the dispatch holder
    // gets a single-property object the type system can see through.
    const dispatch: { resolve: (r: NotificationSetChannelResult) => void } = {
      resolve: () => undefined,
    };
    const setChannel = vi.fn(
      () =>
        new Promise<NotificationSetChannelResult>((resolve) => {
          dispatch.resolve = resolve;
        }),
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [
          uiRow,
          bridgeReadyRow,
          slackNotReadyRow,
          telegramNotReadyRow,
          emailNotReadyRow,
        ],
      }),
      runSetChannel: setChannel,
    });
    await panel.whenLoaded();
    const first = panel.clickAxis('bridge', 'notification');
    expect(panel.hasInFlightWork()).toBe(true);
    const busy = findAxisToggle(host, 'bridge', 'notification');
    expect(busy?.disabled).toBe(false);
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    // The replacement stays focusable; its handler and the pending-promise
    // map remain the single-flight authority for a second activation.
    const second = panel.clickAxis('bridge', 'notification');
    dispatch.resolve({
      ok: true,
      settings: {
        ui: true,
        bridge: true,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
      },
    });
    await Promise.all([first, second]);
    expect(panel.hasInFlightWork()).toBe(false);
    expect(setChannel).toHaveBeenCalledTimes(1);
  });

  it('toggle button uses role=switch + aria-checked (not aria-pressed)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [
          uiRow,
          bridgeReadyRow,
          slackNotReadyRow,
          telegramNotReadyRow,
          emailNotReadyRow,
        ],
      }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    });
    await panel.whenLoaded();
    const bridgeBtn = findByAttr(
      findRowByChannel(host, 'bridge')!,
      NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR,
    )!;
    expect(bridgeBtn.getAttribute('role')).toBe('switch');
    expect(bridgeBtn.getAttribute('aria-checked')).toBe('false');
    expect(bridgeBtn.getAttribute('aria-pressed')).toBeNull();
  });

  it('row error chip carries role=alert for screen reader announcement', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runDescribe: async () => ({
        rows: [
          uiRow,
          bridgeReadyRow,
          slackNotReadyRow,
          telegramNotReadyRow,
          emailNotReadyRow,
        ],
      }),
      runSetChannel: async () => ({
        ok: false,
        reason: 'not_ready',
        channel: 'bridge',
      }),
    });
    await panel.whenLoaded();
    await panel.clickAxis('bridge', 'notification');
    const chip = findByAttr(host, NOTIFICATIONS_ROW_ERROR_ATTR);
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('role')).toBe('alert');
  });
});
