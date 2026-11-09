import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** D-343 slice 5 — what the owner records in Close the day, read back in Yours: Episodes by the day
 *  each happened, and a pursuit's history and when it was last worked on (D-342 §7). The fixture's
 *  records (`&closing_days=1`) are whole days on the browser's clock; it is Saturday 17 October. */
installFullAppHooks();

test('Episodes lists records under the day each happened, latest first, and a day closed later on its own day', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/episodes`);
  const route = page.locator('[data-recued-yours]');
  const days = route.locator('[data-yours-episode-day]');
  await expect(days.first()).toBeVisible();
  expect(await days.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.yoursEpisodeDay)))
    .toEqual(['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-12', '2026-10-10', '2026-09-01']);
  await expect(days.first().locator('h3').first()).toHaveText(new Date(2026, 9, 16).toLocaleDateString(undefined,
    { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }));
  // Monday's records were written on Thursday, after Wednesday's: they sit on Monday.
  const monday = route.locator('[data-yours-episode-day="2026-10-12"]');
  await expect(monday.locator('[data-yours-episode]')).toHaveCount(2);
  await expect(monday.getByRole('heading', { name: 'Ran 5 km', exact: true })).toBeVisible();
  await expect(monday.getByText('Skipped · your record', { exact: true })).toBeVisible();
  // A whole day reads as that day, and a record has no place to be unknown.
  const walk = route.locator('[data-yours-episode="walk"]');
  await expect(walk.locator('.yours-event-date')).toHaveText(new Date(2026, 9, 14).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  await expect(route.getByText('place unknown', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the Pursuits tab says when each pursuit was last worked on, and nothing for one never recorded', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/pursuits`);
  const route = page.locator('[data-recued-yours]');
  const books = route.locator('[data-yours-pursuit="read-books"]');
  await expect(books.locator('dt', { hasText: 'Last worked on' })).toBeVisible();
  await expect(books.locator('dd').last()).toHaveText(new Date(2026, 9, 16, 12).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  await expect(route.locator('[data-yours-pursuit="guitar"]')).toBeVisible();
  await expect(route.locator('[data-yours-pursuit="guitar"] dt', { hasText: 'Last worked on' })).toHaveCount(0);
  // The Assets tab leaves them out.
  await page.evaluate(() => { location.hash = '#yours/assets'; });
  await expect(route.getByRole('link', { name: 'Ana’s passport', exact: true })).toBeVisible();
  await expect(route.getByText('Read more books', { exact: true })).toHaveCount(0);
});

test('a pursuit’s page lists its history, latest first, with when it was last worked on, and Hide takes one away', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/asset/read-books`);
  const route = page.locator('[data-recued-yours]');
  const history = route.locator('[data-yours-pursuit-history]');
  await expect(history).toBeVisible();
  await expect(history.locator('p.yours-muted').first()).toHaveText(`Last worked on ${new Date(2026, 9, 16, 12).toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric' })} · 2 days in the last 30`);
  const records = history.locator('[data-yours-cited-episode]');
  expect(await records.evaluateAll(nodes => nodes.map(node => node.querySelector('h3')?.textContent)))
    .toEqual(['Read 40 pages', 'No reading', 'Read 30 pages', 'Read a chapter']);
  await expect(history.locator('[data-yours-cited-episode="books-15"]')).toContainText('Skipped · your record');
  // Its evidence is this pursuit, so its card links nowhere: it is already here.
  await expect(history.locator('[data-yours-evidence]')).toHaveCount(0);
  await history.locator('[data-yours-cited-episode="books-16"]').getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(records).toHaveCount(3);
  await expect(history.locator('p.yours-muted').first()).toHaveText(`Last worked on ${new Date(2026, 9, 10, 12).toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric' })} · 1 day in the last 30`);
});

test('a pursuit never recorded says so, and a server older than the slice shows no history at all', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/asset/guitar`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[data-yours-pursuit-history]')).toContainText('Nothing recorded yet. What you tell Close the day about it is kept here.');
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1&yours_without_pursuit_activity=1#yours/asset/read-books`);
  await expect(route.locator('[data-yours-pursuit-facts]')).toBeVisible();
  await expect(route.locator('[data-yours-pursuit-history]')).toHaveCount(0);
});
