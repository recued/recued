/** D-402 slice H2b — a dish's browser setting, in a real browser: the dish form offers the owner's paired
 *  browsers by name and saves the one chosen by its lasting id; the only browser is chosen for the
 *  owner; a browser no longer paired stays held, said as such. */

import { expect, test, type Page } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';

const esbuild: BuildOptions = { bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' };
let formBundle: string;
let tokens: string;
test.beforeAll(async () => {
  formBundle = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { openDishForm } from './apps/webclient/src/recipes/dish-form.ts';
    const params = new URL(location.href).searchParams;
    const held = params.get('held') ?? '';
    const paired = JSON.parse(params.get('paired') ?? '[]');
    window.__created = null;
    openDishForm({ document, mode: 'switch-on', dishes: [], start: {},
      entry: { recipe_id: 'read-then-type', publisher_id: 'local', browser_settings: [{ key: 'browser' }],
        recipe: { recipe_id: 'read-then-type', version: 1, metadata: { name: 'Read, then type' }, variables: { browser: held } } },
      callers: { create: async (args) => { window.__created = args; return { dish: { dish_id: 'd-1' } }; } },
      browsers: { list: async () => paired },
      onClose: () => undefined });
    document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const WORK = { browser_id: 'inst-work', name: 'Work', online: true };
const HOME = { browser_id: 'inst-home', name: 'Home', online: false };
const open = async (page: Page, held: string, paired: unknown[]) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/browser-setting.js', (route) => route.fulfill({ contentType: 'text/javascript', body: formBundle }));
  // A regex, not a glob: the page's address carries a query, which a glob would have to match too.
  await page.route(/\/browser-setting\.html(\?|$)/u, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}
    body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)}</style></head>
    <body><main id="app"></main><script type="module" src="/browser-setting.js"></script></body></html>` }));
  await page.goto(`/browser-setting.html?held=${encodeURIComponent(held)}&paired=${encodeURIComponent(JSON.stringify(paired))}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return errors;
};
const browserSelect = (page: Page) => page.locator('[data-recued-browser-variable="browser"] select');
const created = (page: Page) => page.evaluate(() => (window as unknown as { __created: { config_overlay?: Record<string, unknown> } | null }).__created);

for (const width of [390, 1280]) {
  test(`the owner\'s paired browsers by name, one not connected said so, saving the one chosen by its lasting id, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    const errors = await open(page, 'inst-work', [WORK, HOME]);
    const select = browserSelect(page);
    await expect(select.locator('option')).toHaveText(['Home (not connected)', 'Work']);
    await expect(select).toHaveValue('inst-work');
    await expect(page.locator('[data-recued-browser-variable="browser"] label')).toHaveText('Browser');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`dish-browser-setting-${width}.png`) });
    await select.selectOption('inst-home');
    await page.getByRole('button', { name: 'Switch on', exact: true }).click();
    await expect.poll(() => created(page)).not.toBeNull();
    expect((await created(page))?.config_overlay).toMatchObject({ browser: 'inst-home' });
    expect(errors).toEqual([]);
  });
}

test('the only paired browser is chosen for the owner, and saved', async ({ page }) => {
  const errors = await open(page, '', [WORK]);
  await expect(browserSelect(page)).toHaveValue('inst-work');
  await page.getByRole('button', { name: 'Switch on', exact: true }).click();
  await expect.poll(() => created(page)).not.toBeNull();
  expect((await created(page))?.config_overlay).toMatchObject({ browser: 'inst-work' });
  expect(errors).toEqual([]);
});

test('a browser no longer paired stays held, said as such, and is not changed by saving', async ({ page }) => {
  const errors = await open(page, 'inst-gone', [WORK, HOME]);
  const select = browserSelect(page);
  await expect(select).toHaveValue('inst-gone');
  await expect(select.locator('option:checked')).toHaveText('A browser no longer paired');
  await page.getByRole('button', { name: 'Switch on', exact: true }).click();
  await expect.poll(() => created(page)).not.toBeNull();
  expect((await created(page))?.config_overlay?.browser ?? 'inst-gone').toBe('inst-gone');
  expect(errors).toEqual([]);
});
