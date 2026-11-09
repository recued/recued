/** D-341 slice A — the switch beside Send: "Don't ask about browser actions". It shows what the
 *  server holds for the conversation, turns it on and off there, says since when it is on, and stays
 *  hidden for a server that has no such switch. */

import { describe, expect, it, vi } from 'vitest';
import type { BrowserRequestPass } from '@recued/contracts';

import { BROWSER_ACTIONS_ADOPT_WAIT_MS, BROWSER_ACTIONS_SWITCH_ATTR, mountBrowserActionsSwitch } from '../chat/browser-actions-switch.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  title: string;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}
const element = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(), className: '', textContent: '', type: '', title: '', hidden: false,
    attrs: new Map(), children: [], listeners: new Map(),
    setAttribute(k, v) { el.attrs.set(k, v); },
    removeAttribute(k) { el.attrs.delete(k); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    click() { for (const fn of el.listeners.get('click') ?? []) fn(); },
  };
  return el;
};
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

const PASS: BrowserRequestPass = { channel_session_id: 'chat:chat-1', started_at: 1_000, expires_at: 9_000, uses: 0 };

const mount = (state: { pass?: BrowserRequestPass } = {},
  options: { failing?: boolean; now?: () => number; session_id?: string } = {}) => {
  const get = vi.fn(async () => {
    if (options.failing === true) throw new Error('unknown_method');
    return state.pass !== undefined ? { pass: state.pass } : {};
  });
  const set = vi.fn(async (args: { session_id: string; allow: boolean }) => {
    if (options.failing === true) throw new Error('unknown_method');
    state.pass = args.allow ? (state.pass ?? PASS) : undefined;
    return state.pass !== undefined ? { pass: state.pass } : {};
  });
  const mounted = mountBrowserActionsSwitch({ document: { createElement: element } as never, session_id: options.session_id ?? 'chat-1',
    callers: { get, set }, formatTime: (ms) => `T${String(ms)}`, ...(options.now !== undefined ? { now: options.now } : {}) });
  const root = mounted.element as unknown as FakeEl;
  return { mounted, root, button: root.children[0]!, status: root.children[1]!, get, set };
};

describe('D-341 slice A — the switch beside Send', () => {
  it('off: offers to stop asking; clicked, it is on and says since when; clicked again, off', async () => {
    const t = mount();
    await tick();
    expect(t.root.getAttribute(BROWSER_ACTIONS_SWITCH_ATTR)).toBe('chat-1');
    expect(t.root.hidden).toBe(false);
    expect(t.get).toHaveBeenCalledWith({ session_id: 'chat-1' });
    expect(t.button).toMatchObject({ textContent: 'Don’t ask about browser actions' });
    expect(t.button.getAttribute('aria-pressed')).toBe('false');
    t.button.click();
    await tick();
    expect(t.set).toHaveBeenCalledWith({ session_id: 'chat-1', allow: true });
    expect(t.button.textContent).toBe('Not asking about browser actions, since T1000');
    expect(t.button.getAttribute('aria-pressed')).toBe('true');
    expect(t.button.title).toContain('until T9000');
    t.button.click();
    await tick();
    expect(t.set).toHaveBeenLastCalledWith({ session_id: 'chat-1', allow: false });
    expect(t.button.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows on when the server holds it on, and hides for a server without the switch', async () => {
    const on = mount({ pass: PASS });
    await tick();
    expect(on.button.getAttribute('aria-pressed')).toBe('true');
    const older = mount({}, { failing: true });
    await tick();
    expect(older.root.hidden).toBe(true);
  });

  it('a render reads it again only when the last read is older than asked', async () => {
    let clock = 0;
    const t = mount({}, { now: () => clock });
    await tick();
    expect(t.get).toHaveBeenCalledTimes(1);
    clock = 5_000;
    t.mounted.refreshIfOlder(15_000);
    expect(t.get).toHaveBeenCalledTimes(1);
    clock = 16_000;
    t.mounted.refreshIfOlder(15_000);
    await tick();
    expect(t.get).toHaveBeenCalledTimes(2);
  });

  it('a new chat: held on the draft, then set on its conversation before the first message goes', async () => {
    const t = mount({}, { session_id: '' });
    await tick();
    // No conversation yet: nothing asked of the server, and the switch shows at once.
    expect(t.get).not.toHaveBeenCalled();
    expect(t.root.hidden).toBe(false);
    t.button.click();
    expect(t.set).not.toHaveBeenCalled();
    expect(t.button).toMatchObject({ textContent: 'Not asking about browser actions' });
    await t.mounted.adopt('chat-9');
    expect(t.set).toHaveBeenCalledWith({ session_id: 'chat-9', allow: true });
    expect(t.mounted.session_id).toBe('chat-9');
    expect(t.button.textContent).toBe('Not asking about browser actions, since T1000');
    // Left off on the draft: the conversation is only read.
    const off = mount({}, { session_id: '' });
    await off.mounted.adopt('chat-10');
    expect(off.set).not.toHaveBeenCalled();
    expect(off.get).toHaveBeenCalledWith({ session_id: 'chat-10' });
    // A server without the switch: it goes.
    const older = mount({}, { session_id: '', failing: true });
    older.button.click();
    await older.mounted.adopt('chat-11');
    expect(older.root.hidden).toBe(true);
  });

  it('a message going with the switch off here ends one another device turned on; with it on, nothing', async () => {
    const off = mount();
    await tick();
    await off.mounted.endIfOff('chat-1');
    expect(off.set).toHaveBeenCalledWith({ session_id: 'chat-1', allow: false });
    // Another conversation's send is not this switch's.
    off.set.mockClear();
    await off.mounted.endIfOff('chat-2');
    expect(off.set).not.toHaveBeenCalled();
    const on = mount({ pass: PASS });
    await tick();
    await on.mounted.endIfOff('chat-1');
    expect(on.set).not.toHaveBeenCalled();
  });

  it('a first send waits for its switch at most a few seconds: a server that never answers holds nothing up', async () => {
    vi.useFakeTimers();
    try {
      const set = vi.fn(() => new Promise<{ pass?: BrowserRequestPass }>(() => undefined));
      const mounted = mountBrowserActionsSwitch({ document: { createElement: element } as never, session_id: '',
        callers: { get: vi.fn(async () => ({})), set } });
      const root = mounted.element as unknown as FakeEl;
      root.children[0]!.click();
      let adopted = false;
      void mounted.adopt('chat-12').then(() => { adopted = true; });
      await vi.advanceTimersByTimeAsync(BROWSER_ACTIONS_ADOPT_WAIT_MS - 1);
      expect(adopted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(adopted).toBe(true);
      // Not known to be on: the switch goes, and the request asks as with it off.
      expect(root.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
