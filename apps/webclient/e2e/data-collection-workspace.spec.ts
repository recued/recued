import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

test('collection rail keeps its browsing position through a live refresh and a Memory visit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html?settle_reads=1&data=work-entities-paged#data/task`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const rail = page.getByRole('tablist', { name: 'Data collections' });
  await expect(rail).toHaveAttribute('aria-orientation', 'vertical');
  const search = page.getByRole('searchbox', { name: 'Search tasks', exact: true });
  await search.focus();
  const originalSearch = await search.elementHandle();
  await rail.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const position = await rail.evaluate(element => element.scrollTop);
  expect(position).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__app.rpcCallCount('work_entity.list'));
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'warehouse', collection: 'task', op: 'update', id: 'task-0', cursor: Date.now() + 10_000,
  } }));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('work_entity.list'))).toBeGreaterThan(before);
  await expect.poll(() => originalSearch!.evaluate(element => element.isConnected)).toBe(false);
  await expect(search).toBeFocused();
  expect(await rail.evaluate(element => element.scrollTop)).toBeCloseTo(position, 0);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(search).toBeVisible();
  expect(await rail.evaluate(element => element.scrollTop)).toBeCloseTo(position, 0);
});
