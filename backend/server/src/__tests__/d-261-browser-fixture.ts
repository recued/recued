/** Controlled Chrome endpoint for the actual server WS/bridge/recipe tests.
 * Uses real Chrome documentIds and the shipped bridge queue/action functions.
 * The extension's permission/idempotency stores are isolated test stores; this
 * fixture does not claim to exercise the complete extension boot/pairing UI. */
import { build } from 'esbuild';
import { chromium, type Worker } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeCommand, BridgeDocumentIdentity, BridgeIngredientRef, BridgeResult } from '@recued/contracts';

interface BrowserFixtureApi {
  documents(): Promise<BridgeDocumentIdentity[]>;
  openBackground(url: string): Promise<void>;
  tabs(): Promise<Array<{ url: string; active: boolean; window_id: number }>>;
  grant(ingredient: BridgeIngredientRef): Promise<void>;
  block(sites: string[]): Promise<void>;
  reset(): Promise<void>;
  command(command: BridgeCommand): Promise<{ result: BridgeResult }>;
  ordinaryCommand(command: BridgeCommand): Promise<{ result: BridgeResult }>;
}

/** How long Chrome may take to actually start the extension's service worker.
 *  ⚠ Generous ON PURPOSE — this is a scheduling wait under load, not work, and
 *  the point is a NAMED failure rather than a tighter one. Override with
 *  `D261_WORKER_READY_MS` if a machine needs more. */
const WORKER_READY_MS = Number(process.env.D261_WORKER_READY_MS ?? 180_000);

const workerReady = async (worker: Worker): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.evaluate(() => 1),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `d261: the extension service worker did not start within ${WORKER_READY_MS}ms. `
            + 'Chrome had registered it but never evaluated its module — usually CPU '
            + 'starvation from a concurrent full suite. See D-269 REV 31.')),
          WORKER_READY_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** D-335 slice G — `siteGrants: 'chrome'` builds the Bridge's grant store as the
 *  extension does (`createKernelSiteGrantStore`): a kernel ingredient's grant is
 *  the host permissions Chrome holds for this extension, `hostPermissions`, and
 *  `grant` serves only other publishers. The default keeps the grants the tests
 *  put by hand. Either way the owner's list of blocked sites is the extension's
 *  own (`chrome.storage.local`, set with `block`). */
export interface ReviewedBrowserFixtureOptions {
  hostPermissions?: string[];
  siteGrants?: 'manual' | 'chrome';
}

