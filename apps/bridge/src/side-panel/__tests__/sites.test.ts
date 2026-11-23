/** D-335 slice G — the side panel's Sites section: Chrome's grant of every site,
 *  and the owner's list of sites Recued must never use. */

import { describe, expect, it, vi } from 'vitest';
import { BLOCKED_SITES_KEY, BLOCKED_SITES_MAX, EVERY_SITE, SCREENSHOTS_GRANT } from '../../permissions/site-grants.js';
import {
  KEEP_SIGNED_IN_KEY,
  KEEP_SIGNED_IN_MAX_SITES,
  KEEP_SIGNED_IN_STATUS_KEY,
  KEEP_SIGNED_IN_WEB_STORE_SAID,
} from '../../keep-signed-in.js';
import { createSitesControls, type SitesChrome } from '../sites.js';
import type { SidePanelSitesState } from '../store/local-store.js';
import { createSidePanelStore } from '../store/local-store.js';
import {
  SIDE_PANEL_KEEP_ADD_ATTR,
  SIDE_PANEL_KEEP_FIELD_ATTR,
  SIDE_PANEL_KEEP_LASTED_ATTR,
  SIDE_PANEL_KEEP_MESSAGE_ATTR,
  SIDE_PANEL_KEEP_REMOVE_ATTR,
  SIDE_PANEL_KEEP_ROW_ATTR,
  SIDE_PANEL_KEEP_SIGNED_OUT_ATTR,
  SIDE_PANEL_KEEP_STATUS_ATTR,
  SIDE_PANEL_SITES_ADD_ATTR,
  SIDE_PANEL_SITES_GRANT_ATTR,
  SIDE_PANEL_SITES_INPUT_ATTR,
  SIDE_PANEL_SITES_MESSAGE_ATTR,
  SIDE_PANEL_SITES_REMOVE_ATTR,
  SIDE_PANEL_SITES_ROW_ATTR,
  SIDE_PANEL_SITES_SCREENSHOTS_ATTR,
  SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR,
  SIDE_PANEL_SITES_STATUS_ATTR,
  SIDE_PANEL_KEEP_UNDO_ATTR,
  SIDE_PANEL_SITES_UNDO_ATTR,
  renderSitesSection,
  type SitesHandlers,
} from '../views.js';

/** A Chrome whose grants and storage the test holds: every site, and
 *  screenshots (D-335 slice H), each its own grant. */
const fakeChrome = (granted = false, kept?: unknown, screenshots = false) => {
  const state = { granted, screenshots, kept, requested: 0, requests: [] as string[][], removed: [] as string[][] };
  const holds = (origin: string) => (origin === EVERY_SITE ? state.granted : origin === SCREENSHOTS_GRANT ? state.screenshots : false);
  const chrome: SitesChrome = {
    permissions: {
      contains: async (p: { origins: string[] }) => p.origins.every(holds),
      request: vi.fn((p: { origins: string[] }) => {
        state.requested += 1;
        state.requests.push(p.origins);
        for (const origin of p.origins) {
          if (origin === EVERY_SITE) state.granted = true;
          else if (origin === SCREENSHOTS_GRANT) state.screenshots = true;
          else throw new Error(`unexpected origin ${origin}`);
        }
        return Promise.resolve(true);
      }),
      remove: vi.fn(async (p: { origins: string[] }) => {
        state.removed.push(p.origins);
        if (p.origins.includes(EVERY_SITE)) state.granted = false;
        if (p.origins.includes(SCREENSHOTS_GRANT)) state.screenshots = false;
        return true;
      }),
    },
    storage: {
      get: async () => (state.kept === undefined ? {} : { [BLOCKED_SITES_KEY]: state.kept }),
      set: vi.fn(async (items: Record<string, unknown>) => { state.kept = items[BLOCKED_SITES_KEY]; }),
    },
  };
  return { chrome, state };
};
const controlsOn = (chrome: SitesChrome) => {
  const applied: SidePanelSitesState[] = [];
  const controls = createSitesControls(chrome, sites => applied.push(sites));
  return { controls, applied, last: () => applied.at(-1)! };
};

