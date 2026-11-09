import { expect, test, type Page } from '@playwright/test';

/** D-343 slice 4 — "Ask me in the evening" on the Pursuit form (D-342 §3): Close the day's evening
 *  message lists a pursuit that has it. What the form saves is read as the Yours editor reads it. */
const evening = (page: Page) => page.getByLabel('Ask me in the evening', { exact: true });
const privacy = (page: Page) => page.getByLabel('Private', { exact: true });
const mount = async (page: Page, settings?: Record<string, unknown>) => {
  await page.goto('/pursuit-evening-harness.html'); await page.waitForFunction(() => window.__pursuit !== undefined);
  await page.evaluate(value => window.__pursuit.mount(value), settings);
};
const saved = (page: Page) => page.evaluate(() => window.__pursuit.read());

test('a new pursuit is not asked about in the evening unless the owner ticks it', async ({ page }) => {
  await mount(page);
  await page.getByLabel('What you are working toward', { exact: true }).fill('Learn Spanish');
  await expect(evening(page)).not.toBeChecked();
  expect(await saved(page)).toEqual({ name: 'Learn Spanish' });
  await evening(page).check();
  expect(await saved(page)).toEqual({ name: 'Learn Spanish', settings: { evening: true } });
  await expect(page.getByText('Close the day lists it in its evening message, so you can say how it went.')).toBeVisible();
});

test('an edit shows the box as saved and sends it when changed, beside Private', async ({ page }) => {
  await mount(page, { evening: true });
  await expect(evening(page)).toBeChecked();
  expect((await saved(page)).settings).toBeUndefined();
  await evening(page).uncheck(); await privacy(page).check();
  expect((await saved(page)).settings).toEqual({ sensitive: true, evening: false });
});
