import { expect, type Locator, type Page } from '@playwright/test';

export const openBackupDisclosure = async (root: Page | Locator, name: string): Promise<void> => {
  const disclosure = root.locator(`[data-backup-disclosure="${name}"]`);
  await expect(disclosure).toHaveCount(1);
  if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await disclosure.locator(':scope > summary').click();
  await expect(disclosure).toHaveJSProperty('open', true);
};

export const openBackupCopyDetails = async (row: Locator): Promise<void> => {
  const details = row.locator('[data-remote-backup-details]');
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
};