describe('the Sites controls', () => {
  it('reads Chrome\'s grant and the kept list', async () => {
    const { chrome } = fakeChrome(true, ['example.com']);
    const { controls, last } = controlsOn(chrome);
    await controls.refresh();
    expect(last()).toEqual({ every_site: true, screenshots: false, blocked: ['example.com'], message: '', keep: [] });
  });

  it('asks Chrome for every site inside the click, before awaiting anything', async () => {
    const { chrome, state } = fakeChrome(false);
    const { controls, last } = controlsOn(chrome);
    const asked = controls.onAllowEverySite();
    // Synchronously: Chrome grants a site only while the gesture lasts.
    expect(state.requested).toBe(1);
    await asked;
    expect(last()).toEqual({ every_site: true, screenshots: false, blocked: [], message: '', keep: [] });
  });

  it('a request Chrome refuses changes nothing and says so', async () => {
    const { chrome } = fakeChrome(false);
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockImplementationOnce(() => Promise.resolve(false));
    const { controls, last } = controlsOn(chrome);
    await controls.onAllowEverySite();
    expect(last()).toEqual({ every_site: false, screenshots: false, blocked: [], message: 'Chrome did not allow every site, so nothing changed.', keep: [] });
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('no gesture'); });
    await controls.onAllowEverySite();
    expect(last().message).toBe('Chrome did not allow every site, so nothing changed.');
  });

  it('stops using every site, and says so when Chrome keeps it', async () => {
    const { chrome } = fakeChrome(true);
    const { controls, last } = controlsOn(chrome);
    await controls.onStopEverySite();
    expect(last()).toMatchObject({ every_site: false, message: '' });
    (chrome.permissions.remove as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => false);
    await controls.onStopEverySite();
    expect(last().message).toContain('Chrome did not take back every site');
  });

  // D-335 slice H — screenshots: a separate grant, asked for inside the click.
  it('asks Chrome for screenshots inside the click, and stops them alone', async () => {
    const { chrome, state } = fakeChrome(true);
    const { controls, last } = controlsOn(chrome);
    const asked = controls.onAllowScreenshots();
    expect(state.requests).toEqual([[SCREENSHOTS_GRANT]]);
    await asked;
    expect(last()).toEqual({ every_site: true, screenshots: true, blocked: [], message: '', keep: [] });
    await controls.onStopScreenshots();
    expect(state.removed).toEqual([[SCREENSHOTS_GRANT]]);
    expect(last()).toEqual({ every_site: true, screenshots: false, blocked: [], message: '', keep: [] });
  });

  it('stopping every site takes back screenshots too, whose grant covers every site as well', async () => {
    const { chrome, state } = fakeChrome(true, undefined, true);
    const { controls, last } = controlsOn(chrome);
    await controls.onStopEverySite();
    expect(state.removed).toEqual([[EVERY_SITE, SCREENSHOTS_GRANT]]);
    expect(last()).toMatchObject({ every_site: false, screenshots: false });
  });

  it('screenshots Chrome refuses change nothing and say so', async () => {
    const { chrome } = fakeChrome(true);
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockImplementationOnce(() => Promise.resolve(false));
    const { controls, last } = controlsOn(chrome);
    await controls.onAllowScreenshots();
    expect(last()).toMatchObject({ screenshots: false, message: 'Chrome did not allow screenshots, so nothing changed.' });
  });

  it('adds a site once, removes it, and keeps the list as hosts', async () => {
    const { chrome, state } = fakeChrome(true, ['example.com']);
    const { controls, last } = controlsOn(chrome);
    await controls.onAddBlocked('mail.test');
    await controls.onAddBlocked('mail.test');
    expect(state.kept).toEqual(['example.com', 'mail.test']);
    await controls.onRemoveBlocked('example.com');
    expect(state.kept).toEqual(['mail.test']);
    // D-347 follow-up 30 — with its Undo offered where it stood, and focused.
    expect(last()).toEqual({ every_site: true, screenshots: false, blocked: ['mail.test'], message: '', keep: [],
      removed: { site: 'example.com', index: 0 }, focus: { attr: SIDE_PANEL_SITES_UNDO_ATTR, value: 'example.com' } });
  });

  it(`holds at most ${BLOCKED_SITES_MAX} sites`, async () => {
    const full = Array.from({ length: BLOCKED_SITES_MAX }, (_, i) => `site${i}.test`);
    const { chrome, state } = fakeChrome(true, full);
    const { controls, last } = controlsOn(chrome);
    await controls.onAddBlocked('one-more.test');
    expect(state.kept).toEqual(full);
    expect(last().message).toBe(`The list holds at most ${BLOCKED_SITES_MAX} sites.`);
  });

  it('a malformed saved list says the Bridge acts on no page, and the next change writes it afresh', async () => {
    const { chrome, state } = fakeChrome(true, 'corrupt');
    const { controls, last } = controlsOn(chrome);
    await controls.refresh();
    expect(last()).toMatchObject({ blocked: [], message: expect.stringContaining('the Bridge acts on no page') });
    await controls.onAddBlocked('example.com');
    expect(state.kept).toEqual(['example.com']);
    expect(last()).toMatchObject({ blocked: ['example.com'], message: '' });
  });

  it('a list that cannot be saved says so', async () => {
    const { chrome } = fakeChrome(true, []);
    (chrome.storage.set as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('quota'); });
    const { controls, last } = controlsOn(chrome);
    await controls.onAddBlocked('example.com');
    expect(last()).toMatchObject({ blocked: [], message: 'Could not save the list. Try again.' });
  });

  it('only the newest read applies', async () => {
    let release!: () => void;
    const { chrome, state } = fakeChrome(false);
    const slow = new Promise<boolean>(resolve => { release = () => resolve(false); });
    const contains = vi.fn().mockImplementationOnce(() => slow)
      .mockImplementation(async (p: { origins: string[] }) => (p.origins[0] === EVERY_SITE ? state.granted : false));
    chrome.permissions.contains = contains;
    const { controls, applied } = controlsOn(chrome);
    const first = controls.refresh();
    state.granted = true;
    await controls.refresh();
    release();
    await first;
    expect(applied).toEqual([{ every_site: true, screenshots: false, blocked: [], message: '', keep: [] }]);
  });
});

/** Just enough DOM for the section: elements with attributes, children,
 *  listeners and the properties the section sets. */
interface FakeElement {
  tagName: string; textContent: string; className: string; value?: string; disabled?: boolean;
  children: FakeElement[]; attrs: Map<string, string>; listeners: Map<string, Array<(event?: unknown) => void>>;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null;
  addEventListener(type: string, handler: (event?: unknown) => void): void; appendChild(el: FakeElement): FakeElement;
}
const fakeDocument = () => {
  const make = (tagName: string): FakeElement => {
    const el: FakeElement = {
      tagName, textContent: '', className: '', children: [], attrs: new Map(), listeners: new Map(),
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      addEventListener(type, handler) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), handler]); },
      appendChild(child) { el.children.push(child); return child; },
    };
    return el;
  };
  // An SVG element keeps its name's case, as in a browser (follow-up 30's ×).
  return { createElement: (tagName: string) => make(tagName.toUpperCase()), createElementNS: (_ns: string, tagName: string) => make(tagName) };
};
const all = (root: FakeElement, attr: string): FakeElement[] =>
  [...(root.attrs.has(attr) ? [root] : []), ...root.children.flatMap(child => all(child, attr))];
const one = (root: FakeElement, attr: string, value?: string): FakeElement => {
  const hit = all(root, attr).find(el => value === undefined || el.getAttribute(attr) === value);
  if (!hit) throw new Error(`no [${attr}${value === undefined ? '' : `=${value}`}]`);
  return hit;
};
const click = (el: FakeElement) => { for (const handler of el.listeners.get('click') ?? []) handler(); };
const render = (sites: SidePanelSitesState, handlers: SitesHandlers = {}) =>
  renderSitesSection(fakeDocument() as unknown as Document, sites, handlers) as unknown as FakeElement;

