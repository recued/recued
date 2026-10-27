/** D-318 step 7 — Settings → Email chat (`settings/mail-chat-door-panel.ts`):
 *  switching the email chat door on, its settings, and the test round trip.
 *
 *  ⛔ THESE TESTS DRIVE THE CONTROLS AND READ WHAT WENT OUT ON THE WIRE. A panel
 *  that renders its fields proves nothing about the door: what matters is that
 *  switching on asks the server's checks first and saves only past them, that
 *  the owner's confirmation gates it, and that the round trip reads each
 *  request as the door saw it. And the route test proves the reach: a panel no
 *  route mounts is a setting the owner cannot open.
 *
 *  Step 8 — the addresses Recued does not read: added with a code the panel
 *  shows, watched until the code's email settles them, and a door with none of
 *  the owner's mailboxes named, for them alone. */

import { describe, expect, it, vi } from 'vitest';
import {
  MAIL_CHAT_DOOR_DEFAULTS,
  MAIL_CHAT_ENROL_CODE_TTL_MS,
  type MailChatDoorCheckResult,
  type MailChatDoorRecentRequest,
  type MailChatDoorSettings,
  type MailChatEnrolledSender,
} from '@recued/contracts';

import {
  MAIL_CHAT_DOOR_CHAT_PICK_ATTR,
  MAIL_CHAT_DOOR_CHECK_ATTR,
  MAIL_CHAT_DOOR_CHECK_STATUS_ATTR,
  MAIL_CHAT_DOOR_CONFIRM_ATTR,
  MAIL_CHAT_DOOR_DISCLOSURE_ATTR,
  MAIL_CHAT_DOOR_ENROL_ADD_ATTR,
  MAIL_CHAT_DOOR_ENROL_ATTR,
  MAIL_CHAT_DOOR_ENROL_CODE_ATTR,
  MAIL_CHAT_DOOR_ENROL_INPUT_ATTR,
  MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR,
  MAIL_CHAT_DOOR_ENROL_RETRY_ATTR,
  MAIL_CHAT_DOOR_ENROL_SENDER_ATTR,
  MAIL_CHAT_DOOR_ENROL_STATE_ATTR,
  MAIL_CHAT_DOOR_ERROR_ATTR,
  MAIL_CHAT_DOOR_RETRY_ATTR,
  MAIL_CHAT_DOOR_OWNER_PICK_ATTR,
  MAIL_CHAT_DOOR_PANEL_ATTR,
  MAIL_CHAT_DOOR_PAUSED_ATTR,
  MAIL_CHAT_DOOR_PREFIX_ATTR,
  MAIL_CHAT_DOOR_PREFIX_ON_ATTR,
  MAIL_CHAT_DOOR_RECENT_ATTR,
  MAIL_CHAT_DOOR_RESUME_ATTR,
  MAIL_CHAT_DOOR_SAVE_ATTR,
  MAIL_CHAT_DOOR_STALE_ATTR,
  MAIL_CHAT_DOOR_STATE_ATTR,
  MAIL_CHAT_DOOR_TEST_ATTR,
  MAIL_CHAT_DOOR_TEST_HINT_MS,
  MAIL_CHAT_DOOR_TEST_START_ATTR,
  MAIL_CHAT_DOOR_TEST_STEP_ATTR,
  MAIL_CHAT_DOOR_TURN_OFF_ATTR,
  MAIL_CHAT_DOOR_TURN_OFF_CONFIRM_ATTR,
  MAIL_CHAT_DOOR_TURN_ON_ATTR,
  mountMailChatDoorPanel,
  type MailChatDoorMailboxRow,
  type MailChatDoorSetArgs,
} from '../settings/mail-chat-door-panel.js';
import {
  bootstrapSettingsRoute,
  SETTINGS_ROUTE_NAV_ITEM_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
  SETTINGS_ROUTE_STYLES_MARKER,
} from '../settings/bootstrap-settings-route.js';
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
  className: string;
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
    textContent: '', type: '', value: '', className: '',
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
      // A real browser fires no `change` on a disabled control.
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

/** The route appends a `<style>` tag, so its boot needs a `head`. */
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
  expect(hits, `${attr}${value === undefined ? '' : `=${value}`}`).toHaveLength(1);
  return hits[0]!;
};
const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(allText)].filter((text) => text !== '').join(' ');
/** Every await the panel chains settles within a macrotask; its own timers are fake. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const CHAT = 'recued-chat';
const MAILBOXES: MailChatDoorMailboxRow[] = [
  { slug: 'smtp-only', adapter_type: 'smtp', account_email: 'hello@example.test', send_capable: true },
  { slug: CHAT, adapter_type: 'imap', account_email: 'recued@chat.example', send_capable: true },
  { slug: 'me', adapter_type: 'imap', account_email: 'me@owner.example', send_capable: true },
  { slug: 'archive', adapter_type: 'imap', account_email: 'archive@owner.example', send_capable: false },
];
const OFF: MailChatDoorSettings = { ...MAIL_CHAT_DOOR_DEFAULTS };
const ON: MailChatDoorSettings = {
  ...MAIL_CHAT_DOOR_DEFAULTS, chat_mailbox: CHAT, chat_address: 'recued@chat.example', owner_mailboxes: ['me'],
};
const AT = Date.UTC(2026, 9, 14, 9, 31, 0);
const request = (over: Partial<MailChatDoorRecentRequest> = {}): MailChatDoorRecentRequest => ({
  arrived_at: AT, from: 'me@owner.example', state: 'pending', proof: null, reason: null, chat: null, chat_reason: null,
  sender_auth: 'unknown', answer: null, answered_at: null, ...over,
});
/** Step 8 — an address, as the server lists it. */
const ME = 'me@personal.example';
const sender = (over: Partial<MailChatEnrolledSender> = {}): MailChatEnrolledSender => ({
  address: ME, state: 'pending', chat_mailbox: CHAT, code: '482913', expires_at: AT + MAIL_CHAT_ENROL_CODE_TTL_MS,
  attempts: 0, added_at: AT, confirmed_at: null, checked_by: null, failure: null, ...over,
});

