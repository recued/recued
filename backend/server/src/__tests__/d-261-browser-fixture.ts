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
  grant(ingredient: BridgeIngredientRef): Promise<void>;
  command(command: BridgeCommand): Promise<{ result: BridgeResult }>;
  ordinaryCommand(command: BridgeCommand): Promise<{ result: BridgeResult }>;
}

export const createReviewedBrowserFixture = async (url: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'd261-chrome-'));
  const extension = join(dir, 'extension'); mkdirSync(extension);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'D261 controlled bridge',
    version: '1.0', permissions: ['tabs', 'scripting'], host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js', type: 'module' } }));
  try {
    await build({ stdin: { resolveDir: root, contents: `
import { buildActionExecutor } from './apps/bridge/src/actions/executor.ts';
import { describeOpenBridgeDocuments, executeReviewedBridgeDocument } from './apps/bridge/src/actions/reviewed-document.ts';
import { dispatchBridgeCommand } from './apps/bridge/src/queue/dispatcher.ts';
import { createInMemoryBridgeGrantStore, buildGrant } from './apps/bridge/src/permissions/grants.ts';
import { createInMemoryIdempotencyCache } from './apps/bridge/src/idempotency/cache.ts';
const grants = createInMemoryBridgeGrantStore();
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
  captureVisibleTab: async () => null, showNotification: async () => '',
});
globalThis.d261 = {
  // The inventory is scoped to granted origins (D-261 finding 7), so the
  // fixture supplies this extension's real \`host_permissions\` rather than a
  // wildcard — otherwise the scoping would be stubbed out of the one place it
  // runs against a real Chrome.
  documents: () => describeOpenBridgeDocuments(chrome.tabs, chrome.scripting, ['http://127.0.0.1/*']),
  grant: ingredient => grants.put(buildGrant(ingredient, ingredient.domain_allowlist, Date.now())),
  command: command => dispatchBridgeCommand(command, { bridge_version: '1', now: Date.now, grants, idempotency, executor }),
  ordinaryCommand: command => dispatchBridgeCommand(command, { bridge_version: '1', now: Date.now, grants, idempotency, executor: ordinaryExecutor }),
};` }, outfile: join(extension, 'worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120',
      resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: resolve(root, 'apps/bridge/tsconfig.json'), logLevel: 'silent' });
    const browser = await chromium.launchPersistentContext(join(dir, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker: Worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
      const page = await browser.newPage(); await page.goto(url);
      return { browser, page,
        // The function is serialized by Playwright, so do not call the Node
        // closure `api` from inside these callbacks.
        documents: () => worker.evaluate(() => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.documents()),
        grant: (ingredient: BridgeIngredientRef) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.grant(input), ingredient),
        command: (command: BridgeCommand) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.command(input), command),
        ordinaryCommand: (command: BridgeCommand) => worker.evaluate(input => (globalThis as typeof globalThis & { d261: BrowserFixtureApi }).d261.ordinaryCommand(input), command),
        async close() { await browser.close(); rmSync(dir, { recursive: true, force: true }); },
      };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
};
