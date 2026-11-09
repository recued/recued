/** D-335 slice G — the side panel's Sites section: Chrome's grant of every site,
 *  and the owner's list of sites Recued must never use. */

import { describe, expect, it, vi } from 'vitest';
import { BLOCKED_SITES_KEY, BLOCKED_SITES_MAX, EVERY_SITE, SCREENSHOTS_GRANT } from '../../permissions/site-grants.js';
import { KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_MAX_SITES, KEEP_SIGNED_IN_STATUS_KEY } from '../../keep-signed-in.js';
import { createSitesControls, type SitesChrome } from '../sites.js';
import type { SidePanelSitesState } from '../store/local-store.js';
import { createSidePanelStore } from '../store/local-store.js';
import {
  SIDE_PANEL_KEEP_ADD_ATTR,
  SIDE_PANEL_KEEP_FIELD_ATTR,
  SIDE_PANEL_KEEP_MESSAGE_ATTR,
  SIDE_PANEL_KEEP_REMOVE_ATTR,
  SIDE_PANEL_KEEP_ROW_ATTR,
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
    expect(last()).toEqual({ every_site: true, screenshots: false, blocked: ['mail.test'], message: '', keep: [] });
  });

  it(`holds at most ${BLOCKED_SITES_MAX} sites`, async () => {
    const full = Array.from({ length: BLOCKED_SITES_MAX }, (_, i) => `site${i}.test`);
    const { chrome, state } = fakeChrome(true, full);
    const { controls, last } = controlsOn(chrome);
    await controls.onAddBlocked('one-more.test');
    expect(state.kept).toEqual(full);
    expect(last().message).toBe(`The list holds at most ${BLOCKED_SITES_MAX} sites.`);
  });

  it('a list that cannot be read says the Bridge acts on no page, and the next change writes it afresh', async () => {
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
const fakeDocument = () => ({
  createElement(tagName: string): FakeElement {
    const el: FakeElement = {
      tagName: tagName.toUpperCase(), textContent: '', className: '', children: [], attrs: new Map(), listeners: new Map(),
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      addEventListener(type, handler) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), handler]); },
      appendChild(child) { el.children.push(child); return child; },
    };
    return el;
  },
});
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
});