export const createReviewedBrowserFixture = async (url: string, options: ReviewedBrowserFixtureOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'd261-chrome-'));
  const extension = join(dir, 'extension'); mkdirSync(extension);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'D261 controlled bridge',
    version: '1.0', permissions: ['tabs', 'scripting', 'storage'], host_permissions: options.hostPermissions ?? ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js', type: 'module' } }));
  try {
    await build({ stdin: { resolveDir: root, contents: `
import { buildActionExecutor } from './apps/bridge/src/actions/executor.ts';
import { describeOpenBridgeDocuments, executeReviewedBridgeDocument } from './apps/bridge/src/actions/reviewed-document.ts';
import { executeInChromeDocument, listChromeFrames } from './apps/bridge/src/actions/page-inspect.ts';
import { chromePageCapture } from './apps/bridge/src/actions/page-capture.ts';
import { chromePageTabs } from './apps/bridge/src/actions/page-tabs.ts';
import { dispatchBridgeCommand } from './apps/bridge/src/queue/dispatcher.ts';
import { createInMemoryBridgeGrantStore, buildGrant } from './apps/bridge/src/permissions/grants.ts';
import { BLOCKED_SITES_KEY, createKernelSiteGrantStore, readBlockedSites } from './apps/bridge/src/permissions/site-grants.ts';
import { createInMemoryIdempotencyCache } from './apps/bridge/src/idempotency/cache.ts';
const manual = createInMemoryBridgeGrantStore();
const grants = ${JSON.stringify(options.siteGrants ?? 'manual')} === 'chrome'
  ? createKernelSiteGrantStore({ grantedOrigins: async () => (await chrome.permissions.getAll()).origins ?? [], fallback: manual })
  : manual;
const idempotency = createInMemoryIdempotencyCache();
const executor = buildActionExecutor({
  executeReviewedDocument: (document, action, args) => executeReviewedBridgeDocument(chrome.scripting, document, action, args),
  findTabByUrlPattern: async () => { throw new Error('Reviewed calls must not select another tab'); },
  executeScript: async () => { throw new Error('Reviewed calls require Chrome documentIds'); },
  captureVisibleTab: async () => null, showNotification: async () => '',
});
const ordinaryExecutor = buildActionExecutor({
  findTabByUrlPattern: async pattern => {
    const tab = (await chrome.tabs.query({ url: pattern }))[0];
    return tab ? { tab_id: tab.id, url: tab.url, window_id: tab.windowId } : null;
  },
  executeScript: async (tabId, func, args) => (await chrome.scripting.executeScript({ target: { tabId }, func,
    args: args.value === undefined ? [args.selector] : [args.selector, args.value] }))[0].result,
  // The extension's own binding (service-worker-entry.ts), not a stand-in.
  executeInDocument: executeInChromeDocument(chrome.scripting),
  // D-335 slice R — as the extension binds it: a tab's frames, read where the Bridge may.
  listFrames: listChromeFrames(chrome.scripting),
  ...chromePageTabs(chrome.tabs, chrome.scripting),
  // As \`service-worker-entry.ts\` binds them (slice G).
  blockedSites: () => readBlockedSites(chrome.storage.local),
  tabUrl: async tabId => { try { return (await chrome.tabs.get(tabId)).url || null; } catch { return null; } },
  // D-335 slice H — the extension's own binding: the tab comes forward, then the owner's goes back.
  pageCapture: chromePageCapture(chrome, executeInChromeDocument(chrome.scripting)),
  captureVisibleTab: async () => null, showNotification: async () => '',
});
globalThis.d261 = {
  // The inventory is scoped to granted origins (D-261 finding 7), so the
  // fixture supplies this extension's real \`host_permissions\` rather than a
  // wildcard — otherwise the scoping would be stubbed out of the one place it
  // runs against a real Chrome.
  documents: () => describeOpenBridgeDocuments(chrome.tabs, chrome.scripting, ['http://127.0.0.1/*']),
  // D-335 slice H — a tab behind the owner's, in the owner's window, as a step
  // opens one; and which tab is in front of each window.
  openBackground: async url => {
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = await chrome.tabs.create({ url, active: false, ...(front ? { windowId: front.windowId } : {}) });
    for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await new Promise(r => setTimeout(r, 50));
  },
  tabs: async () => (await chrome.tabs.query({})).map(tab => ({ url: tab.url, active: tab.active, window_id: tab.windowId })),
  grant: ingredient => grants.put(buildGrant(ingredient, ingredient.domain_allowlist, Date.now())),
  block: sites => chrome.storage.local.set({ [BLOCKED_SITES_KEY]: sites }),
  // D-269 REV 32 — everything the worker remembers between scenarios. Both
  // stores expose \`clear\`; nothing else here is stateful.
  reset: async () => { await grants.clear(); await idempotency.clear(); await chrome.storage.local.remove(BLOCKED_SITES_KEY); },
  command: command => dispatchBridgeCommand(command, { bridge_version: '1', now: Date.now, grants, idempotency, executor }),
  ordinaryCommand: command => dispatchBridgeCommand(command, { bridge_version: '1', now: Date.now, grants, idempotency, executor: ordinaryExecutor }),
};` }, outfile: join(extension, 'worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120',
      resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: resolve(root, 'apps/bridge/tsconfig.json'), logLevel: 'silent' });
    const browser = await chromium.launchPersistentContext(join(dir, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker: Worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
      // ⛔⛔ `waitForEvent('serviceworker')` FIRES ON REGISTRATION, NOT ON THE
      // MODULE HAVING EVALUATED. Without the line below the handle comes back in
      // 2–4s and the launch LOOKS done, while the first `worker.evaluate`
      // anywhere downstream silently absorbs Chrome's MV3 cold start — measured
      // at up to 415s under full-suite CPU pressure, landing at random on
      // whichever call happened to be first (it was `grant`, which was never
      // itself slow). ⇒ Pay it HERE, where it belongs, and bound it, so the
      // failure says what it is instead of arriving as a bare test timeout.
      await workerReady(worker);
      let page = await browser.newPage(); await page.goto(url);
      return {
        browser,
        // ⚠ A GETTER, because `reset` replaces the page. One scenario CLOSES
        // this page (`closed`) and another opens a second one (`ambiguous`), so
        // a captured reference would go stale the moment the browser is reused.
        get page() { return page; },
        // The function is serialized by Playwright, so do not call the Node
        // closure `api` from inside these callbacks.
        documents: () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.documents()),
        /** Open `url` in a new tab behind the one in front of its window. */
        openBackground: (url: string) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.openBackground(input), url),
        /** Every tab, and whether it is the one in front of its window. */
        tabs: () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.tabs()),
        grant: (ingredient: BridgeIngredientRef) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.grant(input), ingredient),
        /** The owner's list of sites Recued must never use, as the side panel saves it. */
        block: (sites: string[]) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.block(input), sites),
        command: (command: BridgeCommand) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.command(input), command),
        ordinaryCommand: (command: BridgeCommand) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.ordinaryCommand(input), command),
        /** ⛔⛔ RESTORE A PRISTINE BROWSER, so twelve scenarios can share ONE.
         *  Twelve MV3 cold starts were the whole cost (D-269 REV 31); one is
         *  affordable. But sharing is only safe if NOTHING survives a scenario:
         *   · the worker's grant store and idempotency cache — cleared in-page;
         *   · every tab — `documents()` enumerates open tabs scoped to
         *     `127.0.0.1/*`, so a leftover from the previous scenario would be
         *     inventoried as if it belonged to this one;
         *   · the page itself — reopened, since `closed` closes it.
         *  ⚠ A reset that misses one of these does not fail loudly; it makes a
         *  LATER scenario pass or fail on an EARLIER one's leavings. */
        async reset(nextUrl: string) {
          await worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.reset());
          for (const open of browser.pages()) await open.close();
          page = await browser.newPage();
          await page.goto(nextUrl);
        },
        async close() { await browser.close(); rmSync(dir, { recursive: true, force: true }); },
      };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
};
