import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { STORAGE_RECORDS, openStorage, openStorageKind, previewStorage, releaseStorage, storageAction,
  storageCalls, storageDrain, storageForm, storageOutside, storagePanel } from './helpers/storage-fixture.js';

let external: string[] = [];
let downloads: Download[] = [];
test.beforeEach(async ({ page }) => {
  external = []; downloads = [];
  page.on('download', download => downloads.push(download));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin || route.request().url().startsWith('blob:')) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  const fixture = await page.evaluate(() => window.__storageFixture
    ? { runs: window.__storageFixture.calls.filter(call => call.method === 'storage.purge.run').map(call => call.args),
      expected: window.__storageFixture.expectedRuns, downloads: window.__storageFixture.expectedDownloads } : null);
  if (fixture) { expect(fixture.runs).toEqual(fixture.expected); expect(downloads).toHaveLength(fixture.downloads); }
});

test('cancelled CSV export cannot download into a reopened form', async ({ page }) => {
  await openStorage(page, { held: ['records.export'] });
  await openStorageKind(page, STORAGE_RECORDS); await previewStorage(page);
  await storageAction(page, 'export').click();
  await expect.poll(() => storageCalls(page, 'records.export')).toHaveLength(1);
  await storageAction(page, 'cancel').click();
  await openStorageKind(page, STORAGE_RECORDS);
  await releaseStorage(page, 'records.export', 0, { result: { csv: 'id\nretired\n', row_count: 1 } });
  await storageDrain(page);
  await expect(storageAction(page, 'preview')).toBeVisible();
  await expect(storageForm(page)).not.toContainText(/Saved .*\.csv/u);
  expect(downloads).toHaveLength(0);
});

test('retired preview cannot replace a newer preview for the same kind', async ({ page }) => {
  await openStorage(page, { held: ['storage.purge.preview'] }); await openStorageKind(page);
  await storageAction(page, 'preview').click();
  await storageAction(page, 'cancel').click(); await openStorageKind(page);
  await storageAction(page, 'preview').click();
  const calls = await storageCalls(page, 'storage.purge.preview');
  await releaseStorage(page, 'storage.purge.preview', 1, { result: { ...calls[1], items: 7, token: 'new-preview', expires_at: 1700000060000 } });
  await expect(storageAction(page, 'run')).toHaveText('Delete 7 runs');
  await releaseStorage(page, 'storage.purge.preview', 0, { result: { ...calls[0], items: 99, token: 'retired-preview', expires_at: 1700000060000 } });
  await storageDrain(page);
  await expect(storageAction(page, 'run')).toHaveText('Delete 7 runs');
  await expectRun(page, 'new-preview'); await storageAction(page, 'run').click();
  await expect(storageForm(page).locator('.storage-space-receipt')).toBeVisible();
});

test('native date editor stays connected while its value changes', async ({ page }) => {
  await openStorage(page); await openStorageKind(page);
  await storageForm(page).getByRole('radio', { name: 'A date', exact: true }).check();
  const date = storageForm(page).getByLabel('The date', { exact: true });
  const original = await date.elementHandle();
  await date.fill('2022-04-12'); await date.dispatchEvent('change');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(date).toHaveValue('2022-04-12');
  await date.focus(); await date.press('ArrowUp');
  expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
  await expect(date).not.toHaveValue('2022-04-12');
});