const mount = (options: {
  settings?: MailChatDoorSettings;
  check?: MailChatDoorCheckResult;
  recent?: () => MailChatDoorRecentRequest[];
} = {}) => {
  const host = makeFakeElement('div');
  let current = options.settings ?? OFF;
  const sets: MailChatDoorSetArgs[] = [];
  const timers: Array<() => void> = [];
  let clock = AT;
  const runSet = vi.fn(async (args: MailChatDoorSetArgs) => {
    sets.push(args);
    current = {
      ...current,
      ...(args.chat_mailbox !== undefined
        ? { chat_mailbox: args.chat_mailbox, chat_address: args.chat_mailbox === null ? null : 'recued@chat.example' }
        : {}),
      ...(args.owner_mailboxes !== undefined ? { owner_mailboxes: [...args.owner_mailboxes] } : {}),
      ...(args.ask_prefix !== undefined ? { ask_prefix: args.ask_prefix } : {}),
      ...(args.stale_after_minutes !== undefined ? { stale_after_minutes: args.stale_after_minutes } : {}),
      ...(args.resume === true ? { paused_at: null } : {}),
      ...(args.unenroll !== undefined
        ? { enrolled_senders: current.enrolled_senders.filter((entry) => entry.address !== args.unenroll) }
        : {}),
      ...(args.enroll !== undefined
        ? {
            enrolled_senders: [
              ...current.enrolled_senders.filter((entry) => entry.address !== args.enroll),
              sender({ address: args.enroll, added_at: clock, expires_at: clock + MAIL_CHAT_ENROL_CODE_TTL_MS }),
            ],
          }
        : {}),
    };
    return current;
  });
  const runGet = vi.fn(async () => current);
  const runCheck = vi.fn(async () => options.check ?? { ready: true, checks: [] });
  const runRecent = vi.fn(async () => ({ requests: options.recent?.() ?? [] }));
  const panel = mountMailChatDoorPanel({
    host: host as unknown as HTMLElement,
    document: fakeDocument,
    runGet,
    runSet,
    runCheck,
    runRecent,
    runListMailboxes: async () => ({ instances: MAILBOXES }),
    now: () => clock,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => undefined,
    locale: 'en-GB',
    timeZone: 'UTC',
  });
  return {
    host, panel, sets, runSet, runCheck, runRecent, runGet,
    /** What the server holds from now: an email arriving, say. */
    serve: (next: (settings: MailChatDoorSettings) => MailChatDoorSettings) => { current = next(current); },
    /** Fire the timer set last, as the clock moves on. */
    tick: async (ms = 3_000) => {
      clock += ms;
      const fn = timers.pop();
      expect(fn, 'a timer was set').toBeDefined();
      fn!();
      await flush();
    },
    timers,
  };
};

const pickChat = (host: FakeEl, slug: string): void => {
  const select = one(host, MAIL_CHAT_DOOR_CHAT_PICK_ATTR);
  select.value = slug;
  select.dispatchEvent({ type: 'change' });
};

