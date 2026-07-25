import { expect, test } from '@playwright/test';

// The harness is served over HTTP by the config's `webServer` (a `file://`
// page can't load its ES-module bundle — Chromium CORS-blocks opaque origins).
const HARNESS_ORIGIN = 'http://127.0.0.1:4319';

/**
 * Layer 2 — the shipped `#kitchen` route-target components rendered in a real
 * Chromium, off the local mock-conn harness (e2e/harness/). These are the exact
 * components the paired bootstrap dispatches to at `#kitchen/recipe/<id>` (S1)
 * and `#kitchen/pack` (S2); the harness supplies the mock callers the vitest
 * suites proved render the real editor + builder, so this is their browser twin
 * — real CSS + layout, screenshottable, no crypto pairing required.
 *
 * Prereq: `node e2e/harness/build-harness.mjs` (the npm script runs it first).
 */

const ARTIFACTS = 'apps/webclient/e2e/.playwright-artifacts';
const harnessUrl = (surface: 'recipe' | 'pack'): string =>
  `${HARNESS_ORIGIN}/kitchen-harness.html?surface=${surface}`;

const pageErrors: Error[] = [];
test.beforeEach(({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (err) => pageErrors.push(err));
});
test.afterEach(() => {
  expect(pageErrors, `uncaught page errors: ${pageErrors.map((e) => e.message).join(' | ')}`)
    .toHaveLength(0);
});

test('S1 — recipe editor mounts at #kitchen/recipe/<id> and saves', async ({ page }) => {
  await page.goto(harnessUrl('recipe'));
  await page.waitForFunction(() => window.__harness?.mounted === true);

  // The route chrome (tab bar) wraps the surface; the Recipe tab is active.
  await expect(page.locator('[data-recued-kitchen-route-tabs]')).toBeVisible();
  await expect(page.locator('[data-recued-kitchen-route-tab="recipe"]'))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-recued-kitchen-route-tab="pack"]'))
    .toHaveAttribute('href', '#kitchen/pack');

  // The loading shell resolved into the REAL editor (not a not-found/error) —
  // and the mount only mounts the editor when it FINDS the recipe by id, so an
  // absent error status already proves the right recipe resolved.
  await expect(page.locator('[data-recued-recipe-editor-mount-status]')).toHaveCount(0);
  await expect(page.locator('[data-recued-recipe-editor-route]')).toBeVisible();
  // The resolved recipe's name is bound into the editable Name field.
  await expect(page.locator('[data-recued-recipe-editor-field="recipe_name"]'))
    .toHaveValue('Detect deal risk (HubSpot)');

  await page.screenshot({ path: `${ARTIFACTS}/kitchen-recipe-editor.png`, fullPage: true });

  // Save wires through the (mock) recipe.save caller — the S1 end-to-end path.
  const save = page.locator('[data-recued-recipe-editor-save]').first();
  await expect(save).toBeVisible();
  await save.click();
  await page.waitForFunction(() => (window.__harness?.saveCalls.length ?? 0) >= 1);
  const saved = await page.evaluate(() => window.__harness.saveCalls);
  expect(saved[0]?.recipe_id).toBe('detect-deal-risk-hubspot');
});

test('S2 — pack (ingredient) builder mounts at #kitchen/pack', async ({ page }) => {
  await page.goto(harnessUrl('pack'));
  await page.waitForFunction(() => window.__harness?.mounted === true);

  // The route chrome wraps the builder; the Ingredient pack tab is active and
  // the Recipe tab (nothing open) points back at the #recipes library.
  await expect(page.locator('[data-recued-kitchen-route-tabs]')).toBeVisible();
  await expect(page.locator('[data-recued-kitchen-route-tab="pack"]'))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-recued-kitchen-route-tab="recipe"]'))
    .toHaveAttribute('href', '#recipes');

  // The builder route renders on mount (no server round trip needed) — the pack
  // editor the bare `#kitchen` canonicalizes into. Both authoring tables are
  // built into the DOM (the builder is section-navigated, so the non-default
  // section's table is present-but-hidden until selected — assert attached, the
  // same existence contract the vitest suite checks).
  await expect(page.locator('[data-recued-ingredient-builder-route]')).toBeVisible();
  await expect(page.locator('[data-recued-ingredient-operation-family-table]')).toBeAttached();
  await expect(page.locator('[data-recued-ingredient-entity-field-table]')).toBeAttached();

  await page.screenshot({ path: `${ARTIFACTS}/kitchen-pack-builder.png`, fullPage: true });
});