describe('the Sites section', () => {
  it('not yet allowed: says so, and its button asks Chrome inside the click', () => {
    const onAllowEverySite = vi.fn();
    const section = render({ every_site: false, screenshots: false, blocked: [], message: '' }, { onAllowEverySite });
    expect(one(section, SIDE_PANEL_SITES_STATUS_ATTR).getAttribute(SIDE_PANEL_SITES_STATUS_ATTR)).toBe('not_granted');
    expect(one(section, SIDE_PANEL_SITES_STATUS_ATTR).textContent).toBe('The Bridge may not use your sites yet.');
    const button = one(section, SIDE_PANEL_SITES_GRANT_ATTR, 'allow');
    expect(button.textContent).toBe('Allow every site');
    click(button);
    expect(onAllowEverySite).toHaveBeenCalledTimes(1);
  });

  it('allowed: offers to stop; still reading Chrome: offers nothing', () => {
    const onStopEverySite = vi.fn();
    const allowed = render({ every_site: true, screenshots: false, blocked: [], message: '' }, { onStopEverySite });
    expect(one(allowed, SIDE_PANEL_SITES_STATUS_ATTR).textContent).toBe('The Bridge may use every site in this browser for your AI.');
    click(one(allowed, SIDE_PANEL_SITES_GRANT_ATTR, 'stop'));
    expect(onStopEverySite).toHaveBeenCalledTimes(1);
    const reading = render({ every_site: null, screenshots: false, blocked: [], message: '' });
    expect(one(reading, SIDE_PANEL_SITES_STATUS_ATTR).getAttribute(SIDE_PANEL_SITES_STATUS_ATTR)).toBe('unknown');
    expect(all(reading, SIDE_PANEL_SITES_GRANT_ATTR)).toEqual([]);
  });

  it('lists each site with its own Remove, and shows the last change\'s message', () => {
    const onRemoveBlocked = vi.fn();
    const section = render({ every_site: true, screenshots: false, blocked: ['example.com', 'mail.test'], message: 'Could not save the list. Try again.' },
      { onRemoveBlocked });
    expect(all(section, SIDE_PANEL_SITES_ROW_ATTR).map(row => row.getAttribute(SIDE_PANEL_SITES_ROW_ATTR)))
      .toEqual(['example.com', 'mail.test']);
    const remove = one(section, SIDE_PANEL_SITES_REMOVE_ATTR, 'mail.test');
    expect(remove.getAttribute('aria-label')).toBe('Remove mail.test');
    // D-347 follow-up 30 — an ×, not the word: what it does is its name and its tooltip, the × hidden from a screen
    // reader and drawn in the text's colour.
    expect([remove.className, remove.textContent, remove.getAttribute('title')]).toEqual(['sites-remove', '', 'Remove mail.test']);
    expect(remove.children.map(icon => [icon.tagName, icon.getAttribute('aria-hidden'), icon.getAttribute('stroke')]))
      .toEqual([['svg', 'true', 'currentColor']]);
    click(remove);
    expect(onRemoveBlocked).toHaveBeenCalledWith('mail.test');
    expect(one(section, SIDE_PANEL_SITES_MESSAGE_ATTR).textContent).toBe('Could not save the list. Try again.');
  });

  it('adds what was typed as its site, and keeps a typo to fix', async () => {
    const onAddBlocked = vi.fn();
    const section = render({ every_site: true, screenshots: false, blocked: [], message: '' }, { onAddBlocked });
    const input = one(section, SIDE_PANEL_SITES_INPUT_ATTR);
    input.value = 'https://Mail.Example.com/inbox';
    click(one(section, SIDE_PANEL_SITES_ADD_ATTR));
    expect(onAddBlocked).toHaveBeenCalledWith('mail.example.com');
    // The button is busy until the add settles.
    expect(one(section, SIDE_PANEL_SITES_ADD_ATTR).disabled).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    input.value = 'not a site';
    click(one(section, SIDE_PANEL_SITES_ADD_ATTR));
    expect(onAddBlocked).toHaveBeenCalledTimes(1);
    expect(one(section, SIDE_PANEL_SITES_MESSAGE_ATTR).textContent).toBe('Type a site such as example.com.');
    expect(input.value).toBe('not a site');
  });

  it('D-347 follow-up 22 — hands its typo to the section\'s state, so a redraw still says it', () => {
    const onBlockedProblem = vi.fn();
    const section = render({ every_site: true, screenshots: false, blocked: [], message: '' }, { onAddBlocked: vi.fn(), onBlockedProblem });
    one(section, SIDE_PANEL_SITES_INPUT_ATTR).value = 'not a site';
    click(one(section, SIDE_PANEL_SITES_ADD_ATTR));
    expect(onBlockedProblem).toHaveBeenCalledWith('Type a site such as example.com.');
  });
});

describe('the Sites section — screenshots (D-335 slice H)', () => {
  it('offers screenshots only while every site is allowed, and asks for them inside the click', () => {
    const onAllowScreenshots = vi.fn();
    const off = render({ every_site: true, screenshots: false, blocked: [], message: '' }, { onAllowScreenshots });
    expect(one(off, SIDE_PANEL_SITES_SCREENSHOTS_ATTR).getAttribute(SIDE_PANEL_SITES_SCREENSHOTS_ATTR)).toBe('off');
    expect(one(off, SIDE_PANEL_SITES_SCREENSHOTS_ATTR).textContent).toBe('Your AI cannot take screenshots.');
    const allow = one(off, SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR, 'allow');
    expect(allow.textContent).toBe('Allow screenshots');
    click(allow);
    expect(onAllowScreenshots).toHaveBeenCalledTimes(1);
    const onStopScreenshots = vi.fn();
    const on = render({ every_site: true, screenshots: true, blocked: [], message: '' }, { onStopScreenshots });
    expect(one(on, SIDE_PANEL_SITES_SCREENSHOTS_ATTR).textContent).toBe('Your AI can also take screenshots of these pages.');
    click(one(on, SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR, 'stop'));
    expect(onStopScreenshots).toHaveBeenCalledTimes(1);
    for (const sites of [{ every_site: false, screenshots: false }, { every_site: true, screenshots: null }, { every_site: null, screenshots: null }]) {
      expect(all(render({ ...sites, blocked: [], message: '' }), SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR)).toEqual([]);
    }
  });
});

describe('the store keeps the Sites state across a re-pair', () => {
  it('reset() clears the server\'s frames and keeps this browser\'s sites', () => {
    const store = createSidePanelStore();
    store.applySitesState({ every_site: true, screenshots: false, blocked: ['example.com'], message: '' });
    store.reset({ paired: true } as never);
    expect(store.getState().sites).toEqual({ every_site: true, screenshots: false, blocked: ['example.com'], message: '' });
  });
});

// D-347 follow-up 19 — Keep signed in: the sites whose sign-in the Bridge keeps alive (`keep-signed-in.ts`).
/** A Chrome whose storage holds any keys. */
const keepChrome = (kept: Record<string, unknown> = {}) => {
  const chrome: SitesChrome = {
    permissions: { contains: async () => true, request: vi.fn(async () => true), remove: vi.fn(async () => true) },
    storage: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in kept).map(key => [key, kept[key]])),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(kept, items); }),
    },
  };
  return { chrome, kept };
};