const progress = (page: Page) => storageForm(page).locator('[data-focus-key="progress"]');
const unloadBlocked = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
});
const expectRun = async (page: Page, token = 'fixture-preview') => {
  const previews = await storageCalls(page, 'storage.purge.preview');
  await page.evaluate(args => { window.__storageFixture.expectedRuns.push({ ...args, token: args.token }); }, { ...previews.at(-1)!, token });
};
const cancelDeparture = async (page: Page, pattern: RegExp) => {
  const dialogs: string[] = [];
  page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#settings/account'));
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(pattern);
  await expect(page).toHaveURL(/#settings\/server\/storage$/u);
};

for (const outcome of ['success', 'empty', 'error'] as const) {
  for (const owner of ['retry', 'outside'] as const) {
    test(`Storage read retry ${outcome} preserves ${owner} focus`, async ({ page }) => {
      await openStorage(page, { width: owner === 'retry' ? 390 : 1280, readError: true });
      const retry = storagePanel(page).getByRole('button', { name: 'Try again', exact: true });
      const retired = await retry.elementHandle();
      await page.evaluate(() => { window.__storageFixture.held = ['storage.kinds.read']; });
      await retry.focus(); await page.keyboard.press('Enter');
      const loading = storagePanel(page).locator('[data-focus-key="loading"]');
      await expect(loading).toBeFocused();
      await retired!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await page.keyboard.press('Enter');
      expect(await storageCalls(page, 'storage.kinds.read')).toHaveLength(2);
      if (owner === 'outside') await storageOutside(page).focus();
      if (outcome === 'empty') await page.evaluate(() => {
        (window.__storageFixture.snapshot as { kinds: unknown[] }).kinds = [];
      });
      await releaseStorage(page, 'storage.kinds.read', 0, outcome === 'error'
        ? { error: { code: 'UNAVAILABLE', message: 'Storage measurement temporarily unavailable.' } } : undefined);
      if (outcome === 'error') await expect(retry).toBeVisible();
      else if (outcome === 'empty') await expect(storagePanel(page).getByText('No stored kinds to show.', { exact: true })).toBeVisible();
      else await expect(storagePanel(page).getByRole('rowheader', { name: 'Run history', exact: true })).toBeVisible();
      const target = owner === 'outside' ? storageOutside(page) : outcome === 'error' ? retry
        : storagePanel(page).getByRole('heading', { name: 'What takes space', exact: true });
      await expect(target).toBeFocused();
      if (owner === 'retry') await expect(target).toBeInViewport();
      expect(await unloadBlocked(page)).toBe(false);
    });
  }
}

test('a retired initial measurement cannot update a new Settings mount', async ({ page }) => {
  await openStorage(page, { held: ['storage.kinds.read'] });
  await page.evaluate(() => window.__app.setHash('#yours'));
  await expect(storagePanel(page)).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/server/storage'));
  await expect.poll(() => storageCalls(page, 'storage.kinds.read')).toHaveLength(2);
  await releaseStorage(page, 'storage.kinds.read', 1);
  await expect(storagePanel(page).getByRole('rowheader', { name: 'Run history', exact: true })).toBeVisible();
  await releaseStorage(page, 'storage.kinds.read', 0, { error: { code: 'UNAVAILABLE', message: 'Retired measurement failure.' } });
  await storageDrain(page);
  await expect(storagePanel(page).getByRole('alert')).toBeHidden();
});

test('date validation, preview invalidation and draft navigation retain the editor', async ({ page }) => {
  await openStorage(page, { width: 390 }); await openStorageKind(page);
  expect(await unloadBlocked(page)).toBe(false);
  await storageForm(page).getByRole('radio', { name: 'A date', exact: true }).check();
  const date = storageForm(page).getByLabel('The date', { exact: true });
  await date.fill(''); await storageAction(page, 'preview').click();
  await expect(date).toBeFocused(); await expect(date).toHaveAttribute('aria-invalid', 'true');
  expect(await storageCalls(page, 'storage.purge.preview')).toEqual([]);
  await date.fill('2022-04-12'); await previewStorage(page);
  const retiredDelete = await storageAction(page, 'run').elementHandle();
  const original = await date.elementHandle(); await date.fill('2022-04-13');
  await retiredDelete!.evaluate(node => (node as HTMLButtonElement).click());
  await expect(storageAction(page, 'run')).toHaveCount(0);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  expect(await unloadBlocked(page)).toBe(true);
  await cancelDeparture(page, /unfinished Storage deletion choices/u);
  await expect(date).toHaveValue('2022-04-13');
  await storageForm(page).getByRole('radio', { name: '6 months ago', exact: true }).check();
  expect(await unloadBlocked(page)).toBe(false);
  await page.evaluate(() => window.__app.setHash('#settings/account'));
  await expect(page).toHaveURL(/#settings\/account$/u);
});

for (const outcome of ['success', 'error'] as const) for (const owner of ['progress', 'outside'] as const) {
  test(`Storage preview ${outcome} preserves ${owner} focus`, async ({ page }) => {
    await openStorage(page, { width: owner === 'progress' ? 390 : 1280, held: ['storage.purge.preview'] });
    await openStorageKind(page); await storageAction(page, 'preview').click();
    await expect(progress(page)).toBeFocused(); await expect(progress(page)).toBeInViewport();
    if (owner === 'outside') await storageOutside(page).focus();
    const [args] = await storageCalls(page, 'storage.purge.preview');
    await releaseStorage(page, 'storage.purge.preview', 0, outcome === 'error'
      ? { error: { code: 'UNAVAILABLE', message: 'Counting is temporarily unavailable.' } }
      : { result: { ...args, items: 0, token: 'empty-preview', expires_at: 1700000060000 } });
    const target = owner === 'outside' ? storageOutside(page) : outcome === 'error'
      ? storageAction(page, 'preview') : storageForm(page).locator('.storage-space-preview');
    if (outcome === 'error') await expect(storageForm(page).getByRole('alert')).toContainText('Counting is temporarily unavailable.');
    else { await expect(storageForm(page).locator('.storage-space-preview')).toHaveText('Nothing is older than that.'); await expect(storageAction(page, 'run')).toHaveCount(0); }
    await expect(target).toBeFocused();
  });
}

test('CSV exports the complete Records kind and leaves its exact preview available', async ({ page }) => {
  await openStorage(page); await openStorageKind(page, STORAGE_RECORDS); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.expectedDownloads = 1; });
  const file = page.waitForEvent('download'); await storageAction(page, 'export').click();
  const download = await file; expect(download.suggestedFilename()).toBe('body-signals-daily_metric-2023-11-14.csv');
  expect(await readFile((await download.path())!, 'utf8')).toBe('id,value\nold,12\nrecent,14\n');
  expect(await storageCalls(page, 'records.export')).toEqual([{ owner: { publisher: 'fixture', pack_slug: 'body-signals' }, entity: 'daily_metric', format: 'csv' }]);
  await expect(storageAction(page, 'run')).toBeFocused();
  await expect(storageForm(page)).toContainText('Saved body-signals-daily_metric-2023-11-14.csv.');
  expect(await unloadBlocked(page)).toBe(false);
});

