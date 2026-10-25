import { expect, type Locator } from '@playwright/test';

export const openSignoffRequestDetails = async (card: Locator): Promise<void> => {
  const details = card.locator('[data-signoff-disclosure="actions"]');
  await expect(details).toHaveCount(1);
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) {
    await details.locator('summary').first().click();
  }
};