describe('storage read failures while editing site lists', () => {
  type List = 'blocked' | 'keep';
  type Operation = 'add' | 'remove' | 'undo';
  type Failure = 'once' | 'persistent';
  const cases: Array<{ list: List; operation: Operation; failure: Failure }> =
    (['blocked', 'keep'] as const).flatMap(list => (['add', 'remove', 'undo'] as const)
      .map(operation => ({ list, operation, failure: 'once' as const })));
  cases.push({ list: 'blocked', operation: 'undo', failure: 'persistent' },
    { list: 'keep', operation: 'undo', failure: 'persistent' });

  it.each(cases)('preserves $list entries and Undo after $failure read failure on $operation', async ({ list, operation, failure }) => {
    const blocked = ['a.example.com', 'b.example.com', 'c.example.com'];
    const keep = [
      { site: blocked[0]!, every_minutes: 10, mode: 'session', window: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } },
      { site: blocked[1]!, every_minutes: 5, mode: 'reload' },
      { site: blocked[2]!, every_minutes: 15, mode: 'session', window: { days: [0, 6], from: '10:00', to: '14:00' } },
    ];
    const { chrome, kept } = keepChrome({ [BLOCKED_SITES_KEY]: blocked, [KEEP_SIGNED_IN_KEY]: keep });
    const original = structuredClone(kept);
    const { controls, last } = controlsOn(chrome);
    const undo = () => list === 'blocked' ? controls.onUndoRemoveBlocked() : controls.onUndoRemoveKeep();
    const offer = () => list === 'blocked' ? last().removed : last().keep_removed;
    const notice = () => list === 'blocked' ? last().message : last().keep_message;
    if (list === 'blocked') await controls.onRemoveBlocked(blocked[0]!);
    else await controls.onRemoveKeep(blocked[0]!);
    expect(offer()).toMatchObject({ site: blocked[0] });
    const before = structuredClone(kept);
    (chrome.storage.set as ReturnType<typeof vi.fn>).mockClear();

    const key = list === 'blocked' ? BLOCKED_SITES_KEY : KEEP_SIGNED_IN_KEY;
    const get = chrome.storage.get;
    let failures = failure === 'once' ? 1 : Infinity;
    vi.spyOn(chrome.storage, 'get').mockImplementation(async keys => {
      if (keys.includes(key) && failures > 0) { failures--; throw new Error('storage temporarily unavailable'); }
      return get(keys);
    });
    if (operation === 'undo') await undo();
    else if (list === 'blocked') {
      if (operation === 'add') await controls.onAddBlocked('d.example.com');
      else await controls.onRemoveBlocked(blocked[1]!);
    } else if (operation === 'add') {
      await controls.onAddKeep({ site: 'd.example.com', every_minutes: 10, mode: 'session' });
    } else await controls.onRemoveKeep(blocked[1]!);

    expect(chrome.storage.set).not.toHaveBeenCalled();
    expect(kept).toEqual(before);
    expect(offer()).toMatchObject({ site: blocked[0] });
    expect(notice()).toMatch(/read/i);
    expect(notice()).toMatch(/try again/i);

    failures = 0;
    await undo();
    expect(chrome.storage.set).toHaveBeenCalledOnce();
    expect(kept).toEqual(original);
    expect(offer()).toBeUndefined();
    expect(notice() ?? '').toBe('');
  });
});

describe('Keep signed in — the controls (D-347 follow-up 19)', () => {
  it('reads each site with what happened last, takes a site added again with its new settings, and removes one', async () => {
    const { chrome, kept } = keepChrome({
      [KEEP_SIGNED_IN_KEY]: [{ site: 'console.example.com', every_minutes: 10, mode: 'session' }],
      [KEEP_SIGNED_IN_STATUS_KEY]: { 'console.example.com': { next_at: 2, last: { at: 1, what: 'kept', said: 'Kept the session.' } } },
    });
    const { controls, last } = controlsOn(chrome);
    await controls.refresh();
    expect(last().keep).toEqual([{ entry: { site: 'console.example.com', every_minutes: 10, mode: 'session' },
      status: { next_at: 2, last: { at: 1, what: 'kept', said: 'Kept the session.' } } }]);
    await controls.onAddKeep({ site: 'console.example.com', every_minutes: 5, mode: 'reload' });
    const weekdays = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
    await controls.onAddKeep({ site: 'crm.example.com', every_minutes: 15, mode: 'session', window: weekdays });
    expect(kept[KEEP_SIGNED_IN_KEY]).toEqual([{ site: 'console.example.com', every_minutes: 5, mode: 'reload' },
      { site: 'crm.example.com', every_minutes: 15, mode: 'session', window: weekdays }]);
    await controls.onRemoveKeep('console.example.com');
    expect(last().keep!.map(row => row.entry.site)).toEqual(['crm.example.com']);
  });

  it('holds at most its number of sites, and says so', async () => {
    const full = Array.from({ length: KEEP_SIGNED_IN_MAX_SITES },
      (_, i) => ({ site: `s${String(i)}.example.com`, every_minutes: 10, mode: 'session' }));
    const { chrome, kept } = keepChrome({ [KEEP_SIGNED_IN_KEY]: full });
    const { controls, last } = controlsOn(chrome);
    await controls.onAddKeep({ site: 'one-more.example.com', every_minutes: 10, mode: 'session' });
    // In its own card (follow-up 22), not under the list of sites never used.
    expect(last().keep_message).toBe(`Keep signed in holds at most ${String(KEEP_SIGNED_IN_MAX_SITES)} sites.`);
    expect(last().message).toBe('');
    expect(kept[KEEP_SIGNED_IN_KEY]).toHaveLength(KEEP_SIGNED_IN_MAX_SITES);
  });

  it('D-347 follow-up 22 — keeps what a form found to fix through a redraw, each form its own, until its next change', async () => {
    const { chrome } = keepChrome();
    const { controls, last } = controlsOn(chrome);
    await controls.onKeepProblem('Type a site such as console.example.com.');
    expect([last().keep_message, last().message]).toEqual(['Type a site such as console.example.com.', '']);
    // The timer's next status draws the section again from a fresh read: what to fix is still said.
    await controls.refresh();
    expect(last().keep_message).toBe('Type a site such as console.example.com.');
    await controls.onBlockedProblem('Type a site such as example.com.');
    expect([last().keep_message, last().message]).toEqual(['Type a site such as console.example.com.', 'Type a site such as example.com.']);
    // A site added clears its own form's, and only that.
    await controls.onAddKeep({ site: 'console.example.com', every_minutes: 10, mode: 'session' });
    expect([last().keep_message, last().message]).toEqual([undefined, 'Type a site such as example.com.']);
  });
});