describe('Email chat read recovery', () => {
  const setup = (failure?: 'settings' | 'mailboxes', heldGet?: Promise<MailChatDoorSettings>) => {
    const host = makeFakeElement('div');
    const get = vi.fn(() => Promise.resolve(OFF));
    const list = vi.fn(() => Promise.resolve({ instances: MAILBOXES }));
    if (heldGet) get.mockReturnValueOnce(heldGet);
    if (failure === 'settings') get.mockImplementationOnce(() => { throw new Error('Settings unavailable.'); });
    if (failure === 'mailboxes') list.mockImplementationOnce(() => { throw new Error('Mailboxes unavailable.'); });
    const set = vi.fn(async () => OFF);
    const check = vi.fn(async () => ({ ready: true, checks: [] }));
    const recent = vi.fn(async () => ({ requests: [] }));
    const panel = mountMailChatDoorPanel({
      host: host as unknown as HTMLElement, document: fakeDocument,
      runGet: get, runListMailboxes: list, runSet: set, runCheck: check, runRecent: recent,
    });
    return { host, panel, get, list, set, check, recent };
  };

  for (const failure of ['settings', 'mailboxes'] as const) {
    it(`retries a failed ${failure} read without writes or overlapping reads`, async () => {
      const f = setup(failure);
      await flush();
      expect(f.panel.getState()).toBe('error');
      expect(one(f.host, MAIL_CHAT_DOOR_ERROR_ATTR).getAttribute('role')).toBe('alert');
      let settingsDone!: (value: MailChatDoorSettings) => void;
      let mailboxesDone!: (value: { instances: MailChatDoorMailboxRow[] }) => void;
      f.get.mockReturnValueOnce(new Promise(resolve => { settingsDone = resolve; }));
      f.list.mockReturnValueOnce(new Promise(resolve => { mailboxesDone = resolve; }));
      one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR).click();
      const joined = f.panel.refresh();
      await flush();
      const retry = one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR);
      expect(retry.textContent).toBe('Retrying…');
      expect(retry.disabled).toBe(false);
      expect(retry.getAttribute('aria-disabled')).toBe('true');
      expect(retry.getAttribute('aria-busy')).toBe('true');
      retry.click(); retry.click();
      settingsDone(OFF);
      await flush();
      void f.panel.refresh();
      expect(f.panel.getState()).toBe('loading');
      expect(f.get).toHaveBeenCalledTimes(2);
      expect(f.list).toHaveBeenCalledTimes(2);
      mailboxesDone({ instances: MAILBOXES });
      await joined;
      expect(f.panel.getState()).toBe('ready');
      expect(byAttr(f.host, MAIL_CHAT_DOOR_RETRY_ATTR)).toHaveLength(0);
      expect(byAttr(f.host, MAIL_CHAT_DOOR_CHAT_PICK_ATTR)).toHaveLength(1);
      expect(f.set).not.toHaveBeenCalled();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.recent).not.toHaveBeenCalled();
    });
  }

  it('keeps a failed read batch owned until its other read settles, then permits another retry', async () => {
    const f = setup('settings');
    await flush();
    f.get.mockRejectedValueOnce(new Error('Still unavailable.'));
    let mailboxesDone!: (value: { instances: MailChatDoorMailboxRow[] }) => void;
    f.list.mockReturnValueOnce(new Promise(resolve => { mailboxesDone = resolve; }));
    one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR).click();
    await flush();
    one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR).click();
    const joined = f.panel.refresh();
    await flush();
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.panel.getState()).toBe('loading');
    mailboxesDone({ instances: MAILBOXES });
    await joined;
    expect(f.panel.getState()).toBe('error');
    expect(f.panel.getError()).toBe('Still unavailable.');
    expect(one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR).getAttribute('aria-busy')).toBeNull();
    one(f.host, MAIL_CHAT_DOOR_RETRY_ATTR).click();
    await f.panel.refresh();
    expect(f.panel.getState()).toBe('ready');
    expect(f.get).toHaveBeenCalledTimes(3);
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
  });

  it('drops a pending read after disposal and starts no more reads', async () => {
    let settingsDone!: (value: MailChatDoorSettings) => void;
    const f = setup(undefined, new Promise(resolve => { settingsDone = resolve; }));
    const pending = f.panel.refresh();
    await flush();
    const text = allText(f.host);
    f.panel.dispose();
    settingsDone(OFF);
    await pending;
    await f.panel.refresh();
    expect(f.panel.getState()).toBe('loading');
    expect(allText(f.host)).toBe(text);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
  });
});

