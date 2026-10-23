import { expect, test, type Page } from '@playwright/test';

type Surface = 'recipes' | 'packs';
const openResult = async (page: Page, surface: Surface) => {
  const query = 'recipe_result=copyable&recipe_run_facts=1';
  if (surface === 'recipes') {
    await page.goto(`/full-app-harness.html?recipes=installed&recipe_default_run=1&${query}#recipes`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator('[data-recued-recipes-card="autorun-live-1"]')
      .getByRole('button', { name: /Open .+ details/ }).click();
    const root = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
    await root.locator('[data-recued-recipes-action="run-defaults"]').click();
    await expect(root.locator('[data-recued-run-summary]')).toBeVisible();
    return root;
  }
  await page.goto(`/full-app-harness.html?packs=installed&${query}#packs/installed-mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const root = page.locator('[data-recued-pack-app="installed-mail"]');
  await root.locator('[data-recued-pack-app-operation="installed-mail-digest"]').click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Run completed');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(root.locator('[data-recued-run-summary]')).toBeVisible();
  return root;
};

for (const surface of ['recipes', 'packs'] as const) {
  for (const width of [375, 1280]) {
    test(`${surface} copies the run receipt by keyboard at ${width}px`, async ({ page, context }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      const root = await openResult(page, surface);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
      const summary = root.locator('[data-recued-run-summary]');
      const copy = summary.getByRole('button', { name: 'Copy run summary', exact: true });
      await copy.focus();
      await page.keyboard.press('Enter');
      await expect(summary.locator('[data-recued-run-summary-status]')).toHaveText('Run summary copied.');
      await expect(copy).toBeFocused();
      const text = await page.evaluate(() => navigator.clipboard.readText());
      await summary.getByText('View run summary', { exact: true }).click();
      expect(text).toBe(await summary.getByRole('textbox', { name: 'Run summary text' }).inputValue());
      expect(text).toContain(`Recipe: ${surface === 'recipes' ? 'autorun-live-1' : 'installed-mail-digest'}\n`);
      expect(text).toContain('Outcome: Completed\nDuration: 42000 ms\nSteps run: 34\nItems attempted: 1249');
      const output = await root.locator('.copy-btn').getAttribute('data-value');
      expect(output).toBeTruthy();
      expect(text).not.toContain(output!);
      expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(width === 375 ? 44 : 36);
      await expect(summary.getByRole('textbox', { name: 'Run summary text' })).toHaveAttribute('readonly', '');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('run-summary.png') });
      expect(errors).toEqual([]);
    });
  }

  test(`${surface} offers manual selection when the clipboard is denied`, async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('private policy detail')) },
    }));
    const root = await openResult(page, surface);
    const summary = root.locator('[data-recued-run-summary]');
    await summary.getByRole('button', { name: 'Copy run summary', exact: true }).click();
    const field = summary.getByRole('textbox', { name: 'Run summary text' });
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length)).toBe(true);
    await expect(summary.locator('[data-recued-run-summary-status]'))
      .toHaveText('Recued could not copy it. Copy the summary below.');
    await expect(summary).not.toContainText('private policy detail');
  });
}

declare global {
  interface Window {
    __summaryCopy?: { texts: string[]; resolve?: () => void; reject?: () => void };
  }
}

for (const success of [true, false]) {
  test(`a late clipboard ${success ? 'success' : 'denial'} does not alter a replacement run`, async ({ page }) => {
    await page.addInitScript(() => {
      const state = window.__summaryCopy = { texts: [] } as NonNullable<Window['__summaryCopy']>;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: (text: string) => {
          state.texts.push(text);
          return new Promise<void>((resolve, reject) => {
            state.resolve = resolve;
            state.reject = () => reject(new Error('old clipboard denial'));
          });
        },
      } });
    });
    const root = await openResult(page, 'recipes');
    const summary = root.locator('[data-recued-run-summary]');
    const copy = summary.getByRole('button', { name: 'Copy run summary', exact: true });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(copy).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__summaryCopy?.texts.length)).toBe(1);
    await root.locator('[data-recued-recipes-action="run-defaults"]').click();
    await expect(root.locator('[data-recued-recipes-action="run-defaults"]')).toBeEnabled();
    await expect(copy).not.toHaveAttribute('aria-busy', 'true');
    await expect(summary.locator('[data-recued-run-summary-status]')).toBeEmpty();
    await copy.focus();
    await page.evaluate(ok => ok ? window.__summaryCopy?.resolve?.() : window.__summaryCopy?.reject?.(), success);
    await expect(summary.locator('[data-recued-run-summary-status]')).toBeEmpty();
    await expect(copy).toBeFocused();
    await expect(summary.locator('details')).not.toHaveAttribute('open', '');
  });
}
