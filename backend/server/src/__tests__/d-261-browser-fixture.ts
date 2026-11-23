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

/** A load event does not promise complete Bridge discovery. Retry only the
 * inventory read until its exact fixture URL has an observed page handle. */
export const observedFixturePage = async (read: () => Promise<Record<string, unknown>>, url: string, timeoutMs: number): Promise<string> => {
  const until = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  do {
    last = await read();
    const tab = Array.isArray(last.tabs) ? last.tabs.find(tab => tab?.url === url && typeof tab.page === 'string' && tab.page) : undefined;
    if (tab) return tab.page;
    if (Date.now() >= until) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error(`The Bridge did not identify fixture page ${url}. Last inventory: ${JSON.stringify(last)}`);
};

interface BrowserFixtureApi {
  scriptMetrics(): Promise<Array<{ script: string; duration_ms: number }>>;
  armWaitCapture(selector: string, afterReadText: string): Promise<void>;
  waitCaptureProbe(): Promise<{ hidden_reads: number; captures: number } | null>;
  documents(patterns?: string[]): Promise<BridgeDocumentIdentity[]>;
  openBackground(url: string, deadlineMs: number): Promise<void>;
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
/** Fixture navigation has the same bounded allowance in foreground and
 * background tabs. This is setup time, separate from recipe/command budgets. */
const PAGE_LOAD_MS = 30_000;

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
  /** Qualification only: compare an immutable source snapshot with this tree. */
  sourceRoot?: string;
  observeScripts?: boolean;
}

export const createReviewedBrowserFixture = async (url: string, options: ReviewedBrowserFixtureOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'd261-chrome-'));
  const extension = join(dir, 'extension'); mkdirSync(extension);
  const root = options.sourceRoot ?? fileURLToPath(new URL('../../../../', import.meta.url));
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'D261 controlled bridge',
    version: '1.0', permissions: ['tabs', 'scripting', 'storage'], host_permissions: options.hostPermissions ?? ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js', type: 'module' } }));
  try {
    await build({ stdin: { resolveDir: root, contents: `
import { buildActionExecutor } from './apps/bridge/src/actions/executor.ts';
import { describeOpenBridgeDocuments, executeReviewedBridgeDocument } from './apps/bridge/src/actions/reviewed-document.ts';
import { executeInChromeDocument, inspectPage, listChromeFrames } from './apps/bridge/src/actions/page-inspect.ts';
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
const scriptMetrics = [];
let waitCapture = null;
const scripting = {
  executeScript: async details => {
    const begun = performance.now();
    try {
      const results = await chrome.scripting.executeScript(details);
      const probe = waitCapture;
      if (probe && details.func === inspectPage && details.args?.[5]?.selector === probe.selector) {
        const read = results[0]?.result;
        if (read?.waiting) {
          const revealed = await chrome.scripting.executeScript({ target: details.target,
            func: selector => {
              const region = document.querySelector(selector);
              if (!(region instanceof HTMLElement) || !region.hidden) return false;
              region.hidden = false;
              return true;
            }, args: [probe.selector] });
          if (revealed[0]?.result !== true) throw new Error('Wait fixture did not observe a hidden region');
          probe.hidden_reads++;
        } else if (read?.outputs?.html !== undefined) {
          if (probe.hidden_reads === 0) throw new Error('Wait fixture captured before observing the hidden region');
          probe.captures++;
          // Change the live document before returning the captured bytes to the executor.
          // A second read would now return different content.
          await chrome.scripting.executeScript({ target: details.target,
            func: (selector, text) => {
              const region = document.querySelector(selector);
              if (!region) throw new Error('Wait fixture lost its captured region');
              region.append(document.createTextNode(text));
            }, args: [probe.selector, probe.afterReadText] });
        }
      }
      return results;
    }
    finally {
      if (${JSON.stringify(options.observeScripts === true)} && scriptMetrics.length < 1024) scriptMetrics.push({ script: details.func?.name ?? 'file',
        duration_ms: Math.max(0, performance.now() - begun) });
    }
  },
};
const executor = buildActionExecutor({
  executeReviewedDocument: (document, action, args) => executeReviewedBridgeDocument(scripting, document, action, args),
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
  executeInDocument: executeInChromeDocument(scripting),
  // D-335 slice R — as the extension binds it: a tab's frames, read where the Bridge may.
  listFrames: listChromeFrames(scripting),
  ...chromePageTabs(chrome.tabs, scripting),
  // As \`service-worker-entry.ts\` binds them (slice G).
  blockedSites: () => readBlockedSites(chrome.storage.local),
  tabUrl: async tabId => { try { return (await chrome.tabs.get(tabId)).url || null; } catch { return null; } },
  // D-335 slice H — the extension's own binding: the tab comes forward, then the owner's goes back.
  pageCapture: chromePageCapture(chrome, executeInChromeDocument(scripting)),
  captureVisibleTab: async () => null, showNotification: async () => '',
});
globalThis.d261 = {
  scriptMetrics: async () => scriptMetrics.splice(0),
  armWaitCapture: async (selector, afterReadText) => { waitCapture = { selector, afterReadText, hidden_reads: 0, captures: 0 }; },
  waitCaptureProbe: async () => waitCapture && ({ hidden_reads: waitCapture.hidden_reads, captures: waitCapture.captures }),
  // The inventory is scoped to granted origins (D-261 finding 7), so the
  // fixture supplies this extension's real \`host_permissions\` rather than a
  // wildcard — otherwise the scoping would be stubbed out of the one place it
  // runs against a real Chrome.
  // A caller may ask for one site (\`discovered\`): still only where this extension may script.
  documents: (patterns = ['http://127.0.0.1/*']) => describeOpenBridgeDocuments(chrome.tabs, chrome.scripting, patterns),
  // D-335 slice H — a tab behind the owner's, in the owner's window, as a step
  // opens one; and which tab is in front of each window.
  openBackground: async (url, deadlineMs) => {
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = await chrome.tabs.create({ url, active: false, ...(front ? { windowId: front.windowId } : {}) });
    const until = Date.now() + deadlineMs;
    for (;;) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete' && !current.pendingUrl && (current.url !== 'about:blank' || url === 'about:blank')) return;
      if (Date.now() >= until) throw new Error('d261: background tab did not finish within ' + deadlineMs + 'ms (status: '
        + current.status + '; url: ' + current.url + ')');
      await new Promise(r => setTimeout(r, 50));
    }
  },
  tabs: async () => (await chrome.tabs.query({})).map(tab => ({ url: tab.url, active: tab.active, window_id: tab.windowId })),
  grant: ingredient => grants.put(buildGrant(ingredient, ingredient.domain_allowlist, Date.now())),
  block: sites => chrome.storage.local.set({ [BLOCKED_SITES_KEY]: sites }),
  // D-269 REV 32 — clear stores and capture probes between scenarios.
  reset: async () => { waitCapture = null; await grants.clear(); await idempotency.clear(); await chrome.storage.local.remove(BLOCKED_SITES_KEY); },
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
      const pending = new Map<number, { operation: string; began: number }>();
      const recent: Array<{ operation: string; elapsed_ms: number; outcome: 'ok' | 'error' }> = [];
      let nextOperation = 0;
      const observe = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        const id = nextOperation++;
        const began = performance.now();
        pending.set(id, { operation, began });
        let outcome: 'ok' | 'error' = 'error';
        try {
          const result = await run();
          outcome = 'ok';
          return result;
        } finally {
          pending.delete(id);
          recent.push({ operation, elapsed_ms: Math.round(performance.now() - began), outcome });
          if (recent.length > 24) recent.shift();
        }
      };
      // Read without asking Chrome: diagnostics must also work when its worker is stuck.
      const diagnostics = () => ({
        pages: browser.pages().map(open => open.url()),
        pending: [...pending.values()].map(({ operation, began }) =>
          ({ operation, elapsed_ms: Math.round(performance.now() - began) })),
        recent: [...recent],
      });
      let page = await observe('create initial page', () => browser.newPage());
      await observe('load initial page', () => page.goto(url, { timeout: PAGE_LOAD_MS }));
      // The function is serialized by Playwright, so do not call the Node
      // closure `api` from inside these callbacks.
      const documents = (patterns?: string[]) => observe('inventory documents', () => worker.evaluate((input) =>
        (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.documents(input ?? undefined), patterns ?? null));
      return {
        browser,
        diagnostics,
        // ⚠ A GETTER, because `reset` replaces the page. One scenario CLOSES
        // this page (`closed`) and another opens a second one (`ambiguous`), so
        // a captured reference would go stale the moment the browser is reused.
        get page() { return page; },
        scriptMetrics: () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.scriptMetrics()),
        /** Reveal only after the real fused wait/read reports a hidden region. Once it
         *  captures, append text before returning so a second read cannot pass as atomic. */
        armWaitCapture: (selector: string, afterReadText: string) => worker.evaluate(input =>
          (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.armWaitCapture(input.selector, input.afterReadText), { selector, afterReadText }),
        waitCaptureProbe: () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.waitCaptureProbe()),
        documents,
        /** The page at `url` once the Bridge's own inventory holds it: another document than the one the
         *  page handle `other` names, after a reload. ⛔ A load does not promise the Bridge has found the
         *  page yet (`observedFixturePage`): Chrome's tab query and its script in the tab can lag a page
         *  that just loaded, so a step taken at once missed it — a listing found no tab, a step finding its
         *  tab by address opened another, a reloaded page was not recovered (red in sweeps now and then;
         *  forced by keeping each page out of the Bridge's sight for 1.5 s). Read in the extension, as
         *  `documents()` (the tab query and the script in each tab that a listing runs too), so no command,
         *  audit or answer is spent on it. Only a page that inventory can hold: on `127.0.0.1`, and never
         *  the owner's Recued client. */
        discovered: async (url: string, other?: string): Promise<BridgeDocumentIdentity> => {
          const until = Date.now() + PAGE_LOAD_MS;
          const otherDocument = other?.split(':').at(-1);
          // The page's own site, any port: a fixture granted other sites than 127.0.0.1 (D-402 slice H6's
          // site-a.test) inventories them too.
          const { protocol, hostname } = new URL(url);
          for (;;) {
            const inventory = await documents([`${protocol}//${hostname}/*`]);
            const found = inventory.find((document) => document.url === url && document.document_id !== otherDocument);
            if (found) return found;
            if (Date.now() >= until) {
              throw new Error(`The Bridge did not find ${url}${other ? ` after ${other}` : ''} within ${PAGE_LOAD_MS} ms. `
                + `Last inventory: ${JSON.stringify(inventory)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
        /** Open `url` in a new tab behind the one in front of its window, and wait for it to load.
         *  A load still unfinished after `deadlineMs` (by default `PAGE_LOAD_MS`) fails naming the
         *  tab's status and address. ⚠ The calling test needs a limit of its own longer than that
         *  deadline (vitest's default is also 30 s), or a stuck load ends as a bare
         *  `Test timed out` that names nothing. */
        openBackground: (url: string, { deadlineMs = PAGE_LOAD_MS }: { deadlineMs?: number } = {}) => observe('load background tab', () => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.openBackground(input.url, input.deadlineMs), { url, deadlineMs })),
        /** Every tab, and whether it is the one in front of its window. */
        tabs: () => observe('inventory tabs', () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.tabs())),
        grant: (ingredient: BridgeIngredientRef) => observe('grant ingredient', () => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.grant(input), ingredient)),
        /** The owner's list of sites Recued must never use, as the side panel saves it. */
        block: (sites: string[]) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.block(input), sites),
        command: (command: BridgeCommand) => observe(`reviewed command: ${command.action}`, () => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.command(input), command)),
        ordinaryCommand: (command: BridgeCommand) => observe(`ordinary command: ${command.action}`, () => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.ordinaryCommand(input), command)),
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
          await observe('reset extension state', () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.reset()));
          // Keep the window alive while replacing its tabs. Closing its last tab destroys it;
          // the replacement would then race a new window's focus and extension inventory.
          const previous = browser.pages();
          page = await observe('create replacement page', () => browser.newPage());
          for (const open of previous) await observe('close previous page', () => open.close());
          await observe('load replacement page', () => page.goto(nextUrl, { timeout: PAGE_LOAD_MS }));
          await observe('activate replacement page', () => page.bringToFront());
        },
        async close() { await browser.close(); rmSync(dir, { recursive: true, force: true }); },
      };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
};
