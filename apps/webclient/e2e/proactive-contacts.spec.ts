import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
installFullAppHooks();

test('A contact’s recorded history opens the same occasion and episode identities in Yours', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&data=contacts&contact_history=1&settle_reads=1#data/contact`);
  await page.locator('[data-recued-data-contact-row]').first().locator('.data-contact-row-button').click();
  const history = page.locator('[data-contact-proactive-history]'); await expect(history.getByRole('link', { name: 'Ana birthday', exact: true })).toBeVisible();
  await expect(history.getByRole('link', { name: 'Museum afternoon', exact: true })).toHaveAttribute('href', '#yours/episodes/episode/museum');
  await history.getByRole('link', { name: 'Ana birthday', exact: true }).click();
  await expect(page.locator('[data-recued-yours]').getByRole('heading', { name: 'Ana birthday', exact: true })).toBeVisible();
});

test('Contact dates and owner privacy controls survive saving, reopening and explicit clearing', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1#data/contact`);
  const row = page.locator('[data-recued-data-contact-row]').first();
  await row.locator('.data-contact-row-button').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await dialog.getByLabel('Birthday (YYYY-MM-DD or --MM-DD)').fill('--04-02');
  await dialog.getByLabel('Anniversary (YYYY-MM-DD or --MM-DD)').fill('--10-20');
  await dialog.getByLabel('Relationship', { exact: true }).selectOption('family');
  await dialog.getByRole('checkbox', { name: 'Deceased', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-recued-data-contact-detail-heading]')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog.getByLabel('Anniversary (YYYY-MM-DD or --MM-DD)')).toHaveValue('--10-20');
  await expect(dialog.getByLabel('Relationship', { exact: true })).toHaveValue('family');
  await expect(dialog.getByRole('checkbox', { name: 'Deceased', exact: true })).toBeChecked();
  await dialog.getByLabel('Anniversary (YYYY-MM-DD or --MM-DD)').fill('');
  // D-325 §15.8 — an emptied birthday is sent as a clear, not left out.
  await dialog.getByLabel('Birthday (YYYY-MM-DD or --MM-DD)').fill('');
  await dialog.getByLabel('Relationship', { exact: true }).selectOption('');
  await dialog.getByRole('checkbox', { name: 'Deceased', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog.getByLabel('Anniversary (YYYY-MM-DD or --MM-DD)')).toHaveValue('');
  await expect(dialog.getByLabel('Birthday (YYYY-MM-DD or --MM-DD)')).toHaveValue('');
  await expect(dialog.getByLabel('Relationship', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('checkbox', { name: 'Deceased', exact: true })).not.toBeChecked();
});