test('JSONL export follows the frozen cutoff through every page', async ({ page }) => {
  await openStorage(page); await openStorageKind(page); await previewStorage(page);
  await page.evaluate(() => {
    window.__storageFixture.expectedDownloads = 1;
    window.__storageFixture.replies['audit.export.page'] = [
      { result: { body: '{"id":"first"}\n', entries_in_page: 1, next_cursor: 'page-two' } },
      { result: { body: '{"id":"second"}\n', entries_in_page: 1 } },
    ];
  });
  const file = page.waitForEvent('download'); await storageAction(page, 'export').click();
  const download = await file;
  expect(await readFile((await download.path())!, 'utf8')).toBe('{"id":"first"}\n{"id":"second"}\n');
  const [preview] = await storageCalls(page, 'storage.purge.preview');
  expect(await storageCalls(page, 'audit.export.page')).toEqual([
    { until: preview!.before, format: 'jsonl' }, { until: preview!.before, format: 'jsonl', cursor: 'page-two' },
  ]);
  expect(download.suggestedFilename()).toMatch(/^run-history-before-.*\.jsonl$/u);
});

for (const kind of ['records', 'runs'] as const) {
  test(`${kind} export failure offers a retry without a partial download`, async ({ page }) => {
    await openStorage(page); await openStorageKind(page, kind === 'records' ? STORAGE_RECORDS : 'runs'); await previewStorage(page);
    const method = kind === 'records' ? 'records.export' : 'audit.export.page';
    await page.evaluate(({ method, kind }) => {
      window.__storageFixture.replies[method] = [
        ...(kind === 'runs' ? [{ result: { body: '{"id":"partial"}\n', entries_in_page: 1, next_cursor: 'failed-page' } }] : []),
        { error: { code: 'UNAVAILABLE', message: 'Export temporarily unavailable.' } },
      ];
    }, { method, kind });
    await storageAction(page, 'export').click();
    await expect(storageForm(page).getByRole('alert')).toContainText('Export temporarily unavailable.');
    await expect(storageAction(page, 'export')).toBeFocused(); expect(downloads).toHaveLength(0);
    await page.evaluate(() => { window.__storageFixture.expectedDownloads = 1; });
    const file = page.waitForEvent('download'); await storageAction(page, 'export').click(); await file;
    await expect(storageAction(page, 'run')).toBeEnabled();
  });
  test(`${kind} export disposal prevents a late file and further pagination`, async ({ page }) => {
    const method = kind === 'records' ? 'records.export' : 'audit.export.page';
    await openStorage(page, { held: [method] }); await openStorageKind(page, kind === 'records' ? STORAGE_RECORDS : 'runs'); await previewStorage(page);
    await storageAction(page, 'export').click(); await expect(progress(page)).toBeFocused();
    expect(await unloadBlocked(page)).toBe(true); await cancelDeparture(page, /Storage export or deletion.*progress/u);
    await expect(progress(page)).toBeFocused();
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => window.__app.setHash('#yours'));
    await expect(storagePanel(page)).toHaveCount(0);
    await releaseStorage(page, method, 0, { result: kind === 'records' ? { csv: 'id\nretired\n', row_count: 1 }
      : { body: '{"id":"retired"}\n', entries_in_page: 1, next_cursor: 'never-request' } });
    await storageDrain(page); expect(await storageCalls(page, method)).toHaveLength(1);
    expect(downloads).toHaveLength(0);
  });
}

