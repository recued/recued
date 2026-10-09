import { expect, type Page } from '@playwright/test';

/** The main list starts expanded; an addressed view keeps its secondary list
 * folded. Open it only when needed so a management journey works from either. */
export const openSavedViewList = async (page: Page): Promise<void> => {
  const list = page.locator('[data-saved-data-views] details').first();
  await expect(list).toBeVisible();
  if (!await list.evaluate(element => (element as HTMLDetailsElement).open)) {
    await list.locator('summary').first().click();
  }
  await expect(list).toHaveAttribute('open', '');
};
