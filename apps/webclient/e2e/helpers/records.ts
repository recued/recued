import { expect, type Page } from '@playwright/test';

export const openRecordsManagement = async (page: Page): Promise<void> => {
  const management = page.locator('details[data-records-management]');
  await expect(management).toBeVisible();
  if (await management.getAttribute('open') === null) {
    await management.getByText('Manage records', { exact: true }).click();
  }
  await expect(management).toHaveAttribute('open', '');
};
