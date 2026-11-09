import { describe, it, expect } from 'vitest';
import {
  captureMatchedVisibleTab,
  type ChromeTabsForCapture,
} from '../actions/capture-matched-tab.js';

/** D-169 bridge security hunt, F1 — `captureMatchedVisibleTab` must capture
 *  ONLY the matched tab (the one resolved for the command's domain pattern),
 *  never whatever tab is merely foregrounded in the window. */
describe('F1 — screenshot matched-tab confinement', () => {
  const PATTERN = '*://app.hubspot.com/*';
  const matchedArgs = { tab_id: 7, window_id: 42, url_pattern: PATTERN };

  const makeTabs = (overrides: Partial<ChromeTabsForCapture> = {}): {
    tabs: ChromeTabsForCapture;
    calls: { updated: Array<{ tabId: number; active?: boolean }>; queried: unknown[]; captured: Array<number | undefined> };
  } => {
    const calls = {
      updated: [] as Array<{ tabId: number; active?: boolean }>,
      queried: [] as unknown[],
      captured: [] as Array<number | undefined>,
    };
    const tabs: ChromeTabsForCapture = {
      async update(tabId, opts) {
        calls.updated.push({ tabId, ...opts });
      },
      // Default: the matched tab IS the active tab and still matches.
      async query(opts) {
        calls.queried.push(opts);
        return [{ id: 7, url: 'https://app.hubspot.com/x' }];
      },
      async captureVisibleTab(windowId) {
        calls.captured.push(windowId);
        return 'data:image/png;base64,OK';
      },
      ...overrides,
    };
    return { tabs, calls };
  };

  it('captures when the matched tab is the confirmed active tab + still matches', async () => {
    const { tabs, calls } = makeTabs();
    const out = await captureMatchedVisibleTab(tabs, matchedArgs);
    expect(out).toBe('data:image/png;base64,OK');
    // It brought the MATCHED tab to the front, then captured its window.
    expect(calls.updated).toEqual([{ tabId: 7, active: true }]);
    expect(calls.captured).toEqual([42]);
  });

  it('fails closed (null, no capture) when a DIFFERENT tab is active in the window', async () => {
    const { tabs, calls } = makeTabs({
      // Activation didn't stick / a different tab is foregrounded.
      async query() {
        return [{ id: 9, url: 'https://bank.example/account' }];
      },
    });
    const out = await captureMatchedVisibleTab(tabs, matchedArgs);
    expect(out).toBeNull();
    expect(calls.captured).toEqual([]); // never captured the wrong tab's pixels
  });

  it('fails closed when the active tab no longer matches the command pattern', async () => {
    const { tabs, calls } = makeTabs({
      // chrome's match engine returns nothing → the active tab navigated away
      // from the granted domain between match and capture.
      async query() {
        return [];
      },
    });
    const out = await captureMatchedVisibleTab(tabs, matchedArgs);
    expect(out).toBeNull();
    expect(calls.captured).toEqual([]);
  });

  it('fails closed when activation throws', async () => {
    const { tabs } = makeTabs({
      async update() {
        throw new Error('tab closed');
      },
    });
    const out = await captureMatchedVisibleTab(tabs, matchedArgs);
    expect(out).toBeNull();
  });
});