test('cancelled run export stops before the next page even after reopening the same kind', async ({ page }) => {
  await openStorage(page, { held: ['audit.export.page'] }); await openStorageKind(page); await previewStorage(page);
  await storageAction(page, 'export').click(); await storageAction(page, 'cancel').click(); await openStorageKind(page);
  await releaseStorage(page, 'audit.export.page', 0, { result: { body: '{"id":"retired"}\n', entries_in_page: 1, next_cursor: 'never-request' } });
  await storageDrain(page); expect(await storageCalls(page, 'audit.export.page')).toHaveLength(1);
  await expect(storageAction(page, 'preview')).toBeEnabled();
});

test('a repeated export cursor fails without downloading or looping', async ({ page }) => {
  await openStorage(page); await openStorageKind(page); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.replies['audit.export.page'] = [
    { result: { body: '{}\n', entries_in_page: 1, next_cursor: 'same' } }, { result: { body: '{}\n', entries_in_page: 1, next_cursor: 'same' } },
  ]; });
  await storageAction(page, 'export').click();
  await expect(storageForm(page).getByRole('alert')).toContainText('The export repeated a page.');
  expect(await storageCalls(page, 'audit.export.page')).toHaveLength(2);
  await expect(storageAction(page, 'export')).toBeFocused();
});