describe('switching the email chat on', () => {
  it('offers as the chat mailbox only one that can send, and it among yours too — writing to yourself', async () => {
    const h = mount();
    await flush();
    expect(h.host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('off');
    const options = one(h.host, MAIL_CHAT_DOOR_CHAT_PICK_ATTR).children;
    expect(options.map((option) => [option.value, option.disabled])).toEqual([
      ['', false], [CHAT, false], ['me', false], ['archive', true],
    ]);
    expect(options[3]!.textContent).toBe('archive@owner.example (cannot send)');
    pickChat(h.host, CHAT);
    expect(byAttr(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR).map((box) => box.getAttribute(MAIL_CHAT_DOOR_OWNER_PICK_ATTR)))
      .toEqual([CHAT, 'me', 'archive']);
    // §8.18 — the chat mailbox is offered as one of yours, said for what it means.
    expect(allText(one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, CHAT).parent!).trim())
      .toBe('recued@chat.example (the chat mailbox: you write to yourself)');
    expect(allText(h.host)).not.toContain('You write to yourself at');
  });

  it('§8.18 — one mailbox: the chat mailbox ticked as yours, checked and saved, and on to write to yourself', async () => {
    const h = mount();
    await flush();
    pickChat(h.host, CHAT);
    one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, CHAT).dispatchEvent({ type: 'change' });
    expect(allText(h.host)).toContain('You write to yourself at recued@chat.example. Only an email to that address alone');
    // P20 still: only they send from it.
    expect(one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR).disabled).toBe(true);
    one(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR).dispatchEvent({ type: 'change' });
    one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR).click();
    await flush();
    expect(h.runCheck).toHaveBeenCalledWith({ chat_mailbox: CHAT, owner_mailboxes: [CHAT] });
    expect(h.sets).toEqual([{ chat_mailbox: CHAT, owner_mailboxes: [CHAT] }]);
    expect(allText(h.host)).toContain('Email chat is on. Write to yourself at recued@chat.example.');
    expect(allText(h.host)).toContain('Send an email to yourself, recued@chat.example, with the subject');
  });

  it('§8.18 — one mailbox keeps the prefix on: no control turns it off, and Save never sends none', async () => {
    const h = mount({ settings: { ...ON, owner_mailboxes: [CHAT, 'me'] } });
    await flush();
    expect(allText(h.host)).toContain('Email chat is on. Write to recued@chat.example from itself or me@owner.example.');
    const prefixOn = one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR);
    expect(prefixOn.checked).toBe(true);
    expect(prefixOn.disabled).toBe(true);
    expect(allText(h.host)).toContain('You write to yourself, so the prefix stays on');
    // Even unticked from outside the control, Save sends the prefix.
    prefixOn.checked = false;
    one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value = 'recued:';
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ ask_prefix: 'recued:', stale_after_minutes: 60 }]);
    one(h.host, MAIL_CHAT_DOOR_TURN_OFF_ATTR).click();
    expect(allText(h.host)).toContain(
      'Turn off email chat? Recued stops answering the emails you write to yourself at recued@chat.example.');
  });

  it('⛔ stays off until the owner confirms only they send from their mailboxes, and says where answers are kept', async () => {
    const h = mount();
    await flush();
    const turnOn = () => one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR);
    expect(turnOn().disabled).toBe(true);
    pickChat(h.host, CHAT);
    // Step 8 — none of theirs picked is a door for addresses added later.
    expect(turnOn().disabled).toBe(false);
    expect(byAttr(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR)).toEqual([]);
    one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, 'me').dispatchEvent({ type: 'change' });
    expect(turnOn().disabled).toBe(true);
    expect(allText(h.host)).toContain('Only I send email from these mailboxes');
    one(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR).dispatchEvent({ type: 'change' });
    expect(turnOn().disabled).toBe(false);
    // P21, before it is switched on.
    expect(one(h.host, MAIL_CHAT_DOOR_DISCLOSURE_ATTR).textContent)
      .toMatch(/stays in the chat mailbox’s Sent folder and in your inbox, at those mail providers/);
    // Unticked again, it is off again.
    one(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR).dispatchEvent({ type: 'change' });
    expect(turnOn().disabled).toBe(true);
    expect(h.runCheck).not.toHaveBeenCalled();
  });

  it('checks first, saves past the checks, and starts watching for the test email', async () => {
    const h = mount();
    await flush();
    pickChat(h.host, CHAT);
    one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, 'me').dispatchEvent({ type: 'change' });
    one(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR).dispatchEvent({ type: 'change' });
    one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR).click();
    await flush();
    expect(h.runCheck).toHaveBeenCalledWith({ chat_mailbox: CHAT, owner_mailboxes: ['me'] });
    expect(h.sets).toEqual([{ chat_mailbox: CHAT, owner_mailboxes: ['me'] }]);
    expect(h.host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('on');
    expect(allText(h.host)).toContain('Email chat is on. Write to recued@chat.example from me@owner.example.');
    expect(allText(h.host)).toContain('send an email to recued@chat.example with the subject');
    expect(byAttr(h.host, MAIL_CHAT_DOOR_TEST_ATTR).flatMap((section) => allText(section).match(/\bask: ping\b/g) ?? []))
      .toEqual(['ask: ping']);
    expect(allText(h.host)).toContain('Waiting for your email…');
    expect(h.timers).toHaveLength(1);
  });

  it('a check that fails keeps it off and says what to fix', async () => {
    const h = mount({
      check: {
        ready: false,
        checks: [
          { kind: 'chat_mailbox', slug: CHAT, status: 'pass', text: 'It can send, and its first sync is done.' },
          { kind: 'owner_mailbox', slug: 'me', status: 'fail', text: 'Recued cannot look in its Sent folder.' },
        ],
      },
    });
    await flush();
    pickChat(h.host, CHAT);
    one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, 'me').dispatchEvent({ type: 'change' });
    one(h.host, MAIL_CHAT_DOOR_CONFIRM_ATTR).dispatchEvent({ type: 'change' });
    one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR).click();
    await flush();
    expect(h.runSet).not.toHaveBeenCalled();
    expect(h.host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('off');
    expect(one(h.host, MAIL_CHAT_DOOR_CHECK_ATTR, 'me').getAttribute(MAIL_CHAT_DOOR_CHECK_STATUS_ATTR)).toBe('fail');
    expect(allText(h.host)).toContain('✗ me@owner.example: Recued cannot look in its Sent folder.');
    expect(allText(h.host)).toContain('Email chat is still off. Fix what is marked ✗, then try again.');
  });

  it('against a server from before the door, says to update rather than showing a broken form', async () => {
    const host = makeFakeElement('div');
    mountMailChatDoorPanel({
      host: host as unknown as HTMLElement,
      document: fakeDocument,
      runGet: async () => undefined as unknown as MailChatDoorSettings,
      runSet: async () => OFF,
      runCheck: async () => ({ ready: true, checks: [] }),
      runRecent: async () => ({ requests: [] }),
      runListMailboxes: async () => ({ instances: MAILBOXES }),
    });
    await flush();
    expect(host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('error');
    expect(one(host, MAIL_CHAT_DOOR_ERROR_ATTR).textContent)
      .toBe('This server does not have email chat yet. Update Recued to use it.');
    expect(byAttr(host, MAIL_CHAT_DOOR_CHAT_PICK_ATTR)).toEqual([]);
  });

  it('starts with the owner’s mailboxes already named ticked', async () => {
    const h = mount({ settings: { ...OFF, owner_mailboxes: ['me'] } });
    await flush();
    expect(one(h.host, MAIL_CHAT_DOOR_OWNER_PICK_ATTR, 'me').checked).toBe(true);
  });
});

