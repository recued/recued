import { expect, type Page } from '@playwright/test';

/** The library starts expanded. Open the disclosure or desktop switcher
 * when following a view link from the reader. */
export const openSavedViewList = async (page: Page): Promise<void> => {
  const list = page.locator('[data-saved-data-views] details').first();
  await expect(list).toBeVisible();
  if (!await list.evaluate(element => (element as HTMLDetailsElement).open)) {
    await list.locator('summary').first().click();
  }
  await expect(list).toHaveAttribute('open', '');
};
