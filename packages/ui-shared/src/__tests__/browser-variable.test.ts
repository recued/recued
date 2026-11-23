/** D-402 slice H2b — a setting that names one of the owner's browsers: its row, what its list offers,
 *  and the one it starts on. */
import { describe, expect, it, vi } from 'vitest';
import { asBrowserWidget, BROWSER_VARIABLE_ATTR, renderVariableWidget, toWidgetShape, validateWidgetValue } from '../variable-widgets.js';
import { browserOptions, browserPrefill, memoBrowserCallers, type BrowserChoice } from '../browser-variable.js';

const WORK: BrowserChoice = { browser_id: 'inst-work', name: 'Work', online: true };
const HOME: BrowserChoice = { browser_id: 'inst-home', name: 'Home', online: false };

describe('D-402 slice H2b — the row', () => {
  it('only a text setting the server named becomes a browser; the list holds the saved one until it loads', () => {
    const shape = asBrowserWidget(toWidgetShape('browser_1', 'inst-work'), [{ key: 'browser_1' }]);
    expect(shape).toMatchObject({ key: 'browser_1', label: 'Browser 1', type: 'browser', value: 'inst-work' });
    expect(asBrowserWidget(toWidgetShape('query', 'lamps'), [{ key: 'browser_1' }]).type).toBe('text');
    const html = renderVariableWidget(shape, { browserPicker: true });
    expect(html).toContain(`${BROWSER_VARIABLE_ATTR}="browser_1"`);
    expect(html).toContain('<option value="inst-work" selected>Loading your browsers…</option>');
    // Without the list, the text box it was.
    expect(renderVariableWidget(shape, {})).not.toContain(BROWSER_VARIABLE_ATTR);
  });
  it('must be chosen', () => {
    const shape = asBrowserWidget(toWidgetShape('browser', ''), [{ key: 'browser' }]);
    expect(validateWidgetValue(shape, '')).toBe('Required');
    expect(validateWidgetValue(shape, 'inst-work')).toBeNull();
  });
});

describe('D-402 slice H2b — what the list offers', () => {
  it('each paired browser by name, one not connected said so, holding the lasting id', () => {
    expect(browserOptions([WORK, HOME], 'inst-work')).toEqual([
      { value: 'inst-home', label: 'Home (not connected)', selected: false },
      { value: 'inst-work', label: 'Work', selected: true },
    ]);
  });
  it('⛔ keeps a browser no longer paired, saying so: a save must not drop it', () => {
    expect(browserOptions([WORK], 'inst-gone')[0]).toEqual({ value: 'inst-gone', label: 'A browser no longer paired', selected: true });
  });
  it('asks with nothing held, and with nothing paired says where a browser comes from', () => {
    expect(browserOptions([WORK], '')[0]).toEqual({ value: '', label: 'Choose a browser', selected: true });
    expect(browserOptions([], '')).toEqual([{ value: '', label: 'No browser is paired yet: pair one with the Browser Bridge.', selected: true }]);
  });
  it('starts on the only paired browser, and on none when there are several or one is held', () => {
    expect(browserPrefill([WORK], '')).toBe('inst-work');
    expect(browserPrefill([WORK, HOME], '')).toBeNull();
    expect(browserPrefill([WORK], 'inst-home')).toBeNull();
  });
  it('the list is read once for a surface that paints more than once', async () => {
    const list = vi.fn(async () => [WORK]);
    const memo = memoBrowserCallers({ list });
    await memo.list(); await memo.list();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