describe('Keep signed in — the card (D-347 follow-up 19)', () => {
  const sitesWith = (keep: SidePanelSitesState['keep']): SidePanelSitesState =>
    ({ every_site: true, screenshots: false, blocked: [], message: '', keep });
  const at = (hour: number, minute: number) => new Date(2026, 10, 9, hour, minute).getTime();
  const texts = (root: FakeElement): string[] => [root.textContent, ...root.children.flatMap(texts)];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('shows each site, how often, how and when it is refreshed, and what happened last', () => {
    const onRemoveKeep = vi.fn();
    const section = render(sitesWith([
      { entry: { site: 'console.example.com', every_minutes: 10, mode: 'session' },
        status: { next_at: at(10, 32), last: { at: at(10, 22), what: 'kept', said: 'Kept the session.' } } },
      { entry: { site: 'crm.example.com', every_minutes: 1, mode: 'reload', window: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } } },
      { entry: { site: 'ops.example.com', every_minutes: 30, mode: 'session', window: { until: at(17, 30) }, off: true } },
    ]), { onRemoveKeep });
    expect(all(section, SIDE_PANEL_KEEP_ROW_ATTR).map(row => row.getAttribute(SIDE_PANEL_KEEP_ROW_ATTR)))
      .toEqual(['console.example.com', 'crm.example.com', 'ops.example.com']);
    expect(texts(section)).toEqual(expect.arrayContaining(['Every 10 minutes, keeping the session, always.',
      'Every 1 minute, reloading the page, Mon–Fri, 08:00–18:00.', 'Every 30 minutes, keeping the session, until 17:30.']));
    expect(one(section, SIDE_PANEL_KEEP_STATUS_ATTR, 'console.example.com').textContent).toBe('10:22: Kept the session. Next at 10:32.');
    expect(one(section, SIDE_PANEL_KEEP_STATUS_ATTR, 'crm.example.com').textContent).toBe('Not refreshed yet.');
    expect(one(section, SIDE_PANEL_KEEP_STATUS_ATTR, 'ops.example.com').textContent)
      .toBe('Stopped: its hours ran out. Add it again to start again.');
    const remove = one(section, SIDE_PANEL_KEEP_REMOVE_ATTR, 'crm.example.com');
    expect(remove.getAttribute('aria-label')).toBe('Stop keeping crm.example.com signed in');
    // Follow-up 30 — an ×, its tooltip saying what it does.
    expect([remove.className, remove.getAttribute('title')]).toEqual(['sites-remove', 'Stop keeping crm.example.com signed in']);
    click(remove);
    expect(onRemoveKeep).toHaveBeenCalledWith('crm.example.com');
  });

  it('adds a site with how often, how and when; a mistake keeps what was typed and says what to fix', async () => {
    const onAddKeep = vi.fn();
    const onKeepProblem = vi.fn();
    const section = render(sitesWith([]), { onAddKeep, onKeepProblem });
    const field = (key: string) => one(section, SIDE_PANEL_KEEP_FIELD_ATTR, key) as FakeElement & { checked?: boolean };
    const add = () => click(one(section, SIDE_PANEL_KEEP_ADD_ATTR));
    const said = () => one(section, SIDE_PANEL_KEEP_MESSAGE_ATTR).textContent;
    // To start with: every 10 minutes, keeping the session, always; Monday to Friday, 08:00 to 18:00, if on days.
    expect([field('every').value, field('mode').value, field('when').value, field('from').value, field('to').value])
      .toEqual(['10', 'session', 'always', '08:00', '18:00']);
    expect([1, 2, 3, 4, 5, 6, 0].map(day => field(`day-${String(day)}`).checked)).toEqual([true, true, true, true, true, false, false]);
    field('site').value = 'https://Console.Example.com/home';
    field('every').value = '5';
    field('mode').value = 'reload';
    field('when').value = 'days';
    field('day-1').checked = false;
    field('day-6').checked = true;
    field('from').value = '09:00';
    add();
    expect(onAddKeep).toHaveBeenLastCalledWith({ site: 'console.example.com', every_minutes: 5, mode: 'reload',
      window: { days: [2, 3, 4, 5, 6], from: '09:00', to: '18:00' } });
    await tick();
    // For the next hours: until that many hours from now.
    field('when').value = 'hours';
    field('hours').value = '3';
    const before = Date.now();
    add();
    const until = (onAddKeep.mock.calls[1]![0] as { window: { until: number } }).window.until;
    expect(until).toBeGreaterThanOrEqual(before + 3 * 3_600_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 3 * 3_600_000);
    await tick();
    // Mistakes: nothing is added, and the message says what to fix.
    field('every').value = '0';
    add();
    expect(said()).toBe('Refresh it every 1 to 60 minutes.');
    await tick();
    field('every').value = '10';
    field('when').value = 'days';
    field('from').value = '18:00';
    add();
    expect(said()).toBe('Pick at least one day, and a time it starts before the time it ends.');
    await tick();
    field('site').value = 'not a site';
    add();
    expect(said()).toBe('Type a site such as console.example.com.');
    expect(onAddKeep).toHaveBeenCalledTimes(2);
    expect(field('site').value).toBe('not a site');
    // Each also kept in the section's state, so the next redraw says it too (follow-up 22).
    expect(onKeepProblem.mock.calls.map(call => call[0])).toEqual(['Refresh it every 1 to 60 minutes.',
      'Pick at least one day, and a time it starts before the time it ends.', 'Type a site such as console.example.com.']);
  });

  it('D-347 follow-up 22 — says in its card what the section\'s state holds for it, and advises fewer minutes', () => {
    const section = render({ ...sitesWith([]), keep_message: 'Keep signed in holds at most 20 sites.' });
    expect(one(section, SIDE_PANEL_KEEP_MESSAGE_ATTR).textContent).toBe('Keep signed in holds at most 20 sites.');
    expect(one(section, SIDE_PANEL_SITES_MESSAGE_ATTR).textContent).toBe('');
    expect(texts(section)).toEqual(expect.arrayContaining([expect.stringContaining(
      'Pick fewer minutes than the site lets you stay idle, since a refresh can come a little late.')]));
    // Follow-up 23 — what no refresh can do: the owner's two consoles each end a sign-in a set time after it began.
    expect(texts(section)).toEqual(expect.arrayContaining([expect.stringContaining(
      'No refresh helps a site that signs you out a set time after you signed in, whatever you do there: when a site '
        + 'signs you out anyway, it says so here, with how long after you signed in.')]));
    // Follow-up 27 — the tab kept awake.
    expect(texts(section)).toEqual(expect.arrayContaining([expect.stringContaining(
      'While a tab shows it, the Bridge keeps the tab from being put to sleep and refreshes it every few minutes')]));
  });

  it('follow-up 26 — says when a site signed you out anyway, above what was last done, and not for a site stopped', () => {
    const signed_out = { at: at(14, 2), said: 'Signed out: its tab went to a sign-in page on signin.alibabacloud.com, '
      + 'though the Bridge had kept its session every 10 minutes since 08:01.' };
    const section = render(sitesWith([
      { entry: { site: 'modelstudio.console.alibabacloud.com', every_minutes: 10, mode: 'session' },
        status: { next_at: at(14, 20), last: { at: at(14, 10), what: 'skipped', said: 'Its tab is on a sign-in page.' }, signed_out } },
      { entry: { site: 'console.example.com', every_minutes: 10, mode: 'session' },
        status: { next_at: at(14, 20), last: { at: at(14, 10), what: 'kept', said: 'Kept the session.' } } },
      { entry: { site: 'ops.example.com', every_minutes: 30, mode: 'session', window: { until: at(17, 30) }, off: true },
        status: { signed_out } },
    ]));
    const line = one(section, SIDE_PANEL_KEEP_SIGNED_OUT_ATTR, 'modelstudio.console.alibabacloud.com');
    expect(line.textContent).toBe('14:02: Signed out: its tab went to a sign-in page on signin.alibabacloud.com, though the '
      + 'Bridge had kept its session every 10 minutes since 08:01.');
    expect(line.className).toBe('sites-explain sites-signed-out');
    expect(one(section, SIDE_PANEL_KEEP_STATUS_ATTR, 'modelstudio.console.alibabacloud.com').textContent)
      .toBe('14:10: Its tab is on a sign-in page. Next at 14:20.');
    // Said above the status, after how it is kept.
    const lines = texts(section);
    expect(lines.indexOf(line.textContent)).toBeLessThan(lines.indexOf('14:10: Its tab is on a sign-in page. Next at 14:20.'));
    expect(all(section, SIDE_PANEL_KEEP_SIGNED_OUT_ATTR).map((el) => el.getAttribute(SIDE_PANEL_KEEP_SIGNED_OUT_ATTR)))
      .toEqual(['modelstudio.console.alibabacloud.com']);
  });

  it('follow-up 29 — says under how a site is kept when it signed you out about as long after you signed in twice', () => {
    const SIX_HOURS = 363 * 60_000;
    const section = render(sitesWith([
      { entry: { site: 'modelstudio.console.alibabacloud.com', every_minutes: 10, mode: 'reload' },
        status: { next_at: at(14, 20), last: { at: at(14, 10), what: 'kept', said: 'Reloaded its tab.' },
          lasted: { ms: SIX_HOURS, mode: 'reload', again: 'set_time' } } },
      // Kept by its session both times: a reload advised, and not said once the site is reloaded.
      { entry: { site: 'console.example.com', every_minutes: 10, mode: 'session' },
        status: { lasted: { ms: 45 * 60_000, mode: 'session', again: 'try_reload' } } },
      { entry: { site: 'crm.example.com', every_minutes: 10, mode: 'reload' },
        status: { lasted: { ms: 45 * 60_000, mode: 'session', again: 'try_reload' } } },
      // Once only, nothing to say yet; nor for a site stopped.
      { entry: { site: 'erp.example.com', every_minutes: 10, mode: 'session' }, status: { lasted: { ms: SIX_HOURS, mode: 'session' } } },
      { entry: { site: 'ops.example.com', every_minutes: 30, mode: 'reload', window: { until: at(17, 30) }, off: true },
        status: { lasted: { ms: SIX_HOURS, mode: 'reload', again: 'set_time' } } },
    ]));
    const note = one(section, SIDE_PANEL_KEEP_LASTED_ATTR, 'modelstudio.console.alibabacloud.com');
    expect(note.textContent).toBe('It signed you out about 6 hours 3 minutes after you signed in, as the time before, though '
      + 'it was refreshed on time: it ends a sign-in a set time after it began, and no refresh helps, so you can stop keeping it.');
    expect(note.className).toBe('sites-explain');
    expect(one(section, SIDE_PANEL_KEEP_LASTED_ATTR, 'console.example.com').textContent).toBe('It signed you out about 45 '
      + 'minutes after you signed in, as the time before, though its session was kept on time. Try adding it again with '
      + 'Reload the page: if that does not keep you signed in either, it ends a sign-in a set time after it began, and no '
      + 'refresh helps.');
    expect(all(section, SIDE_PANEL_KEEP_LASTED_ATTR).map((el) => el.getAttribute(SIDE_PANEL_KEEP_LASTED_ATTR)))
      .toEqual(['modelstudio.console.alibabacloud.com', 'console.example.com']);
    // Right under how it is kept, above what was last done.
    const lines = texts(section);
    expect(lines.indexOf(note.textContent)).toBe(lines.indexOf('Every 10 minutes, reloading the page, always.') + 1);
    expect(lines.indexOf(note.textContent)).toBeLessThan(lines.indexOf('14:10: Reloaded its tab. Next at 14:20.'));
  });

  it('D-347 follow-up 20 — a site on the list of sites never to use is not added, and what was typed stays', () => {
    const onAddKeep = vi.fn();
    const section = render({ ...sitesWith([]), blocked: ['example.com'] }, { onAddKeep });
    const site = one(section, SIDE_PANEL_KEEP_FIELD_ATTR, 'site') as FakeElement & { value: string };
    site.value = 'console.example.com';
    click(one(section, SIDE_PANEL_KEEP_ADD_ATTR));
    expect(onAddKeep).not.toHaveBeenCalled();
    expect(one(section, SIDE_PANEL_KEEP_MESSAGE_ATTR).textContent)
      .toBe('console.example.com is on your list of sites never to use, so the Bridge leaves it alone.');
    expect(site.value).toBe('console.example.com');
  });

  it('follow-up 23 — a Chrome Web Store site is not added, either way of refreshing, and the card says why', async () => {
    const onAddKeep = vi.fn();
    const onKeepProblem = vi.fn();
    const section = render(sitesWith([]), { onAddKeep, onKeepProblem });
    const field = (key: string) => one(section, SIDE_PANEL_KEEP_FIELD_ATTR, key) as FakeElement & { value: string };
    for (const [typed, mode] of [['https://chrome.google.com/u/1/webstore/devconsole', 'session'],
      ['chrome.google.com', 'reload'], ['chromewebstore.google.com', 'session']] as const) {
      field('site').value = typed;
      field('mode').value = mode;
      click(one(section, SIDE_PANEL_KEEP_ADD_ATTR));
      await tick();
      expect(onAddKeep).not.toHaveBeenCalled();
      expect(one(section, SIDE_PANEL_KEEP_MESSAGE_ATTR).textContent).toBe(KEEP_SIGNED_IN_WEB_STORE_SAID);
      expect(field('site').value).toBe(typed);
    }
    // Kept in the section's state too, so the next status the timer writes does not wipe it (follow-up 22).
    expect(onKeepProblem).toHaveBeenLastCalledWith(KEEP_SIGNED_IN_WEB_STORE_SAID);
    // A site above it is added: its other pages are refreshed, its store pages left alone.
    field('site').value = 'google.com';
    click(one(section, SIDE_PANEL_KEEP_ADD_ATTR));
    expect(onAddKeep).toHaveBeenCalledWith({ site: 'google.com', every_minutes: 10, mode: 'session' });
  });
});

