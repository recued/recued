/** D-402 slice H3c (ruling 14) — a run its browser stopped before step 1, in a real browser: the run
 *  dialog says why (the server's reason), what else to do, links the dish's settings, and moves the dish
 *  to the one browser offered in one click ("Use “Home” instead"), then says where it acts now. The
 *  webclient's own dialog (`wireRunModal`, `setRunModalBrowserMove`), as every run dialog wires it. */

import { expect, test, type Page } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';

const esbuild: BuildOptions = { bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' };
const REASON = '“Old laptop”, the browser this recipe acts in, is no longer paired: choose the browser to use instead in the '
  + 'recipe\'s settings. Nothing was done.';
let bundle: string;
let tokens: string;
test.beforeAll(async () => {
  bundle = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { setRunModalBrowserMove, wireRunModal } from './apps/webclient/src/shell/run-modal.ts';
    const params = new URL(location.href).searchParams;
    const need = JSON.parse(params.get('need'));
    window.__moved = [];
    setRunModalBrowserMove(async (args) => { window.__moved.push(args); });
    const recipe = { recipe_id: 'read-then-type', version: 1, ttl: 60, variables: {}, prefetch_steps: [], steps: [],
      metadata: { name: 'Read, then type', description: 'x', author: 'you', supported_platforms: [] }, output: { render: [] } };
    window.__handle = wireRunModal({ document,
      recipe: { recipe_id: 'read-then-type', publisher_id: 'local', version: 1, recipe_hash: 'h', recipe, source: 'local', installed_at: 1 },
      execute: async () => ({ recipe_id: 'read-then-type', recipe_hash: 'h', success: false, output: { render: [], sidebar: [] }, steps: [],
        errors: [{ error_id: 'browsers-1', code: 'ROLE_RESTRICTION', severity: 'fatal', message: ${JSON.stringify(REASON)},
          source: { recipe_id: 'read-then-type', step_id: 'type_home', ingredient_slug: null }, details: {}, timestamp: '2026-11-18T01:00:00Z',
          retryable: false }],
        duration_ms: 0, validation_issues: [], run_needs: [need] }) });
    // wireRunModal builds the dialog and never mounts it: its host does.
    document.body.appendChild(window.__handle.element);
    document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const GONE = { kind: 'browser', step_id: 'type_home', problem: 'not_paired', setting: 'browser_2', browser_id: 'inst-old',
  name: 'Old laptop', dish_id: 'dsh_main', instead: { browser_id: 'inst-home', name: 'Home' } };
const open = async (page: Page, need: unknown) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/run-browser-instead.js', (route) => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route(/\/run-browser-instead\.html(\?|$)/u, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}
    body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)}</style></head>
    <body><main id="app"></main><script type="module" src="/run-browser-instead.js"></script></body></html>` }));
  await page.goto(`/run-browser-instead.html?need=${encodeURIComponent(JSON.stringify(need))}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('[data-recued-run-modal-action="confirm-run"]').click();
  return errors;
};

for (const width of [390, 1280]) {
  test(`a browser no longer paired: the reason, what else to do, its settings, and "Use “Home” instead", at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    const errors = await open(page, GONE);
    const dialog = page.locator('[data-recued-run-modal]');
    await expect(dialog).toContainText(REASON);
    // The lead, then the button and the dish's settings (each link the dialog's next step offers).
    await expect(dialog.locator('.run-modal-next-lead')).toHaveText('Use another browser instead.');
    await expect(dialog.locator('[data-recued-run-modal-next-step]')).toHaveText(['Choose a browser']);
    await expect(dialog.locator('[data-recued-run-modal-next-step]')).toHaveAttribute('href', '#automation/dishes/dsh_main');
    const move = dialog.locator('[data-recued-run-modal-action="next-action"]');
    await expect(move).toHaveText('Use “Home” instead');
    await expect(move).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`run-browser-instead-${width}.png`) });
    await move.click();
    await expect(dialog.locator('[data-recued-run-modal-next-action-done]')).toHaveText('It acts in “Home” now. Run it again.');
    expect(await page.evaluate(() => (window as unknown as { __moved: unknown[] }).__moved))
      .toEqual([{ dish_id: 'dsh_main', from: 'inst-old', to: 'inst-home' }]);
    expect(errors).toEqual([]);
  });
}

test('⛔ no one-click move when the server offered no browser: its settings are where to choose', async ({ page }) => {
  const { instead: _instead, ...none } = GONE;
  const errors = await open(page, { ...none, problem: 'offline', name: 'Home' });
  await expect(page.locator('.run-modal-next-lead')).toHaveText('Or use another browser instead.');
  await expect(page.locator('[data-recued-run-modal-next-step]')).toHaveText(['Choose a browser']);
  await expect(page.locator('[data-recued-run-modal-action="next-action"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
