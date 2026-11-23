/** D-402 slice H4d — a pass for a recipe that names its browsers says which browser, wherever the owner
 *  sees it: the Contracts list and its suggestions, through the rpc, named from the real routing that
 *  the composition root reads (`browserPassBrowserFrom`); and the notice when a suggestion opens. A pass
 *  whose browser is no longer paired is said to be, by the name it went by. A pass whose key names no
 *  browser (every Browser Toolkit pass) reads as it did. The ask itself is proved through
 *  `handleExecute` in `d-402-browser-check.test.ts`. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { BrowserPassKey } from '@recued/contracts';

import { browserPassBrowserFrom, createBrowserPassRpcHandlers } from '../browser-pass-rpc.js';
import { browserPassSuggestedNotice } from '../browser-passes.js';
import { createBridgeDispatcher, createBridgeResultListener } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { stripSourceComments } from './helpers/source-guards.js';

const NOW = 1_763_000_000_000;
const ROSTER = [
  { bridge_id: 'tok-work', bridge_label: 'Work', browser_id: 'inst-work' },
  { bridge_id: 'tok-home', bridge_label: 'Home', browser_id: 'inst-home' },
];
/** Routing as the server builds it: the paired browsers, and the name any browser went by. */
const routing = () => createBridgeDispatcher({
  registry: createBridgeRegistry(), listener: createBridgeResultListener(), pairedBridges: () => ROSTER,
  browserName: (id) => ({ 'inst-home': 'Home', 'inst-work': 'Work', 'inst-old': 'Old laptop' } as Record<string, string>)[id],
  transport: { cancel: async () => ({ ok: true }), send: async () => ({ ok: true }) },
});
const HOME_KEY: BrowserPassKey = { principal: { kind: 'owner_chat' }, recipe: 'send-orders', site: 'https://b.example', browser: 'inst-home' };
const { browser: _browser, ...NO_BROWSER } = HOME_KEY;

describe('D-402 slice H4d — the browser a pass names, as routing knows it', () => {
  it('paired: its owner\'s name; no longer paired: the name it went by, and that it is gone', () => {
    const browserOf = browserPassBrowserFrom(() => routing());
    expect(browserOf('inst-home')).toEqual({ name: 'Home', paired: true });
    expect(browserOf('inst-old')).toEqual({ name: 'Old laptop', paired: false });
    expect(browserOf('inst-never')).toEqual({ paired: false });
    // With no routing to read, nothing is claimed either way.
    expect(browserPassBrowserFrom(() => undefined)('inst-home')).toEqual({});
  });
});

describe('D-402 slice H4d — the passes list and its suggestions, through the rpc', () => {
  const setup = () => {
    const store = createBrowserPassStore(new Database(':memory:'));
    const rpc = createBrowserPassRpcHandlers({ store, browserOf: browserPassBrowserFrom(() => routing()), now: () => NOW });
    return { store, rpc };
  };

  it('each pass by the browser it was granted in, one whose browser is gone said to be, one with none as it was', async () => {
    const { store, rpc } = setup();
    store.mint({ key: HOME_KEY, host: 'b.example', kind: 'always', now: NOW });
    store.mint({ key: { ...HOME_KEY, browser: 'inst-old' }, host: 'b.example', kind: 'always', now: NOW + 1 });
    store.mint({ key: { ...NO_BROWSER, recipe: 'click-web-element' }, host: 'b.example', kind: 'always', now: NOW + 2 });
    const { passes } = await rpc['collection.contract.listBrowserPasses']();
    expect(Object.fromEntries(passes.map((pass) => [pass.key.browser ?? 'none', [pass.browser_name, pass.browser_paired]])))
      .toEqual({ 'inst-home': ['Home', true], 'inst-old': ['Old laptop', false], none: [undefined, undefined] });
    expect(passes.find((pass) => pass.key.browser === undefined)).not.toHaveProperty('browser_name');
    // Ended, the pass the answer returns is still named.
    const home = passes.find((pass) => pass.key.browser === 'inst-home')!;
    expect((await rpc['collection.contract.revokeBrowserPass']({ pass_id: home.pass_id })).pass)
      .toMatchObject({ pass_id: home.pass_id, browser_name: 'Home', browser_paired: true });
  });

  it('a suggestion for one browser names it, and so does the pass accepting it mints', async () => {
    const { store, rpc } = setup();
    let suggested = false;
    for (let i = 0; i < 20 && !suggested; i += 1) {
      suggested = store.recordAnswer({ run_id: `run-${i}`, key: HOME_KEY, host: 'b.example', outcome: 'approved',
        occasion: `chat:s|day-${i}`, element: 'button “Send”', at: NOW - 20 + i }).suggested;
    }
    expect(suggested).toBe(true);
    const { suggestions } = await rpc['collection.contract.listBrowserPassSuggestions']();
    expect(suggestions.map((row) => [row.key.browser, row.browser_name, row.browser_paired])).toEqual([['inst-home', 'Home', true]]);
    const accepted = await rpc['collection.contract.acceptBrowserPassSuggestion']({ key_hash: suggestions[0]!.key_hash });
    expect(accepted.pass).toMatchObject({ key: HOME_KEY, browser_name: 'Home', browser_paired: true });
    expect(accepted.suggestion).toMatchObject({ browser_name: 'Home', browser_paired: true });
  });
});

describe('D-402 slice H4d — the notice when a suggestion opens', () => {
  it('its title names the browser of a key that names one', () => {
    expect(browserPassSuggestedNotice(HOME_KEY, { name: 'Home' }).title).toBe('Always allow? Run send-orders on b.example in “Home”');
    expect(browserPassSuggestedNotice({ ...NO_BROWSER, recipe: 'click-web-element' }).title).toBe('Always allow? Click on b.example');
  });
});

describe('D-402 slice H4d — the composition root names passes from routing', () => {
  // ⛔ The rpc names nothing without its dep, and only the composition root can read routing: unit tests
  // that hand the rpc a resolver pass whether or not the server does.
  it('compose-listeners hands the contract handler a resolver over routing, read at each call', () => {
    const source = stripSourceComments(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'), 'utf-8'));
    expect(source).toMatch(/browserPassBrowserOf: browserPassBrowserFrom\(\(\) => execution\.executeDeps\.executorConfig\.bridgeDispatcherRef\?\.\(\)\)/);
  });
});