describe('the email chat, switched on', () => {
  it('resumes after the burst guard paused it', async () => {
    const h = mount({ settings: { ...ON, paused_at: AT } });
    await flush();
    expect(allText(one(h.host, MAIL_CHAT_DOOR_PAUSED_ATTR))).toMatch(/^Paused since 09:31: more than 10 of your emails/);
    one(h.host, MAIL_CHAT_DOOR_RESUME_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ resume: true }]);
    expect(byAttr(h.host, MAIL_CHAT_DOOR_PAUSED_ATTR)).toEqual([]);
  });

  it('saves the prefix and how late an email may be reached, or no prefix at all; refuses what the server would', async () => {
    const h = mount({ settings: ON });
    await flush();
    one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value = 'chat:';
    one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value = '30';
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ ask_prefix: 'chat:', stale_after_minutes: 30 }]);
    expect(allText(h.host)).toContain('Now 30 minutes.');

    one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).checked = false;
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets[1]).toEqual({ ask_prefix: null, stale_after_minutes: 30 });

    one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value = '3';
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets).toHaveLength(2);
    expect(one(h.host, MAIL_CHAT_DOOR_ERROR_ATTR).textContent).toBe('Enter whole minutes from 5 to 1440.');
  });

  it('turning off asks first, then clears the chat mailbox', async () => {
    const h = mount({ settings: ON });
    await flush();
    one(h.host, MAIL_CHAT_DOOR_TURN_OFF_ATTR).click();
    expect(allText(h.host)).toContain('Turn off email chat? Recued stops answering recued@chat.example');
    expect(h.runSet).not.toHaveBeenCalled();
    one(h.host, MAIL_CHAT_DOOR_TURN_OFF_CONFIRM_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ chat_mailbox: null }]);
    expect(h.host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('off');
  });
});