for (const owner of ['progress', 'outside'] as const) {
  test(`acknowledged deletion retains its receipt and ${owner} focus through measurement recovery`, async ({ page }) => {
    await openStorage(page, { width: owner === 'progress' ? 390 : 1280, held: ['storage.purge.run'] }); await openStorageKind(page);
    const retiredCancel = await storageAction(page, 'cancel').elementHandle();
    const other = await storagePanel(page).locator(`[data-kind="${STORAGE_RECORDS}"]`).elementHandle();
    await previewStorage(page); const retiredDelete = await storageAction(page, 'run').elementHandle();
    await expectRun(page); await storageAction(page, 'run').click();
    await expect(progress(page)).toBeFocused(); expect(await unloadBlocked(page)).toBe(true);
    await retiredCancel!.evaluate(node => (node as HTMLButtonElement).click());
    await retiredDelete!.evaluate(node => (node as HTMLButtonElement).click());
    await other!.evaluate(node => (node as HTMLButtonElement).click());
    await expect(storageForm(page)).toHaveAttribute('data-recued-storage-purge', 'runs');
    await expect(storageAction(page, 'cancel')).toBeDisabled();
    await cancelDeparture(page, /Storage export or deletion.*progress/u);
    if (owner === 'outside') await storageOutside(page).focus();
    const [args] = await storageCalls(page, 'storage.purge.run');
    await page.evaluate(() => { window.__storageFixture.held.push('storage.kinds.read'); });
    await releaseStorage(page, 'storage.purge.run', 0, { result: { kind: args!.kind, before: args!.before, deleted: 10, blocked: 2, bytes_freed: 1024 } });
    const receipt = storageForm(page).locator('.storage-space-receipt');
    await expect(receipt).toContainText('Deleted 10 runs.');
    await expect(storageForm(page)).toContainText('2 runs stayed: other records point at them.');
    await expect(owner === 'outside' ? storageOutside(page) : receipt).toBeFocused();
    expect(await unloadBlocked(page)).toBe(false);
    await releaseStorage(page, 'storage.kinds.read', 0, { error: { code: 'UNAVAILABLE', message: 'Space refresh temporarily unavailable.' } });
    await expect(storagePanel(page).getByRole('alert')).toContainText('Space refresh temporarily unavailable.');
    await expect(receipt).toBeVisible();
    await storagePanel(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await page.evaluate(() => { const snapshot = window.__storageFixture.snapshot as { kinds: Array<{ kind: string }> };
      snapshot.kinds = snapshot.kinds.filter(row => row.kind !== 'runs'); });
    await releaseStorage(page, 'storage.kinds.read', 1);
    await expect(receipt).toBeVisible(); await expect(receipt).toContainText('Deleted 10 runs.');
    await storageAction(page, 'close').click(); await expect(storageForm(page)).toHaveCount(0);
    await expect(storagePanel(page).getByRole('heading', { name: 'What takes space', exact: true })).toBeFocused();
  });
}

test('a refused deletion requires a fresh preview and never reuses the rejected token', async ({ page }) => {
  await openStorage(page); await openStorageKind(page); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.replies['storage.purge.run'] = [
    { error: { code: 'CONFLICT', message: 'This preview expired. Preview again.' } },
  ]; });
  await expectRun(page); const retiredDelete = await storageAction(page, 'run').elementHandle(); await storageAction(page, 'run').click();
  await expect(storageForm(page).getByRole('alert')).toContainText('Preview again to check what remains.');
  await expect(storageAction(page, 'preview')).toBeFocused(); await expect(storageAction(page, 'run')).toHaveCount(0);
  expect(await unloadBlocked(page)).toBe(true);
  await retiredDelete!.evaluate(node => (node as HTMLButtonElement).click());
  await page.evaluate(() => { const args = window.__storageFixture.calls.find(call => call.method === 'storage.purge.preview')!.args;
    window.__storageFixture.replies['storage.purge.preview'] = [{ result: { ...args, items: 3, token: 'recounted-preview', expires_at: 1700000060000 } }]; });
  await previewStorage(page); expect(await unloadBlocked(page)).toBe(false);
  await expect(storageAction(page, 'run')).toHaveText('Delete 3 runs');
  await expectRun(page, 'recounted-preview'); await storageAction(page, 'run').click();
  await expect(storageForm(page).locator('.storage-space-receipt')).toBeVisible();
  expect(await storageCalls(page, 'storage.purge.run')).toHaveLength(2);
});

for (const change of ['reordered', 'missing'] as const) test(`a measurement retry preserves a newly edited date when its kind is ${change}`, async ({ page }) => {
  await openStorage(page); await openStorageKind(page); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.replies['storage.kinds.read'] = [
    { error: { code: 'UNAVAILABLE', message: 'Space refresh temporarily unavailable.' } },
  ]; });
  await expectRun(page); await storageAction(page, 'run').click();
  await expect(storagePanel(page).getByRole('alert')).toContainText('Space refresh temporarily unavailable.');
  await storageAction(page, 'close').click(); await openStorageKind(page, STORAGE_RECORDS);
  await storageForm(page).getByRole('radio', { name: 'A date', exact: true }).check();
  await page.evaluate(() => { window.__storageFixture.held.push('storage.kinds.read'); });
  await storagePanel(page).getByRole('button', { name: 'Try again', exact: true }).click();
  const date = storageForm(page).getByLabel('The date', { exact: true }); const original = await date.elementHandle();
  await date.fill('2022-03-10'); await date.focus();
  if (change === 'missing') {
    await page.evaluate(() => { window.__storageFixture.held.push('storage.purge.preview'); });
    await storageAction(page, 'preview').click(); await expect(progress(page)).toBeFocused();
  }
  await page.evaluate(change => { const snapshot = window.__storageFixture.snapshot as { kinds: Array<{ kind: string }> };
    if (change === 'reordered') snapshot.kinds.reverse(); else snapshot.kinds = snapshot.kinds.filter(row => row.kind !== 'records:fixture/body-signals/daily_metric');
  }, change);
  await releaseStorage(page, 'storage.kinds.read', 0); await storageDrain(page);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  if (change === 'reordered') await expect(date).toBeFocused();
  else {
    await expect(progress(page)).toBeFocused();
    const previews = await storageCalls(page, 'storage.purge.preview');
    await releaseStorage(page, 'storage.purge.preview', 0, { result: { ...previews.at(-1)!, items: 12, token: 'retired-kind-preview', expires_at: 1700000060000 } });
    await expect(date).toBeDisabled(); await expect(storageForm(page).locator('[data-focus-key="unavailable"]')).toBeFocused();
    await expect(storageAction(page, 'preview')).toHaveCount(0);
  }
  await expect(date).toHaveValue('2022-03-10'); expect(await unloadBlocked(page)).toBe(true);
});

