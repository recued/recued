import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarEventFixture } from './helpers/calendar-event-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });

// D-407 slice 5 (§4.1, Q4, Q5) — the Occasion tick on an event, clicked as the owner clicks it: the checkbox and the
// label route through the Data route's actions, it asks which waiting occasion this is (the match chosen first), and
// unticked it lets the event go.
for (const width of [280, 1280]) {
  test(`ticking Occasion asks which occasion, makes it its next one, and lets it go at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
    await installCalendarEventFixture(page, 'occasion');
    await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/calendar'));
    await page.locator('[data-collection-record]').first().click();
    const section = page.getByRole('region', { name: 'Occasion', exact: true });
    const tick = section.getByRole('checkbox', { name: 'Occasion', exact: true });
    await expect(tick).not.toBeChecked();
    await tick.click();
    await expect(section).toContainText('Which occasion is this?');
    await expect(section.getByRole('radio', { name: 'Dr. Lee: its next one (its organizer or place matches)', exact: true })).toBeChecked();
    // Dr. Lee is Shown by name: Private follows the occasion chosen. Ticked by its label.
    const privacy = section.getByRole('checkbox', { name: 'Private', exact: true });
    await expect(privacy).not.toBeChecked();
    await section.getByText('Private', { exact: true }).click();
    await expect(privacy).toBeChecked();
    await section.getByRole('button', { name: 'Make it an occasion', exact: true }).click();
    const held = section.getByRole('checkbox', { name: 'Occasion: Dr. Lee', exact: true });
    await expect(held).toBeChecked();
    await expect(section.getByRole('status')).toContainText("This event is Dr. Lee's next one, Private.");
    expect(await page.evaluate(() => window.__calendarEvent.occasionChanges()))
      .toEqual([{ action: 'occasion.adopt_event', slug: 'local', source_id: 'event-1', occasion_id: 'occ-lee', private: true }]);
    await held.click();
    await expect(section.getByRole('checkbox', { name: 'Occasion', exact: true })).not.toBeChecked();
    expect((await page.evaluate(() => window.__calendarEvent.occasionChanges())).at(-1))
      .toEqual({ action: 'occasion.release_event', slug: 'local', source_id: 'event-1' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