// D-347 follow-up 30 — Remove is an ×, and a site removed by it can be put back.
describe('Undo after a removal (D-347 follow-up 30)', () => {
  it('puts a site never to use back where it stood, focusing its Undo, then the × put back, once each', async () => {
    const { chrome, state } = fakeChrome(true, ['a.test', 'b.test', 'c.test']);
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveBlocked('b.test');
    expect(state.kept).toEqual(['a.test', 'c.test']);
    expect(last()).toMatchObject({ removed: { site: 'b.test', index: 1 }, focus: { attr: SIDE_PANEL_SITES_UNDO_ATTR, value: 'b.test' } });
    // Keep signed in's next status draws the section again: the offer stays, the focus is not given twice.
    await controls.refresh();
    expect([last().removed, last().focus]).toEqual([{ site: 'b.test', index: 1 }, undefined]);
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(['a.test', 'b.test', 'c.test']);
    expect([last().removed, last().focus]).toEqual([undefined, { attr: SIDE_PANEL_SITES_REMOVE_ATTR, value: 'b.test' }]);
    // Put back, the offer is over: removed from elsewhere (another window's panel), this panel offers nothing, and its
    // Undo does nothing.
    state.kept = ['a.test', 'c.test'];
    await controls.refresh();
    expect(last().removed).toBeUndefined();
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(['a.test', 'c.test']);
  });

  it('offers the last removal only, not once a site is added, and not while the site is listed again', async () => {
    const { chrome, state } = fakeChrome(true, ['a.test', 'b.test', 'c.test']);
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveBlocked('a.test');
    await controls.onRemoveBlocked('b.test');
    expect(last().removed).toEqual({ site: 'b.test', index: 0 });
    // A second click on a site already gone leaves the offer as it was.
    await controls.onRemoveBlocked('b.test');
    expect(last().removed).toEqual({ site: 'b.test', index: 0 });
    await controls.onAddBlocked('d.test');
    expect(last().removed).toBeUndefined();
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(['c.test', 'd.test']);
    // Listed again from elsewhere (the panel of another window): not offered, and Undo adds it no second time.
    await controls.onRemoveBlocked('c.test');
    state.kept = ['d.test', 'c.test'];
    await controls.refresh();
    expect(last().removed).toBeUndefined();
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(['d.test', 'c.test']);
  });

  it('puts it back at the end of a list grown shorter meanwhile, and holds the list to its most sites', async () => {
    const { chrome, state } = fakeChrome(true, ['a.test', 'b.test', 'c.test']);
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveBlocked('c.test');
    state.kept = ['a.test'];
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(['a.test', 'c.test']);
    await controls.onRemoveBlocked('a.test');
    const full = Array.from({ length: BLOCKED_SITES_MAX }, (_, i) => `site${String(i)}.test`);
    state.kept = full;
    await controls.onUndoRemoveBlocked();
    expect(state.kept).toEqual(full);
    expect(last().message).toBe(`The list holds at most ${String(BLOCKED_SITES_MAX)} sites.`);
  });

  it('a removal that could not be saved offers no Undo, in either list', async () => {
    const { chrome, state } = fakeChrome(true, ['a.test']);
    (chrome.storage.set as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('quota'); });
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveBlocked('a.test');
    expect(state.kept).toEqual(['a.test']);
    expect(last()).toMatchObject({ blocked: ['a.test'], message: 'Could not save the list. Try again.' });
    expect([last().removed, last().focus]).toEqual([undefined, undefined]);
    const keeping = keepChrome({ [KEEP_SIGNED_IN_KEY]: [{ site: 'a.example.com', every_minutes: 10, mode: 'session' }] });
    (keeping.chrome.storage.set as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('quota'); });
    const card = controlsOn(keeping.chrome);
    await card.controls.onRemoveKeep('a.example.com');
    expect(card.last()).toMatchObject({ keep_message: 'Could not save the list. Try again.' });
    expect([card.last().keep_removed, card.last().focus]).toEqual([undefined, undefined]);
  });

  it('puts a kept site back where it stood, with the settings and hours it had; each list offers its own', async () => {
    const weekdays = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
    const sites = [{ site: 'a.example.com', every_minutes: 10, mode: 'session' },
      { site: 'b.example.com', every_minutes: 5, mode: 'reload', window: weekdays },
      { site: 'c.example.com', every_minutes: 30, mode: 'session', window: { until: 1 }, off: true }];
    const { chrome, kept } = keepChrome({ [KEEP_SIGNED_IN_KEY]: structuredClone(sites), [BLOCKED_SITES_KEY]: ['mail.test'] });
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveKeep('b.example.com');
    expect(last()).toMatchObject({ keep_removed: { site: 'b.example.com', index: 1 },
      focus: { attr: SIDE_PANEL_KEEP_UNDO_ATTR, value: 'b.example.com' } });
    expect(last().removed).toBeUndefined();
    await controls.onRemoveBlocked('mail.test');
    expect(last()).toMatchObject({ removed: { site: 'mail.test', index: 0 }, keep_removed: { site: 'b.example.com', index: 1 } });
    // A second click on a site already gone leaves the offer as it was.
    await controls.onRemoveKeep('b.example.com');
    expect(last().keep_removed).toEqual({ site: 'b.example.com', index: 1 });
    await controls.onUndoRemoveKeep();
    expect(kept[KEEP_SIGNED_IN_KEY]).toEqual(sites);
    expect(last()).toMatchObject({ removed: { site: 'mail.test', index: 0 },
      focus: { attr: SIDE_PANEL_KEEP_REMOVE_ATTR, value: 'b.example.com' } });
    expect(last().keep_removed).toBeUndefined();
    // Put back, the offer is over: removed from elsewhere, this panel offers nothing.
    kept[KEEP_SIGNED_IN_KEY] = structuredClone(sites).filter(entry => entry.site !== 'b.example.com');
    await controls.refresh();
    expect(last().keep_removed).toBeUndefined();
    kept[KEEP_SIGNED_IN_KEY] = structuredClone(sites);
    // A site added to the card ends its offer; one listed again from elsewhere is not added twice.
    await controls.onRemoveKeep('a.example.com');
    await controls.onAddKeep({ site: 'd.example.com', every_minutes: 10, mode: 'session' });
    expect(last().keep_removed).toBeUndefined();
    await controls.onRemoveKeep('d.example.com');
    kept[KEEP_SIGNED_IN_KEY] = [...(kept[KEEP_SIGNED_IN_KEY] as unknown[]), { site: 'd.example.com', every_minutes: 1, mode: 'session' }];
    await controls.refresh();
    expect(last().keep_removed).toBeUndefined();
    await controls.onUndoRemoveKeep();
    expect((kept[KEEP_SIGNED_IN_KEY] as Array<{ site: string }>).filter(entry => entry.site === 'd.example.com')).toHaveLength(1);
  });

  it(`holds Keep signed in to its ${String(KEEP_SIGNED_IN_MAX_SITES)} sites, said in its own card`, async () => {
    const one = { site: 'a.example.com', every_minutes: 10, mode: 'session' };
    const { chrome, kept } = keepChrome({ [KEEP_SIGNED_IN_KEY]: [one] });
    const { controls, last } = controlsOn(chrome);
    await controls.onRemoveKeep('a.example.com');
    const full = Array.from({ length: KEEP_SIGNED_IN_MAX_SITES },
      (_, i) => ({ site: `s${String(i)}.example.com`, every_minutes: 10, mode: 'session' }));
    kept[KEEP_SIGNED_IN_KEY] = full;
    await controls.onUndoRemoveKeep();
    expect(kept[KEEP_SIGNED_IN_KEY]).toEqual(full);
    expect(last().keep_message).toBe(`Keep signed in holds at most ${String(KEEP_SIGNED_IN_MAX_SITES)} sites.`);
  });

  /** The rows and Undo rows of a list, in order: a site, or `undo <site>`. */
  const rowsOf = (root: FakeElement, row: string, undo: string): string[] => {
    const walk = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap(walk)];
    return walk(root).flatMap(el => (el.attrs.has(row) ? [el.getAttribute(row)!]
      : el.attrs.has(undo) ? [`undo ${el.getAttribute(undo)!}`] : []));
  };
  const byId = (root: FakeElement, id: string): FakeElement | undefined =>
    root.getAttribute('id') === id ? root : root.children.map(child => byId(child, id)).find(Boolean);

  it('in place of a site just removed: what its removal did, and Undo, described by it, which puts it back', () => {
    const onUndoRemoveBlocked = vi.fn();
    const section = render({ every_site: true, screenshots: false, blocked: ['a.test', 'c.test'], message: '',
      removed: { site: 'b.test', index: 1 } }, { onUndoRemoveBlocked });
    expect(rowsOf(section, SIDE_PANEL_SITES_ROW_ATTR, SIDE_PANEL_SITES_UNDO_ATTR)).toEqual(['a.test', 'undo b.test', 'c.test']);
    const undo = one(section, SIDE_PANEL_SITES_UNDO_ATTR, 'b.test');
    expect([undo.textContent, undo.getAttribute('aria-label')]).toEqual(['Undo', 'Undo removing b.test']);
    expect(byId(section, undo.getAttribute('aria-describedby')!)?.textContent).toBe('Removed b.test. Your AI may use it again.');
    click(undo);
    expect(onUndoRemoveBlocked).toHaveBeenCalledTimes(1);
    // Last when it stood last, or past a list grown shorter; with the empty list's line when none is left.
    expect(rowsOf(render({ every_site: true, screenshots: false, blocked: ['a.test'], message: '', removed: { site: 'z.test', index: 4 } }),
      SIDE_PANEL_SITES_ROW_ATTR, SIDE_PANEL_SITES_UNDO_ATTR)).toEqual(['a.test', 'undo z.test']);
    const empty = render({ every_site: true, screenshots: false, blocked: [], message: '', removed: { site: 'a.test', index: 0 } });
    expect(rowsOf(empty, SIDE_PANEL_SITES_ROW_ATTR, SIDE_PANEL_SITES_UNDO_ATTR)).toEqual(['undo a.test']);
    const walk = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap(walk)];
    expect(walk(empty).map(el => el.textContent)).toEqual(expect.arrayContaining([
      'No sites listed. A site here, and every page under it, is never read or acted on.', 'Removed a.test. Your AI may use it again.']));
  });

  it('in Keep signed in\'s card, in place of the site and its lines: that it stopped, and Undo', () => {
    const onUndoRemoveKeep = vi.fn();
    const section = render({ every_site: true, screenshots: false, blocked: [], message: '',
      keep: [{ entry: { site: 'a.example.com', every_minutes: 10, mode: 'session' } },
        { entry: { site: 'c.example.com', every_minutes: 10, mode: 'reload' } }],
      keep_removed: { site: 'b.example.com', index: 1 } }, { onUndoRemoveKeep });
    expect(rowsOf(section, SIDE_PANEL_KEEP_ROW_ATTR, SIDE_PANEL_KEEP_UNDO_ATTR))
      .toEqual(['a.example.com', 'undo b.example.com', 'c.example.com']);
    const undo = one(section, SIDE_PANEL_KEEP_UNDO_ATTR, 'b.example.com');
    expect(undo.getAttribute('aria-label')).toBe('Undo removing b.example.com');
    expect(byId(section, undo.getAttribute('aria-describedby')!)?.textContent).toBe('Stopped keeping b.example.com signed in.');
    click(undo);
    expect(onUndoRemoveKeep).toHaveBeenCalledTimes(1);
    // The list of sites never used offers nothing of it.
    expect(all(section, SIDE_PANEL_SITES_UNDO_ATTR)).toEqual([]);
  });
});