test('CSV completion preserves outside focus and a later scroll position', async ({ page }) => {
  await openStorage(page, { width: 390, held: ['records.export'] }); await openStorageKind(page, STORAGE_RECORDS); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.expectedDownloads = 1; });
  await storageAction(page, 'export').click(); await expect(progress(page)).toBeFocused();
  await storageOutside(page).focus();
  const scroll = await page.evaluate(() => { const main = document.querySelector('main')!; main.scrollTop = 24; return main.scrollTop; });
  const file = page.waitForEvent('download');
  await releaseStorage(page, 'records.export', 0, { result: { csv: 'id\ncomplete\n', row_count: 1 } }); await file;
  await expect(storageAction(page, 'run')).toBeEnabled(); await expect(storageOutside(page)).toBeFocused();
  expect(await page.evaluate(() => document.querySelector('main')!.scrollTop)).toBe(scroll);
});

test('a pre-delete measurement cannot overwrite the acknowledged delete refresh', async ({ page }) => {
  await openStorage(page); await openStorageKind(page); await previewStorage(page);
  await page.evaluate(() => { window.__storageFixture.replies['storage.kinds.read'] = [{ error: { code: 'UNAVAILABLE', message: 'Refresh unavailable.' } }]; });
  await expectRun(page); await storageAction(page, 'run').click();
  await expect(storagePanel(page).getByRole('alert')).toContainText('Refresh unavailable.');
  await storageAction(page, 'close').click();
  await page.evaluate(() => { window.__storageFixture.held.push('storage.kinds.read'); });
  await storagePanel(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await openStorageKind(page); await previewStorage(page); await expectRun(page); await storageAction(page, 'run').click();
  await expect.poll(() => storageCalls(page, 'storage.kinds.read')).toHaveLength(4);
  await page.evaluate(() => { (window.__storageFixture.snapshot as { kinds: unknown[] }).kinds = []; });
  await releaseStorage(page, 'storage.kinds.read', 1);
  await expect(storagePanel(page).getByRole('rowheader', { name: 'Body signals · Daily metric', exact: true })).toHaveCount(0);
  await releaseStorage(page, 'storage.kinds.read', 0, { result: { measured_at: 1, database: { file_bytes: 1, free_bytes: 0 }, kinds: [
    { kind: 'stale', group: 'yours', label: 'Stale before delete', items: 99, item_words: 'items', hold: 'yours' },
  ] } });
  await storageDrain(page);
  await expect(storagePanel(page)).not.toContainText('Stale before delete');
  await expect(storageForm(page).locator('.storage-space-receipt')).toBeVisible();
});

test('held kinds explain retention and a kind without export still supports explicit preview', async ({ page }) => {
  await openStorage(page);
  for (const reason of ['Yours, never deleted here', 'Goes when its source goes', 'Would come back on the next sync', 'Not yet'])
    await expect(storagePanel(page).getByRole('cell', { name: reason, exact: true })).toBeVisible();
  await expect(storagePanel(page).locator('[data-recued-storage-kind="source"]')).toContainText('0 files');
  await expect(storagePanel(page).locator('[data-recued-storage-kind="synced_mail"]')).toContainText('—');
  expect(await storageCalls(page, 'storage.purge.preview')).toEqual([]);
  await openStorageKind(page, 'reading_history'); await previewStorage(page);
  await expect(storageAction(page, 'export')).toHaveCount(0);
  await expect(storageAction(page, 'run')).toHaveText('Delete 12 readings');
});
