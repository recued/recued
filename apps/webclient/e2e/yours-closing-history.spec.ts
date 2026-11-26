import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** D-343 slice 5 — what the owner records in Close the day, read back in Yours: Episodes by the day
 *  each happened, and a pursuit's history and when it was last worked on (D-342 §7). The fixture's
 *  records (`&closing_days=1`) are whole days on the browser's clock; it is Saturday 17 October. */
installFullAppHooks();

test.describe('Episodes on wide touch', () => {
  test.use({ viewport: { width: 1440, height: 800 }, hasTouch: true });

  test('Episode cards group each record by the day it happened, latest first', async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/episodes`);
    const route = page.locator('[data-recued-yours]');
    const days = route.locator('[data-yours-episode-day]');
    await expect(days.first()).toBeVisible();
    await expect(route.getByRole('group', { name: 'Episode timeline', exact: true })).toHaveCount(0);
    expect(await days.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.yoursEpisodeDay)))
      .toEqual(['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-12', '2026-10-10', '2026-09-01']);
    await expect(days.first().locator('h3').first()).toHaveText(new Date(2026, 9, 16).toLocaleDateString(undefined,
      { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }));
    // Monday's records were written on Thursday, after Wednesday's: they sit on Monday.
    const monday = route.locator('[data-yours-episode-day="2026-10-12"]');
    await expect(monday.locator('[data-yours-episode]')).toHaveCount(2);
    await expect(monday.getByRole('heading', { name: 'Ran 5 km', exact: true })).toBeVisible();
    await expect(monday.getByText('Skipped · your record', { exact: true })).toBeVisible();
    const walk = route.locator('[data-yours-episode="walk"]');
    await expect(walk.locator('.yours-event-date')).toHaveText(new Date(2026, 9, 14).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    await expect(route.getByText('place unknown', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test.describe('Desktop Episodes', () => {
  test.use({ viewport: { width: 1280, height: 650 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });

  test('Back restores the episode timeline and follows a correction onto another page', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-24T18:00:00Z'));
    const address = `${HARNESS_URL}?yours=demo&yours_episode_workspace#yours/episodes`;
    await page.goto(address);
    const route = page.locator('[data-recued-yours]');
    const timeline = route.getByRole('group', { name: 'Episode timeline', exact: true });
    const scope = route.getByLabel('Sphere on this page', { exact: true });
    await scope.selectOption('professional');
    await expect(timeline.getByRole('button', { name: 'Personal check-in', exact: true })).toHaveCount(0);
    await expect(timeline.locator('[data-yours-episode-day]').first()).toHaveAttribute('data-yours-episode-day', '2026-11-22');
    const oldDay = timeline.locator('[data-yours-episode-day="2026-10-17"]');
    const review = timeline.locator('[data-yours-episode-row="design-review"]');
    await expect(oldDay.getByRole('button', { name: 'Design review', exact: true })).toHaveCount(1);
    await review.scrollIntoViewIfNeeded();
    await review.press('Enter');
    const preview = route.getByRole('region', { name: 'Episode preview', exact: true });
    await expect(preview.getByText('With Ana', { exact: true })).toBeVisible();
    await expect(preview.getByText('Confirm the prototype photos before sharing.', { exact: true })).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Open source record', exact: true })).toHaveAttribute('href', /personal.*flowers/u);
    const open = preview.getByRole('link', { name: 'Open episode', exact: true });
    await open.scrollIntoViewIfNeeded();
    const scroll = await timeline.evaluate(node => node.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await open.press('Enter');
    await expect(page).toHaveURL(/#yours\/episodes\/episode\/design-review$/u);
    const detail = route.locator('[data-yours-episode="design-review"]');
    const correct = detail.getByRole('button', { name: 'Correct or annotate', exact: true });
    await expect(correct).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(address);
    await expect(scope).toHaveValue('professional');
    await expect(review).toHaveAttribute('aria-current', 'true');
    await expect(review).toBeFocused();
    await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBe(scroll);

    await open.press('Enter');
    await correct.click();
    const form = route.locator('[data-yours-editor]');
    await form.getByLabel('From', { exact: true }).fill('2026-09-24T09:30');
    await form.getByLabel('To', { exact: true }).fill('2026-09-24T10:00');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(detail.getByText(/Sep 24, 2026/u)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#yours\/episodes\/page\/2$/u);
    await expect(scope).toHaveValue('professional');
    const newDay = timeline.locator('[data-yours-episode-day="2026-09-24"]');
    await expect(newDay.getByRole('button', { name: 'Design review', exact: true })).toHaveAttribute('data-yours-episode-row', 'design-review');
    await expect(review).toHaveAttribute('aria-current', 'true');
    await expect(review).toBeFocused();
    await expect(review).toBeInViewport();
    await expect(preview.getByText('Confirm the prototype photos before sharing.', { exact: true })).toBeVisible();
  });
});

test('the Pursuits tab says when each pursuit was last worked on, and nothing for one never recorded', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/pursuits`);
  const route = page.locator('[data-recued-yours]');
  const books = route.locator('[data-yours-pursuit="read-books"]');
  await expect(books.locator('dt', { hasText: 'Last worked on' })).toBeVisible();
  await expect(books.locator('dd').last()).toHaveText(new Date(2026, 9, 16, 12).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  await expect(route.locator('[data-yours-pursuit="guitar"]')).toBeVisible();
  await expect(route.locator('[data-yours-pursuit="guitar"] dt', { hasText: 'Last worked on' })).toHaveCount(0);
  // The Assets tab leaves them out.
  await page.evaluate(() => { location.hash = '#yours/assets'; });
  await expect(route.locator('[data-yours-asset="passport"]')).toBeVisible();
  await expect(route.getByText('Read more books', { exact: true })).toHaveCount(0);
});

test('Desktop Pursuits adds a child to the selected goal and restores the filtered outline on Back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  const address = `${HARNESS_URL}?yours=demo&closing_days=1&with_pursuit_type=1&yours_pursuit_workspace=1#yours/pursuits`;
  await page.goto(address);
  const route = page.locator('[data-recued-yours]');
  const outline = route.getByRole('group', { name: 'Pursuit outline' });
  const preview = route.getByRole('region', { name: 'Pursuit preview' });
  const sphere = route.getByRole('combobox', { name: 'Sphere on this page' });
  await sphere.selectOption('unsorted');
  await expect(outline.getByRole('button', { name: 'Learn guitar' })).toHaveCount(0);
  const books = outline.getByRole('button', { name: 'Read more books', exact: true });
  await books.scrollIntoViewIfNeeded();
  await books.press('Enter');
  await expect(preview.getByRole('heading', { name: 'Read more books' })).toBeVisible();
  await expect(preview).toContainText('2 books');
  await expect(preview).toContainText('Target date');
  await expect(preview).toContainText('Last worked on');

  const form = route.locator('[data-yours-editor]');
  const edit = preview.getByRole('button', { name: 'Edit Read more books', exact: true });
  await edit.press('Enter');
  await form.getByLabel('Progress (optional)').fill('3');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeFocused();
  await expect(preview).toContainText('3 books');

  const addPart = preview.getByRole('button', { name: 'Add a part to Read more books' });
  await addPart.press('Enter');
  await expect(form.getByLabel('Part of (optional)')).toHaveValue('read-books');
  await form.getByLabel('What you are working toward').fill('Finish the chapter');
  await form.getByRole('button', { name: 'Add pursuit', exact: true }).click();
  const chapter = outline.getByRole('button', { name: 'Finish the chapter', exact: true });
  await expect(chapter).toHaveAccessibleDescription('Part of Read more books');
  await expect(addPart).toBeFocused();
  await expect(books).toHaveAttribute('aria-current', 'true');

  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
  const refresh = route.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.click();
  await expect(route.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
  await books.press('ArrowDown');
  await expect(chapter).toBeFocused();
  await expect(preview.getByRole('heading', { name: 'Finish the chapter' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
  await expect(refresh).toBeEnabled();
  await expect(chapter).toBeFocused();
  await expect(chapter).toHaveAttribute('aria-current', 'true');

  const readScroll = () => outline.evaluate(node => ({ outline: node.scrollTop, top: node.getBoundingClientRect().top }));
  const open = preview.getByRole('link', { name: 'Open pursuit', exact: true });
  await open.scrollIntoViewIfNeeded();
  const scroll = await readScroll();
  expect(scroll.outline).toBeGreaterThan(0);
  await open.press('Enter');
  await expect(page).toHaveURL(/#yours\/asset\/new-\d+$/u);
  await expect.poll(() => page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
  await expect(route.getByRole('heading', { name: 'Finish the chapter', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(address);
  await expect.poll(() => page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
  await expect(sphere).toHaveValue('unsorted');
  await expect(chapter).toBeFocused();
  await expect(chapter).toHaveAttribute('aria-current', 'true');
  await expect(preview.getByRole('heading', { name: 'Finish the chapter' })).toBeVisible();
  await expect.poll(async () => (await readScroll()).outline).toBe(scroll.outline);
  await expect.poll(async () => Math.abs((await readScroll()).top - scroll.top)).toBeLessThan(1);
});

test('Desktop Pursuits follows the selected goal into Ended and back to active', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`${HARNESS_URL}?yours=demo&closing_days=1#yours/pursuits`);
  const route = page.locator('[data-recued-yours]');
  const outline = route.getByRole('group', { name: 'Pursuit outline' });
  const preview = route.getByRole('region', { name: 'Pursuit preview' });
  const guitar = outline.getByRole('button', { name: 'Learn guitar', exact: true });
  await guitar.press('Enter');
  await preview.getByLabel('More actions for Learn guitar', { exact: true }).press('Enter');
  await preview.getByRole('button', { name: 'Reached', exact: true }).press('Enter');
  const ended = outline.locator('details').filter({ hasText: 'Ended · 1' });
  await expect(ended.locator('summary')).toBeVisible();
  await expect(ended.getByRole('button', { name: 'Learn guitar' })).toBeFocused();
  await expect(preview).toContainText('Reached');

  await preview.getByRole('link', { name: 'Open pursuit', exact: true }).press('Enter');
  await route.getByRole('link', { name: 'Back to pursuits', exact: true }).click();
  await expect(ended.getByRole('button', { name: 'Learn guitar' })).toBeFocused();
  await preview.getByRole('button', { name: 'Bring back Learn guitar', exact: true }).press('Enter');
  await expect(ended).toHaveCount(0);
  await expect(guitar).toBeFocused();
  await expect(guitar).toHaveAttribute('aria-current', 'true');
  await expect(preview.getByRole('button', { name: 'Edit Learn guitar', exact: true })).toBeVisible();
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