describe('Email chat drafts during background reads', () => {
  const type = (host: FakeEl, attr: string, value: string): void => {
    const input = one(host, attr);
    input.value = value;
    input.dispatchEvent({ type: 'input' });
  };
  const draft = (host: FakeEl, enabled = true): void => {
    type(host, MAIL_CHAT_DOOR_PREFIX_ATTR, ' reply: ');
    type(host, MAIL_CHAT_DOOR_STALE_ATTR, '47');
    type(host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR, 'second@personal.example');
    const toggle = one(host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR);
    toggle.checked = enabled;
    toggle.dispatchEvent({ type: 'change' });
  };
  const expectDraft = (host: FakeEl, enabled = true): void => {
    expect(one(host, MAIL_CHAT_DOOR_PREFIX_ATTR).value).toBe(' reply: ');
    expect(one(host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).checked).toBe(enabled);
    expect(one(host, MAIL_CHAT_DOOR_PREFIX_ATTR).disabled).toBe(!enabled);
    expect(one(host, MAIL_CHAT_DOOR_STALE_ATTR).value).toBe('47');
  };

  for (const kind of ['verification', 'round trip', 'refresh'] as const) {
    it(`keeps drafts while ${kind} updates the displayed server state`, async () => {
      let requests: MailChatDoorRecentRequest[] = [];
      const h = mount({
        settings: kind === 'verification' ? { ...ON, enrolled_senders: [sender()] } : ON,
        recent: () => requests,
      });
      await flush();
      draft(h.host, false);
      if (kind === 'verification') {
        h.serve(current => ({ ...current, enrolled_senders: [sender({ state: 'confirmed', code: null,
          expires_at: null, confirmed_at: AT + 1, checked_by: 'mx.zohomail.com' })] }));
        await h.tick();
        expect(one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, ME).getAttribute(MAIL_CHAT_DOOR_ENROL_STATE_ATTR))
          .toBe('confirmed');
      } else if (kind === 'round trip') {
        one(h.host, MAIL_CHAT_DOOR_TEST_START_ATTR).click();
        await flush();
        requests = [request({ arrived_at: AT + 1, state: 'proven', proof: 'sent_record',
          sender_auth: 'pass', chat: 'admitted', answer: 'sent', answered_at: AT + 2 })];
        await h.tick();
        expect(allText(one(h.host, MAIL_CHAT_DOOR_TEST_ATTR))).toContain('Answer sent');
      } else {
        h.serve(current => ({ ...current, ask_prefix: 'server:', stale_after_minutes: 90 }));
        await h.panel.refresh();
        expect(allText(h.host)).toContain('Now 90 minutes.');
      }
      expectDraft(h.host, false);
      expect(one(h.host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR).value).toBe('second@personal.example');
      expect(h.runSet).not.toHaveBeenCalled();
      expect(h.runCheck).not.toHaveBeenCalled();
    });
  }

  it('updates untouched fields when a fresh server snapshot arrives', async () => {
    const h = mount({ settings: ON });
    await flush();
    h.serve(current => ({ ...current, ask_prefix: null, stale_after_minutes: 90 }));
    await h.panel.refresh();
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).checked).toBe(false);
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).disabled).toBe(true);
    expect(one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value).toBe('90');
  });

  for (const invalid of ['prefix', 'timeout'] as const) {
    it(`keeps invalid ${invalid} text through validation and another read`, async () => {
      const h = mount({ settings: ON });
      await flush();
      draft(h.host);
      const attr = invalid === 'prefix' ? MAIL_CHAT_DOOR_PREFIX_ATTR : MAIL_CHAT_DOOR_STALE_ATTR;
      type(h.host, attr, '');
      one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
      expect(one(h.host, attr).value).toBe('');
      expect(allText(h.host)).toContain(invalid === 'prefix' ? 'Enter a prefix' : 'Enter whole minutes');
      await h.panel.refresh();
      expect(one(h.host, attr).value).toBe('');
      expect(h.runSet).not.toHaveBeenCalled();
    });
  }

  it('keeps a refused save and releases its drafts only after a successful save', async () => {
    const h = mount({ settings: ON });
    await flush();
    draft(h.host);
    h.runSet.mockRejectedValueOnce(new Error('Settings not saved.'));
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expectDraft(h.host);
    expect(allText(h.host)).toContain('Settings not saved.');
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ ask_prefix: 'reply:', stale_after_minutes: 47 }]);
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value).toBe('reply:');
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR).value).toBe('second@personal.example');
    h.serve(current => ({ ...current, ask_prefix: 'server:', stale_after_minutes: 90 }));
    await h.panel.refresh();
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value).toBe('server:');
    expect(one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value).toBe('90');
  });

  it('preserves settings drafts through unrelated resume and address saves', async () => {
    const h = mount({ settings: { ...ON, paused_at: AT } });
    await flush();
    draft(h.host, false);
    one(h.host, MAIL_CHAT_DOOR_RESUME_ATTR).click();
    await flush();
    expectDraft(h.host, false);
    one(h.host, MAIL_CHAT_DOOR_ENROL_ADD_ATTR).click();
    await flush();
    expectDraft(h.host, false);
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR).value).toBe('');
    expect(h.sets).toEqual([{ resume: true }, { enroll: 'second@personal.example' }]);
  });

  for (const kind of ['verification', 'refresh'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores a pre-save ${kind} ${outcome} arriving after the save`, async () => {
        const h = mount({ settings: kind === 'verification' ? { ...ON, enrolled_senders: [sender()] } : ON });
        await flush();
        let resolve!: (value: MailChatDoorSettings) => void;
        let reject!: (reason: Error) => void;
        h.runGet.mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
        let pending: Promise<void> | undefined;
        if (kind === 'verification') await h.tick();
        else { pending = h.panel.refresh(); await flush(); }
        draft(h.host);
        one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
        await flush();
        if (outcome === 'success') resolve(ON);
        else reject(new Error('Old read failed.'));
        await pending;
        await flush();
        expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value).toBe('reply:');
        expect(one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value).toBe('47');
        expect(h.panel.getError()).toBeNull();
        expect(h.panel.getState()).toBe('ready');
        expect(h.sets).toEqual([{ ask_prefix: 'reply:', stale_after_minutes: 47 }]);
      });
    }
  }

  it('retires drafts when the mailbox is switched off and on again', async () => {
    const h = mount({ settings: ON });
    await flush();
    draft(h.host, false);
    one(h.host, MAIL_CHAT_DOOR_TURN_OFF_ATTR).click();
    one(h.host, MAIL_CHAT_DOOR_TURN_OFF_CONFIRM_ATTR).click();
    await flush();
    h.serve(() => ON);
    await h.panel.refresh();
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).value).toBe(ON.ask_prefix);
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).checked).toBe(true);
    expect(one(h.host, MAIL_CHAT_DOOR_STALE_ATTR).value).toBe(String(ON.stale_after_minutes));
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR).value).toBe('');
  });

  it('still forces the prefix on when the server changes to writing to yourself', async () => {
    const h = mount({ settings: ON });
    await flush();
    draft(h.host, false);
    h.serve(current => ({ ...current, owner_mailboxes: [CHAT] }));
    await h.panel.refresh();
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).checked).toBe(true);
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ON_ATTR).disabled).toBe(true);
    expect(one(h.host, MAIL_CHAT_DOOR_PREFIX_ATTR).disabled).toBe(false);
    one(h.host, MAIL_CHAT_DOOR_SAVE_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ ask_prefix: 'reply:', stale_after_minutes: 47 }]);
  });
});

describe('the test round trip', () => {
  it('shows each step as the door saw it, and stops watching once it settles', async () => {
    let requests: MailChatDoorRecentRequest[] = [request({ arrived_at: AT - 60_000, state: 'proven', chat: 'admitted', answer: 'sent', answered_at: AT - 30_000 })];
    const h = mount({ settings: ON, recent: () => requests });
    await flush();
    one(h.host, MAIL_CHAT_DOOR_TEST_START_ATTR).click();
    await flush();
    // The request from before the test is not the test.
    expect(allText(h.host)).toContain('Waiting for your email…');

    requests = [request({ arrived_at: AT + 5_000 }), ...requests];
    await h.tick();
    const steps = () => byAttr(h.host, MAIL_CHAT_DOOR_TEST_STEP_ATTR).map((step) => step.textContent);
    expect(steps()).toEqual(['Arrived at 09:31 from me@owner.example.', 'Looking for it in your Sent folder…']);

    requests = [request({
      arrived_at: AT + 5_000, state: 'proven', chat: 'admitted', sender_auth: 'pass', answer: 'sent', answered_at: AT + 60_000,
    }), ...requests.slice(1)];
    await h.tick();
    expect(steps()).toEqual([
      'Arrived at 09:31 from me@owner.example.',
      'Found in your Sent folder: it is yours.',
      'It passed the sender check (DMARC) where it arrived.',
      'Answer sent at 09:32. Look for it in your inbox.',
    ]);
    // Settled: no further look.
    expect(h.timers).toHaveLength(0);
    expect(byAttr(h.host, MAIL_CHAT_DOOR_RECENT_ATTR)).toHaveLength(1);
  });

  it('says why one stopped — an alias in To, say — and, with nothing arriving, what to check', async () => {
    let requests: MailChatDoorRecentRequest[] = [];
    const h = mount({ settings: ON, recent: () => requests });
    await flush();
    one(h.host, MAIL_CHAT_DOOR_TEST_START_ATTR).click();
    await flush();
    await h.tick(MAIL_CHAT_DOOR_TEST_HINT_MS);
    expect(allText(h.host)).toContain(
      'Nothing has arrived yet. Check it went to recued@chat.example, and that its subject begins with “ask:”.');
    requests = [request({ arrived_at: AT + 1_000, state: 'ignored', reason: 'not_addressed' })];
    await h.tick();
    expect(byAttr(h.host, MAIL_CHAT_DOOR_TEST_STEP_ATTR).map((step) => step.textContent)[1])
      .toBe('The chat mailbox’s own address was not in To (an alias, or Cc), so Recued did not answer it.');
    expect(h.timers).toHaveLength(0);
  });

  it('the recent list says where each request stopped — one set aside, why', async () => {
    const h = mount({
      settings: ON,
      recent: () => [request({ arrived_at: AT + 1_000, state: 'proven', chat: 'dropped', chat_reason: 'the email chat is paused' })],
    });
    await flush();
    const words = allText(one(h.host, MAIL_CHAT_DOOR_RECENT_ATTR));
    expect(words).toContain('09:31 · me@owner.example · Not answered: the email chat is paused.');
  });
});

describe('D-318 step 8 — addresses Recued does not read', () => {
  const typeAddress = (host: FakeEl, value: string): void => {
    const input = one(host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR);
    input.value = value;
    input.dispatchEvent({ type: 'input' });
  };

  it('switched on with none of the owner’s mailboxes, says no address can write to it yet', async () => {
    const h = mount();
    await flush();
    pickChat(h.host, CHAT);
    expect(allText(h.host)).toContain('None picked: once email chat is on, you can add an address Recued does not read');
    one(h.host, MAIL_CHAT_DOOR_TURN_ON_ATTR).click();
    await flush();
    expect(h.runCheck).toHaveBeenCalledWith({ chat_mailbox: CHAT, owner_mailboxes: [] });
    expect(h.sets).toEqual([{ chat_mailbox: CHAT, owner_mailboxes: [] }]);
    expect(allText(h.host)).toContain('but no address can write to it yet: add one below');
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_ATTR)).toBeDefined();
  });

  it('adds an address: shows the code to send from it, and watches until the code’s email confirms it', async () => {
    const h = mount({ settings: ON });
    await flush();
    typeAddress(h.host, ' Me@Personal.Example ');
    one(h.host, MAIL_CHAT_DOOR_ENROL_ADD_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ enroll: ME }]);
    const item = one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, ME);
    expect(item.getAttribute(MAIL_CHAT_DOOR_ENROL_STATE_ATTR)).toBe('pending');
    expect(one(item, MAIL_CHAT_DOOR_ENROL_CODE_ATTR).textContent).toBe('482913');
    expect(allText(item)).toContain(`From ${ME}, send an email to recued@chat.example with this in the subject:`);
    expect(allText(item)).toContain('The code works until 10:01.');
    // The field is cleared for the next one.
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_INPUT_ATTR).value).toBe('');
    // Nothing yet: it looks again.
    const gets = h.runGet.mock.calls.length;
    await h.tick();
    expect(h.runGet.mock.calls.length).toBe(gets + 1);
    expect(one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, ME).getAttribute(MAIL_CHAT_DOOR_ENROL_STATE_ATTR)).toBe('pending');
    // The code's email arrives and passes.
    h.serve((current) => ({
      ...current,
      enrolled_senders: [sender({ state: 'confirmed', code: null, expires_at: null, confirmed_at: AT + 60_000,
        checked_by: 'mx.zohomail.com' })],
    }));
    await h.tick();
    const confirmed = one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, ME);
    expect(confirmed.getAttribute(MAIL_CHAT_DOOR_ENROL_STATE_ATTR)).toBe('confirmed');
    // The provider, not the host: any of its hosts checks.
    expect(allText(confirmed)).toContain('Added. Each email from it must pass the sender check by zohomail.com.');
    expect(byAttr(h.host, MAIL_CHAT_DOOR_ENROL_CODE_ATTR)).toEqual([]);
    // Settled: it stops looking.
    expect(h.timers).toEqual([]);
    // It can write now.
    expect(allText(h.host)).toContain(`Write to recued@chat.example from me@owner.example or ${ME}.`);
  });

  it('refuses what is not an address without asking the server', async () => {
    const h = mount({ settings: ON });
    await flush();
    typeAddress(h.host, 'me@');
    one(h.host, MAIL_CHAT_DOOR_ENROL_ADD_ATTR).click();
    await flush();
    expect(h.runSet).not.toHaveBeenCalled();
    expect(allText(h.host)).toContain('Enter an email address, such as me@example.com.');
  });

  it('one not added says why, and offers a new code or removing it; a pending one can be cancelled', async () => {
    const h = mount({ settings: { ...ON, enrolled_senders: [
      sender({ state: 'failed', code: null, expires_at: null, failure: 'foreign_check' }),
      sender({ address: 'two@personal.example' }),
    ] } });
    await flush();
    const failed = one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, ME);
    expect(allText(failed)).toContain('Not added. The sender check on its email was not made by your chat mailbox’s provider');
    one(failed, MAIL_CHAT_DOOR_ENROL_RETRY_ATTR).click();
    await flush();
    one(one(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, 'two@personal.example'), MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR).click();
    await flush();
    expect(h.sets).toEqual([{ enroll: ME }, { unenroll: 'two@personal.example' }]);
    expect(byAttr(h.host, MAIL_CHAT_DOOR_ENROL_SENDER_ATTR).map((item) => item.getAttribute(MAIL_CHAT_DOOR_ENROL_SENDER_ATTR)))
      .toEqual([ME]);
  });

  it('the round trip reads a request from an added address as proven by its sender check, not a Sent folder', async () => {
    let requests: MailChatDoorRecentRequest[] = [];
    const h = mount({
      settings: { ...ON, owner_mailboxes: [], enrolled_senders: [sender({
        state: 'confirmed', code: null, expires_at: null, confirmed_at: AT, checked_by: '',
      })] },
      recent: () => requests,
    });
    await flush();
    // Microsoft's stamp names no checker.
    expect(allText(h.host)).toContain('must pass the sender check by Microsoft.');
    expect(allText(one(h.host, MAIL_CHAT_DOOR_TEST_ATTR))).toContain(`From ${ME}, send an email to recued@chat.example`);
    one(h.host, MAIL_CHAT_DOOR_TEST_START_ATTR).click();
    await flush();
    requests = [request({ from: ME, arrived_at: AT + 1 })];
    await h.tick();
    expect(byAttr(h.host, MAIL_CHAT_DOOR_TEST_STEP_ATTR).map((step) => step.textContent)).toContain('Checking who sent it…');
    requests = [request({ from: ME, arrived_at: AT + 1, state: 'proven', proof: 'enrolled', sender_auth: 'pass',
      chat: 'admitted', answer: 'sent', answered_at: AT + 60_000 })];
    await h.tick();
    const steps = byAttr(h.host, MAIL_CHAT_DOOR_TEST_STEP_ATTR).map((step) => step.textContent);
    expect(steps).toContain('It passed the sender check for an address you added: it is yours.');
    expect(steps.join(' ')).not.toContain('Sent folder');
  });

  it('a request from an added address that does not pass says so', async () => {
    const h = mount({
      settings: ON,
      recent: () => [request({ from: ME, state: 'not_proven', reason: 'unverified' })],
    });
    await flush();
    expect(allText(one(h.host, MAIL_CHAT_DOOR_RECENT_ATTR)))
      .toContain('did not confirm it came from that address’s mail servers');
  });

  it('⚠ against a server from before step 8, the switched-on screen works and offers no addresses', async () => {
    const { enrolled_senders: _dropped, ...before } = ON;
    const h = mount({ settings: before as MailChatDoorSettings });
    await flush();
    expect(h.host.getAttribute(MAIL_CHAT_DOOR_STATE_ATTR)).toBe('on');
    expect(allText(h.host)).toContain('Email chat is on. Write to recued@chat.example from me@owner.example.');
    expect(byAttr(h.host, MAIL_CHAT_DOOR_ENROL_ATTR)).toEqual([]);
    expect(h.timers).toEqual([]);
  });

  it('stops looking once disposed', async () => {
    const h = mount({ settings: { ...ON, enrolled_senders: [sender()] } });
    await flush();
    expect(h.timers).toHaveLength(1);
    h.panel.dispose();
    const gets = h.runGet.mock.calls.length;
    h.timers.pop()!();
    await flush();
    expect(h.runGet.mock.calls.length).toBe(gets);
  });
});

describe('Settings → Email chat, from the real route', () => {
  const callers = {
    mailChatDoorGetCaller: async () => OFF,
    mailChatDoorSetCaller: async () => OFF,
    mailChatDoorCheckCaller: async () => ({ ready: true, checks: [] }),
    mailChatDoorRecentCaller: async () => ({ requests: [] }),
    mailChatDoorMailboxesCaller: async () => ({ instances: MAILBOXES }),
  };

  it('mounts the panel in its own section, and its styles reach the route bundle', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'email-chat',
      ...callers,
    });
    await flush();
    const section = one(host, SETTINGS_ROUTE_SECTION_ATTR, 'email-chat');
    expect(byAttr(section, MAIL_CHAT_DOOR_PANEL_ATTR)).toHaveLength(1);
    expect(byAttr(section, MAIL_CHAT_DOOR_CHAT_PICK_ATTR)).toHaveLength(1);
    const styles = (doc as unknown as { head: { querySelector(s: string): FakeEl | null } })
      .head.querySelector(`style[${SETTINGS_ROUTE_STYLES_MARKER}]`);
    expect(styles?.textContent).toContain(`[${MAIL_CHAT_DOOR_PANEL_ATTR}]`);
    route.dispose();
  });

  it('⚠ reads nothing until the section is opened — opening Settings must not list the mailboxes', async () => {
    const get = vi.fn(callers.mailChatDoorGetCaller);
    const list = vi.fn(callers.mailChatDoorMailboxesCaller);
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument(),
      localStore: createInMemoryWebclientLocalStore(),
      ...callers,
      mailChatDoorGetCaller: get,
      mailChatDoorMailboxesCaller: list,
    });
    await flush();
    const section = one(host, SETTINGS_ROUTE_SECTION_ATTR, 'email-chat');
    expect(byAttr(section, MAIL_CHAT_DOOR_PANEL_ATTR)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    one(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'email-chat').click();
    await flush();
    expect(byAttr(section, MAIL_CHAT_DOOR_PANEL_ATTR)).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    // Opened again, it reads afresh.
    one(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'email-chat').click();
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(byAttr(section, MAIL_CHAT_DOOR_PANEL_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('⚠ any caller missing omits the section — no half-mounted door', async () => {
    for (const missing of Object.keys(callers)) {
      const host = makeFakeElement('div');
      const route = bootstrapSettingsRoute({
        root: host as unknown as HTMLElement,
        document: makeFakeDocument(),
        localStore: createInMemoryWebclientLocalStore(),
        ...Object.fromEntries(Object.entries(callers).filter(([name]) => name !== missing)),
      });
      await flush();
      expect(byAttr(host, SETTINGS_ROUTE_SECTION_ATTR, 'email-chat'), missing).toEqual([]);
      route.dispose();
    }
  });
});
